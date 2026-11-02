// 交付前检查：node build/qa.mjs [--seg s1,s2]
// 逐项检查成片，结果写进 验收报告.md 的“机器检查过的”一栏（只改标记之间的部分）和 out/qa.json。
// 检查项、阈值和放行写法见 README 的“交付前检查”。
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { inputsHash, fingerprint, productFingerprint, assetsFingerprint } from './inputs.mjs'
import { exportTL } from './export_tl.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default
const argv = process.argv.slice(2)
const pick = argv.includes('--seg') ? argv[argv.indexOf('--seg') + 1].split(',') : null
const segs = CFG.segments.filter(s => !pick || pick.includes(s.id))
const Q = { lufs: -16, lufsTol: 1, tpMax: -1, staticMax: 6, blackLuma: 4, flashDiff: 8, viewRatio: 6, minArcmin: 15, waive: [], ...(CFG.qa || {}) }

// ---------- 结果 ----------
const ROWS = []
const row = (key, title) => {
  const r = { key, title, info: '', fails: [], warns: [], waived: [], skip: '' }
  ROWS.push(r)
  return r
}
const fmtT = t => `${t.toFixed(1)} 秒`
const label = it => [it.seg, it.t != null ? fmtT(it.t) : null, it.msg].filter(Boolean).join(' ')
// 放行：film.config.js 的 qa.waive 里写 { check, seg?, id?, t?, match?, why }，人工确认过没问题的才写
function fail(r, it) {
  const w = Q.waive.find(w => w.check === r.key && (w.seg == null || w.seg === it.seg) && (w.id == null || w.id === it.id) && (w.t == null || (it.t != null && Math.abs(w.t - it.t) <= 1)) && (w.match == null || it.msg.includes(w.match)))
  if (w) r.waived.push({ ...it, why: w.why || '（没写理由）' })
  else r.fails.push(it)
}
const status = r => (r.fails.length ? 'fail' : r.skip ? 'skip' : r.warns.length ? 'warn' : 'pass')

// ---------- 工具 ----------
const mtime = f => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)
const readJSON = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)
const sha = f => createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 16)
const segFile = s => path.join(root, 'out/分段', `${CFG.name}_${s.name}.mp4`)
const voFile = id => ['wav', 'mp3'].map(e => path.join(root, 'audio/vo', `${id}.${e}`)).find(f => fs.existsSync(f))
function streams(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration,r_frame_rate', '-of', 'json', f], { encoding: 'utf8' })
  return JSON.parse(r.stdout || '{}').streams || []
}
function loudness(f) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'))
  const I = s.match(/I:\s+(-?[\d.]+|-inf) LUFS/), P = s.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)
  return { I: I ? +I[1] : null, tp: P ? (P[1] === '-inf' ? -Infinity : +P[1]) : null }
}

// 画面分析：缩到 192×108 灰度逐帧看。黑帧、闪帧（一两帧突变又回到原样）、长时间静止（字幕带以上半秒内几乎没有变化）
function analyze(file, fps) {
  const W = 192, H = 108, N = W * H, HS = Math.floor((H * (1080 - 190)) / 1080) * W
  const L = Math.max(1, Math.round(fps * 0.5)), KEEP = Math.max(L, 3) + 1
  const md = (a, b) => {
    let s = 0
    for (let j = 0; j < N; j += 2) s += Math.abs(a[j] - b[j])
    return s / (N / 2)
  }
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'])
    const ring = [], black = [], still = [], flash = []
    let buf = Buffer.alloc(0), i = 0
    p.stdout.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d
      while (buf.length >= N) {
        const f = new Uint8Array(buf.subarray(0, N))
        buf = buf.subarray(N)
        let dark = 0
        for (let j = 0; j < N; j++) if (f[j] <= Q.blackLuma) dark++
        black[i] = dark / N >= 0.98
        if (ring.length >= L) {
          const g = ring[ring.length - L]
          let ch = 0
          for (let j = 0; j < HS; j++) if (Math.abs(f[j] - g[j]) > 8) ch++
          still[i] = !black[i] && ch / HS < 0.002
        } else still[i] = false
        // 闪帧：c 和前一帧 a、后面的 b 都差很多，a 和 b 却很像
        for (const k of [1, 2]) {
          if (ring.length < k + 1) continue
          const c = ring[ring.length - k], a = ring[ring.length - k - 1]
          const dac = md(a, c), dcb = md(c, f)
          if (dac > Q.flashDiff && dcb > Q.flashDiff && md(a, f) < 0.4 * Math.min(dac, dcb)) flash.push((i - k) / fps)
        }
        ring.push(f)
        if (ring.length > KEEP) ring.shift()
        i++
      }
    })
    p.on('error', reject)
    p.on('close', code => {
      if (code) return reject(new Error('ffmpeg 解码失败：' + file))
      const runs = (arr, minLen) => {
        const out = []
        for (let s = 0; s < arr.length; s++) {
          if (!arr[s]) continue
          let e = s
          while (e + 1 < arr.length && arr[e + 1]) e++
          if (e - s + 1 >= minLen) out.push([s, e])
          s = e
        }
        return out
      }
      const fl = flash.filter((t, j) => !j || t - flash[j - 1] > 3 / fps)
      resolve({
        frames: i,
        black: runs(black, Math.max(2, Math.round(fps * 0.1))).map(([s, e]) => [s / fps, (e + 1) / fps]),
        still: runs(still, 1).map(([s, e]) => [Math.max(0, s - L) / fps, (e + 1) / fps]),
        flash: fl,
      })
    })
  })
}

