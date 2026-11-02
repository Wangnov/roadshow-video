// 真实界面运镜引擎：应用在 iframe 里真实运行，时间轴驱动镜头、光标、聚焦、标注、字幕与章节卡。
// 渲染端每帧依次调用 input(t) → 推进虚拟时钟 → syncAnims() → paint(t) → 截图。
const $ = s => document.querySelector(s)
const SW = 1920, SH = 1080, BAR = 36
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, k) => a + (b - a) * k

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = t => ((ax * t + bx) * t + cx) * t
  const sy = t => ((ay * t + by) * t + cy) * t
  const dx = t => (3 * ax * t + 2 * bx) * t + cx
  return x => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x
      if (Math.abs(e) < 1e-6) break
      const d = dx(t)
      if (Math.abs(d) < 1e-6) break
      t -= e / d
    }
    return sy(clamp(t, 0, 1))
  }
}
const EASE = {
  cam: bezier(0.62, 0, 0.18, 1),
  move: bezier(0.42, 0, 0.16, 1),
  out: bezier(0.16, 1, 0.3, 1),
  in: bezier(0.55, 0, 0.9, 0.4),
  io: bezier(0.45, 0, 0.55, 1),
  lin: x => x,
}
const ease = n => (typeof n === 'function' ? n : EASE[n || 'cam'])
const win01 = (t, a, d) => clamp((t - a) / d, 0, 1)

// 平滑缩放路径（van Wijk & Nuij），p = [cx, cy, 视口宽度（世界单位）]
function zoomPath(p0, p1, rho = 1.0) {
  const rho2 = rho * rho, rho4 = rho2 * rho2
  const [ux0, uy0, w0] = p0, [ux1, uy1, w1] = p1
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy
  if (d2 < 1e-6) {
    const S = Math.log(w1 / w0) / rho
    return t => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)]
  }
  const d1 = Math.sqrt(d2)
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1)
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const S = (r1 - r0) / rho
  return t => {
    const s = t * S, c0 = Math.cosh(r0)
    const u = (w0 / (rho2 * d1)) * (c0 * Math.tanh(rho * s + r0) - Math.sinh(r0))
    return [ux0 + u * dx, uy0 + u * dy, (w0 * c0) / Math.cosh(rho * s + r0)]
  }
}

const params = new URLSearchParams(location.search)
// 项目配置（film.config.js），渲染端把它挂在导演页同目录下
const CFG = (await import(`./film.config.js?v=${Date.now()}`)).default
let VO = {}
try {
  VO = await (await fetch(`./vo/index.json?v=${Date.now()}`)).json()
} catch {}
const MOD = (await import(`./${params.get('tl') || 's0'}.js?v=${Date.now()}`)).default
const TL = typeof MOD === 'function' ? MOD(VO) : MOD
for (const w of TL.warnings || []) console.warn('TIMELINE', w)

// 版式三种：
//   browser：浏览器窗口，应用默认 1600×900（Web 应用）
//   phone：手机外框，应用默认 390×844（手机网页）
//   scene：场景照片（比如展台），屏幕位置贴第二个页面，旁边一部手机放应用
const LAY = { ...(CFG.layout || {}), ...(TL.layout || {}) }
const KIND = LAY.kind || 'browser'
const isPhone = KIND === 'phone' || KIND === 'scene'
const AW = LAY.aw ?? (isPhone ? 390 : 1600), AH = LAY.ah ?? (isPhone ? 844 : 900)
const OX = LAY.ox ?? (KIND === 'phone' ? 20 : 0), OY = LAY.oy ?? (KIND === 'browser' ? BAR : 28)
const WW = LAY.ww ?? (KIND === 'phone' ? AW + 40 : AW), WH = LAY.wh ?? (KIND === 'browser' ? AH + BAR : AH + 56)
const world = $('#world')
const lockSvg = '<svg width="11" height="12" viewBox="0 0 11 12"><path fill="#33415a" d="M2 5V3.6a3.5 3.5 0 0 1 7 0V5h.6c.5 0 .9.4.9.9v5.2c0 .5-.4.9-.9.9H1.4a.9.9 0 0 1-.9-.9V5.9c0-.5.4-.9.9-.9zm1.4 0h4.2V3.6a2.1 2.1 0 0 0-4.2 0z"/></svg>'
const phoneHtml = (x, y) => `<div class="phone" style="left:${x}px;top:${y}px;width:${AW + 40}px;height:${AH + 56}px"><iframe id="app" style="width:${AW}px;height:${AH}px"></iframe><i class="phone-island"></i></div>`
if (KIND === 'browser') {
  world.innerHTML = `<div class="win" id="win" style="width:${AW}px"><div class="win-bar"><i></i><i></i><i></i><div class="win-url">${lockSvg}<span id="urltext"></span></div></div>
    <div class="win-body" style="width:${AW}px;height:${AH}px"><iframe id="app" style="width:${AW}px;height:${AH}px"></iframe></div></div>`
} else if (KIND === 'phone') {
  world.innerHTML = phoneHtml(0, 0)
} else if (KIND === 'scene') {
  const sc = LAY.screen
  world.innerHTML = `<div class="scene-photo" style="width:${LAY.photo.w}px;height:${LAY.photo.h}px;background-image:url(${LAY.photo.src})"></div>
    ${sc ? `<div class="scene-screen" style="left:${sc.x}px;top:${sc.y}px;width:${sc.w}px;height:${sc.h}px"><iframe id="app2" style="width:${sc.iw}px;height:${sc.ih}px;transform:scale(${sc.w / sc.iw})"></iframe><i class="scene-glare"></i></div>` : ''}
    ${phoneHtml(OX - 20, OY - 28)}`
  if (sc) $('#app2').src = sc.url
}
if (CFG.badge?.src) $('#badge').src = CFG.badge.src
const app = $('#app')
const AWIN = () => app.contentWindow
const ADOC = () => app.contentDocument

