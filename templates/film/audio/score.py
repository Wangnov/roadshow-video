#!/usr/bin/env python3
"""按时间轴现场作曲并混音：python3 audio/score.py <段> [--style 风格] [--plan]
风格族：流行商务（国内商务宣传片常用的风格），见 references/配乐风格库.md。
输入：audio/tl_<段>.json（build/export_tl.mjs 导出）、audio/vo/index.json 与 audio/vo/<id>.wav|.mp3
输出：audio/music_<段>.wav（纯配乐）、audio/mix_<段>.wav（旁白、配乐、音效混好的成品，-16 LUFS）、audio/stems_<段>/（分轨；mix_vo、mix_music、mix_sfx 三轨是成品拆开的样子，剪辑用）、
      audio/mix_<段>.json（这次用的时间轴与配音的指纹，交付检查用）

段落风格（时间轴里写 timeline(VO, { music: { style: '...' } })，或命令行 --style）：
  title 片头　brisk 日常操作　lively 现场、高能　steady 办公、平稳（默认）　leader 管理层　close 收尾
编法：钢琴分解和弦（按强弱拍给力度、5 到 10 毫秒错位）、中提琴与大提琴铺底、拨弦或跳弓、流行鼓组、电贝司；
  片头、管理层、收尾加圆号与定音鼓。和声是流行进行（I-V-vi-IV、IV-V-iii-vi、vi-IV-I-V 等）。
卡点：从时间轴取出节点，速度在节点之间微调，让节点落在小节强拍上。节点分四级：
  章节、片头片尾（一级）：管弦小军鼓滚奏、反向镲、吊镲、圆号八度与低频冲击，落点前留空白；
  关键操作（二级，时间轴里 cue(t, 'key')）：低频下潜、钢琴低八度与大鼓，不打断律动；
  普通界面操作（三级）：短促的反吸噪声、颤音琴提示音与轻大鼓；
  旁白起句（四级）：只换和声。
混音：旁白时低频声部闪避 8 dB、高频声部闪避 13 dB，800 Hz 到 3 kHz 再让 3 dB；旁白去齿音加两级压缩；总响度 -16 LUFS。
音色库：MuseScore General（MIT）出旋律与弦乐，GeneralUser GS 出鼓组；目录由 ROADSHOW_SOUNDFONTS 指定。
音效：CC0 真实录音（BigSoundBank 编号命名），目录由 ROADSHOW_SFX 指定，缺的音效跳过并在最后列出。"""
import hashlib, itertools, json, os, random, struct, subprocess, sys
import numpy as np

D = os.path.dirname(os.path.abspath(__file__))
SFDIR = os.environ.get('ROADSHOW_SOUNDFONTS', os.path.expanduser('~/.local/share/soundfonts'))
def _sf(name):
    for d in (SFDIR, os.path.join(D, 'sf')):
        p = os.path.join(d, name)
        if os.path.exists(p): return p
    raise SystemExit(f'找不到音色库 {name}：按问题库 Q5.1 安装，或用 ROADSHOW_SOUNDFONTS 指向它所在的目录')
SF_MS = _sf('MuseScore_General.sf3')
SF_GU = _sf('GeneralUser-GS.sf2')
NAME = next((a for a in sys.argv[1:] if not a.startswith('--')), 's1')
ST = os.path.join(D, f'stems_{NAME}')
os.makedirs(ST, exist_ok=True)
SR = 48000
TL = json.load(open(os.path.join(D, f'tl_{NAME}.json')))
VOI = json.load(open(os.path.join(D, 'vo', 'index.json')))
MUSIC = TL.get('music') or {}
STYLE = (sys.argv[sys.argv.index('--style') + 1] if '--style' in sys.argv else None) or MUSIC.get('style') or 'steady'
CFG = {
    'title':   dict(bpm=92, key=2, piano='arp', drums='half', ost=None, bass=False, brass=True, timp=True),
    'brisk': dict(bpm=116, key=2, piano='alberti', drums='pop', ost='pizz', bass=True, brass=False, timp=False),
    'lively':    dict(bpm=122, key=4, piano='pulse', drums='pop', ost='spic', bass=True, brass=False, timp=False),
    'steady':  dict(bpm=104, key=0, piano='arp', drums='pop', ost='pizz', bass=True, brass=False, timp=False),
    'leader': dict(bpm=100, key=-2, piano='pulse', drums='half', ost='spic', bass=True, brass=True, timp=True),
    'close':   dict(bpm=96, key=2, piano='arp', drums='half', ost='spic', bass=True, brass=True, timp=True),
}.get(STYLE)
if CFG is None: raise SystemExit(f'没有这种段落风格：{STYLE}（可选 title、brisk、lively、steady、leader、close）')
KEY = CFG['key']
DUR = TL['dur'] + 0.6
N = int(DUR * SR)
rng = np.random.default_rng(17)
R = random.Random(29 + sum(map(ord, NAME)))
VO_SPANS = sorted((v['t'], v['t'] + VOI[v['id']]['dur']) for v in TL['vo'])

# ---------------- 节点：从时间轴取操作与画面事件，分三级 ----------------
# 二级界面操作：点击目标里包含这些片段的算二级（时间轴里 music.uiTaps）；标注文字里含这些词的加提示音（music.chimeWords）
UI_TAPS = tuple(MUSIC.get('uiTaps', []))
CHIME_CALL = tuple(MUSIC.get('chimeWords', []))
def events():
    ev = []
    for c in TL['cards']:
        k = c['kind']
        if k == 'chap': ev.append((c['t'] + 1.0, 3, 'chap'))
        elif k == 'title': ev.append((c['t'] + 0.75, 3, 'title'))
        elif k == 'lower': ev.append((c['t'] + 0.1, 2, 'lower'))
        elif k == 'note': ev.append((c['t'] + 0.4, 2, 'note'))
        elif k == 'float': ev.append((c['t'] + 0.3, 2, 'float'))
    for n in TL.get('nodes', []): ev.append((n['t'] + 0.15, 1 if n['edge'] else 2, 'node'))
    for tp in TL['taps']:
        g = tp['target']
        lv = 2 if any(k in g for k in UI_TAPS) else 1
        ev.append((tp['t'], lv, 'tap'))
    for c in TL.get('callouts', []):
        if any(k in c['text'] for k in CHIME_CALL): ev.append((c['t'] + 0.1, 2, 'chime'))
    for cu in TL['cues']:
        if cu['kind'] == 'key': ev.append((cu['t'], 3, 'key'))
        elif cu['kind'] == 'shutter': ev.append((cu['t'], 2, 'shutter'))
    for r in TL.get('reveals', []): ev.append((r['t'], 2, 'reveal'))
    for a, b in VO_SPANS: ev.append((a, 1, 'vo'))
    return sorted(ev)
EV = events()
def tier(lv, kind):
    if kind in ('chap', 'title'): return 'big'
    return {3: 'key', 2: 'ui', 1: 'soft'}.get(lv, '')
# 结尾：片头段停在属和弦上冲进第一章；落地段以片尾卡为最后一个落点；其余段在淡出前两秒落主和弦
fo = [f for f in TL['fades'] if f['to'] == 1 and f['t'] > 5]
if STYLE == 'title': END = (TL['dur'], 0, 'half')
elif STYLE == 'close': END = max((e for e in EV if e[2] == 'title'), key=lambda e: e[0])
else:
    te = (fo[-1]['t'] - 2.0) if fo else TL['dur'] - 2.6
    late = (fo[-1]['t'] - 0.6) if fo else TL['dur'] - 1.2
    near = [e for e in EV if e[1] == 3 and te - 2.5 < e[0] <= late]
    END = (near[-1][0], 3, 'end') if near else (te, 2, 'end')
MIN = {3: 3.0, 2: 3.6}
def select():
    acc = []
    cand = [e for e in EV if 0.6 <= e[0] < END[0] - 2.4]
    def ok(e, g): return all(abs(e[0] - a[0]) >= g for a in acc + [END])
    for lv in (3, 2):
        for e in [e for e in cand if e[1] == lv]:
            if ok(e, MIN[lv]): acc.append(e)
    # 太长的空段用旁白起句（其次是普通点击）补一个轻锚点，乐句跟着旁白换
    while True:
        pts = sorted([(0.0, 0, 'start')] + acc + [END]); add = None
        for a, b in zip(pts, pts[1:]):
            if b[0] - a[0] <= 12.5: continue
            mid = (a[0] + b[0]) / 2
            cs = [e for e in cand if e[1] == 1 and a[0] + 4.5 < e[0] < b[0] - 4.5]
            if cs: add = min(cs, key=lambda e: abs(e[0] - mid) - (1.5 if e[2] == 'vo' else 0)); break
        if not add: break
        acc.append(add)
    return sorted([(0.0, 0, 'start')] + acc + [END])
