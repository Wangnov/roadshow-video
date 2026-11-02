#!/usr/bin/env python3
"""配乐（管弦铺底族，轻柔政务风）：python3 audio/score_orch.py s1
按时间轴自动编曲：小节线从 0.35 秒起（82 BPM，D 大调），模块切换处换乐段（左下角模块名出现的时刻对齐到最近的强拍），
乐段之间轮换四种和声与配器（钢琴琶音、拨弦推进、轻心跳鼓、弦乐抬高八度），段尾淡出处落 Dmaj9。
FluidSynth + GeneralUser GS 渲染钢琴、弦乐铺底、大提琴与低音提琴、竖琴与钢片琴、定音鼓；numpy 合成拨弦、低频、轻打击、上扬与重音。
关键操作（时间轴里 cue(t, 'key')）给钢片琴两个音加一记轻低频。旁白段配乐闪避 7 dB，总响度 -16 LUFS。
和 score.py（流行商务族）二选一，一部片子各段用同一个脚本；风格怎么挑见 references/配乐风格库.md。
输入：audio/tl_<段>.json（build/export_tl.mjs 导出）、audio/vo/index.json 与 audio/vo/<id>.wav|.mp3
输出：audio/music_<段>.wav、audio/mix_<段>.wav（-16 LUFS）、audio/stems_<段>/（分轨；mix_vo、mix_music、mix_sfx 三轨是成品拆开的样子，剪辑用）、
      audio/mix_<段>.json（这次用的时间轴与配音的指纹，交付检查用）"""
import hashlib, json, os, struct, subprocess, sys, random
import numpy as np

D = os.path.dirname(os.path.abspath(__file__))
# 音色库：先找 ROADSHOW_SOUNDFONTS（默认 ~/.local/share/soundfonts），再找工程里的 audio/sf/
SFDIR = os.environ.get('ROADSHOW_SOUNDFONTS', os.path.expanduser('~/.local/share/soundfonts'))
def _sf(name):
    for d in (SFDIR, os.path.join(D, 'sf')):
        p = os.path.join(d, name)
        if os.path.exists(p): return p
    raise SystemExit(f'找不到音色库 {name}：按问题库 Q5.1 安装，或用 ROADSHOW_SOUNDFONTS 指向它所在的目录')
SF = _sf('GeneralUser-GS.sf2')
NAME = next((a for a in sys.argv[1:] if not a.startswith('--')), 's1')
ST = os.path.join(D, f'stems_{NAME}')
os.makedirs(ST, exist_ok=True)
SR = 48000
TL = json.load(open(os.path.join(D, f'tl_{NAME}.json')))
VOI = json.load(open(os.path.join(D, 'vo', 'index.json')))
DUR = TL['dur'] + 0.6
N = int(DUR * SR)
BPM = 82.0
BEAT = 60 / BPM
BAR = 4 * BEAT
O = 0.35
NB = int((DUR - O) / BAR) + 1
def bt(bar, beat=0.0): return O + (bar + beat / 4) * BAR
def snap(t): return max(0, int(round((t - O) / BAR)))
rng = np.random.default_rng(7)
R = random.Random(11 + sum(map(ord, NAME)))

# ---------------- 和声 ----------------
V = {
    'D': ([50, 57, 62, 64, 66], 38), 'Dmaj9': ([50, 57, 61, 64, 66], 38), 'A/C#': ([52, 57, 61, 64, 69], 37),
    'Bm7': ([50, 54, 57, 62, 66], 35), 'Gmaj7': ([50, 54, 59, 62, 67], 31), 'G': ([50, 55, 59, 62, 67], 31),
    'D/F#': ([50, 57, 62, 64, 66], 42), 'Em7': ([50, 55, 59, 62, 67], 40), 'Asus': ([52, 57, 62, 64, 69], 33),
    'A': ([52, 57, 61, 64, 69], 33), 'F#m7': ([49, 52, 57, 61, 64], 42),
}
PROGS = {
    'A': ['D', 'A/C#', 'Bm7', 'Gmaj7'],
    'B': ['G', 'D/F#', 'Em7', 'A'],
    'C': ['Bm7', 'Gmaj7', 'D', 'A'],
    'D': ['Gmaj7', 'F#m7', 'Em7', 'Asus'],
}
# 乐段：(起始小节, 类型)；类型决定和声与配器
starts = {0}
for c in TL['cards']:
    if c['kind'] in ('lower',):
        starts.add(snap(c['t'] + 0.2))