// ---------- 目标解析：选择器 → 应用坐标矩形 ----------
function appRect(tg) {
  if (!tg || tg === 'full') return { x: 0, y: 0, w: AW, h: AH }
  if (tg.wrect) return { x: tg.wrect[0] - OX, y: tg.wrect[1] - OY, w: tg.wrect[2], h: tg.wrect[3] }
  if (Array.isArray(tg)) {
    const rs = tg.map(appRect).filter(Boolean)
    const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y))
    return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y }
  }
  if (tg.rect) return { x: tg.rect[0], y: tg.rect[1], w: tg.rect[2], h: tg.rect[3] }
  const spec = typeof tg === 'string' ? { sel: tg } : tg
  const doc = ADOC()
  if (!doc) return null
  let els = [...doc.querySelectorAll(spec.sel)]
  if (spec.text) els = els.filter(e => (e.innerText || e.textContent || '').includes(spec.text))
  // all: true 时取所有匹配元素合成的一个框，比如同时框住几行
  if (spec.all) {
    const rs = els.map((_, i) => appRect({ ...spec, all: false, nth: i })).filter(Boolean)
    if (!rs.length) return null
    const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y))
    return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y }
  }
  const e = els[spec.nth || 0]
  if (!e) {
    console.warn('no target', JSON.stringify(spec))
    return null
  }
  const b = e.getBoundingClientRect()
  // 已收起、透明或几乎没有尺寸的元素当作不存在（例如自动消失的提示条）
  if (b.width < 12 || b.height < 12) return null
  for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
    const cs = n.ownerDocument.defaultView.getComputedStyle(n)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.15) return null
  }
  let r = { x: b.x, y: b.y, w: b.width, h: b.height }
  if (spec.inset) r = { x: r.x + spec.inset[0], y: r.y + spec.inset[1], w: r.w - spec.inset[0] - spec.inset[2], h: r.h - spec.inset[1] - spec.inset[3] }
  if (spec.h) r.h = spec.h
  if (spec.w) r.w = spec.w
  // 裁到应用可视区内（长卡片的下半截在滚动容器外）
  if (spec.clip !== false) {
    const y0 = Math.max(0, r.y), y1 = Math.min(AH, r.y + r.h), x0 = Math.max(0, r.x), x1 = Math.min(AW, r.x + r.w)
    r = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
  }
  return r
}
const toWorld = r => r && { x: r.x + OX, y: r.y + OY, w: r.w, h: r.h }

// ---------- 镜头 ----------
const FULL = LAY.full ? { rx: 0, ry: 0, ...LAY.full } : { cx: WW / 2, cy: WH / 2 + 22, s: Math.min((SW - 200) / WW, (SH - 110) / WH), rx: 0, ry: 0 }
function viewOf(v) {
  if (!v || v === 'full') return { ...FULL }
  if (v.full) return { ...FULL, s: FULL.s * (v.zoom || 1), cy: FULL.cy + (v.dy || 0), rx: v.tilt?.[0] || 0, ry: v.tilt?.[1] || 0 }
  const r = toWorld(appRect(v.target))
  if (!r) return { ...FULL }
  const pad = v.pad ?? 48
  let s = v.zoom || Math.min(SW / (r.w + 2 * pad), (SH - (v.subSafe === false ? 0 : 120)) / (r.h + 2 * pad))
  s = clamp(s, v.min ?? FULL.s, v.max ?? 2.4)
  let cx = r.x + r.w / 2 - (v.dx || 0) / s
  let cy = r.y + r.h / 2 - (v.dy || 0) / s + (v.subSafe === false ? 0 : 40 / s)
  if (v.clamp !== false) {
    const hw = SW / 2 / s, hh = SH / 2 / s
    if (2 * hw < WW) cx = clamp(cx, hw, WW - hw)
    if (2 * hh < WH) cy = clamp(cy, hh, WH - hh)
  }
  return { cx, cy, s, rx: v.tilt?.[0] || 0, ry: v.tilt?.[1] || 0 }
}
const camCache = new Map()
function camAt(t) {
  const ms = TL.cam
  let st = camCache.get(0) ?? (camCache.set(0, viewOf(ms[0].to)), camCache.get(0))
  let arrive = ms[0].t + (ms[0].d || 0), drift = ms[0].drift || 0
  const drifted = (v, dt) => (drift ? { ...v, s: v.s * (1 + drift * EASE.io(clamp(dt / (drift_d || 8), 0, 1))) } : v)
  let drift_d = ms[0].driftD || 8
  for (let i = 1; i < ms.length; i++) {
    const m = ms[i]
    if (t < m.t) return drifted(st, t - arrive)
    const from = drifted(st, m.t - arrive)
    if (t < m.t + m.d) {
      const to = viewOf(m.to)
      const k = ease(m.ease)((t - m.t) / m.d)
      let cx, cy, s
      if (m.path === 'zoom') {
        const p = zoomPath([from.cx, from.cy, SW / from.s], [to.cx, to.cy, SW / to.s], m.rho ?? 1)(k)
        ;[cx, cy, s] = [p[0], p[1], SW / p[2]]
      } else {
        s = Math.exp(lerp(Math.log(from.s), Math.log(to.s), k))
        // 让屏幕上的运动均匀：中心按缩放比例插值
        const a = 1 / from.s, b = 1 / to.s, ik = Math.abs(a - b) < 1e-6 ? k : (a - 1 / s) / (a - b)
        cx = lerp(from.cx, to.cx, ik)
        cy = lerp(from.cy, to.cy, ik)
      }
      return { cx, cy, s, rx: lerp(from.rx, to.rx, k), ry: lerp(from.ry, to.ry, k) }
    }
    if (!camCache.has(i)) camCache.set(i, viewOf(m.to))
    st = camCache.get(i)
    arrive = m.t + m.d
    drift = m.drift || 0
    drift_d = m.driftD || 8
  }
  return drifted(st, t - arrive)
}
let CAM = FULL
const worldTf = () => `translate(${SW / 2}px,${SH / 2}px) perspective(2600px) rotateX(${CAM.rx}deg) rotateY(${CAM.ry}deg) scale(${CAM.s}) translate(${-CAM.cx}px,${-CAM.cy}px)`
const W2S = (x, y) => [SW / 2 + (x - CAM.cx) * CAM.s, SH / 2 + (y - CAM.cy) * CAM.s]
const A2S = (x, y) => W2S(x + OX, y + OY)
const rectS = r => {
  const [x, y] = A2S(r.x, r.y)
  return { x, y, w: r.w * CAM.s, h: r.h * CAM.s }
}