ANCH = select()

# ---------------- 速度图：锚点之间整拍，速度平滑 ----------------
def plan(bpm):
    ivs = list(zip(ANCH, ANCH[1:])); opts = []
    for a, b in ivs:
        raw = (b[0] - a[0]) * bpm / 60; cs = []
        for nb in range(max(1, int(raw * 0.86)), max(2, int(np.ceil(raw * 1.14))) + 1):
            pen = 0 if (raw < 4 or nb % 4 == 0) else (0.012 if nb % 2 == 0 else 0.03)
            cs.append((nb, abs(nb / raw - 1) + pen, bpm * nb / raw))
        opts.append(cs)
    # 动态规划：偏离目标速度、非整小节、相邻速度跳变三项代价
    best = [{i: (c[1], [i]) for i, c in enumerate(opts[0])}]
    for k in range(1, len(opts)):
        cur = {}
        for j, c in enumerate(opts[k]):
            pick = None
            for i, (cost, path) in best[-1].items():
                p = opts[k - 1][i]
                jump = 0 if (k == 1 and p[0] < 4) else 1.4 * abs(c[2] / p[2] - 1)
                v = cost + c[1] + jump
                if pick is None or v < pick[0]: pick = (v, path + [j])
            cur[j] = pick
        best.append(cur)
    cost, path = min(best[-1].values())
    return cost, [opts[k][j] for k, j in enumerate(path)]
BPM0 = CFG['bpm']
COST, CHOICE = min((plan(BPM0 * f) for f in np.linspace(0.95, 1.05, 11)), key=lambda x: x[0])
ABEAT = [0]
for c in CHOICE: ABEAT.append(ABEAT[-1] + c[0])
ATIME = [a[0] for a in ANCH]
TEMPO_END = CHOICE[-1][2]
BB = np.array(ABEAT + [ABEAT[-1] + 400], float)
TT = np.array(ATIME + [ATIME[-1] + 400 * 60 / TEMPO_END])
def B(beat): return float(np.interp(beat, BB, TT))
def BD(beat, n): return B(beat + n) - B(beat)
def beat_of(t): return float(np.interp(t, TT, BB))

# ---------------- 小节与和声 ----------------
CH = {'I': (0, (0, 4, 7)), 'ii': (2, (2, 5, 9)), 'iii': (4, (4, 7, 11)), 'IV': (5, (5, 9, 0)), 'V': (7, (7, 11, 2)), 'vi': (9, (9, 0, 4)),
      'V6': (7, (7, 11, 2)), 'I6': (0, (0, 4, 7)), 'Vsus': (7, (7, 0, 2))}
BASSPC = {'V6': 11, 'I6': 4}
COLOR = {'I': 2, 'IV': 7, 'vi': 7, 'ii': 0, 'iii': 2, 'I6': 2}
PROGS = {
    'title':   [['I', 'V6', 'vi', 'IV'], ['IV', 'V', 'iii', 'vi']],
    'brisk': [['I', 'V', 'vi', 'IV'], ['IV', 'V', 'iii', 'vi'], ['I', 'iii', 'IV', 'V'], ['vi', 'IV', 'I', 'V']],
    'lively':    [['vi', 'IV', 'I', 'V'], ['IV', 'V', 'vi', 'I'], ['I', 'V', 'vi', 'IV']],
    'steady':  [['I', 'V6', 'vi', 'IV'], ['IV', 'I6', 'ii', 'V'], ['vi', 'iii', 'IV', 'I']],
    'leader': [['vi', 'IV', 'I', 'V'], ['ii', 'IV', 'I', 'V'], ['vi', 'V', 'IV', 'V']],
    'close':   [['IV', 'V', 'iii', 'vi'], ['I', 'V6', 'vi', 'IV'], ['IV', 'V', 'I', 'vi']],
}[STYLE]
SAD = [['vi', 'iii', 'IV', 'I'], ['vi', 'IV', 'ii', 'V']]
FIRST_NOTE = min([a[0] for a in ANCH if a[2] == 'note'] or [1e9])
RULE = {'title': {0: 0, 1: 1, 2: 1, 3: 2}, 'brisk': {0: 0, 1: 1, 2: 2, 3: 2}, 'lively': {0: 0, 1: 2, 2: 2, 3: 3},
        'steady': {0: 0, 1: 1, 2: 2, 3: 2}, 'leader': {0: 0, 1: 1, 2: 2, 3: 2}, 'close': {0: 0, 1: 1, 2: 2, 3: 3}}[STYLE]