# 收尾：段尾黑场淡出开始的那个小节落主和弦，前一小节做终止式；没有淡出就留最后三小节
FEND = TL['fades'][-1] if TL.get('fades') and TL['fades'][-1]['to'] == 1 else None
OUTRO = max(1, snap(FEND['t']) - 1) if FEND else NB - 3
KEYS = [c for c in TL.get('cues', []) if c['kind'] == 'key']
starts = sorted(b for b in starts if b < OUTRO - 1)
# 太长的乐段每 8 小节再分一次，保持变化
segs = []
for i, b in enumerate(starts):
    e = starts[i + 1] if i + 1 < len(starts) else OUTRO
    k = b
    while e - k > 10:
        segs.append((k, k + 8)); k += 8
    segs.append((k, e))
CYCLE = ['A', 'B', 'C', 'D', 'B', 'C', 'A', 'D']
TITLE = any(c['kind'] == 'title' for c in TL['cards'])
PLAN = {}  # bar -> dict(ch=[...], kind, layers, i)
for si, (b0, b1) in enumerate(segs):
    kind = 'A' if si == 0 else CYCLE[si % len(CYCLE)]
    prog = PROGS[kind]
    n = b1 - b0
    for j in range(n):
        bar = b0 + j
        ch = [prog[j % 4]]
        if j == n - 1 and n >= 4:  # 乐段尾小节做终止式，回到下一段
            ch = ['Em7', 'Asus'] if kind != 'D' else ['Asus', 'A']
        dens = 0 if si == 0 else (1 if kind in ('A', 'D') else 2)
        if j < 1 and si > 0: dens = max(0, dens - 1)
        PLAN[bar] = dict(ch=ch, kind=kind, dens=dens, first=(j == 0), si=si, melody=(kind in ('C', 'D') and j % 2 == 0 and j < n - 1))
for bar in range(OUTRO, NB + 1):
    k = bar - OUTRO
    PLAN[bar] = dict(ch=(['G', 'Asus'] if k == 0 else ['Dmaj9']), kind='E', dens=0, first=(k == 0), si=99, melody=False, outro=k)
def chords(bar):
    cs = PLAN.get(bar, {'ch': ['Dmaj9']})['ch']
    return [(0, 4, cs[0])] if len(cs) == 1 else [(0, 2, cs[0]), (2, 2, cs[1])]

# ---------------- MIDI ----------------
PPQ = 480
class Midi:
    def __init__(s, seed=7): s.ev = []; s.r = random.Random(seed)
    def tk(s, sec): return int(round(max(0, sec) / BEAT * PPQ))
    def note(s, ch, p, t, d, v, hum=0.008):
        if t >= DUR: return
        j = s.r.uniform(-hum, hum) if t > 0.05 else 0
        v = max(1, min(127, int(v + s.r.uniform(-3, 3))))
        s.ev.append((s.tk(t + j), 1, ch, p, v)); s.ev.append((s.tk(t + j + d), 0, ch, p, 0))
    def cc(s, ch, c, t, v): s.ev.append((s.tk(t), 2, ch, c, int(max(0, min(127, v)))))
    def ramp(s, ch, c, t0, t1, v0, v1, step=0.1):
        t = t0
        while t <= t1 + 1e-6:
            s.cc(ch, c, t, v0 + (v1 - v0) * (t - t0) / max(1e-6, t1 - t0)); t += step
    def prog(s, ch, p): s.ev.append((0, 3, ch, p, 0))
    def write(s, path):
        evs = sorted(s.ev, key=lambda e: (e[0], {3: -2, 2: -1, 0: 0, 1: 1}[e[1]]))
        tr = bytearray(); last = 0
        def vl(n):
            b = [n & 0x7f]; n >>= 7
            while n: b.append((n & 0x7f) | 0x80); n >>= 7
            return bytes(reversed(b))
        tr += vl(0) + b'\xff\x51\x03' + int(60e6 / BPM).to_bytes(3, 'big')
        for (t, k, ch, a, b) in evs:
            tr += vl(t - last); last = t
            tr += bytes([0x90 | ch, a, b]) if k == 1 else bytes([0x80 | ch, a, 0]) if k == 0 else bytes([0xB0 | ch, a, b]) if k == 2 else bytes([0xC0 | ch, a])
        tr += vl(0) + b'\xff\x2f\x00'
        open(path, 'wb').write(b'MThd' + struct.pack('>IHHH', 6, 0, 1, PPQ) + b'MTrk' + struct.pack('>I', len(tr)) + bytes(tr))