// 有意黑场：淡入之前到淡入结束，淡出开始到下一次淡入结束（或段尾）
function blackOK(fades, a, b) {
  const fs_ = [...fades].sort((x, y) => x.t - y.t)
  const iv = []
  for (const f of fs_) {
    if (f.from >= 0.99) iv.push([f.t - 0.1, f.t + f.d + 0.1])
    if (f.to >= 0.99) {
      const nx = fs_.find(g => g.t > f.t && g.from >= 0.99)
      iv.push([f.t - 0.1, nx ? nx.t + nx.d + 0.1 : Infinity])
    }
  }
  return iv.some(([lo, hi]) => a >= lo && b <= hi)
}
// 静止区间扣掉标了 hold 的部分，剩下最长的一截
function stillLeft(holds, a, b) {
  let parts = [[a, b]]
  for (const h of holds) {
    const lo = h.t - 0.5, hi = h.t + h.d + 0.5
    parts = parts.flatMap(([x, y]) => (hi <= x || lo >= y ? [[x, y]] : [[x, Math.min(y, lo)], [Math.max(x, hi), y]].filter(([p, q]) => q - p > 0.05)))
  }
  return parts.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0] || null
}

// ---------- 时间轴 ----------
const TLS = {}
for (const s of segs) TLS[s.id] = await exportTL(root, s.id)
const VOIDX = fs.existsSync(path.join(root, 'audio/vo/index.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'audio/vo/index.json'), 'utf8')) : {}
const META = Object.fromEntries(segs.map(s => [s.id, readJSON(path.join(root, 'out', `video_${s.id}.json`))]))

// 1. 成片齐全、按最新输入渲染
const PRODUCT = productFingerprint(root, CFG)
{
  const r = row('files', '成片齐全、按最新输入渲染')
  if (!PRODUCT) r.warns.push({ msg: '没登记产品源码的位置（film.config.js 的 app.repo），渲染之后改过产品界面查不出来' })
  for (const s of segs) {
    const m = META[s.id], { tl, TL } = TLS[s.id]
    const video = path.join(root, 'out', `video_${s.id}.mp4`), mix = path.join(root, 'audio', `mix_${s.id}.wav`), tlf = path.join(root, 'audio', `tl_${s.id}.json`)
    if (!m || !fs.existsSync(video)) fail(r, { seg: s.id, msg: '没有成片画面或渲染记录（out/video_<段>.json），用 render.mjs 完整渲一遍' })
    else {
      if (!m.full) fail(r, { seg: s.id, msg: `画面只渲了 ${m.start} 到 ${m.end} 秒，要完整渲一遍` })
      if (m.inputs !== inputsHash(root, CFG, s.id, TL)) fail(r, { seg: s.id, msg: '渲染之后改过配置、时间轴或配音数据，要重渲' })
      const desc = p => (p.kind === 'git' ? `${p.rev}${p.dirty ? ' 加未提交的改动' : ''}` : `${p.files} 个文件`)
      if (!('product' in m)) r.warns.push({ seg: s.id, msg: '渲染记录里没有产品版本，用新版引擎重渲才能核对产品改没改' })
      else if (m.product && PRODUCT && m.product.id !== PRODUCT.id) fail(r, { seg: s.id, msg: `渲染之后产品改过（${desc(m.product)} → ${desc(PRODUCT)}），要重渲` })
      if (m.assets && m.assets.id !== assetsFingerprint(root, CFG, TL).id) fail(r, { seg: s.id, msg: `渲染之后本段用到的素材改过（${m.assets.refs.join('、')}），要重渲` })
      if (!m.master) r.warns.push({ seg: s.id, msg: `这是草稿画面（${m.fps} 帧、${m.dpr} 倍），交付前出母版` })
    }
    if (!fs.existsSync(mix)) fail(r, { seg: s.id, msg: '没有混音 audio/mix_<段>.wav，跑 score.py' })
    else {
      const old = readJSON(tlf)
      const rec = readJSON(mix.replace(/\.wav$/, '.json'))
      if (JSON.stringify(old) !== JSON.stringify(tl)) fail(r, { seg: s.id, msg: '配乐用的时间轴不是最新的，重跑 export_tl.mjs 和 score.py' })
      else if (!rec) fail(r, { seg: s.id, msg: '混音没有记下用的时间轴（audio/mix_<段>.json），重跑 score.py' })
      else if (rec.tl !== sha(tlf)) fail(r, { seg: s.id, msg: '导出时间轴之后没有重新作曲，重跑 score.py' })
      const changed = rec ? TL.vo.filter(v => voFile(v.id) && rec.vo?.[v.id] !== sha(voFile(v.id))).map(v => v.id) : []
      if (changed.length) fail(r, { seg: s.id, msg: `配音 ${changed.join('、')} 和混音里用的不一样，重跑 score.py` })
    }
    const sf = segFile(s)
    if (!fs.existsSync(sf)) fail(r, { seg: s.id, msg: '没有分段成片，跑 mux.mjs' })
    else {
      const rec = readJSON(path.join(root, 'out', `mux_${s.id}.json`))
      if (!rec || rec.video !== fingerprint(video) || rec.mix !== fingerprint(mix)) fail(r, { seg: s.id, msg: '分段成片不是用现在的画面和混音合的，重跑 mux.mjs' })
    }
  }
  if (!pick && CFG.segments.length > 1) {
    const full = path.join(root, 'out', `${CFG.name}_全片.mp4`)
    if (!fs.existsSync(full)) fail(r, { msg: '没有全片，跑 join.mjs' })
    else {
      const rec = readJSON(path.join(root, 'out', 'join.json'))
      if (!rec || CFG.segments.some(s => rec.parts?.[path.basename(segFile(s))] !== fingerprint(segFile(s)))) fail(r, { msg: '全片不是用现在的分段拼的，重跑 join.mjs' })
    }
  }
  const ms = segs.map(s => META[s.id]).filter(Boolean)
  r.info = `${segs.length} 段` + (ms.length ? `，${ms.every(m => m.master) ? '母版' : '含草稿'}，${[...new Set(ms.map(m => m.fps))].join('/')} 帧` : '')
}

// 2、3. 引擎在渲染时报的问题：目标与点击，字幕与标注版面
{
  const groups = [
    ['engine', '界面目标、点击与页面', ['TIMELINE', 'no target', 'FOCUS EMPTY', 'FOCUS TINY', 'CALLOUT EMPTY', 'CLICK OFFSCREEN', 'CLICK OUTSIDE APP', 'PAGEERROR']],
    ['layout', '字幕与标注版面', ['SUB OVERFLOW', 'CALLOUT CLIPPED', 'OVERLAP']],
  ]
  for (const [key, title, kinds] of groups) {
    const r = row(key, title)
    if (segs.some(s => !META[s.id])) r.skip = '有段落没有渲染记录'
    for (const s of segs) {
      const iss = META[s.id]?.issues || {}
      for (const k of kinds) for (const m of (iss[k] || []).slice(0, 8)) fail(r, { seg: s.id, msg: `${k} ${m}` })
      if (key === 'engine' && iss['API MISS']?.length) r.warns.push({ seg: s.id, msg: `成片渲染时有 ${iss['API MISS'].length} 个接口没走缓存，换机器渲染前用 --strict 再验一次` })
    }
    r.info = r.skip ? '' : `${segs.length} 段的渲染记录`
  }
}

// 远看可读性：最远的观众离屏幕是画面高度的 viewRatio 倍，要看清的字高不小于 minArcmin 角分
{
  const r = row('read', '远看可读性')
  const px = arcmin => 1080 * Math.tan(((arcmin / 60) * Math.PI) / 180) * Q.viewRatio
  const need = px(Q.minArcmin), good = px(20)
  if (segs.some(s => !META[s.id]?.measures)) r.skip = '渲染记录里没有字号测量，用新版引擎重渲'
  for (const s of segs) {
    const callouts = TLS[s.id].TL.callouts || []
    for (const m of META[s.id]?.measures || []) {
      if (m.px >= need) continue
      if (m.kind === 'overlay') fail(r, { seg: s.id, t: m.t, msg: `${m.what}“${m.text}”${m.px} 像素，后排看不清` })
      // 聚焦期间有标注把要点说出来，就不要求界面上的字本身看得清
      else if (!callouts.some(c => c.t < (m.to ?? m.t) && (m.from ?? m.t) < c.t + c.d)) r.warns.push({ seg: s.id, t: m.t, msg: `聚焦的内容里最大的字“${m.text}”只有 ${m.px} 像素，后排看不清，推近一些或加标注` })
    }
  }
  r.info = `最远观众在画面高度 ${Q.viewRatio} 倍处：要看清的字至少 ${Math.ceil(need)} 像素，看着舒服要 ${Math.ceil(good)} 像素`
}

// 4、5、6. 画面：黑帧、闪帧、长时间静止；7. 时长与音画
{
  const rb = row('black', '黑帧'), rf = row('flash', '闪帧'), rs = row('static', '长时间静止'), ry = row('sync', '时长与音画')
  let n = 0
  for (const s of segs) {
    const f = fs.existsSync(segFile(s)) ? segFile(s) : path.join(root, 'out', `video_${s.id}.mp4`)
    if (!fs.existsSync(f)) continue
    const { tl } = TLS[s.id]
    const st = streams(f), v = st.find(x => x.codec_type === 'video'), au = st.find(x => x.codec_type === 'audio')
    const fps = v ? Math.round(eval(v.r_frame_rate)) : 30
    const A = await analyze(f, fps)
    n++
    for (const [a, b] of A.black) if (!blackOK(tl.fades, a, b)) fail(rb, { seg: s.id, t: a, msg: `黑了 ${(b - a).toFixed(2)} 秒，不在淡入淡出里` })
    for (const t of A.flash) fail(rf, { seg: s.id, t, msg: '一两帧突变后又回到原样' })
    // 片头卡、章节卡的停留是设计好的，和 hold() 一样不算；示意图、空镜这类卡片照查
    const holds = [...(tl.holds || []), ...tl.cards.filter(c => c.kind === 'title' || c.kind === 'chap').map(c => ({ t: c.t, d: c.d + (c.outD || 0) }))]
    for (const [a, b] of A.still) {
      const left = stillLeft(holds, a, b)
      if (left && left[1] - left[0] > Q.staticMax) fail(rs, { seg: s.id, t: left[0], msg: `画面静止 ${(left[1] - left[0]).toFixed(1)} 秒（到 ${fmtT(left[1])}）` })
    }
    const vd = A.frames / fps
    if (Math.abs(vd - tl.dur) > 2 / fps + 0.01) fail(ry, { seg: s.id, msg: `画面 ${vd.toFixed(2)} 秒，时间轴 ${tl.dur} 秒` })
    if (f === segFile(s)) {
      if (!au) fail(ry, { seg: s.id, msg: '分段成片没有声音' })
      else if (Math.abs(+au.duration - vd) > 0.1) fail(ry, { seg: s.id, msg: `声音 ${(+au.duration).toFixed(2)} 秒，画面 ${vd.toFixed(2)} 秒` })
    }
  }
  for (const r of [rb, rf, rs, ry]) {
    if (!n) r.skip = '没有可分析的成片'
    else r.info = `${n} 段逐帧`
  }
  rs.info += `，阈值 ${Q.staticMax} 秒`
}

// 8. 响度与峰值
{
  const r = row('loudness', '响度与峰值')
  const full = path.join(root, 'out', `${CFG.name}_全片.mp4`)
  const target = !pick && CFG.segments.length > 1 ? full : segFile(segs[0])
  if (!fs.existsSync(target)) r.skip = '没有成片'
  else {
    const L = loudness(target)
    r.info = `${path.basename(target)}：${L.I} LUFS，峰值 ${L.tp} dBTP（目标 ${Q.lufs}±${Q.lufsTol} LUFS，峰值不高于 ${Q.tpMax}）`
    if (L.I == null || Math.abs(L.I - Q.lufs) > Q.lufsTol) fail(r, { msg: `总响度 ${L.I} LUFS，偏离目标 ${Q.lufs}` })
    if (L.tp == null || L.tp > Q.tpMax) fail(r, { msg: `真峰值 ${L.tp} dBTP，超过 ${Q.tpMax}` })
    const per = segs.filter(s => fs.existsSync(segFile(s))).map(s => ({ s, I: loudness(segFile(s)).I }))
    const vals = per.map(p => p.I).filter(x => x != null && isFinite(x))
    if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) > 2) r.warns.push({ msg: `各段响度差 ${(Math.max(...vals) - Math.min(...vals)).toFixed(1)} LU：${per.map(p => `${p.s.id} ${p.I}`).join('，')}` })
  }
}