BARS = []
cyc = 0
for i in range(len(ANCH) - 1):
    a0, a1 = ANCH[i], ANCH[i + 1]; b0 = ABEAT[i]; nb = ABEAT[i + 1] - b0
    pick = i == 0 and B(nb) - B(0) < 2.2
    lens = [4] * (nb // 4) + ([nb % 4] if nb % 4 else [])
    if nb % 4 == 1 and nb > 4: lens = lens[:-2] + [3, 2]
    if pick: lens = [nb]
    sad = STYLE == 'title' and a0[0] >= FIRST_NOTE - 0.01
    if a0[1] == 3: prog = next((p for p in PROGS if p[0] == 'I'), ['I', 'V', 'vi', 'IV'])
    else: prog = (SAD if sad else PROGS)[cyc % len(SAD if sad else PROGS)]; cyc += 1
    pos = b0
    for k, L in enumerate(lens):
        last = k == len(lens) - 1
        t1 = tier(a1[1], a1[2])
        if pick: ch = [(0, L, 'V')]
        elif last and (t1 in ('big', 'key') or a1[2] == 'half'):
            ch = [(0, 2, 'IV'), (2, 1, 'Vsus'), (3, L - 3, 'V')] if L >= 4 else [(0, 1, 'IV'), (1, L - 1, 'V')] if L == 3 else [(0, L, 'V')]
            if a1[2] == 'half': ch = [(0, L, 'IV')] if L < 2 else [(0, L / 2, 'IV'), (L / 2, L / 2, 'V')]
        elif last and t1 == 'ui':  # 普通界面操作：只在后半小节走到属和弦
            c = prog[k % len(prog)]
            ch = [(0, 2, c), (2, L - 2, 'V')] if L >= 4 and c not in ('V', 'Vsus') else [(0, L, c)]
        else: ch = [(0, L, prog[k % len(prog)])]
        e = RULE[a0[1]] if not pick else 0
        if a0[1] == 3 and k < (2 if STYLE == 'title' else 4): e = 3 if STYLE != 'title' else 2
        if STYLE == 'close' and a0[0] >= FIRST_NOTE - 0.01: e = max(e, 2)
        if STYLE == 'title' and a0[2] == 'start' and not pick: e = 0
        if last and a1[1] == 3 and not pick: e = max(e, 2)
        BARS.append(dict(b=pos, n=L, ph=i, k=k, nk=len(lens), last=last, lvl0=a0[1] if k == 0 else 0, kind0=a0[2], lvl1=a1[1] if last else 0,
                         kind1=a1[2] if last else '', ch=ch, e=e, pick=pick, tail=False, sad=sad))
        pos += L
# 能量每小节最多降一级，避免鼓和低音一下子全撤
for a, b in zip(BARS, BARS[1:]):
    if not (a['pick'] or b['pick']): b['e'] = max(b['e'], a['e'] - 1)
# 尾声：最后一个锚点之后只留收束和弦
tb = ABEAT[-1]
while B(tb) < DUR:
    BARS.append(dict(b=tb, n=4, ph=len(ANCH) - 1, k=tb - ABEAT[-1], nk=0, last=False, lvl0=END[1] if tb == ABEAT[-1] else 0, kind0='end', lvl1=0,
                     kind1='', ch=[(0, 4, 'V' if END[2] == 'half' else 'I')], e=1, pick=False, tail=True, sad=False))
    tb += 4
L3B = [ABEAT[i] for i, a in enumerate(ANCH) if tier(a[1], a[2]) == 'big']
def drop(beat): return any(a - 0.5 <= beat < a - 1e-6 for a in L3B)
def pcs_of(sym, color=False):
    r, p = CH[sym]; p = list(p)
    if color and sym in COLOR: p.append(COLOR[sym])
    return p
def voicing(pcs, center, prev=None, span=(-7, 8)):
    lo, hi = center + span[0], center + span[1]; opts = []
    for pc in pcs:
        ns = [n for n in range(lo, hi + 1) if n % 12 == pc]
        opts.append(ns or [min(range(lo - 6, hi + 7), key=lambda n: (n % 12 != pc, abs(n - center)))])
    best = None
    for combo in itertools.product(*opts):
        v = sorted(combo)
        if len(set(v)) < len(v) or v[-1] - v[0] > 14: continue
        c = abs(sum(v) / len(v) - center) * 0.5 + (sum(min(abs(a - b) for b in prev) for a in v) * 0.6 if prev else 0)
        if best is None or c < best[0]: best = (c, v)
    return best[1] if best else sorted(o[0] for o in opts)
def vtable(center, color=False, span=(-7, 8)):
    tab = {}; prev = None
    for i, bar in enumerate(BARS):
        for o, n, sym in bar['ch']:
            prev = tab[(i, o)] = voicing(pcs_of(sym, color), center, prev, span)
    return tab
def low(pc, lo):  # 在 [lo, lo+11] 里取该音级
    return lo + (pc - lo) % 12
def bass_pc(sym): return BASSPC.get(sym, CH[sym][0])
def ladder(sym, lo=76, hi=96):
    return [n for n in range(lo, hi + 1) if n % 12 in CH[sym][1]]
def chord_at(bar, off):
    cur = bar['ch'][0]
    for c in bar['ch']:
        if c[0] <= off + 1e-6: cur = c
    return cur
def segs():  # (小节序号, 小节, 和弦起拍偏移, 拍数, 和弦)
    for i, bar in enumerate(BARS):
        for o, n, sym in bar['ch']: yield i, bar, o, n, sym

# ---------------- MIDI（按秒写，固定 120 拍） ----------------
class Midi:
    def __init__(s, seed=7): s.ev = []; s.r = random.Random(seed)
    def tk(s, sec): return int(round(max(0, sec) * 960))
    def note(s, ch, p, t, d, v, hum=0.006):
        if t >= DUR or d <= 0: return
        if ch != 9: p = p + KEY
        if not 0 <= p <= 127: return
        j = s.r.uniform(-hum, hum) if (t > 0.05 and hum) else 0
        v = max(1, min(127, int(v + s.r.uniform(-3, 3))))
        s.ev.append((s.tk(t + j), 1, ch, p, v)); s.ev.append((s.tk(t + j + d), 0, ch, p, 0))
    def cc(s, ch, c, t, v): s.ev.append((s.tk(t), 2, ch, c, int(max(0, min(127, v)))))
    def ramp(s, ch, c, t0, t1, v0, v1, step=0.05):
        t = t0
        while t <= t1 + 1e-6:
            s.cc(ch, c, t, v0 + (v1 - v0) * (t - t0) / max(1e-6, t1 - t0)); t += step
    def prog(s, ch, p, bank=0):
        if ch != 9: s.ev.append((0, 2, ch, 0, bank))
        s.ev.append((0, 3, ch, p, 0))
    def write(s, path):
        evs = sorted(s.ev, key=lambda e: (e[0], {3: -1, 2: -2, 0: 0, 1: 1}[e[1]]))
        tr = bytearray(); last = 0
        def vl(n):
            b = [n & 0x7f]; n >>= 7
            while n: b.append((n & 0x7f) | 0x80); n >>= 7
            return bytes(reversed(b))
        tr += vl(0) + b'\xff\x51\x03' + (500000).to_bytes(3, 'big')
        for (t, k, ch, a, b) in evs:
            tr += vl(t - last); last = t
            tr += bytes([0x90 | ch, a, b]) if k == 1 else bytes([0x80 | ch, a, 0]) if k == 0 else bytes([0xB0 | ch, a, b]) if k == 2 else bytes([0xC0 | ch, a])
        tr += vl(0) + b'\xff\x2f\x00'
        open(path, 'wb').write(b'MThd' + struct.pack('>IHHH', 6, 0, 1, 480) + b'MTrk' + struct.pack('>I', len(tr)) + bytes(tr))
def load(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, '<f4').astype(np.float64).reshape(-1, 2)
def fit(x, n=N):
    if len(x) < n: x = np.vstack([x, np.zeros((n - len(x), 2))])
    return x[:n].copy()
def fluid(m, name, sf=SF_MS, gain=0.6, n=N):
    mid = os.path.join(ST, name + '.mid'); wav = os.path.join(ST, name + '_dry.wav')
    m.write(mid)
    subprocess.run(['fluidsynth', '-ni', '-q', '-g', str(gain), '-r', str(SR), '-R', '0', '-C', '0', '-F', wav, sf, mid], check=True, capture_output=True)
    x = fit(load(wav), n); os.remove(wav); return x

# ---------------- 处理 ----------------
def filt(x, lo=None, hi=None, order=2):
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)[:, None] + 1e-9
    g = np.ones_like(f)
    if hi: g = g / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo: g = g / np.sqrt(1 + (lo / f) ** (2 * order))
    return np.fft.irfft(X * g, len(x), axis=0)
def bell(x, fc, dbv, q=1.0):
    X = np.fft.rfft(x, axis=0); f = np.fft.rfftfreq(len(x), 1 / SR)[:, None] + 1e-9
    g = 10 ** (dbv / 20); w = np.exp(-(np.log2(f / fc) * q * 1.4) ** 2)
    return np.fft.irfft(X * (1 + (g - 1) * w), len(x), axis=0)
def conv(x, ir):
    n = len(x) + len(ir) - 1; M = 1 << (n - 1).bit_length(); y = np.zeros((len(x), 2))
    for c in range(2): y[:, c] = np.fft.irfft(np.fft.rfft(x[:, c], M) * np.fft.rfft(ir[:, c], M), M)[:len(x)]
    return y
def hall(sec=3.0, seed=3, damp=2200, pre=0.025):
    r = np.random.default_rng(seed); n = int(sec * SR); t = np.arange(n) / SR; ir = np.zeros((n, 2))
    for c in range(2):
        x = r.standard_normal(n); X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / SR)
        dark = np.fft.irfft(X / (1 + (f / damp) ** 2), n); bright = np.fft.irfft(X / (1 + (f / 8000) ** 2), n)
        k = np.exp(-t * 1.4); ir[:, c] = (bright * k + dark * (1 - k)) * np.exp(-t * 2.1)
    p = int(pre * SR); ir = np.vstack([np.zeros((p, 2)), ir])[:n]
    ir[p:p + int(.02 * SR)] *= np.linspace(0, 1, int(.02 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum() / 2)
HALL = hall(); ROOM = hall(1.2, 5, 3000, .008)
def width(x, ms=9, amt=0.3):
    d = int(ms / 1000 * SR); m = (x[:, 0] + x[:, 1]) / 2; s = (x[:, 0] - x[:, 1]) / 2
    s2 = s + amt * np.concatenate([np.zeros(d), m[:-d]]) * 0.5
    return np.stack([m + s2, m - s2], 1)
def smooth(v, att, rel):
    step = 48; vs = v[::step]; o = np.empty_like(vs); a = np.exp(-step / (att * SR)); r = np.exp(-step / (rel * SR)); y = 0.0
    for i, z in enumerate(vs):
        k = a if z < y else r
        y = k * y + (1 - k) * z; o[i] = y
    return np.interp(np.arange(len(v)), np.arange(len(vs)) * step, o)
def comp(x, thr=-18, ratio=2.5, att=0.02, rel=0.25):
    lvl = np.sqrt(np.convolve((x ** 2).mean(1), np.ones(480) / 480, 'same')) + 1e-9
    over = np.maximum(0, 20 * np.log10(lvl) - thr); g = smooth(-over * (1 - 1 / ratio), att, rel)
    return x * (10 ** (g / 20))[:, None]
def db(x): return 10 ** (x / 20)
def arms(x):  # 有声部分的均方根
    e = np.sqrt(np.convolve((x ** 2).mean(1), np.ones(4800) / 4800, 'same'))
    m = e > e.max() * 0.06
    return np.sqrt((x[m] ** 2).mean()) if m.any() else 1e-9
def place(buf, x, t, g=1.0):
    i = int(round(t * SR))
    if x.ndim == 1: x = np.stack([x, x], 1)
    if i < 0: x = x[-i:]; i = 0
    n = min(len(x), len(buf) - i)
    if n > 0: buf[i:i + n] += x[:n] * g
def write(p, x):
    x = np.clip(x, -1, 1); data = (x * 32767).astype('<i2').tobytes()
    with open(p, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 2, SR, SR * 4, 4, 16) + b'data' + struct.pack('<I', len(data)) + data)