// ---------- 光标 ----------
const curCache = new Map()
function curAt(t) {
  let pos = TL.curStart || [AW * 0.62, AH * 0.7]
  let vis = 0, press = 0, ripple = null
  for (let i = 0; i < TL.cur.length; i++) {
    const c = TL.cur[i]
    if (t < c.t) break
    if (c.show !== undefined) {
      const k = EASE.io(win01(t, c.t, 0.35))
      vis = c.show ? Math.max(vis, k) : Math.min(vis, 1 - k)
      if (c.at) pos = c.at
    }
    if (c.click) {
      const dt = t - c.t
      if (dt < 0.22) press = Math.sin((dt / 0.22) * Math.PI)
      if (dt < 0.6) ripple = { k: dt / 0.6, pos }
    }
    if (c.to) {
      const aim = () => {
        const r = appRect(c.to.target ?? c.to)
        const at = c.to.at || [0.5, 0.5]
        return r ? [r.x + r.w * at[0] + (c.to.dx || 0), r.y + r.h * at[1] + (c.to.dy || 0)] : null
      }
      if (!curCache.has(i)) curCache.set(i, { from: pos })
      const ent = curCache.get(i)
      const done = t >= c.t + (c.d || 0.9)
      if (done && !ent.to) ent.to = aim() || ent.last || ent.from
      const from = ent.from
      const to = done ? ent.to : (ent.last = aim() || ent.last || from)
      const k = EASE.move(win01(t, c.t, c.d || 0.9))
      const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2
      const dx = to[0] - from[0], dy = to[1] - from[1]
      const bend = (c.bend ?? 0.12) * (i % 2 ? 1 : -1)
      const px = mx - dy * bend, py = my + dx * bend
      pos = [(1 - k) * (1 - k) * from[0] + 2 * (1 - k) * k * px + k * k * to[0], (1 - k) * (1 - k) * from[1] + 2 * (1 - k) * k * py + k * k * to[1]]
    }
  }
  return { pos, vis, press, ripple }
}

// ---------- 输入事件（交给渲染端执行） ----------
let lastT = -1
let mouseDown = false
let lastMouse = null
const scrollFrom = new Map()
// 应用里的 scrollIntoView 会连带滚动导演页的窗口容器，每帧归零，否则画面与点击都会错位
function pinScroll() {
  for (const el of [document.querySelector('.win-body'), $('#stage'), $('#world'), document.scrollingElement]) if (el && (el.scrollTop || el.scrollLeft)) { el.scrollTop = 0; el.scrollLeft = 0 }
}
function input(t) {
  pinScroll()
  const ops = []
  const fired = e => lastT < e.t && e.t <= t
  for (const a of TL.acts || []) {
    if (a.nav && fired(a)) ops.push({ op: 'nav', url: a.nav, ready: a.ready, label: a.label })
    if (a.js && fired(a)) a.js(AWIN(), ADOC())
    if (a.scroll && t >= a.t && lastT < a.t + a.d) {
      const el = ADOC()?.querySelector(a.scroll.sel)
      if (el) {
        if (!scrollFrom.has(a)) {
          let to = a.scroll.to
          if (a.scroll.el) {
            const tg = ADOC().querySelector(a.scroll.el)
            const top = el === ADOC().documentElement ? 0 : el.getBoundingClientRect().top
            to = tg ? tg.getBoundingClientRect().top - top + el.scrollTop - (a.scroll.offset ?? 90) : el.scrollTop
          }
          scrollFrom.set(a, [el.scrollTop, Math.max(0, to)])
        }
        const [s0, s1] = scrollFrom.get(a)
        el.scrollTop = lerp(s0, s1, ease(a.ease || 'io')(win01(t, a.t, a.d)))
      }
    }
    if (a.upload && fired(a)) ops.push({ op: 'upload', sel: a.upload.sel, file: a.upload.file })
    if (a.key && fired(a)) ops.push({ op: 'press', key: a.key })
    if (a.hash && fired(a)) AWIN().location.hash = a.hash
    if (a.media && t >= a.t && lastT < a.t + a.d) {
      const el = ADOC()?.querySelector(a.media.sel || 'audio')
      if (el) {
        el.muted = true
        const want = (a.media.from || 0) + (t - a.t) * (a.media.rate || 1)
        if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want
      }
    }
    // 逐行显露：模型结果一次到位，画面上按时长从上往下揭开（片中代替流式输出）
    if (a.reveal && t >= a.t - 0.05 && lastT < a.t + a.d + 0.1) {
      const el = ADOC()?.querySelector(a.reveal)
      if (el) el.style.clipPath = t >= a.t + a.d ? '' : `inset(0 0 ${(1 - ease(a.ease || 'lin')(win01(t, a.t, a.d))) * 100}% 0)`
    }
    if (a.type && t >= a.t) {
      const n0 = Math.floor(Math.max(0, lastT - a.t) * a.cps), n1 = Math.floor((t - a.t) * a.cps)
      const s = [...a.type].slice(n0, n1).join('')
      if (s && lastT < a.t + a.type.length / a.cps + 0.1) ops.push({ op: 'type', text: s })
    }
  }
  // 光标位置换算成页面坐标，交给真实鼠标（悬停、点击都由应用自己响应）
  CAM = camAt(t)
  // 先把镜头摆到这一帧，鼠标事件的命中位置才与换算一致（镜头运动中点击不会偏一帧）
  $('#world').style.transform = worldTf()
  const c = curAt(t)
  const [sx, sy] = A2S(c.pos[0], c.pos[1])
  const m = [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10]
  // 先松开再移动，按下与松开必须落在同一个元素上
  for (const k of TL.cur) {
    if (k.click && mouseDown && lastT < k.t + 0.09 && t >= k.t + 0.09) ops.push({ op: 'up' }), (mouseDown = false)
  }
  if (!lastMouse || m[0] !== lastMouse[0] || m[1] !== lastMouse[1]) {
    ops.push({ op: 'move', x: m[0], y: m[1] })
    lastMouse = m
  }
  for (const k of TL.cur) {
    if (k.click && fired(k)) {
      if (m[0] < 0 || m[1] < 0 || m[0] > SW || m[1] > SH) console.warn('CLICK OFFSCREEN', t.toFixed(2), JSON.stringify(m))
      if (c.pos[0] < 0 || c.pos[1] < 0 || c.pos[0] > AW || c.pos[1] > AH) console.warn('CLICK OUTSIDE APP', t.toFixed(2), JSON.stringify(c.pos.map(Math.round)))
      if (TL.debugClicks) { const e = ADOC()?.elementFromPoint(c.pos[0], c.pos[1]); const top = document.elementFromPoint(m[0], m[1]); console.warn('CLICKAT', t.toFixed(2), JSON.stringify(c.pos.map(Math.round)), 'top=' + (top ? top.tagName + '#' + top.id + '.' + String(top.className).slice(0, 30) : 'none'), e ? e.tagName + '.' + String(e.className).slice(0, 60) + ' «' + (e.innerText || '').slice(0, 20) + '»' : 'none') }
      ops.push({ op: 'down' }), (mouseDown = true)
    }
  }
  lastT = t
  return ops
}