def load(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, '<f4').astype(np.float64).reshape(-1, 2)
def fit(x, n=N):
    if len(x) < n: x = np.vstack([x, np.zeros((n - len(x), 2))])
    return x[:n].copy()
def fluid(m, name, gain=0.6):
    mid = os.path.join(ST, name + '.mid'); wav = os.path.join(ST, name + '_dry.wav')
    m.write(mid)
    subprocess.run(['fluidsynth', '-ni', '-q', '-g', str(gain), '-r', str(SR), '-R', '0', '-C', '0', '-F', wav, SF, mid], check=True, capture_output=True)
    x = fit(load(wav)); os.remove(wav); return x

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
def hall(sec=3.4, seed=3, damp=1800, pre=0.022):
    r = np.random.default_rng(seed); n = int(sec * SR); t = np.arange(n) / SR; ir = np.zeros((n, 2))
    for c in range(2):
        x = r.standard_normal(n); X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / SR)
        dark = np.fft.irfft(X / (1 + (f / damp) ** 2), n); bright = np.fft.irfft(X / (1 + (f / 7000) ** 2), n)
        k = np.exp(-t * 1.3); ir[:, c] = (bright * k + dark * (1 - k)) * np.exp(-t * 1.9)
    p = int(pre * SR); ir = np.vstack([np.zeros((p, 2)), ir])[:n]
    ir[p:p + int(.02 * SR)] *= np.linspace(0, 1, int(.02 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum() / 2)
HALL = hall(); ROOM = hall(1.2, 5, 3000, .008)
def delay(x, sec, fb=0.3, mix=0.3):
    d = int(sec * SR); y = x.copy(); tap = x.copy()
    for k in range(1, 7):
        tap = np.vstack([np.zeros((d, 2)), tap[:-d]]) * fb
        tap = filt(tap[:, ::-1], 200, 5000, 1)
        y += tap * mix / fb
    return y
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
def place(buf, x, t, g=1.0):
    i = int(t * SR)
    if x.ndim == 1: x = np.stack([x, x], 1)
    if i < 0: x = x[-i:]; i = 0
    n = min(len(x), len(buf) - i)
    if n > 0: buf[i:i + n] += x[:n] * g
def write(p, x):
    x = np.clip(x, -1, 1); data = (x * 32767).astype('<i2').tobytes()
    with open(p, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 2, SR, SR * 4, 4, 16) + b'data' + struct.pack('<I', len(data)) + data)
NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
def mp(s):
    n = NOTE[s[0]]; i = 1
    if s[1] == '#': n += 1; i = 2
    return 12 * (int(s[i:]) + 1) + n

# ---------------- 声部 ----------------
def part_pad():
    m = Midi(1); m.prog(0, 89); m.prog(1, 49); m.cc(0, 7, 0, 100); m.cc(1, 7, 0, 92); m.cc(1, 11, 0, 30)
    for bar in range(0, NB + 1):
        p = PLAN.get(bar, {})
        for b0, bd, c in chords(bar):
            up, _ = V[c]; t = bt(bar, b0); d = bd * BEAT + 0.15
            lvl = 0.55 + 0.08 * p.get('dens', 0)
            for q in up[:4]: m.note(0, q, t, d, int(70 * lvl + 18))
            if bar >= (1 if not TITLE else 2):
                for q in up[1:]: m.note(1, q + (12 if p.get('kind') == 'C' else 0), t, d, int(60 * lvl + 18))
        if p.get('first'): m.ramp(1, 11, bt(bar) - 0.2, bt(bar) + 2.5, 60, 96)
    m.ramp(0, 11, 0, bt(1, 3), 25, 100, 0.08); m.ramp(1, 11, bt(1), bt(2), 30, 92)
    m.ramp(0, 11, bt(OUTRO + 1), DUR, 100, 0); m.ramp(1, 11, bt(OUTRO + 1), DUR, 96, 0)
    return fluid(m, 'pad', 0.55)