// 9. 旁白逐句回听对稿
{
  const r = row('asr', '旁白逐句回听对稿')
  const ids = segs.flatMap(s => TLS[s.id].TL.vo.map(v => v.id))
  const asr = path.join(root, 'audio/vo/asr.json')
  if (!fs.existsSync(asr)) r.skip = '没有 audio/vo/asr.json：用 ASR 逐句回听后写入，见 references/服务与工具文档.md 的回听一节'
  else {
    const A = JSON.parse(fs.readFileSync(asr, 'utf8'))
    const miss = ids.filter(id => !(id in A))
    if (miss.length) fail(r, { msg: `回听结果里缺 ${miss.join('、')}` })
    // 每句带了 audio（回听的那版音频的 sha1 前 16 位）就按内容比，没带就按修改时间比
    const stale = ids.filter(id => voFile(id) && (A[id]?.audio ? A[id].audio !== sha(voFile(id)) : mtime(voFile(id)) > mtime(asr)))
    if (stale.length) fail(r, { msg: `配音 ${stale.join('、')} 比回听结果新，重新回听` })
    const py = spawnSync(process.env.PYTHON || 'python3', [path.join(root, 'audio/asr_check.py')], { encoding: 'utf8', cwd: root })
    let out = {}
    try {
      out = JSON.parse(py.stdout)
    } catch {
      out = { error: (py.stderr || '比对脚本没有输出').trim().split('\n').pop() }
    }
    if (out.error) r.skip = out.error + (process.env.PYTHON ? '' : '（装在别的 Python 里时用 PYTHON 环境变量指过去）')
    else {
      let errs = 0, total = 0
      for (const id of ids) {
        const x = out.rows?.[id]
        if (!x) continue
        errs += x.errors
        total += x.n
        if (x.errors) fail(r, { id, msg: `${id} 读音差 ${x.errors} 处：${x.spans.map(p => `“${p.ref || '（无）'}”听成“${p.hyp || '（无）'}”`).join('，')}` })
      }
      r.info = `${ids.length} 句，按无调拼音比对，读音差 ${errs}/${total}`
    }
  }
}