# ---------------- 声部 ----------------
EV_SCALE = {0: 0.78, 1: 0.88, 2: 1.0, 3: 1.1}
def vo_frac(bar):  # 小节里有旁白的时间占比
    t0, t1 = B(bar['b']), B(bar['b'] + bar['n'])
    return sum(max(0, min(t1, b) - max(t0, a)) for a, b in VO_SPANS) / max(1e-6, t1 - t0)
def next_tier(bar): return tier(bar['lvl1'], bar['kind1']) if bar['last'] else ''
PVEL = {0: 90, 4: 82, 2: 72, 6: 72}  # 八分音符位置的力度：一拍最强、三拍次强、二四拍再次，反拍最弱
def part_piano():
    m = Midi(1); m.prog(0, 0); m.cc(0, 7, 0, 100); m.cc(0, 10, 0, 58)
    vt = vtable(67, color=True)
    for i, bar, o, n, sym in segs():
        e = bar['e']; b0 = bar['b'] + o; v = vt[(i, o)]
        if bar['tail']:
            if bar['k'] == 0:  # 收束：低八度加琶音上行的大和弦
                r = low(bass_pc(sym), 26); t = B(b0)
                m.cc(0, 64, t - 0.02, 0); m.cc(0, 64, t + 0.02, 110)
                for k_, q in enumerate([r, r + 12] + v + [v[0] + 12]):
                    m.note(0, q, t + k_ * 0.055, 5.0, 72 - k_ * 3, hum=0)
            continue
        if bar['pick']: continue
        m.cc(0, 64, B(b0) - 0.02, 0); m.cc(0, 64, B(b0) + 0.03, 96)
        if e == 0 or (bar['sad'] and e < 2):  # 长音和弦，手指先后落下
            for k_, q in enumerate(v): m.note(0, q, B(b0) + k_ * R.uniform(0.012, 0.026), BD(b0, n) * 0.98, 52 - 2 * k_, hum=0)
            if n >= 3: m.note(0, v[-1] + 12, B(b0 + 2) + 0.01, BD(b0 + 2, n - 2), 42)
        else:  # 分解和弦：一个八度多一点内上行再回落，按强弱拍给力度
            seq = v + [v[0] + 12]
            for j in range(int(round(n * 2))):
                bt = b0 + j / 2
                if drop(bt): continue
                pos = int(round((bt - bar['b']) * 2))
                q = seq[[0, 1, 2, 3, len(seq) - 1, 3, 2, 1][pos % 8] if len(seq) > 4 else [0, 1, 2, 3, 2, 1, 2, 1][pos % 8] % len(seq)]
                vel = PVEL.get(pos % 8, 60) * (0.88 if e == 1 else 1.0) + R.uniform(-5, 5)
                m.note(0, q, B(bt), BD(bt, 1.4), vel, hum=0.009)
        if e >= 1 and not drop(b0):  # 左手：小节头的低八度根音，踩着踏板留住
            r = low(bass_pc(sym), 36)
            m.note(0, r, B(b0), BD(b0, n) * 0.96, 62 * EV_SCALE[e], hum=0.006)
            m.note(0, r + 12, B(b0) + 0.009, BD(b0, n) * 0.96, 52 * EV_SCALE[e], hum=0.006)
    m.cc(0, 64, DUR - 0.1, 0)
    return fluid(m, 'piano', SF_MS, 0.6)
def pingpong(x, sec, fb=0.38, taps=4):  # 附点八分乒乓延迟
    d = int(sec * SR); y = x.copy(); g = 1.0
    for k in range(1, taps + 1):
        g *= fb; s = k * d
        if s >= len(x): break
        sh = np.zeros_like(x); sh[s:] = x[:-s]
        pl, pr = (1.0, 0.3) if k % 2 else (0.3, 1.0)
        y[:, 0] += sh[:, 0] * g * pl; y[:, 1] += sh[:, 1] * g * pr
    return y
def part_guitar():  # 第三稿配对盲测里被听成塑料合成器琶音，第四稿起不用，保留代码备查
    if True: return np.zeros((N, 2))
    m = Midi(14); m.prog(0, 28); m.cc(0, 7, 0, 100); m.cc(0, 10, 0, 64)
    for i, bar, o, n, sym in segs():
        e = bar['e']
        if bar['tail'] or bar['pick'] or e < 1 or (STYLE == 'close' and e < 2): continue
        b0 = bar['b'] + o; r = low(CH[sym][0], 40)
        pat = [r, r, r + 7, r, r + 12, r, r + 7, r]
        for j in range(int(round(n * 2))):
            bt = b0 + j / 2
            if drop(bt): continue
            pos = int(round((bt - bar['b']) * 2)); acc = pos % 8 in (0, 3, 6)
            vel = (90 if acc else 64) * (0.84 if e == 1 else 1.0) + R.uniform(-7, 7)
            m.note(0, pat[pos % 8], B(bt), BD(bt, 0.42), vel, hum=0.007)
            if acc and e >= 2 and pat[pos % 8] == r: m.note(0, r + 7, B(bt) + 0.006, BD(bt, 0.42), vel - 10, hum=0.007)
    x = fluid(m, 'guitar', SF_MS, 0.6)
    return pingpong(x, 0.75 * 60 / float(np.median([c[2] for c in CHOICE])))
def strings_expr(m, chs):
    LEVEL = {0: 58, 1: 70, 2: 84, 3: 100}
    for bar in BARS:
        t0 = B(bar['b']); t1 = B(bar['b'] + bar['n'])
        if bar['tail']:
            if bar['k'] == 0:
                for ch in chs:
                    m.ramp(ch, 11, t0, t0 + 0.3, 100, 96)
                    if END[2] == 'half': m.ramp(ch, 11, t0 + 0.3, min(DUR, t0 + 5.5), 96, 127)
                    else: m.ramp(ch, 11, t0 + 3.0, min(DUR, t0 + 7.5), 96, 0)
            continue
        lv = LEVEL[bar['e']]; nt = next_tier(bar)
        for ch in chs:
            if nt == 'big': m.ramp(ch, 11, t0, t1 - 0.05, lv, 124)
            elif nt == 'key': m.ramp(ch, 11, t0, t0 + 0.3, lv - 8, lv); m.ramp(ch, 11, (t0 + t1) / 2, t1 - 0.05, lv, min(127, lv + 22))
            elif nt == 'ui': m.ramp(ch, 11, t0, t0 + 0.3, lv - 8, lv); m.ramp(ch, 11, (t0 + t1) / 2, t1 - 0.05, lv, min(127, lv + 12))
            else:  # 每小节有起伏：推到六成处再回落
                tm = t0 + 0.55 * (t1 - t0)
                m.ramp(ch, 11, t0, tm, lv - 10, lv + 4, 0.06); m.ramp(ch, 11, tm, t1 - 0.02, lv + 4, lv - 4, 0.06)
def part_strings(hi):
    m = Midi(2 if hi else 13)
    for ch, bank, pan, vol in (((1, 20, 42, 96), (2, 30, 78, 92)) if hi else ((3, 40, 86, 98), (4, 50, 96, 92))):
        m.prog(ch, 49, bank); m.cc(ch, 10, 0, pan); m.cc(ch, 7, 0, vol)
    strings_expr(m, (1, 2) if hi else (3, 4))
    va = vtable(62, span=(-6, 7)); vn = vtable(72, span=(-5, 6))
    for i, bar, o, n, sym in segs():
        if bar['tail'] and bar['k'] != 0: continue
        if bar['pick']: continue
        e = bar['e']; t = B(bar['b'] + o); d = (BD(bar['b'] + o, n) + 0.08) if not bar['tail'] else 7.5
        if hi:  # 中提琴在中音区铺底；小提琴只在片头片尾的高潮与收束进，且不上 C5 以上
            for q in va[(i, o)][:2]: m.note(2, q, t, d, 74)
            if STYLE in ('title', 'close') and (bar['tail'] or (e >= 3 and vo_frac(bar) < 0.5)):
                m.note(1, vn[(i, o)][-1], t, d, 72)
        else:
            m.note(3, low(bass_pc(sym), 43), t, d, 78)
            if e >= 2 or bar['tail']: m.note(4, low(bass_pc(sym), 31), t, d, 72)
    return fluid(m, 'strings_hi' if hi else 'strings_lo', SF_MS, 0.6)