def part_piano():
    m = Midi(2); m.prog(0, 0); m.cc(0, 7, 0, 108)
    m.note(0, mp('D5'), max(0.05, bt(0) - 0.2), 3.0, 50); m.note(0, mp('A4'), bt(0, 2), 2.0, 38)
    for q in [62, 66, 69, 74]: m.note(0, q, bt(1), 2.6, 36)
    for bar in range(2, NB + 1):
        p = PLAN.get(bar, {})
        if p.get('kind') == 'E':
            if p.get('outro') == 0:
                for b0, bd, c in chords(bar):
                    up, bass = V[c]
                    for q in [bass + 12] + up[1:]: m.note(0, q + 12 if q > 60 else q, bt(bar, b0), bd * BEAT, 48)
            elif p.get('outro') == 1:
                for k, q in enumerate([50, 57, 61, 66, 69, 73, 76, 78]): m.note(0, q, bt(bar) + k * 0.11, 5.0, 52 - k * 2)
            continue
        base = 40 + 3 * p.get('dens', 0)
        for b0, bd, c in chords(bar):
            up, bass = V[c]; t = bt(bar, b0)
            m.note(0, bass + 12, t, bd * BEAT * 0.95, base + 4)
            arp = [up[1], up[3], up[4], up[3]]
            steps = [0.5, 1.0, 1.5, 2.5, 3.0] if bd == 4 else [0.5, 1.0, 1.5]
            if p.get('kind') == 'B': steps = [0.5, 1.5, 2.0, 3.0, 3.5] if bd == 4 else [0.5, 1.5]
            for k, s_ in enumerate(steps):
                m.note(0, arp[k % 4] + 12, t + s_ * BEAT, 1.1 * BEAT, base - 6 + (4 if k == 0 else 0))
        if p.get('melody'):
            up, _ = V[chords(bar)[0][2]]
            tones = sorted(set([q + 12 for q in up[1:]] + [q + 24 for q in up[1:3]]))
            pat = R.choice([[(0, 2), (2, 1), (3, 1)], [(0, 3), (3, 1)], [(0, 1.5), (1.5, 0.5), (2, 2)], [(0, 2), (2, 2)]])
            idx = R.randrange(1, len(tones) - 1)
            for (bb, dd) in pat:
                idx = max(0, min(len(tones) - 1, idx + R.choice([-1, 0, 1, 1])))
                m.note(0, tones[idx], bt(bar, bb), dd * BEAT * 0.98, 50)
        m.cc(0, 64, bt(bar) - 0.02, 0); m.cc(0, 64, bt(bar) + 0.03, 100)
    m.cc(0, 64, DUR - 0.1, 0)
    return fluid(m, 'piano', 0.6)
def part_low():
    m = Midi(3); m.prog(0, 42); m.prog(1, 43); m.cc(0, 7, 0, 96); m.cc(1, 7, 0, 88)
    for bar in range(2 if TITLE else 1, NB + 1):
        p = PLAN.get(bar, {})
        for b0, bd, c in chords(bar):
            _, bass = V[c]; t = bt(bar, b0)
            m.note(0, bass + 12 if bass < 36 else bass, t, bd * BEAT + 0.1, 58 + 6 * p.get('dens', 0))
            if p.get('dens', 0) >= 1: m.note(1, bass, t, bd * BEAT + 0.1, 58)
    m.ramp(0, 11, bt(1), bt(3), 40, 100); m.ramp(0, 11, bt(OUTRO + 1), DUR, 100, 0); m.ramp(1, 11, bt(OUTRO + 1), DUR, 100, 0)
    return fluid(m, 'low', 0.55)