// ---------- 虚拟时钟下的 CSS 动画 ----------
const born = new WeakMap()
// 片中不出现的界面元素：比如演示环境的降级提示、调试条（配置里写选择器与包含的文字）
const HIDE_SEL = (CFG.hide?.selectors || []).join(', ')
const HIDE_TXT = CFG.hide?.texts || []
function syncAnims() {
  const doc = ADOC()
  if (!doc) return 0
  if (HIDE_SEL) for (const a of doc.querySelectorAll(HIDE_SEL)) if (!HIDE_TXT.length || HIDE_TXT.some(h => a.innerText.includes(h))) a.style.display = 'none'
  const now = performance.now()
  let n = 0
  for (const a of doc.getAnimations()) {
    let b = born.get(a)
    if (b === undefined) {
      b = now
      born.set(a, b)
    }
    const ct = (now - b) * (a.playbackRate || 1)
    const end = a.effect?.getComputedTiming().endTime
    if (Number.isFinite(end) && ct >= end) {
      a.finish()
      continue
    }
    if (a.playState !== 'paused') a.pause()
    a.currentTime = ct
    n++
  }
  return n
}

// ---------- 画面元素 ----------
const hud = $('#hud'), cards = $('#cards')
const coEls = (TL.callouts || []).map(c => {
  const el = document.createElement('div')
  el.className = 'co'
  el.innerHTML = `<div class="co-line"></div><div class="co-dot"></div><div class="co-chip">${c.text}${c.sub ? `<small>${c.sub}</small>` : ''}</div>`
  hud.appendChild(el)
  return el
})
// 背景：静态图或视频序列帧（seq: {dir, n, fps}，帧名 0001.jpg 起）
const bgEl = (c, cls) => (c.seq ? `<img class="${cls} seq" alt="">` : `<div class="${cls}" style="background-image:url(${c.bg})"></div>`)
const pending = []
// 手机上用指尖圆点代替箭头
const TOUCH = isPhone
if (TOUCH) $('#cursor').innerHTML = '<circle cx="17" cy="17" r="13" fill="rgba(255,255,255,.28)" stroke="rgba(255,255,255,.95)" stroke-width="2"/>'
function seqFrame(img, seq, lt) {
  const i = clamp(Math.floor(lt * seq.fps * (seq.rate || 1)) + (seq.from || 0), 0, seq.n - 1) + 1
  const src = `${seq.dir}/${String(i).padStart(4, '0')}.jpg`
  if (img.dataset.src !== src) {
    img.dataset.src = src
    img.src = src
    pending.push(img.decode().catch(() => {}))
  }
}
const cardEls = (TL.cards || []).map(c => {
  const el = document.createElement('div')
  el.className = 'card ' + c.kind
  if (c.kind === 'title') {
    el.innerHTML = `${bgEl(c, 'title-bg')}<div class="title-shade"></div>
      ${c.logo ? `<img class="title-logo" src="${c.logo}" alt="">` : ''}<div class="title-text"><div class="title-k">${c.k || ''}</div><div class="title-h">${[...c.h].map(ch => `<span style="display:inline-block">${ch}</span>`).join('')}</div>${c.en ? `<div class="title-en">${c.en}</div>` : ''}
      <div class="title-rule"></div><div class="title-items">${(c.items || []).map((x, i) => `<span><b>0${i + 1}</b>${x}</span>`).join('')}</div></div>
      <div class="title-foot">${c.foot || ''}</div>`
  } else if (c.kind === 'lower') {
    el.innerHTML = `<div class="lw"><span class="lw-k">${c.k || ''}</span><b>${c.name}</b>${c.sub ? `<small>${c.sub}</small>` : ''}</div>`
  } else if (c.kind === 'diagram') {
    // 接入示意图：框、节点、连线（屏幕坐标），各自按时间出现
    el.innerHTML = `${c.seq ? bgEl(c, 'note-bg') : ''}<div class="dg-shade"></div><div class="dg-title">${c.title || ''}</div>
      <svg class="dg-svg" width="1920" height="1080">${(c.edges || []).map(e => `<path d="${e.d}" class="dg-edge${e.dash ? ' dash' : ''}"/>`).join('')}</svg>
      ${(c.boxes || []).map(b => `<div class="dg-box" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span>${b.label}</span></div>`).join('')}
      ${(c.nodes || []).map(n => `<div class="dg-node${n.core ? ' core' : ''}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px"><b>${n.title}</b><small>${n.sub || ''}</small></div>`).join('')}
      ${(c.edges || []).filter(e => e.label).map(e => `<div class="dg-label" style="left:${e.lx}px;top:${e.ly}px">${e.label}</div>`).join('')}`
  } else if (c.kind === 'float') {
    el.innerHTML = `<img class="float-img" src="${c.src}" style="width:${c.w}px">`
  } else if (c.kind === 'broll') {
    el.innerHTML = `${bgEl(c, 'note-bg')}<div class="broll-shade"></div>`
  } else if (c.kind === 'note') {
    el.innerHTML = `${c.seq || c.bg ? bgEl(c, 'note-bg') : ''}${c.seq || c.bg ? '<div class="note-shade"></div>' : ''}<div class="note-in${c.small ? ' small' : ''}">${c.lines.map(l => `<p>${l}</p>`).join('')}</div>`
  } else {
    // 章节图标：时间轴里直接给 { bg, svg }
    const mk = c.mark
    el.innerHTML = `${bgEl(c, 'chap-bg')}<div class="chap-shade"></div>
      <div class="chap-in"><div class="chap-no">${c.no}</div><div class="chap-sep"></div><div>
      ${mk ? `<div class="chap-mark" style="background:${mk.bg}">${mk.svg}</div>` : ''}${c.en ? `<div class="chap-en">${c.en}</div>` : ''}<div class="chap-name">${c.name}</div><div class="chap-sub">${c.sub || ''}</div></div></div>`
  }
  el.style.zIndex = c.z ?? { lower: 5, title: 4, chap: 4, broll: 2, note: 3 }[c.kind] ?? 1
  cards.appendChild(el)
  return el
})

// 字幕：切分规则在 dsl.js 的 subtitles()，交付时导出 SRT 用的是同一份
const SUB_MAX = CFG.subtitle?.maxChars ?? 20
const SUBS = (await import('./dsl.js')).subtitles(TL, VO, SUB_MAX)
// 不烧字幕的画面（交给剪辑软件，字幕单独成轨）：渲染时加 --nosub
const NOSUB = !!params.get('nosub')
if (NOSUB) $('#subwrap').style.display = 'none'
for (const s of SUBS) if (s.n > SUB_MAX) console.warn('SUB OVERFLOW', `${s.t.toFixed(1)} 字幕一条 ${s.n} 字，超过 ${SUB_MAX} 字（旁白这里缺标点，或者句子太长）：${s.raw}`)