def part_ost():
    kind = CFG['ost']
    if not kind: return np.zeros((N, 2))
    m = Midi(3)
    m.prog(5, 48, 40); m.cc(5, 10, 0, 84); m.prog(7, 45, 0); m.cc(7, 10, 0, 76)
    vt = vtable(67, span=(-6, 7))
    for i, bar, o, n, sym in segs():
        e = bar['e']
        if bar['tail'] or bar['pick'] or e < 1: continue
        b0 = bar['b'] + o; r = low(bass_pc(sym), 43); v = vt[(i, o)]
        if kind == 'spic' and e >= 2:  # 大提琴跳弓八分，3-3-2 重音
            for j in range(int(round(n * 2))):
                bt = b0 + j / 2; pos = int(round((bt - bar['b']) * 2))
                if drop(bt): continue
                q = [r, r, r + 12, r, r, r + 12, r, r + 7][pos % 8]
                m.note(5, q, B(bt), BD(bt, 0.36), (88 if pos % 8 in (0, 3, 6) else 62) + R.uniform(-7, 7), hum=0.007)
        if kind == 'pizz' or (kind == 'spic' and e == 1):  # 拨弦：低音、和弦音弹跳
            pat = [(0, r, 80), (1, v[0], 60), (1.5, v[1], 54), (2, r + 7, 70), (3, v[1], 60), (3.5, v[2] if len(v) > 2 else v[0], 56)]
            for off, q, vel in pat:
                if off >= n or drop(b0 + off): continue
                m.note(7, q, B(b0 + off), 0.3, vel * EV_SCALE[e] + R.uniform(-6, 6), hum=0.008)
    return fluid(m, 'ost', SF_MS, 0.6)
def part_bass():
    if not CFG['bass']: return np.zeros((N, 2))
    m = Midi(4); m.prog(0, 33); m.cc(0, 7, 0, 104)
    for i, bar, o, n, sym in segs():
        e = bar['e']; b0 = bar['b'] + o; r = low(bass_pc(sym), 28)
        if bar['tail']:
            if bar['k'] == 0: m.note(0, r, B(b0), 3.5, 80, hum=0)
            continue
        if bar['pick'] or e < 1: continue
        if e == 1:
            for off in (0, 2):
                if off < n and not drop(b0 + off): m.note(0, r, B(b0 + off), BD(b0 + off, min(2, n - off) * 0.92), 76 + R.uniform(-5, 5))
            continue
        for j in range(int(round(n * 2))):
            bt = b0 + j / 2; pos = int(round((bt - bar['b']) * 2))
            if drop(bt): continue
            q = r + (12 if (e >= 3 and pos % 4 == 3) or pos % 8 == 7 else 0)
            m.note(0, q, B(bt), BD(bt, 0.45), (84 if pos % 8 in (0, 3, 6) else 66) + R.uniform(-6, 6))
    return fluid(m, 'bass', SF_MS, 0.6)
def part_drums():
    m = Midi(5); m.prog(9, 16 if STYLE in ('lively', 'close') else 0); m.cc(9, 7, 0, 104)
    pat = CFG['drums']
    for i, bar in enumerate(BARS):
        if bar['tail'] or bar['pick']: continue
        e = bar['e']; n = bar['n']; b = bar['b']; sc = EV_SCALE[e]; nt = next_tier(bar)
        ff = n - {'big': 2, 'key': 0.5}.get(nt, 0)  # 落点前做减法：大落点空两拍，关键操作空半拍，界面操作不打断律动
        def hit(p, off, v, d=0.12, keep=False):
            if off >= n - 1e-6 or drop(b + off) or (off >= ff - 1e-6 and not keep): return
            m.note(9, p, B(b + off), d, v * sc + R.uniform(-7, 7), hum=0.006)
        if pat == 'pop':
            if e >= 1:
                for j in range(int(n * 4)): hit(82, j / 4, 40 if j % 4 == 0 else 30 if j % 2 == 0 else 22)
            if e == 1:
                for off, v in ((0, 72), (2, 58)): hit(36, off, v)
                for off in (1, 3): hit(37, off, 44)
            if e >= 2:
                for off, v in ((0, 92), (2, 84), (2.5, 60)) if e == 2 else ((0, 98), (1, 88), (2, 94), (3, 86)): hit(36, off, v)
                for off in (1, 3):
                    hit(38, off, 72)
                    if e >= 3: hit(39, off, 52)
                for j in range(int(n * 2)): hit(42, j / 2, 50 if j % 2 == 0 else 34, 0.1)
                if e >= 3: hit(46, n - 0.5, 50, 0.3)
        else:  # 半速：大鼓一拍、小军鼓三拍
            if e >= 1:
                for off, v in ((0, 84), (1.5, 56)) if e == 1 else ((0, 96), (1.5, 68), (2.5, 64)): hit(36, off, v)
            if e >= 2:
                hit(38, 2, 80); hit(39, 2, 60)
                for j in range(int(n * 2)): hit(42, j / 2, 46 if j % 2 == 0 else 32, 0.1)
            if e >= 3:
                for off in (0.5, 1.5, 3.5): hit(45 if off < 2 else 41, off, 56)
        if nt == 'big':  # 冲向大落点：大鼓四分渐强，滚奏在落点轨
            for k_, off in enumerate(range(int(ff), n)): hit(36, off, 74 + 10 * k_, keep=True)
    return fluid(m, 'drums', SF_GU, 0.55)
def gaps():
    out = []; sp = VO_SPANS
    for (a0, a1), (b0, b1) in zip(sp, sp[1:]):
        if b0 - a1 >= 0.7: out.append((a1, b0))
    return out
def part_bells():
    m = Midi(6)
    m.prog(0, 0); m.cc(0, 7, 0, 92); m.cc(0, 10, 0, 74)     # 高音钢琴：旁白气口里的应答句
    m.prog(1, 11); m.cc(1, 7, 0, 90); m.cc(1, 10, 0, 50)    # 颤音琴：界面操作的提示音，中高音区、长混响
    m.prog(2, 46); m.cc(2, 7, 0, 104); m.cc(2, 10, 0, 60)   # 竖琴：大落点前的上行刮奏
    SH = [[0, 1, 2, 3], [0, 2, 1, 3], [1, 2, 3, 4], [3, 2, 1, 2], [0, 1, 3, 2]]
    busy = [ATIME[i] for i, a in enumerate(ANCH) if a[1] >= 2]
    for gi, (g0, g1) in enumerate(gaps()):
        bs = np.ceil(beat_of(g0 + 0.08) * 2) / 2; be = beat_of(g1 + 0.2)
        k_ = int(min(4, (be - bs) * 2))
        if k_ < 2: continue
        bar = max((b for b in BARS if b['b'] <= bs), key=lambda b: b['b'], default=None)
        if not bar or bar['tail'] or bar['pick'] or bar['e'] < 1: continue
        if any(g0 - 0.1 < t < g0 + 0.6 for t in busy): continue
        m.cc(0, 64, B(bs) - 0.02, 0); m.cc(0, 64, B(bs) + 0.02, 90)
        for j, idx in enumerate(SH[gi % len(SH)][:k_]):
            bt = bs + j / 2; bb = max((b for b in BARS if b['b'] <= bt + 1e-6), key=lambda b: b['b'])
            sym = chord_at(bb, bt - bb['b'])[2]; lad = ladder(sym, 72, 91)
            m.note(0, lad[min(len(lad) - 1, idx + 1)], B(bt), 1.0, 56 - 3 * j + R.uniform(-4, 4), hum=0.008)
    for i, a in enumerate(ANCH):
        if a[2] in ('start', 'half'): continue
        tr = tier(a[1], a[2]); bar = next((b for b in BARS if abs(b['b'] - ABEAT[i]) < 1e-6), None)
        sym = bar['ch'][0][2] if bar else 'I'; t = ATIME[i]
        if tr == 'big':
            lad = [n for n in range(50, 87) if n % 12 in CH[sym][1]]
            for j, q in enumerate(lad): m.note(2, q, t - 0.5 + 0.48 * j / len(lad), 1.6, 50 + 30 * j / len(lad), hum=0)
        elif tr in ('key', 'ui'):
            lad = ladder(sym, 72, 86)
            m.note(1, lad[1], t, 1.8, 54 if tr == 'key' else 46, hum=0); m.note(1, lad[3] if len(lad) > 3 else lad[-1], t + 0.1, 2.0, 48 if tr == 'key' else 40, hum=0)
    # 没有选作锚点的二级事件（意思一致、上屏、点出结果）：颤音琴单音提示，落在事件本身的时刻
    taken = list(ATIME)
    for t, lv, kind in EV:
        if lv < 2 or kind in ('lower', 'note', 'chap', 'title', 'vo') or t >= END[0]: continue
        if any(abs(t - x) < 0.7 for x in taken): continue
        taken.append(t)
        bb = max((b for b in BARS if B(b['b']) <= t + 1e-6), key=lambda b: b['b'])
        sym = chord_at(bb, beat_of(t) - bb['b'])[2]; lad = ladder(sym, 72, 86)
        m.note(1, lad[2] if len(lad) > 2 else lad[-1], t, 1.6, 40, hum=0)
    if END[2] != 'half':  # 收尾：高音钢琴分解主和弦
        tb = [b for b in BARS if b['tail']]
        if tb:
            sym = tb[0]['ch'][0][2]; lad = ladder(sym, 72, 96)
            for j, q in enumerate(lad[:5]): m.note(0, q, B(tb[0]['b'] + 1 + j * 0.5), 1.6, 58 - 2 * j)
    return fluid(m, 'bells', SF_MS, 0.55)