def part_color():
    m = Midi(4); m.prog(0, 46); m.prog(1, 8); m.cc(0, 7, 0, 90); m.cc(1, 7, 0, 82)
    for c in TL['cards']:
        if c['kind'] == 'title':
            for i, q in enumerate(['A5', 'D6', 'E6', 'F#6']): m.note(1, mp(q), c['t'] + 1.9 + i * 0.28, 1.6, 50)
        if c['kind'] == 'chap':
            for i, q in enumerate([50, 54, 57, 62, 64, 66, 69, 74, 76, 78]): m.note(0, q, c['t'] + 0.25 + i * 0.06, 1.4, 40 + i * 3)
        if c['kind'] == 'lower':
            t = bt(snap(c['t'] + 0.2))
            m.note(1, mp('A5'), t, 1.4, 40); m.note(1, mp('E6'), t + 0.35, 1.4, 36)
    for c in KEYS:  # 关键操作：钢片琴两个音，轻轻点一下
        m.note(1, mp('F#6'), c['t'], 1.2, 38); m.note(1, mp('A6'), c['t'] + 0.18, 1.2, 32)
    for i, q in enumerate([62, 66, 69, 73, 74, 78, 81, 85]): m.note(0, q, bt(OUTRO + 1) + i * 0.09, 2.5, 46)
    for i, q in enumerate(['A5', 'C#6', 'F#6']): m.note(1, mp(q), bt(OUTRO + 1) + 0.4 + i * 0.35, 2.0, 44)
    return fluid(m, 'color', 0.55)
def part_timp():
    m = Midi(5); m.prog(0, 47); m.cc(0, 7, 0, 100)
    for c in TL['cards']:
        if c['kind'] in ('chap', 'title'): m.note(0, mp('D2'), c['t'] + 0.3, 2.5, 72); m.note(0, mp('A1'), c['t'] + 0.32, 2.5, 50)
    return fluid(m, 'timp', 0.55)
def ks(freq, dur):
    n = int(dur * SR); p = int(SR / freq); buf = rng.uniform(-1, 1, p); out = np.zeros(n)
    buf = np.convolve(buf, [0.5, 0.5], 'same')
    for i in range(n):
        out[i] = buf[i % p]; buf[i % p] = 0.996 * 0.5 * (buf[i % p] + buf[(i + 1) % p])
    return out * np.minimum(1, np.arange(n) / (0.002 * SR)) * np.exp(-np.arange(n) / SR * 3.2)
def part_pluck():
    y = np.zeros((N, 2)); cache = {}
    for bar in range(NB):
        p = PLAN.get(bar, {})
        if p.get('dens', 0) < 2 or p.get('kind') == 'E': continue
        for b0, bd, c in chords(bar):
            up, _ = V[c]; pat = [up[0] + 12, up[2] + 12, up[3] + 12, up[2] + 12, up[1] + 12, up[2] + 12, up[4] + 12, up[2] + 12]
            for k in range(int(bd * 2)):
                q = pat[(int(b0 * 2) + k) % 8]
                if q not in cache: cache[q] = ks(440 * 2 ** ((q - 69) / 12), 0.9)
                pan = -0.35 if k % 2 == 0 else 0.35; x = cache[q] * (1.0 if k % 2 == 0 else 0.7) * 0.6
                place(y, np.stack([x * np.sqrt((1 - pan) / 2), x * np.sqrt((1 + pan) / 2)], 1) * 1.4, bt(bar, b0 + k * 0.5))
    return delay(filt(y, 250, 6000), BEAT * 0.75)
def part_sub():
    y = np.zeros(N)
    for bar in range(NB):
        p = PLAN.get(bar, {})
        if p.get('dens', 0) < 1: continue
        for b0, bd, c in chords(bar):
            _, bass = V[c]; f = 440 * 2 ** ((bass - 69 - (12 if bass >= 36 else 0)) / 12)
            a = int(bt(bar, b0) * SR); n = int(bd * BEAT * SR); t = np.arange(n) / SR
            env = np.minimum(1, t / 0.05) * np.minimum(1, (n / SR - t) / 0.08)
            seg = np.sin(2 * np.pi * f * t) * env * 0.5
            y[a:a + n] += seg[:max(0, min(n, N - a))]
    return np.stack([y, y], 1)
def kick():
    n = int(0.45 * SR); t = np.arange(n) / SR; f = 46 + 70 * np.exp(-t * 28)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5) + 0.12 * rng.standard_normal(n) * np.exp(-t * 120)
    return filt(np.stack([x, x], 1), None, 900)
def shaker():
    n = int(0.09 * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n) * np.minimum(1, t / 0.012) * np.exp(-t * 55)
    return filt(np.stack([x, x * 0.9], 1), 5000, 12000)
