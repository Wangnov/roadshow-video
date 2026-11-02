// 真实界面逐帧渲染。
//   node build/render.mjs --seg s1 [--master] [--fps 60 --dpr 2 --workers 4] [--start 0 --end 46]
//                        [--only 2.5,8,13（秒，出检查帧）] [--out frames/s1] [--png] [--strict]
// 不带 --only 时直接编码成 out/video_<段>.mp4（只有画面，声音由 mux 合进去）。
// --nosub 出不烧字幕的画面 out/video_<段>_nosub.mp4，给剪辑软件用，字幕走 SRT。
// 每帧依次：执行输入 → 推进虚拟时钟 → 同步 CSS 动画 → 画导演层 → 截图。
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inputsHash, productFingerprint, assetsFingerprint } from './inputs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default

// Playwright：先找工程自己的依赖，再找 PW_NODE_MODULES 指定的目录
function loadPlaywright() {
  const tries = [path.join(root, 'package.json'), process.env.PW_NODE_MODULES && path.join(process.env.PW_NODE_MODULES, 'x.js')].filter(Boolean)
  for (const t of tries) {
    try {
      return createRequire(t)('playwright')
    } catch {}
  }
  console.error('找不到 playwright。在工程目录里运行 npm install，或用 PW_NODE_MODULES 指向已有的 node_modules。')
  process.exit(2)
}
const { chromium } = loadPlaywright()