def part_pad():
    m = Midi(7); m.prog(0, 89); m.cc(0, 7, 0, 90)
    vt = vtable(60, span=(-6, 7))
    for i, bar, o, n, sym in segs():
        if bar['pick'] or (bar['tail'] and bar['k'] != 0): continue
        t = B(bar['b'] + o); d = BD(bar['b'] + o, n) + 0.1 if not bar['tail'] else 5.0
        for q in vt[(i, o)]: m.note(0, q, t, d, 54)
    strings_expr(m, (0,))
    return fluid(m, 'pad', SF_MS, 0.5)
def part_brass():
    if not CFG['brass']: return np.zeros((N, 2))
    m = Midi(8); m.prog(0, 60); m.cc(0, 7, 0, 96); m.cc(0, 10, 0, 70)
    vt = vtable(60, span=(-6, 6))
    for i, bar, o, n, sym in segs():
        if bar['pick'] or (bar['tail'] and bar['k'] != 0): continue
        if bar['e'] < 2 and not bar['tail']: continue
        t = B(bar['b'] + o); d = BD(bar['b'] + o, n) + 0.06 if not bar['tail'] else 4.5
        for q in vt[(i, o)][:2]: m.note(0, q, t, d, 72 if bar['e'] < 3 else 86)
    strings_expr(m, (0,))
    return fluid(m, 'brass', SF_MS, 0.55)

# ---------------- 落点与铺垫（单独一轨，旁白下少闪避） ----------------
def boom(dur=1.6, f0=64, f1=33):
    t = np.arange(int(dur * SR)) / SR; f = f1 + (f0 - f1) * np.exp(-t * 6)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.4) * (1 - np.exp(-t * 300))
    return np.stack([x, x], 1)
def riser(L, seed=0):  # 反吸白噪声：高频由暗到亮、由弱到强
    r = np.random.default_rng(seed); n = int(L * SR); x = r.standard_normal((n, 2))
    x = filt(x, 1800, 9000); x *= (np.linspace(0, 1, n) ** 2.5)[:, None]
    return x / (np.abs(x).max() + 1e-9)
def part_hits():
    ms = Midi(9)
    ms.prog(0, 47); ms.prog(1, 0); ms.prog(2, 48); ms.prog(3, 44); ms.prog(4, 60)
    ms.cc(3, 10, 0, 64); ms.cc(4, 10, 0, 58)
    for c in range(5): ms.cc(c, 7, 0, 110)
    std = Midi(10); std.prog(9, 0); orch = Midi(11); orch.prog(9, 48)
    y = np.zeros((N, 2)); vt = vtable(64, span=(-7, 8))
    for i, a in enumerate(ANCH):
        if a[2] in ('start', 'half'): continue
        t = ATIME[i]; tr = tier(a[1], a[2]); final = STYLE == 'close' and i == len(ANCH) - 1
        bi = next((j for j, b in enumerate(BARS) if abs(b['b'] - ABEAT[i]) < 1e-6), None)
        sym = BARS[bi]['ch'][0][2] if bi is not None else 'I'; r = bass_pc(sym)
        if tr == 'big':  # 章节与片头片尾：定音鼓、钢琴低八度、弦乐短奏、圆号八度、吊镲、大鼓与低频冲击
            ms.note(0, low(r, 38), t, 2.6, 118, hum=0)
            ms.cc(1, 64, t - 0.02, 0); ms.cc(1, 64, t + 0.02, 120)
            ms.note(1, low(r, 22), t, 3.0, 112, hum=0); ms.note(1, low(r, 22) + 12, t, 3.0, 104, hum=0)
            if bi is not None:
                for q in vt[(bi, 0)] + [low(r, 40)]: ms.note(2, q, t, 0.32 if not final else 5.5, 112, hum=0)
            ms.cc(1, 64, t + 2.8, 0)
            hd = 5.0 if final else 1.6
            for q in (low(CH[sym][0], 53), low(CH[sym][0], 53) + 12): ms.note(4, q, t, hd, 104 if final else 92, hum=0)
            if final:
                for q in (low(r, 28), low(r, 40)): ms.note(2, q, t, 5.5, 104, hum=0)
            std.note(9, 49, t, 2.0, 110, hum=0); std.note(9, 57, t + 0.004, 2.0, 92, hum=0); std.note(9, 36, t, 0.3, 120, hum=0)
            orch.note(9, 36, t, 1.5, 124, hum=0)
            place(y, boom(3.2 if final else 2.2, 85, 42), t, 1.0 if final else 0.9)
        elif tr == 'key':  # 关键操作：低频下潜、钢琴低八度、大鼓
            ms.cc(1, 64, t - 0.02, 0); ms.cc(1, 64, t + 0.02, 110)
            ms.note(1, low(r, 22), t, 2.2, 96, hum=0); ms.note(1, low(r, 22) + 12, t, 2.2, 88, hum=0)
            ms.cc(1, 64, t + 2.0, 0)
            if CFG['timp']: ms.note(0, low(r, 38), t, 1.6, 80, hum=0)
            std.note(9, 36, t, 0.3, 104, hum=0)
            place(y, boom(1.2, 72, 42), t, 0.4)
        elif tr == 'ui':  # 普通界面操作：钢琴低音与轻大鼓
            ms.cc(1, 64, t - 0.02, 0); ms.cc(1, 64, t + 0.02, 100)
            ms.note(1, low(r, 22) + 12, t, 1.6, 72, hum=0)
            ms.cc(1, 64, t + 1.4, 0)
            std.note(9, 36, t, 0.3, 80, hum=0)
        if tr == 'big' and i > 0:  # 铺垫：一拍半管弦小军鼓滚奏（双手交替、力度起伏、两种采样轮换）与弦乐震音渐强
            b1 = ABEAT[i]; b0 = max(ABEAT[i - 1], b1 - (4 if STYLE in ('title', 'close', 'leader') else 2))
            s0 = max(b0, b1 - 2); k_ = int((b1 - 0.5 - s0) * 6)
            for j in range(k_):
                x_ = j / max(1, k_ - 1)
                orch.note(9, 38 if j % 3 else 40, B(s0 + j / 6), 0.1, 30 + 70 * x_ ** 1.5 + (6 if j % 2 == 0 else -4) + R.uniform(-8, 8), hum=0.005)
            if b1 - b0 >= 1:
                for q in voicing(pcs_of('V'), 72): ms.note(3, q, B(b0), B(b1) - B(b0) - 0.03, 90, hum=0)
                ms.ramp(3, 11, B(b0), B(b1) - 0.05, 20, 127); ms.cc(3, 11, B(b1), 0)
    x = fluid(ms, 'hits_ms', SF_MS, 0.6) + fluid(std, 'hits_std', SF_GU, 0.55) + fluid(orch, 'hits_orch', SF_GU, 0.55)
    # 反向镲只给大落点；关键操作与界面操作用短促的反吸噪声
    cm = Midi(12); cm.prog(9, 0); cm.note(9, 49, 0.1, 6.0, 120, hum=0); cm.note(9, 57, 0.1, 6.0, 110, hum=0)
    cy = fluid(cm, 'cym', SF_GU, 0.6, int(6.5 * SR)); pk = int(np.argmax(np.abs(cy).max(1)))
    rev = cy[pk:][::-1].copy(); rev /= np.abs(rev).max() + 1e-9
    for i, a in enumerate(ANCH):
        if a[2] == 'start': continue
        t = ATIME[i] if a[2] != 'half' else DUR - 0.62; tr = tier(a[1], a[2]) if a[2] != 'half' else 'half'
        gap = t - (ATIME[i - 1] if i > 0 else 0) - 0.2
        if tr in ('big', 'half'):
            L = min(2.2 if tr == 'big' else 3.0, gap, len(rev) / SR)
            if L < 0.3: continue
            seg = rev[-int(L * SR):].copy(); f = int(min(0.3, L / 3) * SR); seg[:f] *= np.linspace(0, 1, f)[:, None]
            place(y, seg, t - len(seg) / SR - 0.01, 0.8)
        elif tr in ('key', 'ui'):
            L = min(0.55 if tr == 'key' else 0.38, gap)
            if L < 0.2: continue
            place(y, riser(L, i), t - L - 0.01, 0.2 if tr == 'key' else 0.11)
    return x + y * (np.abs(x).max() + 1e-9) / (np.abs(y).max() + 1e-9) * 0.5