def part_perc():
    y = np.zeros((N, 2)); k = kick(); sh = shaker()
    for bar in range(NB):
        p = PLAN.get(bar, {})
        if p.get('dens', 0) < 2 or p.get('kind') == 'E': continue
        for b in (0, 2): place(y, k, bt(bar, b), 0.6)
        if p.get('kind') == 'C':
            for s_ in range(16): place(y, sh, bt(bar, s_ * 0.25), 0.15 if s_ % 2 else 0.09)
    return y
def revcym(t_end, dur=1.6, g=0.35):
    n = int(dur * SR); t = np.arange(n) / SR
    x = filt(rng.standard_normal((n, 2)), 3000, 14000) * np.exp(-t * 2.8)[:, None]
    return x[::-1] * g, t_end - dur
def boom():
    n = int(3.0 * SR); t = np.arange(n) / SR; f = 34 + 60 * np.exp(-t * 9)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6) + filt(rng.standard_normal((n, 1)), 40, 400)[:, 0] * np.exp(-t * 6) * 0.25
    return np.stack([x, x], 1) * 0.9

# ---------------- 音效 ----------------
SFX = os.environ.get('ROADSHOW_SFX', os.path.expanduser('~/.local/share/roadshow-video/sfx'))
MISSING = set()
def src(name):
    p = os.path.join(SFX, name + '.wav')
    if os.path.exists(p): return load(p)
    MISSING.add(name); return np.zeros((int(0.3 * SR), 2))
def onsets(x, thr=0.25, gap=0.07):
    e = np.convolve(np.abs(x).max(1), np.ones(96) / 96, 'same'); m = e.max(); idx = []; last = -10 ** 9
    for i in np.where((e[1:-1] > e[:-2]) & (e[1:-1] >= e[2:]) & (e[1:-1] > thr * m))[0] + 1:
        if i - last > gap * SR: idx.append(i); last = i
    return idx
def keystrokes():
    x = src('kbd1729'); ks = []
    if not np.abs(x).max(): return ks
    for i in onsets(x)[:80]:
        seg = x[max(0, i - int(0.005 * SR)):i + int(0.11 * SR)].copy()
        if len(seg) > 1000:
            n = int(0.03 * SR); seg[-n:] *= np.linspace(1, 0, n)[:, None]; ks.append(seg)
    return ks
def stretch(x, r):
    n = int(len(x) / r); i = np.arange(n) * r
    return np.stack([np.interp(i, np.arange(len(x)), x[:, c]) for c in range(2)], 1)
def click():
    n = int(0.03 * SR); t = np.arange(n) / SR
    a = rng.standard_normal(n) * np.exp(-t * 900) * 0.6 + np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 600) * 0.4
    b = rng.standard_normal(n) * np.exp(-t * 1100) * 0.4 + np.sin(2 * np.pi * 3100 * t) * np.exp(-t * 700) * 0.3
    y = np.zeros((int(0.12 * SR), 2)); place(y, filt(np.stack([a, a], 1), 1200, 9000), 0); place(y, filt(np.stack([b, b], 1), 1500, 9000), 0.085)
    return y
def tick(f0=1760):
    n = int(0.5 * SR); t = np.arange(n) / SR
    x = (np.sin(2 * np.pi * f0 * t) + 0.35 * np.sin(2 * np.pi * f0 * 2.01 * t)) * np.exp(-t * 9) * np.minimum(1, t / 0.002)
    return np.stack([x, x], 1) * 0.5
def swish(dur=0.45, lo=600, hi=5000):
    n = int(dur * SR); t = np.arange(n) / SR; k = t / dur
    x = rng.standard_normal((n, 2)); out = np.zeros_like(x); seg = int(0.03 * SR)
    for i in range(0, n, seg):
        c = lo + (hi - lo) * np.sin(np.pi * k[i]) ** 2
        out[i:i + seg] = filt(x[i:i + seg], c * 0.6, c * 1.4, 1)
    return out * (np.sin(np.pi * k) ** 1.5)[:, None] * 0.5