// 聚焦开始时目标若有一部分在所在滚动区域之外，平滑滚到完整可见
function findTarget(tg) {
  const spec = typeof tg === 'string' ? { sel: tg } : Array.isArray(tg) ? (typeof tg[0] === 'string' ? { sel: tg[0] } : tg[0]) : tg
  if (!spec?.sel) return null
  let els = [...(ADOC()?.querySelectorAll(spec.sel) || [])]
  if (spec.text) els = els.filter(e => (e.innerText || e.textContent || '').includes(spec.text))
  return els[spec.nth || 0] || null
}
function scrollParent(e) {
  for (let n = e.parentElement; n && n !== ADOC().body; n = n.parentElement) {
    const cs = AWIN().getComputedStyle(n)
    if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n
  }
  return ADOC().scrollingElement
}
const SCROLLS = (TL.acts || []).filter(a => a.scroll)
const scrollBusy = (a, b) => SCROLLS.some(x => x.t < b && x.t + x.d > a)
function ensureVisible(t) {
  for (const f of TL.focus || []) {
    const end = f.t + f.d
    // 聚焦结束：滚动还原，除非紧接着还有聚焦或编排里本来就有滚动
    if (f._sc && t > end) {
      if (f._rs === undefined) {
        const next = (TL.focus || []).some(g => g !== f && g.t >= end - 0.2 && g.t <= end + 0.6)
        f._rs = next || scrollBusy(end, end + 1.2) ? null : { from: f._sc.c.scrollTop, to: f._sc.from, t0: t }
      }
      if (f._rs && t <= f._rs.t0 + 0.8) f._sc.c.scrollTop = lerp(f._rs.from, f._rs.to, EASE.io(win01(t, f._rs.t0, 0.7)))
      continue
    }
    if (t < f.t || t > end || f.noScroll) continue
    if (f._sc === undefined) {
      if (scrollBusy(f.t - 1.0, f.t + 1.0)) { f._sc = null; continue }
      if (t > f.t + 1.5) { f._sc = null; continue }
      const el = findTarget(f.target)
      if (!el) continue
      const c = scrollParent(el)
      if (!c) { f._sc = null; continue }
      const root = c === ADOC().scrollingElement
      const cr = root ? { top: 0, bottom: AH } : c.getBoundingClientRect()
      const top = Math.max(0, cr.top), bottom = Math.min(AH, cr.bottom)
      const r = el.getBoundingClientRect()
      if (AWIN().getComputedStyle(el).position === 'fixed' || (r.top >= top + 6 && r.bottom <= bottom - 6)) { f._sc = null; continue }
      const room = bottom - top
      const delta = r.height < room - 80 ? (r.top < top ? r.top - top - 40 : r.bottom - bottom + 70) : r.top - top - 40
      f._sc = { c, from: c.scrollTop, to: Math.max(0, Math.min(c.scrollHeight - c.clientHeight, c.scrollTop + delta)), t0: t }
    }
    if (f._sc && t <= f._sc.t0 + 0.9) f._sc.c.scrollTop = lerp(f._sc.from, f._sc.to, EASE.io(win01(t, f._sc.t0, 0.8)))
  }
}