# ---------------- 音效（真实录音） ----------------
SFX = os.environ.get('ROADSHOW_SFX', os.path.expanduser('~/.local/share/roadshow-video/sfx'))
_c = {}
MISSING = set()
def src(name):
    if name not in _c:
        p = os.path.join(SFX, name + '.wav')
        if os.path.exists(p): _c[name] = load(p)
        else: MISSING.add(name); _c[name] = np.zeros((int(0.3 * SR), 2))
    return _c[name]
def trim(x, thr=0.02):
    e = np.abs(x).max(1); i = np.argmax(e > thr * e.max()); return x[max(0, i - int(0.004 * SR)):]
def fade(x, fo=0.05):
    n = min(len(x), int(fo * SR)); y = x.copy(); y[-n:] *= np.linspace(1, 0, n)[:, None]; return y
def pitch(x, r):
    n = int(len(x) / r); i = np.arange(n) * r
    return np.stack([np.interp(i, np.arange(len(x)), x[:, c]) for c in range(2)], 1)
def norm(x, dbv=-6): return x / (np.abs(x).max() + 1e-9) * db(dbv)
def onsets(x, thr=0.3, gap=0.07):
    e = np.convolve(np.abs(x).max(1), np.ones(96) / 96, 'same'); m = e.max(); idx = []; last = -10 ** 9
    for i in np.where((e[1:-1] > e[:-2]) & (e[1:-1] >= e[2:]) & (e[1:-1] > thr * m))[0] + 1:
        if i - last > gap * SR: idx.append(i); last = i
    return idx
def keystrokes():
    x = src('kbd1729'); ks = []
    for i in onsets(x, 0.25)[:80]:
        seg = x[max(0, i - int(0.005 * SR)):i + int(0.11 * SR)]
        if len(seg) > 1000: ks.append(fade(seg, 0.03))
    return ks