def build_sfx():
    y = np.zeros((N, 2)); w1, w2, w3 = src('whoosh1795'), src('whoosh1796'), src('whoosh1797')
    ck = click(); sw = swish(0.5, 900, 4200)
    for c in TL.get('taps', []): place(y, ck, c['t'], 0.42)
    for i, c in enumerate(TL.get('callouts', [])): place(y, tick(1568 if i % 2 == 0 else 1760), c['t'], 0.07)
    for f in TL.get('focus', []): place(y, sw, f - 0.05, 0.045)
    ks = keystrokes(); r = random.Random(5)
    for ty in (TL.get('types', []) if ks else []):
        t = ty['t']; end = t + ty['d']
        while t < end:
            place(y, stretch(r.choice(ks), r.uniform(0.95, 1.05)), t, (0.18 if TL.get('touch') else 0.32) * r.uniform(0.75, 1.0)); t += r.uniform(0.07, 0.15)
    sent = src('sent1312')
    for c in KEYS:  # 发出、提交这类，时间轴里 cue(t, 'key', { sfx: 'sent' })
        if c.get('sfx') == 'sent': place(y, sent / (np.abs(sent).max() + 1e-9) * db(-8), c['t'] + 0.18, 0.3)
    w2s = filt(stretch(w2, 0.55), 150, 3500)
    for m in TL['cam']:
        if m['d'] >= 1.4: place(y, w2s, m['t'] - 0.05, 0.05)
    for c in TL['cards']:
        if c['kind'] == 'chap':
            place(y, filt(w1, 120, 8000), c['t'] + 0.05, 0.2)
            place(y, filt(stretch(w3, 0.8), 150, 6000), c['t'] + c['d'] - 0.1, 0.16)
        elif c['kind'] == 'title':
            place(y, filt(stretch(w1, 0.6), 100, 5000), c['t'] + c['d'] - 0.2, 0.14)
        elif c['kind'] == 'lower':
            place(y, filt(stretch(w3, 1.1), 400, 7000), c['t'] - 0.05, 0.06)
    return conv(y, ROOM) * 0.25 + y

def stem(name, x, gain_db, lo=None, hi=None, rev=0.3, wid=0.0, eq=None):
    if lo or hi: x = filt(x, lo, hi)
    for e in (eq or []): x = bell(x, *e)
    if wid: x = width(x, 9, wid)
    if rev: x = x + conv(x, HALL) * rev
    x = x * db(gain_db); write(os.path.join(ST, name + '.wav'), x); return x
def lufs(p):
    s = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
    a = s.rindex('{'); b = s.index('}', a); return json.loads(s[a:b + 1])