let lastPaintT = null
function paint(t) {
  ensureVisible(t)
  pinScroll()
  CAM = camAt(t)
  $('#world').style.transform = worldTf()
  // 背景光斑缓慢漂移
  const g1 = $('#bg .g1'), g2 = $('#bg .g2')
  g1.style.transform = `translate(${-200 + Math.sin(t * 0.13) * 160}px, ${-420 + Math.cos(t * 0.11) * 90}px)`
  g2.style.transform = `translate(${1200 + Math.cos(t * 0.09) * 180}px, ${520 + Math.sin(t * 0.12) * 80}px)`
  $('#bg .grid').style.transform = `translate(${(-CAM.cx * 0.04) % 64}px, ${(-CAM.cy * 0.04) % 64}px)`
  const ut = $('#urltext')
  if (ut) ut.textContent = TL.urlLabel?.(t) ?? ''

  // 聚焦
  const fs = TL.focus || []
  let fo = 0, fr = null
  const dtp = lastPaintT === null ? 0 : Math.max(0, t - lastPaintT)
  for (let i = 0; i < fs.length; i++) {
    const f = fs[i]
    if (t < f.t || t > f.t + f.d) continue
    const prev = fs[i - 1]
    const chained = prev && prev.t + prev.d >= f.t - 0.05
    const next = fs[i + 1]
    const chainedOut = next && f.t + f.d >= next.t - 0.05
    const kin = chained ? 1 : EASE.io(win01(t, f.t, 0.45))
    const kout = chainedOut ? 1 : 1 - EASE.io(win01(t, f.t + f.d - 0.4, 0.4))
    fo = Math.min(kin, kout)
    let ar = appRect(f.target)
    f._p = Math.max(0, Math.min(1, (f._p ?? (ar ? 1 : 0)) + (ar ? 1 : -1) * dtp / 0.3))
    if (ar) f._last = ar
    else {
      if (t > f.t + 0.3 && t < f.t + f.d - 0.3 && Math.round(t * 10) % 5 === 0) console.warn('FOCUS EMPTY', t.toFixed(1), JSON.stringify(f.target).slice(0, 90))
      if (!f._last || f._p <= 0) continue
      ar = f._last
    }
    if (ar.w * ar.h < 1600 && Math.round(t * 10) % 5 === 0) console.warn('FOCUS TINY', t.toFixed(1), JSON.stringify(f.target).slice(0, 90))
    const r = rectS(ar)
    const pad = (f.pad ?? 10) * CAM.s
    let R = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }
    if (chained) {
      const pr = rectS(appRect(prev.target) || prev._last || ar), pp = (prev.pad ?? 10) * CAM.s
      const P = { x: pr.x - pp, y: pr.y - pp, w: pr.w + 2 * pp, h: pr.h + 2 * pp }
      const k = EASE.cam(win01(t, f.t, 0.6))
      R = { x: lerp(P.x, R.x, k), y: lerp(P.y, R.y, k), w: lerp(P.w, R.w, k), h: lerp(P.h, R.h, k) }
    } else {
      const g = (1 - EASE.out(win01(t, f.t, 0.7))) * 36
      R = { x: R.x - g, y: R.y - g, w: R.w + 2 * g, h: R.h + 2 * g }
    }
    fo *= EASE.io(f._p)
    fr = { ...R, rad: (f.radius ?? 10) * CAM.s }
  }
  const focus = $('#focus'), ring = $('#ring')
  focus.style.opacity = fo
  ring.style.opacity = fo
  if (fr) {
    const p = `M0 0H${SW}V${SH}H0Z M${fr.x + fr.rad} ${fr.y}H${fr.x + fr.w - fr.rad}A${fr.rad} ${fr.rad} 0 0 1 ${fr.x + fr.w} ${fr.y + fr.rad}V${fr.y + fr.h - fr.rad}A${fr.rad} ${fr.rad} 0 0 1 ${fr.x + fr.w - fr.rad} ${fr.y + fr.h}H${fr.x + fr.rad}A${fr.rad} ${fr.rad} 0 0 1 ${fr.x} ${fr.y + fr.h - fr.rad}V${fr.y + fr.rad}A${fr.rad} ${fr.rad} 0 0 1 ${fr.x + fr.rad} ${fr.y}Z`
    const m = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${SW}' height='${SH}'><path fill-rule='evenodd' fill='#000' d='${p}'/></svg>`)}")`
    focus.style.maskImage = m
    focus.style.webkitMaskImage = m
    Object.assign(ring.style, { left: fr.x - 2 + 'px', top: fr.y - 2 + 'px', width: fr.w + 4 + 'px', height: fr.h + 4 + 'px', borderRadius: fr.rad + 2 + 'px' })
  }

  // 标注
  ;(TL.callouts || []).forEach((c, i) => {
    const el = coEls[i]
    if (t < c.t || t > c.t + c.d) return (el.style.opacity = 0)
    let ar = appRect(c.target)
    c._p = Math.max(0, Math.min(1, (c._p ?? (ar ? 1 : 0)) + (ar ? 1 : -1) * dtp / 0.3))
    if (ar) c._last = ar
    else {
      if (t > c.t + 0.3 && t < c.t + c.d - 0.3 && Math.round(t * 10) % 5 === 0) console.warn('CALLOUT EMPTY', t.toFixed(1), JSON.stringify(c.target).slice(0, 90))
      if (!c._last || c._p <= 0) return (el.style.opacity = 0)
      ar = c._last
    }
    const r = rectS(ar)
    const side = c.side || 'right'
    const at = c.at ?? 0.5
    const anchor = side === 'right' ? [r.x + r.w, r.y + r.h * at] : side === 'left' ? [r.x, r.y + r.h * at] : side === 'top' ? [r.x + r.w * at, r.y] : [r.x + r.w * at, r.y + r.h]
    const off = c.off || (side === 'right' ? [90, -36] : side === 'left' ? [-90, -36] : side === 'top' ? [40, -110] : [40, 90])
    const chip = el.querySelector('.co-chip'), line = el.querySelector('.co-line'), dot = el.querySelector('.co-dot')
    const cw = chip.offsetWidth, ch = chip.offsetHeight
    const cx = anchor[0] + off[0] - (off[0] < 0 ? cw : 0), cy = anchor[1] + off[1] - ch / 2
    const end = [off[0] < 0 ? cx + cw : cx, cy + ch / 2]
    const kd = EASE.out(win01(t, c.t, 0.3)), kl = EASE.out(win01(t, c.t + 0.12, 0.42)), kc = EASE.out(win01(t, c.t + 0.3, 0.5))
    const ko = 1 - EASE.io(win01(t, c.t + c.d - 0.35, 0.35))
    el.style.opacity = ko * EASE.io(c._p)
    Object.assign(dot.style, { left: anchor[0] + 'px', top: anchor[1] + 'px', transform: `scale(${kd})` })
    const len = Math.hypot(end[0] - anchor[0], end[1] - anchor[1])
    Object.assign(line.style, { left: anchor[0] + 'px', top: anchor[1] + 'px', width: len + 'px', transform: `rotate(${Math.atan2(end[1] - anchor[1], end[0] - anchor[0])}rad) scaleX(${kl})` })
    Object.assign(chip.style, { left: cx + 'px', top: cy + 'px', opacity: kc, transform: `translate(${(1 - kc) * (off[0] < 0 ? -18 : 18)}px, 0)` })
    // 完全出场后的位置留给版面检查
    c._chip = kc > 0.98 && ko > 0.98 && c._p > 0.98 ? { x: cx, y: cy, w: cw, h: ch, target: r } : null
  })

  // 光标
  const c = curAt(t)
  const [x, y] = A2S(c.pos[0], c.pos[1])
  window.__dbg = { pos: c.pos.map(Math.round), scr: [Math.round(x), Math.round(y)], vis: +c.vis.toFixed(2) }
  const cur = $('#cursor')
  cur.style.opacity = c.vis
  cur.style.transform = TOUCH ? `translate(${x - 17}px, ${y - 17}px) scale(${1 - 0.2 * c.press})` : `translate(${x - 7}px, ${y - 3.5}px) scale(${1 - 0.12 * c.press})`
  const rp = $('#ripple')
  if (c.ripple) {
    const [rx, ry] = A2S(c.ripple.pos[0], c.ripple.pos[1])
    rp.style.left = rx + 'px'
    rp.style.top = ry + 'px'
    rp.style.opacity = (1 - c.ripple.k) * 0.9
    rp.style.transform = `scale(${0.3 + EASE.out(c.ripple.k) * 0.9})`
  } else rp.style.opacity = 0

  // 字幕
  const s = SUBS.find(s => t >= s.t && t < s.t + s.d + 0.05)
  const subOn = SUBS.some(s => t >= s.t - 0.2 && t < s.t + s.d + 0.4)
  $('#subwrap').style.opacity = subOn ? 1 : 0
  $('#sub').textContent = s ? s.text : ''
  $('#sub').style.opacity = s ? EASE.io(win01(t, s.t, 0.12)) : 0
  checkLayout(t, s)
  measureText(t)

  // 片头与章节卡
  ;(TL.cards || []).forEach((c, i) => paintCard(cardEls[i], c, t))

  // 常驻角标：片头、章节卡、空镜、字幕卡在场时让开
  const badge = $('#badge')
  if (badge.getAttribute('src')) {
    const covered = (TL.cards || []).some((c, i) => c.kind !== 'lower' && c.kind !== 'float' && +cardEls[i].style.opacity > 0.05)
    badge.style.opacity = covered || TL.noBadge ? 0 : 0.92
  }

  // 黑场
  let fade = 0
  for (const f of TL.fades || []) if (t >= f.t && t <= f.t + f.d) fade = lerp(f.from, f.to, EASE.io(win01(t, f.t, f.d)))
    else if (t > f.t + f.d) fade = f.to
  $('#fade').style.opacity = fade
  lastPaintT = t
}