const a = Object.fromEntries(process.argv.slice(2).reduce((r, v, i, arr) => (v.startsWith('--') ? [...r, [v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? '1' : arr[i + 1]]] : r), []))
const seg = a.seg || 's0'
const SUF = a.nosub ? '_nosub' : ''
const preset = a.master ? CFG.render?.master || { fps: 60, dpr: 2 } : CFG.render?.draft || { fps: 30, dpr: 1 }
const fps = +(a.fps || preset.fps), dpr = +(a.dpr || preset.dpr)
const workers = +(a.workers || CFG.render?.workers || Math.max(1, Math.min(6, Math.floor(os.cpus().length / 2))))
const only = a.only ? a.only.split(',').map(s => Math.round(+s * fps)) : null
const out = path.resolve(root, a.out || (only ? `frames/chk_${seg}` : `frames/chunks_${seg}${SUF}`))
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const BASE = CFG.app.base.replace(/\/$/, '')
const APPDIR = CFG.app.dir ? path.resolve(root, CFG.app.dir) : null
const CACHE = path.join(root, 'build/apicache')
fs.mkdirSync(CACHE, { recursive: true })
const VOIDX = fs.existsSync(path.join(root, 'audio/vo/index.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'audio/vo/index.json'), 'utf8')) : {}
const MODT = (await import(pathToFileURL(path.join(root, 'src', seg + '.js')).href)).default
const TLN = typeof MODT === 'function' ? MODT(VOIDX) : MODT
const HOOKS = fs.existsSync(path.join(root, 'build/hooks.mjs')) ? await import(pathToFileURL(path.join(root, 'build/hooks.mjs')).href) : {}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }
// /__v/ 下：配置文件、配音数据、素材、导演页源码
const MOUNT = [['film.config.js', path.join(root, 'film.config.js')], ['vo/', path.join(root, 'audio/vo/')], ['assets/', path.join(root, 'assets/')], ['', path.join(root, 'src/')]]

// 问题汇总：交给检查脚本和验收报告。每个进程都从 0 秒重放，同一条问题会报多次，按原文去重
const ISSUES = Object.fromEntries(['TIMELINE', 'no target', 'FOCUS EMPTY', 'FOCUS TINY', 'CALLOUT EMPTY', 'CALLOUT CLIPPED', 'OVERLAP', 'SUB OVERFLOW', 'CLICK OFFSCREEN', 'CLICK OUTSIDE APP', 'PAGEERROR', 'API MISS'].map(k => [k, new Set()]))
// 字号测量：远看可读性检查用，同样按原文去重
const MEASURES = new Set()
const note = (id, kind, text) => {
  if (!(kind in ISSUES) || ISSUES[kind].has(text)) return
  ISSUES[kind].add(text)
  console.error(`[w${id}] ${kind} ${text}`)
}

async function run(id, range) {
  const br = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-gpu-mem-available-mb=8192', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] })
  const ctx = await br.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr, locale: CFG.locale || 'zh-CN', timezoneId: CFG.timezone || 'Asia/Shanghai' })
  // 接上一段：把上一段结束时的应用状态写进本地存储（每个标签页只写一次）
  if (TLN.preload && CFG.stateKey) {
    await ctx.addInitScript(([key, st]) => { try { if (!sessionStorage.getItem('__film_preloaded')) { localStorage.setItem(key, st); sessionStorage.setItem('__film_preloaded', '1') } } catch {} }, [CFG.stateKey, fs.readFileSync(path.join(root, TLN.preload), 'utf8')])
  }
  await ctx.addInitScript(([storage, seed0]) => {
    try {
      for (const [k, v] of Object.entries(storage.session || {})) sessionStorage.setItem(k, v)
      for (const [k, v] of Object.entries(storage.local || {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v)
    } catch {}
    // 随机数与 UUID 固定种子：每次渲染、每个进程看到的随机内容一样
    let seed = seed0
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    Math.random = rnd
    if (window.crypto) crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = (rnd() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16) })
    // 记录在途请求：数据落定之前不推进时钟
    let n = 0
    window.__inflight = () => n
    const f = window.fetch
    window.fetch = function (...args) {
      n++
      return f.apply(this, args).finally(() => n--)
    }
  }, [CFG.storage || {}, CFG.seed || 1])

  // 模型接口：按路径加请求体做键，录一次回放
  const match = CFG.api?.match || '/api/'
  const methods = CFG.api?.methods || ['POST']
  await ctx.route(u => u.pathname.startsWith(match) && u.origin === new URL(BASE).origin, async route => {
    const req = route.request(), p = new URL(req.url()).pathname
    if (!methods.includes(req.method())) return route.continue()
    const key = createHash('sha1').update(req.method() + ' ' + p + '\n' + (req.postData() || '')).digest('hex').slice(0, 20)
    const file = path.join(CACHE, key + '.json')
    if (fs.existsSync(file)) {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
      return route.fulfill({ status: rec.status, contentType: rec.type, body: rec.body })
    }
    if (a.strict) {
      note(id, 'API MISS', `${p}（--strict 只走缓存）`)
      return route.fulfill({ status: 503, body: 'no cache' })
    }
    // 缓存必须来自真实接口调用，不手写结果
    const r = await route.fetch({ timeout: 180000 })
    const rec = { path: p, status: r.status(), type: r.headers()['content-type'] || 'application/json', body: (await r.body()).toString('utf8') }
    if (r.status() < 400) fs.writeFileSync(file, JSON.stringify(rec))
    note(id, 'API MISS', `${p} -> ${r.status()}（已录入缓存）`)
    return route.fulfill({ status: rec.status, contentType: rec.type, body: rec.body })
  })

  // 导演页与素材
  await ctx.route(BASE + '/__v/**', route => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__v\//, ''))
    for (const [pre, dir] of MOUNT) {
      if (pre.endsWith('.js') ? rel !== pre : !rel.startsWith(pre)) continue
      const f = pre.endsWith('.js') ? dir : path.join(dir, rel.slice(pre.length))
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ path: f, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' } })
    }
    return route.fulfill({ status: 404 })
  })

  // 静态产品：按目录直接提供，找不到的路径回到 index.html（单页应用）
  if (APPDIR) {
    await ctx.route(u => u.origin === new URL(BASE).origin && !u.pathname.startsWith('/__v/') && !u.pathname.startsWith(match), route => {
      const p = decodeURIComponent(new URL(route.request().url()).pathname)
      let f = path.join(APPDIR, p)
      if (!f.startsWith(APPDIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(APPDIR, 'index.html')
      return route.fulfill({ path: f, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' } })
    })
  }

  // 项目自己的路由（比如模拟的推送数据），放在 build/hooks.mjs 的 route() 里。最后注册，Playwright 里越晚注册的越先匹配
  if (HOOKS.route) await HOOKS.route({ ctx, TL: TLN, root, CFG })

  await ctx.clock.install({ time: new Date(CFG.clock || '2026-01-01T09:00:00+08:00') })
  const pg = await ctx.newPage()
  pg.on('pageerror', e => note(id, 'PAGEERROR', e.message))
  pg.on('response', r => r.status() >= 500 && console.error(`[w${id}] HTTP${r.status()}`, r.url().replace(BASE, '')))
  pg.on('console', m => {
    const t = m.text()
    if (t.startsWith('MEASURE ')) return MEASURES.add(t.slice(8))
    if (m.type() !== 'warning' && m.type() !== 'error') return
    const kind = Object.keys(ISSUES).find(k => t.startsWith(k))
    if (kind) note(id, kind, t.slice(kind.length).trim().slice(0, 200))
    else if (!/deprecat|Failed to load resource|React Router/i.test(t)) console.error(`[w${id}]`, m.type(), t.slice(0, 200))
  })
  await pg.goto(`${BASE}/__v/director.html?tl=${seg}${a.nosub ? '&nosub=1' : ''}`)
  await pg.waitForFunction('window.booted === true', null, { timeout: 60000 })
  const dur = await pg.evaluate(() => window.TL.dur)
  const ready0 = await pg.evaluate(() => window.TL.ready0 ?? window.CFG.app.ready)
  await waitApp(pg, ready0, null, false)
  const ready2 = await pg.evaluate(() => window.TL.layout?.screen?.ready ?? window.CFG.layout?.screen?.ready)
  if (ready2) await waitApp(pg, ready2, null, false, '#app2')
  // 假时钟装好后默认按真实时间流动，渲染越慢虚拟时间跑得越快；加载完立刻暂停，之后只靠逐帧推进
  await pg.clock.pauseAt((await pg.evaluate(() => Date.now())) + 500)

  const last = Math.round((a.end != null ? +a.end : dur) * fps)
  const lo = range ? range[0] : Math.round(+(a.start || 0) * fps), hi = range ? range[1] : last
  const stopAt = only ? Math.max(...only) + 1 : hi
  const t0 = Date.now()
  let shots = 0
  // 截图直接喂给本进程的 ffmpeg，编码成分块，不落中间帧
  let enc = null
  if (!only) {
    const chunk = path.join(out, `chunk_${String(id).padStart(2, '0')}.mp4`)
    // 浏览器截图是全范围色彩，转成视频标准范围并写明 BT.709，部分播放器才不会发灰或拒播
    enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-vf', 'scale=1920:1080:flags=lanczos:in_range=full:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-profile:v', 'high',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', chunk], { stdio: ['pipe', 'inherit', 'inherit'] })
    enc.done = new Promise(r => enc.on('close', r))
  }
  for (let n = 0; n < stopAt; n++) {
    const t = n / fps
    const ops = await pg.evaluate(t => window.input(t), t)
    for (const op of ops) {
      if (op.op === 'move') await pg.mouse.move(op.x, op.y)
      else if (op.op === 'down') await pg.mouse.down()
      else if (op.op === 'up') await pg.mouse.up()
      else if (op.op === 'type') await pg.keyboard.insertText(op.text)
      else if (op.op === 'press') await pg.keyboard.press(op.key)
      else if (op.op === 'upload') {
        const fr = await (await pg.$('#app')).contentFrame()
        await fr.setInputFiles(op.sel, path.resolve(root, op.file), { timeout: 8000 })
      } else if (op.op === 'nav') {
        await pg.evaluate(u => window.nav(u), op.url)
        await waitApp(pg, op.ready, op.url)
      }
    }
    await settleNet(pg)
    await pg.clock.runFor(1000 / fps)
    await settleNet(pg)
    await pg.evaluate(t => {
      window.syncAnims()
      window.paint(t)
      return window.settle()
    }, t)
    const want = only ? only.includes(n) : n >= lo
    if (!want) continue
    if (enc) {
      const buf = await pg.screenshot(a.png ? { type: 'png' } : { type: 'jpeg', quality: 95 })
      if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r))
    } else {
      await pg.screenshot({ path: path.join(out, `f${String(n).padStart(5, '0')}.png`), type: 'png' })
    }
    shots++
    if (shots % 300 === 0) process.stderr.write(`[w${id}] ${shots}/${only ? only.length : hi - lo} 帧 ${((Date.now() - t0) / 1000).toFixed(0)} 秒\n`)
  }
  if (enc) {
    enc.stdin.end()
    await enc.done
  }
  if (process.env.DUMP_STATE && CFG.stateKey) fs.writeFileSync(path.resolve(root, process.env.DUMP_STATE), await pg.evaluate(k => document.querySelector('#app').contentWindow.localStorage.getItem(k) || '{}', CFG.stateKey))
  await br.close()
  return { shots, dur }
}