def main():
    print(NAME, 'bars', NB, 'segs', segs, 'outro', OUTRO, flush=True)
    music = (stem('pad', part_pad(), -3, 60, 6000, 0.55, 0.3) + stem('piano', part_piano(), -2, 70, 7500, 0.45, 0.25, [(3000, -2.0, 0.8)])
             + stem('low', part_low(), -5, 40, 3500, 0.35) + stem('color', part_color(), -6, 200, 12000, 0.7)
             + stem('timp', part_timp(), -5, 30, 5000, 0.6) + stem('pluck', part_pluck(), -12, None, None, 0.25)
             + stem('sub', part_sub(), -25, None, 140, 0) + stem('perc', part_perc(), -18, None, None, 0.12))
    fx = np.zeros((N, 2))
    for c in TL['cards']:
        if c['kind'] == 'chap': place(fx, boom(), c['t'] + 0.3, 0.35)
        if c['kind'] == 'title':
            r, t = revcym(c['t'] + 1.0, 1.4); place(fx, r, max(0, t))
        if c['kind'] == 'lower':
            r, t = revcym(bt(snap(c['t'] + 0.2)), 1.2, 0.18); place(fx, r, t)
    for c in KEYS: place(fx, boom(), c['t'], 0.12)
    music += stem('fx', fx, -6, 25, None, 0.4)
    music = comp(music, -16, 2.0, 0.03, 0.3)
    music = bell(music, 2500, -3.0, 0.7)
    music = music / (np.abs(music).max() + 1e-9) * 0.7
    tt = np.arange(N) / SR
    for c in TL['cards']:  # 片头没有旁白时配乐抬起
        if c['kind'] == 'title': music *= db(6.0 * np.clip((c['t'] + c['d'] - tt) / 1.2, 0, 1))[:, None]
    fi = int(0.6 * SR); music[:fi] *= np.linspace(0, 1, fi)[:, None]
    if FEND:
        a = int(FEND['t'] * SR); b = min(N, int((FEND['t'] + FEND['d'] + 0.4) * SR)); music[a:b] *= np.linspace(1, 0, b - a)[:, None]; music[b:] = 0
    write(os.path.join(D, f'music_{NAME}.wav'), music)

    vo = np.zeros((N, 2)); spans = []
    for v in TL['vo']:
        p = next((os.path.join(D, 'vo', v['id'] + e) for e in ('.wav', '.mp3') if os.path.exists(os.path.join(D, 'vo', v['id'] + e))), None)
        if p: place(vo, load(p), v['t'])
        else: print('缺配音音频', v['id'], flush=True)
        spans.append((v['t'], v['t'] + VOI.get(v['id'], {}).get('dur', 0)))
    vo = comp(bell(bell(filt(vo, 80, None), 3500, 1.5, 0.8), 220, -1.0, 1.0), -22, 2.2, 0.01, 0.15)
    e = np.zeros(N)
    for a, b in spans: e[max(0, int((a - 0.05) * SR)):int((b + 0.1) * SR)] = 1
    duck = db(-7.0 * smooth(e, 0.25, 0.6))
    act = np.abs(vo).sum(1) > 1e-3
    vo_n = vo / (np.sqrt((vo[act] ** 2).mean()) + 1e-9) * db(-20) if act.any() else vo
    mus_n = music / (np.sqrt((music ** 2).mean()) + 1e-9) * db(-29)
    stems = {'vo': vo_n, 'music': mus_n * duck[:, None], 'sfx': build_sfx() * db(-4)}
    mix = stems['vo'] + stems['music'] + stems['sfx']
    s1 = 1 / max(1.0, np.abs(mix).max() / 0.95)
    raw = os.path.join(D, f'mix_{NAME}_raw.wav'); write(raw, mix * s1)
    j = lufs(raw)
    af = f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true"
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af', af, '-ar', str(SR), os.path.join(D, f'mix_{NAME}.wav')], check=True)
    os.remove(raw)
    # 剪辑用分轨：旁白、配乐（含避让）、音效，乘上和成品一样的增益，三轨相加约等于成品
    # 响度处理在峰值高时不是单一增益，按 50 毫秒一格量出成品相对原混音的实际增益，乘到三条分轨上
    fin = load(os.path.join(D, f'mix_{NAME}.wav')); n = min(len(fin), len(mix)); hop = 2400; k = n // hop
    ra = np.sqrt(((mix[:k * hop] * s1).mean(1).reshape(k, hop) ** 2).mean(1)); rb = np.sqrt((fin[:k * hop].mean(1).reshape(k, hop) ** 2).mean(1))
    ok = ra > 1e-4; g0 = float(np.median(rb[ok] / ra[ok])) if ok.any() else 1.0
    g = np.interp(np.arange(len(mix)), (np.arange(k) + 0.5) * hop, np.clip(np.where(ok, rb / np.maximum(ra, 1e-9), g0), g0 / 4, g0 * 4))
    for key, x in stems.items(): write(os.path.join(ST, f'mix_{key}.wav'), x * s1 * g[:, None])
    # 记下这次用的时间轴和配音，交付检查拿它判断混音是不是最新的
    h = lambda p: hashlib.sha1(open(p, 'rb').read()).hexdigest()[:16]
    vos = {v['id']: h(p) for v in TL['vo'] for p in [os.path.join(D, 'vo', v['id'] + e) for e in ('.wav', '.mp3')] if os.path.exists(p)}
    json.dump({'tl': h(os.path.join(D, f'tl_{NAME}.json')), 'vo': vos, 'style': 'orch'}, open(os.path.join(D, f'mix_{NAME}.json'), 'w'), ensure_ascii=False, indent=1)
    print('mix', NAME, j['input_i'], 'LUFS in', flush=True)
    if MISSING: print('缺这些音效，已跳过：', '、'.join(sorted(MISSING)), '（按问题库 Q5.2 下载，或用 ROADSHOW_SFX 指向音效目录）', flush=True)

if __name__ == '__main__':
    main()