// 版面检查：字幕折行或出画、标注出画、标注压住字幕或自己指的目标。每处只报一次
const REPORTED = new Set()
const once = (key, kind, msg) => REPORTED.has(key) || (REPORTED.add(key), console.warn(kind, msg))
const hit = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
function checkLayout(t, s) {
  let sr = null
  if (s && !NOSUB) {
    const el = $('#sub'), b = el.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 51
    // 字幕每条长短不一，按整行最大宽度、上方再留 24 像素算字幕区
    const mw = parseFloat(getComputedStyle(el).maxWidth) || 1500
    sr = { x: (SW - mw) / 2, y: b.top - 24, w: mw, h: b.height + 24 }
    if (b.height > lh * 1.4 || b.left < 0 || b.right > SW) once('sub' + s.t, 'SUB OVERFLOW', `${t.toFixed(1)} 字幕折行或出画：${s.text}`)
  }
  ;(TL.callouts || []).forEach((c, i) => {
    const k = c._chip
    if (!k) return
    const name = (c.text || '').replace(/<[^>]+>/g, '')
    if (k.x < 0 || k.y < 0 || k.x + k.w > SW || k.y + k.h > SH) once('clip' + i, 'CALLOUT CLIPPED', `${t.toFixed(1)} 标注出画：${name}`)
    if (sr && hit(k, sr) > 0) once('sub' + i, 'OVERLAP', `${t.toFixed(1)} 标注压住字幕：${name}`)
    const tr = k.target
    if (tr && hit(k, tr) > 0.15 * tr.w * tr.h) once('tg' + i, 'OVERLAP', `${t.toFixed(1)} 标注挡住它指的目标：${name}`)
  })
}

// 远看可读性：记下要看清的字在成片上的字号（像素），交付检查按观看距离判断够不够大。
// 要看清的：字幕、标注、模块名、章节名、片头标题与模块、片头说明、示意图节点名、字幕卡；装饰性的英文小标、编号不算
const MUST = { '#sub': '字幕', '.co-chip': '标注', '.lw b': '模块名', '.chap-name': '章节名', '.title-h': '片头标题', '.title-items span': '片头模块', '.title-foot': '片头说明', '.dg-node b': '示意图节点', '.note-in p': '字幕卡' }
const MEASURED = new Set()
const report = (key, o) => MEASURED.has(key) || (MEASURED.add(key), console.log('MEASURE ' + JSON.stringify(o)))
const shown = el => {
  let o = 1
  for (let e = el; e && e !== document.body; e = e.parentElement) o *= +getComputedStyle(e).opacity
  return o > 0.9
}
function targetEls(tg) {
  if (!tg || tg === 'full' || tg.rect || tg.wrect) return []
  if (Array.isArray(tg)) return tg.flatMap(targetEls)
  const spec = typeof tg === 'string' ? { sel: tg } : tg
  let els = [...(ADOC()?.querySelectorAll(spec.sel) || [])]
  if (spec.text) els = els.filter(e => (e.innerText || e.textContent || '').includes(spec.text))
  return spec.all ? els : els[spec.nth || 0] ? [els[spec.nth || 0]] : []
}
function measureText(t) {
  for (const [sel, what] of Object.entries(MUST))
    document.querySelectorAll(sel).forEach((el, i) => {
      if (MEASURED.has(sel + i) || !el.textContent.trim()) return
      const b = el.getBoundingClientRect()
      if (!b.width || !b.height || b.right < 0 || b.left > SW || b.bottom < 0 || b.top > SH || !shown(el)) return
      const k = el.offsetHeight ? b.height / el.offsetHeight : 1
      report(sel + i, { kind: 'overlay', what, t: +t.toFixed(1), px: +(parseFloat(getComputedStyle(el).fontSize) * k).toFixed(1), text: el.textContent.trim().slice(0, 24) })
    })
  // 聚焦的界面内容：完全亮起、镜头停稳后量一次，取框里最大的字
  ;(TL.focus || []).forEach((f, i) => {
    if (MEASURED.has('focus' + i) || !(f._p >= 0.98) || t < f.t + 0.6 || t > f.t + f.d) return
    let max = 0, txt = ''
    for (const root of targetEls(f.target)) {
      const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentElement
        if (!n.textContent.trim() || !p || !p.getClientRects().length) continue
        const fs = parseFloat(p.ownerDocument.defaultView.getComputedStyle(p).fontSize)
        if (fs > max) (max = fs), (txt = n.textContent.trim())
      }
    }
    if (max) report('focus' + i, { kind: 'focus', what: '聚焦', t: +t.toFixed(1), from: +f.t.toFixed(2), to: +(f.t + f.d).toFixed(2), px: +(max * CAM.s).toFixed(1), text: txt.slice(0, 24) })
  })
}