// 10. 编排规范（只提醒）
{
  const r = row('lint', '编排规范')
  let taps = 0
  for (const s of segs) {
    const { TL } = TLS[s.id]
    for (const a of TL.acts || []) if (a.type && (a.cps < 8 || a.cps > 15)) r.warns.push({ seg: s.id, t: a.t, msg: `打字每秒 ${a.cps} 字（常用 9 到 14）` })
    for (const m of TL.cam.slice(1)) {
      if ((m.d || 0) < 0.3 || m.chain) continue
      if (m.d < 0.9) r.warns.push({ seg: s.id, t: m.t, msg: `镜头运动只有 ${m.d} 秒，会显得急（常用 1.1 到 1.8）` })
      if (m.d > 2.4 && !m.drift) r.warns.push({ seg: s.id, t: m.t, msg: `镜头运动 ${m.d} 秒，偏慢` })
    }
    for (const c of TL.callouts || []) {
      const text = (c.text || '').replace(/<[^>]+>/g, '')
      if ([...text].length > 14) r.warns.push({ seg: s.id, t: c.t, msg: `标注“${text}”超过 14 字` })
      if (c.d < 2.0) r.warns.push({ seg: s.id, t: c.t, msg: `标注“${text}”只停 ${c.d} 秒` })
    }
    for (const v of TL.vo) {
      const m = VOIDX[v.id]
      if (!m?.dur) continue
      const n = [...(m.text || '').replace(/[\s，。、；：？！“”‘’（）《》【】,.;:?!"'()…]/g, '')].length
      if (n / m.dur > 5.8) r.warns.push({ seg: s.id, t: v.t, msg: `${v.id} 每秒 ${(n / m.dur).toFixed(1)} 字，念得偏快` })
      taps += ((m.text || '').match(/点一下/g) || []).length
    }
  }
  if (taps > 3) r.warns.push({ msg: `旁白里“点一下”出现 ${taps} 次（全片不超过 3 次）` })
  r.info = '打字速度、镜头时长、标注长度与停留、念速、口头禅'
}

// ---------- 输出 ----------
const fails = ROWS.filter(r => status(r) === 'fail')
const skips = ROWS.filter(r => r.skip)
const warns = ROWS.reduce((n, r) => n + r.warns.length, 0)
const now = new Date()
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
const ZH = { pass: '通过', fail: '未通过', warn: '通过，有提醒', skip: '没跑成' }
const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const md = [
  '<!-- qa:begin 这一栏由 build/qa.mjs 生成，重跑会覆盖 -->',
  '## 机器检查过的',
  '',
  `检查时间 ${stamp}${pick ? `，只查了 ${pick.join('、')}` : ''}。结论：**${fails.length ? `未通过（${fails.length} 项）` : skips.length ? `没有未通过的项，${skips.length} 项没跑成` : '全部通过'}**${warns ? `，另有 ${warns} 条提醒` : ''}`,
  '',
  '| 检查 | 结果 | 说明 |',
  '|---|---|---|',
  ...ROWS.map(r => `| ${r.title} | ${ZH[status(r)]} | ${cell(r.skip || r.info)} |`),
]
const list = (title, items) => (items.length ? ['', `### ${title}`, '', ...items] : [])
md.push(...list('未通过的项', ROWS.flatMap(r => r.fails.map(it => `- ${r.title}：${label(it)}`))))
md.push(...list('提醒（不挡交付，看一眼）', ROWS.flatMap(r => r.warns.map(it => `- ${r.title}：${label(it)}`))))
md.push(...list('人工确认后放行的', ROWS.flatMap(r => r.waived.map(it => `- ${r.title}：${label(it)}（放行理由：${it.why}）`))))
md.push(...list('没跑成的检查（写进“未验证”）', skips.map(r => `- ${r.title}：${r.skip}`)))
md.push('<!-- qa:end -->')
const block = md.join('\n')

const rp = path.join(root, '验收报告.md')
let doc = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : ''
if (/<!-- qa:begin[\s\S]*?<!-- qa:end -->/.test(doc)) doc = doc.replace(/<!-- qa:begin[\s\S]*?<!-- qa:end -->/, () => block)
else
  doc = [
    `# 验收报告：${CFG.name}`,
    '',
    block,
    '',
    '## 看过、听过的',
    '',
    '（Agent 填写：实际看过的段落、时间点与联系表，回听过的句子，交给新的眼睛复查的结论。没看过的不写在这里。）',
    '',
    '## 未验证',
    '',
    '- 音色合不合适、配乐合不合口味：只有用户能判断。',
    '- （没跑成的检查、没来得及看的段落写在这里）',
    '',
  ].join('\n')
fs.writeFileSync(rp, doc)
fs.mkdirSync(path.join(root, 'out'), { recursive: true })
fs.writeFileSync(path.join(root, 'out/qa.json'), JSON.stringify({ at: now.toISOString(), segs: segs.map(s => s.id), rows: ROWS.map(r => ({ ...r, status: status(r) })) }, null, 1))

for (const r of ROWS) {
  console.log(`${{ pass: '✓', fail: '✗', warn: '!', skip: '-' }[status(r)]} ${r.title}：${ZH[status(r)]}${r.skip || r.info ? `（${r.skip || r.info}）` : ''}`)
  for (const it of r.fails) console.log(`    ✗ ${label(it)}`)
  for (const it of r.warns) console.log(`    ! ${label(it)}`)
  for (const it of r.waived) console.log(`    放行 ${label(it)}（理由：${it.why}）`)
}
console.log(`\n${fails.length ? `未通过 ${fails.length} 项` : '没有未通过的项'}${skips.length ? `，${skips.length} 项没跑成` : ''}。报告：验收报告.md`)
// 退出码：1 有未通过的项，2 没有未通过但有没跑成的，0 全部通过
process.exit(fails.length ? 1 : skips.length ? 2 : 0)