def build_sfx():
    y = np.zeros((N, 2)); r = random.Random(5)
    mouse = norm(fade(trim(src('mouse1742'))[:int(0.25 * SR)]), -4); pad = norm(fade(trim(src('trackpad1738'))[:int(0.25 * SR)]), -4)
    touch = norm(fade(trim(src('touch2038'))), -6)
    sent = norm(trim(src('sent1312')), -8); shutter = norm(trim(src('shutter0448'))[:int(0.9 * SR)], -6)
    whooshes = [norm(trim(src(n)), -6) for n in ('whoosh1795', 'whoosh1796', 'whoosh1797', 'whoosh1799')]
    ks = keystrokes()
    for tp in TL.get('taps', []):
        tgt = tp['target']
        if TL.get('touch'): place(y, pitch(touch, r.uniform(0.96, 1.04)), tp['t'] - 0.01, 0.45)
        else: place(y, pitch(mouse if r.random() < 0.7 else pad, r.uniform(0.97, 1.03)), tp['t'] - 0.012, 0.48)
    for ty in (TL.get('types', []) if ks else []):
        t = ty['t']; end = t + ty['d']
        while t < end:
            place(y, pitch(r.choice(ks), r.uniform(0.95, 1.05)), t, (0.18 if TL.get('touch') else 0.32) * r.uniform(0.75, 1.0))
            t += r.uniform(0.07, 0.15)
    for cu in TL.get('cues', []):
        if cu['kind'] == 'shutter': place(y, shutter, cu['t'], 0.45)
        if cu.get('sfx') == 'sent': place(y, sent, cu['t'] + 0.18, 0.3)  # 发出、提交这类，时间轴里 cue(t, 'key', { sfx: 'sent' })
    for m in TL['cam']:
        if m['d'] >= 1.8: place(y, filt(pitch(r.choice(whooshes), r.uniform(0.6, 0.75)), 150, 4000), m['t'] - 0.05, 0.05)
    for c in TL['cards']:
        if c['kind'] == 'chap':
            place(y, filt(whooshes[0], 120, 9000), c['t'] + 0.05, 0.18)
            place(y, filt(pitch(whooshes[2], 0.8), 150, 7000), c['t'] + c['d'] - 0.1, 0.16)
        elif c['kind'] == 'lower':
            place(y, filt(pitch(whooshes[3], 1.1), 500, 8000), c['t'] - 0.05, 0.05)
        elif c['kind'] == 'float':
            place(y, filt(pitch(whooshes[3], 0.9), 300, 8000), c['t'], 0.12)
    y = filt(y, 120, 9000)
    amb = np.zeros((N, 2))
    if MUSIC.get('ambience'):  # 现场环境声（比如展会人群 crowd3515）：压低并切掉低频，旁白时再让开
        a_ = bell(filt(src(MUSIC['ambience']), 250, 4000), 1800, -7, 0.45)
        a_ = np.vstack([a_] * (N // len(a_) + 1))[:N]
        amb = a_ / (np.sqrt((a_ ** 2).mean()) + 1e-9) * db(-40)
        g = np.ones(N); a = int(MUSIC.get('ambienceFrom', 3.4) * SR); g[:a] = 0; g[a:a + int(3.0 * SR)] = np.linspace(0, 1, int(3.0 * SR)) ** 2
        amb *= g[:, None]
    return conv(y, ROOM) * 0.18 + y, amb

# 各声部按“有声部分”的均方根对齐到目标电平（dBFS），再按风格微调
LEVELS = dict(piano=-19, strings_hi=-22, strings_lo=-22, ost=-23, bass=-21, drums=-19.5, bells=-30, pad=-31, brass=-25, guitar=-23)
LEVELS.update({'brisk': dict(ost=-22), 'lively': dict(drums=-18.5, ost=-22), 'steady': dict(drums=-22.5, piano=-18),
               'leader': dict(strings_hi=-21, brass=-24), 'close': dict(strings_hi=-20, strings_lo=-21, brass=-23, drums=-20.5),
               'title': dict(strings_hi=-20, strings_lo=-20, brass=-24)}.get(STYLE, {}))
def stem(name, x, lo=None, hi=None, rev=0.3, wid=0.0, eq=None):
    if not np.abs(x).max() > 1e-6: return np.zeros((N, 2))
    if lo or hi: x = filt(x, lo, hi)
    for e in (eq or []): x = bell(x, *e)
    if wid: x = width(x, 9, wid)
    if rev: x = x + conv(x, HALL) * rev
    x = x * db(LEVELS[name]) / arms(x) if name in LEVELS else x
    write(os.path.join(ST, name + '.wav'), x); return x
def lufs(p):
    s = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
    a = s.rindex('{'); b = s.index('}', a); return json.loads(s[a:b + 1])
def comp_gain(x, thr, ratio, att, rel):
    lvl = np.sqrt(np.convolve((x ** 2).mean(1), np.ones(480) / 480, 'same')) + 1e-9
    over = np.maximum(0, 20 * np.log10(lvl) - thr); return 10 ** (smooth(-over * (1 - 1 / ratio), att, rel) / 20)
def deess(x, lo=5200, hi=9500, ratio=3.0):  # 齿音段超过平时 4 dB 的部分按 3:1 压
    band = filt(x, lo, hi, 2)
    lvl = np.sqrt(np.convolve((band ** 2).mean(1), np.ones(240) / 240, 'same')) + 1e-9
    act = lvl > lvl.max() * 0.01
    thr = 20 * np.log10(np.sqrt((lvl[act] ** 2).mean())) + 4 if act.any() else 0
    over = np.maximum(0, 20 * np.log10(lvl) - thr); g = 10 ** (smooth(-over * (1 - 1 / ratio), 0.002, 0.06) / 20)
    return x + band * (g - 1)[:, None]
def endfade(xs):  # 段尾按余弦曲线淡出，留住混响尾音
    if STYLE == 'title': return
    if fo: a = fo[-1]['t'] - 0.2; b = fo[-1]['t'] + fo[-1]['d'] + 0.6
    else: a = TL['dur'] - 1.4; b = TL['dur'] + 0.1
    ia, ib = int(a * SR), min(N, int(b * SR)); c = np.cos(np.linspace(0, np.pi / 2, ib - ia))
    for x in xs: x[ia:ib] *= c[:, None]; x[ib:] = 0

def report():
    print(NAME, STYLE, 'bpm', BPM0, 'key', KEY, 'bars', len(BARS), flush=True)
    for i, a in enumerate(ANCH):
        tp = CHOICE[i][2] if i < len(CHOICE) else TEMPO_END
        print(f'  {a[0]:7.2f}  L{a[1]} {a[2]:<8} {tier(a[1], a[2]):<4} beat {ABEAT[i]:4d}  → {tp:6.1f} bpm', flush=True)

def main():
    report()
    lo = (stem('strings_lo', part_strings(False), 30, 9000, 0.45, 0.3) + stem('bass', part_bass(), 30, 5000, 0.08)
          + stem('drums', part_drums(), 30, 15000, 0.16, 0.2) + stem('pad', part_pad(), 80, 8000, 0.4, 0.4)
          + stem('guitar', part_guitar(), 110, 3200, 0.22, 0.3))
    hi = (stem('piano', part_piano(), 60, 8500, 0.32, 0.2) + stem('strings_hi', part_strings(True), 120, 12000, 0.5, 0.35)
          + stem('ost', part_ost(), 60, 11000, 0.3, 0.25) + stem('bells', part_bells(), 200, 14000, 0.6, 0.3)
          + stem('brass', part_brass(), 70, 9000, 0.45, 0.2))
    g = comp_gain(lo + hi, -16, 2.0, 0.03, 0.3)[:, None]
    tone = lambda x: bell(bell(bell(x, 2800, -3.5, 0.7), 90, 2.5, 0.5), 6500, -2.0, 0.6)  # 低频托厚、高频松开
    lo = tone(lo * g); hi = tone(hi * g)
    sc = db(-27) / (np.sqrt(((lo + hi) ** 2).mean()) + 1e-9); lo *= sc; hi *= sc
    hits = part_hits(); hits = filt(hits, 25, 16000)
    hits = hits + conv(hits, HALL if STYLE != 'close' else hall(4.5, 7, 2600, 0.03)) * 0.35  # 片尾落点用更长的混响收
    write(os.path.join(ST, 'hits.wav'), hits / (np.abs(hits).max() + 1e-9) * 0.9)
    hits = hits / (arms(hits) + 1e-9) * arms(lo + hi)
    fi = int(0.3 * SR)
    for x in (lo, hi): x[:fi] *= np.linspace(0, 1, fi)[:, None]
    endfade((lo, hi, hits))
    music = lo + hi + hits
    write(os.path.join(D, f'music_{NAME}.wav'), music / max(1.0, np.abs(music).max() / 0.95))

    vo = np.zeros((N, 2))
    for v in TL['vo']:
        p = next((os.path.join(D, 'vo', v['id'] + e) for e in ('.wav', '.mp3') if os.path.exists(os.path.join(D, 'vo', v['id'] + e))), None)
        if p: place(vo, load(p), v['t'])
        else: print('缺配音音频', v['id'], flush=True)
    vo = deess(bell(bell(filt(vo, 80, None), 3500, 1.5, 0.8), 220, -1.0, 1.0))
    vo = vo * comp_gain(vo, -24, 4.0, 0.003, 0.08)[:, None]      # 快压：削掉字头
    vo = vo * comp_gain(vo, -26, 2.5, 0.012, 0.45)[:, None]      # 慢压：把密度托起来
    e = np.zeros(N)
    for a, b in VO_SPANS: e[int(max(0, a - 0.15) * SR):int((b + 0.15) * SR)] = 1
    env = smooth(e, 0.3, 0.7)[:, None]
    act = np.abs(vo).sum(1) > 1e-3
    vo_n = vo / (np.sqrt((vo[act] ** 2).mean()) + 1e-9) * db(-20) if act.any() else vo
    bed = lo * db(-8.0 * env) + hi * db(-13.0 * env)
    bed = bed + filt(bed, 800, 3000) * (db(-3.0 * env) - 1)          # 人声清晰度频段再让 3 dB
    sfx, amb = build_sfx()
    stems = {'vo': vo_n, 'music': bed + hits * db(-6.0 * env), 'sfx': sfx * db(-5) + amb * db(-9.0 * env)}
    mix = stems['vo'] + stems['music'] + stems['sfx']
    s1 = 1 / max(1.0, np.abs(mix).max() / 0.95)
    raw = os.path.join(D, f'mix_{NAME}_raw.wav'); write(raw, mix * s1)
    j = lufs(raw)
    af = f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true"
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af', af, '-ar', str(SR), os.path.join(D, f'mix_{NAME}.wav')], check=True)
    os.remove(raw)
    # 剪辑用分轨：旁白、配乐（含避让与打击）、音效，乘上和成品一样的增益，三轨相加约等于成品
    # 响度处理在峰值高时不是单一增益，按 50 毫秒一格量出成品相对原混音的实际增益，乘到三条分轨上
    fin = load(os.path.join(D, f'mix_{NAME}.wav')); n = min(len(fin), len(mix)); hop = 2400; k = n // hop
    ra = np.sqrt(((mix[:k * hop] * s1).mean(1).reshape(k, hop) ** 2).mean(1)); rb = np.sqrt((fin[:k * hop].mean(1).reshape(k, hop) ** 2).mean(1))
    ok = ra > 1e-4; g0 = float(np.median(rb[ok] / ra[ok])) if ok.any() else 1.0
    g = np.interp(np.arange(len(mix)), (np.arange(k) + 0.5) * hop, np.clip(np.where(ok, rb / np.maximum(ra, 1e-9), g0), g0 / 4, g0 * 4))
    for key, x in stems.items(): write(os.path.join(ST, f'mix_{key}.wav'), x * s1 * g[:, None])
    # 记下这次用的时间轴和配音，交付检查拿它判断混音是不是最新的
    h = lambda p: hashlib.sha1(open(p, 'rb').read()).hexdigest()[:16]
    vos = {v['id']: h(p) for v in TL['vo'] for p in [os.path.join(D, 'vo', v['id'] + e) for e in ('.wav', '.mp3')] if os.path.exists(p)}
    json.dump({'tl': h(os.path.join(D, f'tl_{NAME}.json')), 'vo': vos, 'style': STYLE}, open(os.path.join(D, f'mix_{NAME}.json'), 'w'), ensure_ascii=False, indent=1)
    print('mix', NAME, j['input_i'], 'LUFS in', flush=True)
    if MISSING: print('缺这些音效，已跳过：', '、'.join(sorted(MISSING)), '（按问题库 Q5.2 下载，或用 ROADSHOW_SFX 指向音效目录）', flush=True)

if __name__ == '__main__':
    if '--plan' in sys.argv: report()
    else: main()