function paintCard(el, c, t) {
  const lt = t - c.t
  if (lt < -0.01 || lt > c.d + c.outD) return (el.style.opacity = 0)
  if (c.kind === 'lower') {
    // 左下角模块名：竖线先长出，文字随后滑入
    const kin = EASE.out(win01(lt, 0, 0.7)), kout = 1 - EASE.io(win01(lt, c.d, c.outD))
    el.style.opacity = Math.min(1, kin * 1.4) * kout
    const lw = el.querySelector('.lw')
    lw.style.setProperty('--bar', kin)
    lw.style.transform = `translateX(${(1 - kin) * -30}px)`
    return
  }
  if (c.kind === 'diagram') {
    el.style.opacity = Math.min(EASE.io(win01(lt, 0, 0.9)), 1 - EASE.io(win01(lt, c.d, c.outD)))
    if (c.seq) { seqFrame(el.querySelector('.note-bg'), c.seq, lt); el.querySelector('.note-bg').style.transform = `scale(${1.06 - 0.05 * win01(lt, 0, c.d + c.outD)})` }
    const ti = el.querySelector('.dg-title'), qt = EASE.out(win01(lt, 0.3, 0.9)); ti.style.opacity = qt; ti.style.transform = `translateY(${(1 - qt) * 14}px)`
    el.querySelectorAll('.dg-box').forEach((b, i) => { const q = EASE.out(win01(lt, c.boxes[i].t, 0.8)); b.style.opacity = q; b.style.transform = `scale(${0.97 + 0.03 * q})` })
    el.querySelectorAll('.dg-node').forEach((b, i) => { const q = EASE.out(win01(lt, c.nodes[i].t, 0.7)); b.style.opacity = q; b.style.transform = `translateY(${(1 - q) * 18}px)`; b.classList.toggle('lit', lt >= (c.nodes[i].lit ?? 1e9)) })
    el.querySelectorAll('.dg-edge').forEach((p, i) => { const e = c.edges[i]; const L = (p._len ??= p.getTotalLength()); const q = EASE.io(win01(lt, e.t, e.dur ?? 0.9)); p.style.strokeDasharray = e.dash ? `6 8` : `${L} ${L}`; p.style.strokeDashoffset = e.dash ? `${-lt * 30}` : `${L * (1 - q)}`; p.style.opacity = e.dash ? q : Math.min(1, q * 3) })
    el.querySelectorAll('.dg-label').forEach((l, i) => { const e = c.edges.filter(e => e.label)[i]; const q = EASE.out(win01(lt, e.t + (e.dur ?? 0.9) * 0.6, 0.6)); l.style.opacity = q; l.style.transform = `translate(-50%, ${(1 - q) * 8}px)` })
    return
  }
  if (c.kind === 'float') {
    // 实物照片从画面外滑入、轻微倾斜，停留后淡出（位置是屏幕坐标）
    const kin = EASE.out(win01(lt, 0, 0.8)), kout = EASE.io(win01(lt, c.d, c.outD))
    el.style.opacity = Math.min(1, kin * 1.3) * (1 - kout)
    const img = el.querySelector('.float-img')
    img.style.transform = `translate(${c.x + (1 - kin) * 260}px, ${c.y + (1 - kin) * 120 - kout * 40}px) rotate(${(c.rot ?? -6) + (1 - kin) * 10}deg) scale(${1 - 0.04 * kout})`
    return
  }
  if (c.kind === 'broll') {
    el.style.opacity = Math.min(EASE.io(win01(lt, 0, c.inD ?? 0.9)), 1 - EASE.io(win01(lt, c.d, c.outD)))
    seqFrame(el.querySelector('.note-bg'), c.seq, lt)
    el.querySelector('.note-bg').style.transform = `scale(${1.07 - 0.06 * win01(lt, 0, c.d + c.outD)}) translateX(${(c.pan || 0) * win01(lt, 0, c.d + c.outD)}px)`
    return
  }
  if (c.kind === 'note') {
    const kin = EASE.io(win01(lt, 0, 1.6)), kout = 1 - EASE.io(win01(lt, c.d, c.outD))
    el.style.opacity = Math.min(EASE.io(win01(lt, 0, 1.0)), kout)
    if (c.seq) seqFrame(el.querySelector('.note-bg'), c.seq, lt)
    const bg = el.querySelector('.note-bg')
    if (bg) bg.style.transform = `scale(${1.06 - 0.05 * win01(lt, 0, c.d + c.outD)})`
    el.querySelectorAll('.note-in p').forEach((p, i) => {
      const q = EASE.io(win01(lt, (c.at || 1.2) + i * 1.4, 2.2))
      p.style.opacity = q
      p.style.filter = `blur(${(1 - q) * 6}px)`
      p.style.transform = `translateY(${(1 - q) * 10}px)`
    })
    return
  }
  if (c.kind === 'title') {
    // 开场卡从第 0 帧起就盖满，淡入交给黑场，免得底下的界面透出来
    const kin = c.cover ? 1 : EASE.io(win01(lt, 0, 0.8))
    const kout = 1 - EASE.io(win01(lt, c.d, c.outD))
    el.style.opacity = Math.min(kin, kout)
    el.style.transform = `scale(${1 + 0.04 * EASE.in(win01(lt, c.d, c.outD))})`
    if (c.seq) seqFrame(el.querySelector('.title-bg'), c.seq, lt)
    el.querySelector('.title-bg').style.transform = `scale(${1.12 - 0.08 * EASE.io(win01(lt, 0, c.d + c.outD))}) translateX(${-20 * win01(lt, 0, c.d)}px)`
    const k = el.querySelector('.title-k'), kk = EASE.out(win01(lt, 0.4, 0.9))
    k.style.opacity = kk
    k.style.letterSpacing = 8 + (1 - kk) * 10 + 'px'
    el.querySelectorAll('.title-h span').forEach((s, i) => {
      const q = EASE.out(win01(lt, 0.7 + i * 0.07, 0.8))
      s.style.opacity = q
      s.style.transform = `translateY(${(1 - q) * 34}px)`
      s.style.filter = `blur(${(1 - q) * 8}px)`
    })
    const en = el.querySelector('.title-en')
    if (en) { const qe = EASE.out(win01(lt, 1.3, 1.0)); en.style.opacity = qe; en.style.transform = `translateY(${(1 - qe) * 12}px)` }
    el.querySelector('.title-rule').style.transform = `scaleX(${EASE.out(win01(lt, 1.5, 1.1))})`
    el.querySelectorAll('.title-items span').forEach((s, i) => {
      const q = EASE.out(win01(lt, 1.9 + i * 0.28, 0.7))
      s.style.opacity = q
      s.style.transform = `translateY(${(1 - q) * 16}px)`
    })
    el.querySelector('.title-foot').style.opacity = EASE.io(win01(lt, 2.8, 0.8))
  } else {
    // 章节卡：从右侧擦入，停留，向左擦出露出界面
    const kin = c.cover ? 1 : EASE.cam(win01(lt, 0, 0.7)), kout = EASE.cam(win01(lt, c.d, c.outD))
    el.style.opacity = 1
    el.style.clipPath = `inset(0 ${kout * 100}% 0 ${(1 - kin) * 100}%)`
    if (c.seq) seqFrame(el.querySelector('.chap-bg'), c.seq, lt)
    el.querySelector('.chap-bg').style.transform = `scale(${1.08 - 0.05 * win01(lt, 0, c.d + c.outD)})`
    const inner = el.querySelector('.chap-in')
    const q = EASE.out(win01(lt, 0.35, 0.8))
    inner.style.opacity = q * (1 - kout)
    inner.style.transform = `translate(${(1 - q) * 60 - kout * 80}px, -50%)`
    const no = el.querySelector('.chap-no')
    no.style.opacity = EASE.out(win01(lt, 0.45, 0.6))
  }
}

// 导航只换地址；等待加载与就绪由渲染端在 Node 侧轮询（虚拟时钟下页面计时器不走）
function nav(url) {
  app.src = url
}

window.settle = () => Promise.all(pending.splice(0))
window.TL = TL
window.input = input
window.paint = paint
window.syncAnims = syncAnims
window.nav = nav
window.SUBS = SUBS
nav(TL.url0 ?? CFG.app.url0 ?? "/")
window.CFG = CFG
window.booted = true