async function settleNet(pg) {
  for (let i = 0; i < 400; i++) {
    const n = await pg.evaluate(() => {
      const w = document.querySelector('#app')?.contentWindow
      const w2 = document.querySelector('#app2')?.contentWindow
      return (w?.__inflight?.() ?? 0) + (w2?.__inflight?.() ?? 0)
    })
    if (!n) return i
    await new Promise(r => setTimeout(r, 10))
  }
}

// advance=false：开拍前的等待不推进虚拟时钟，每个进程都从同一虚拟时刻开拍
async function waitApp(pg, ready, url, advance = true, frame = '#app') {
  for (let i = 0; i < 1200; i++) {
    const ok = await pg.evaluate(
      ([ready, url, frame]) => {
        const d = document.querySelector(frame)?.contentDocument
        if (!d || d.readyState !== 'complete') return false
        if (url && !d.location.href.includes(url.split('#')[0])) return false
        return !ready || !!d.querySelector(ready)
      },
      [ready, url, frame],
    )
    if (ok) return
    if (advance) await pg.clock.runFor(16)
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('应用没有就绪：' + ready)
}

const T0 = Date.now()
let total
if (only || workers <= 1) total = await run(0)
else {
  // 并行：每个进程从 0 秒重放到自己的区间，只截区间内的帧。越靠后的进程重放越久，区间按 (1-q)^i 递减
  const dur = TLN.dur
  const lo = Math.round(+(a.start || 0) * fps), hi = Math.round((a.end != null ? +a.end : dur) * fps)
  const q = +(process.env.CHUNK_Q || 0.08)
  const w = Array.from({ length: workers }, (_, i) => (1 - q) ** i), sw = w.reduce((x, y) => x + y, 0)
  const cut = [lo]
  for (let i = 0; i < workers; i++) cut.push(i === workers - 1 ? hi : Math.round(cut[i] + ((hi - lo) * w[i]) / sw))
  const rs = await Promise.all(Array.from({ length: workers }, (_, i) => run(i, [cut[i], cut[i + 1]])))
  total = { shots: rs.reduce((n, r) => n + r.shots, 0), dur }
}

// 不是检查帧时，把分块拼成这一段的画面
if (!only) {
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  const chunks = fs.readdirSync(out).filter(f => /^chunk_\d+\.mp4$/.test(f)).sort()
  fs.writeFileSync(path.join(out, 'list.txt'), chunks.map(f => `file '${path.join(out, f)}'`).join('\n'))
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(out, 'list.txt'), '-c', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0', path.join(root, 'out', `video_${seg}${SUF}.mp4`)], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
}

// 问题汇总写进 frames/issues_<段>.json，检查脚本读它。
// 出成片画面时另记一份 out/video_<段>.json：渲染参数、区间、输入指纹和问题，交付检查读它
const issues = Object.fromEntries(Object.entries(ISSUES).map(([k, v]) => [k, [...v]]))
fs.mkdirSync(path.join(root, 'frames'), { recursive: true })
fs.writeFileSync(path.join(root, 'frames', `issues_${seg}.json`), JSON.stringify({ seg, fps, dpr, ...issues }, null, 1))
if (!only) {
  const start = +(a.start || 0), end = a.end != null ? +a.end : TLN.dur
  const meta = { seg, fps, dpr, master: !!a.master, nosub: !!a.nosub, start, end, dur: TLN.dur, full: start === 0 && end >= TLN.dur, strict: !!a.strict, inputs: inputsHash(root, CFG, seg, TLN), product: productFingerprint(root, CFG), assets: assetsFingerprint(root, CFG, TLN), at: new Date().toISOString(), issues, measures: [...MEASURES].map(m => JSON.parse(m)).sort((x, y) => x.t - y.t) }
  fs.writeFileSync(path.join(root, 'out', `video_${seg}${SUF}.json`), JSON.stringify(meta, null, 1))
}
const bad = Object.entries(issues).filter(([, v]) => v.length)
console.error(`${seg}：${total.shots} 帧，用时 ${((Date.now() - T0) / 1000).toFixed(1)} 秒${bad.length ? '；问题 ' + bad.map(([k, v]) => `${k} ${v.length}`).join('，') : '；没有发现问题'}`)
