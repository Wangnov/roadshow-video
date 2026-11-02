// 时间轴写法：以旁白为骨架。say() 依次排句，L.at('词') 取这句念到某个词的时刻，镜头、点击、聚焦、标注都锚在上面。
// 锚词时刻优先取配音后的逐字强制对齐（vo/<id>.json 的 words），没有对齐数据时按字数比例估算并记一条警告。

const PUNCT = /[\s，。、；：？！“”‘’（）《》【】,.;:?!"'()[\]<>…—-]/g
const plainOf = s => (s || '').replace(PUNCT, '')

// 按与引擎相同的规则找元素（脚本兜底点击用）
export function findEl(d, tg) {
  const spec = typeof tg === 'string' ? { sel: tg } : tg
  let els = [...d.querySelectorAll(spec.sel)]
  if (spec.text) els = els.filter(e => (e.innerText || e.textContent || '').includes(spec.text))
  return els[spec.nth || 0]
}

// 字幕：按标点切成不超过 max 字的短句；有逐字对齐时按真实时刻出入，没有就按字数分配时长。
// 导演页画字幕、交付时导出 SRT 都用它。返回 [{ t, d, text（显示用）, raw（原文）, n（字数） }]
export function subtitles(TL, VO, max = 20) {
  const out = []
  for (const v of TL.vo || []) {
    const meta = VO[v.id]
    const text = v.text || meta?.text || ''
    const dur = meta?.dur || text.length / 4.2
    const parts = text.split(/(?<=[，。；：？！])/).map(s => s.trim()).filter(Boolean)
    const chunks = []
    for (const p of parts) {
      const last = chunks[chunks.length - 1]
      if (last && (last + p).replace(/[，。；：？！]/g, '').length <= max && !/[。？！]$/.test(last)) chunks[chunks.length - 1] = last + p
      else chunks.push(p)
    }
    // 逐字时刻
    let chars = null
    if (Array.isArray(meta?.words) && meta.words.length) {
      chars = []
      for (const w of meta.words) {
        const cs = [...plainOf(w.c)]
        cs.forEach((ch, k) => chars.push({ s: w.s + ((w.e - w.s) * k) / cs.length, e: w.s + ((w.e - w.s) * (k + 1)) / cs.length }))
      }
      if (chars.length !== [...plainOf(text)].length) chars = null
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    let at = v.t, ci = 0
    chunks.forEach((c, j) => {
      const n = [...plainOf(c)].length
      let t0 = at, d = (dur * c.length) / total
      if (chars && n) {
        t0 = v.t + chars[ci].s
        const next = j < chunks.length - 1 && chars[ci + n] ? v.t + chars[ci + n].s : v.t + chars[ci + n - 1].e + 0.15
        d = Math.max(0.3, next - t0)
      }
      out.push({ id: v.id, t: t0, d, text: c.replace(/[，。；：]$/g, '').replace(/[，；：]/g, '　'), raw: c, n })
      at += (dur * c.length) / total
      ci += n
    })
  }
  return out
}

// 运镜禁令：推近之后至少停住这么久，才能开始下一次镜头运动
export const HOLD_AFTER_PUSH = 1.2

export function timeline(VO, base = {}) {
  const T = { vo: [], cam: [], cur: [], acts: [], focus: [], callouts: [], cards: [], fades: [], cues: [], holds: [], warnings: [], ...base }
  let now = 0
  let curShown = false
  const warn = msg => T.warnings.push(msg)
  const estimated = new Set()

  const line = (id, t) => {
    const m = VO[id] || { text: '', dur: 3 }
    if (!VO[id]) warn(`旁白 ${id} 没有配音数据，按 3 秒占位`)
    const plain = plainOf(m.text)
    // words：[{ c: '早', s: 0.12, e: 0.25 }, ...]，c 可以是一个字或一个词，s、e 是相对本句音频开头的秒数
    const words = Array.isArray(m.words) && m.words.length ? m.words : null
    let chars = null
    if (words) {
      chars = []
      for (const w of words) {
        const cs = [...plainOf(w.c)]
        cs.forEach((ch, k) => chars.push({ ch, s: w.s + ((w.e - w.s) * k) / cs.length, e: w.s + ((w.e - w.s) * (k + 1)) / cs.length }))
      }
      if (chars.map(x => x.ch).join('') !== plain) {
        warn(`旁白 ${id} 的对齐文字和原文对不上，退回按字数估算`)
        chars = null
      }
    }
    return {
      id,
      t,
      d: m.dur,
      end: t + m.dur,
      // k=0 取这个词开始念的时刻，k=1 取念完的时刻
      at(ph, k = 0) {
        const p = plainOf(ph)
        const i = plain.indexOf(p)
        if (i < 0) throw new Error(`${id} 里没有“${ph}”`)
        if (chars) return t + (k ? chars[i + p.length - 1].e : chars[i].s)
        if (!estimated.has(id)) {
          estimated.add(id)
          warn(`旁白 ${id} 没有逐字对齐数据，锚词按字数比例估算`)
        }
        return t + m.dur * ((i + k * p.length) / plain.length)
      },
      frac: f => t + m.dur * f,
    }
  }

  const api = {
    T,
    get now() {
      return now
    },
    to(t) {
      now = t
      return api
    },
    wait(d) {
      now += d
      return api
    },
    // o.feature：这句讲的是功能清单里的哪一项，写进交付的时间索引
    say(id, gap = 1.3, o = {}) {
      // 每句前的留白可按段统一加长（gapPad），节奏放缓时所有动作仍锚在旁白上
      const L = line(id, now + gap + (T.gapPad || 0))
      T.vo.push({ id, t: L.t, ...o })
      now = L.end
      return L
    },
    // 镜头：to 是 'full'、{ full: true, zoom }、或 { target, pad, zoom, dx, dy }；o 里可以有 drift、ease、path: 'zoom'、chain
    cam(t, d, to, o = {}) {
      T.cam.push({ t, d, to, ...o })
    },
    show(t, at) {
      T.cur.push({ t, show: true, ...(at ? { at } : {}) })
      curShown = true
    },
    hide(t) {
      T.cur.push({ t, show: false })
      curShown = false
    },
    move(t, d, target, o = {}) {
      T.cur.push({ t, d, to: { target, at: o.at || [0.5, 0.5], dx: o.dx, dy: o.dy }, bend: o.bend })
    },
    click(t) {
      T.cur.push({ t, click: true })
    },
    // 移过去再点：t 是按下的时刻；o.js 为真时同时用脚本点一次（合成点击不生效的控件）
    tap(t, target, o = {}) {
      const d = o.d ?? 0.85
      if (!curShown) api.show(t - d - (o.pre ?? 0.15) - 0.35)
      api.move(t - d - (o.pre ?? 0.15), d, target, o)
      api.click(t)
      const sel = typeof target === 'string' ? target : target?.sel || ''
      const jsDefault = T.jsTap ? new RegExp(T.jsTap).test(sel) : false
      if (o.js ?? jsDefault) T.acts.push({ t: t + 0.12, js: (w, doc) => { const el = findEl(doc, target); (el?.querySelector('input') || el)?.click() } })
      return t
    },
    focus(t, d, target, o = {}) {
      T.focus.push({ t, d, target, ...o })
    },
    callout(t, d, target, text, o = {}) {
      T.callouts.push({ t, d, target, text, ...o })
    },
    act(a) {
      T.acts.push(a)
    },
    scroll(t, d, sel, top, o = {}) {
      T.acts.push({ t, d, scroll: typeof top === 'string' ? { sel, el: top, offset: o.offset } : { sel, to: top }, ...o })
    },
    type(t, text, cps = 12) {
      T.acts.push({ t, type: text, cps })
      return t + [...text].length / cps
    },
    key(t, k) {
      T.acts.push({ t, key: k })
    },
    upload(t, sel, file) {
      T.acts.push({ t, upload: { sel, file } })
    },
    reveal(t, d, sel, o = {}) {
      T.acts.push({ t, d, reveal: sel, ...o })
    },
    nav(t, url, ready) {
      T.acts.push({ t, nav: url, ready })
    },
    hash(t, h) {
      T.acts.push({ t, hash: h })
    },
    card(c) {
      T.cards.push(c)
    },
    lower(t, name, sub, o = {}) {
      T.cards.push({ kind: 'lower', t, d: o.d ?? 3.6, outD: 0.6, name, sub, k: o.k })
    },
    // 配乐节点：kind 用 'chapter'（一级）、'key'（二级，确认、发出、生成这类关键操作）
    cue(t, kind, o = {}) {
      T.cues.push({ t, kind, ...o })
    },
    fade(t, d, from, to) {
      T.fades.push({ t, d, from, to })
    },
    // 有意的停留：这段画面就是要静止（比如留给讲者接话），交付检查不报长时间静止
    hold(t, d, why = '') {
      T.holds.push({ t, d, why })
    },
    end(t) {
      T.dur = Math.round(t * 100) / 100
      T.cam.sort((a, b) => a.t - b.t)
      T.cur.sort((a, b) => a.t - b.t)
      T.focus.sort((a, b) => a.t - b.t)
      checkCam(T, warn)
      return T
    },
  }
  return api
}

// 运镜禁令的静态检查：一次推近（目标镜头或放大的全景）结束后，下一次镜头运动要等停住 HOLD_AFTER_PUSH 秒。
// 拉回全景、标了 chain: true 的连续运镜不算。
function checkCam(T, warn) {
  // 运动不到 0.3 秒的是瞬时定位（比如章节卡遮着时摆好机位），观众看不到推的过程，不算推近
  const push = m => (m.d || 0) >= 0.3 && m.to && m.to !== 'full' && (m.to.target || (m.to.full && (m.to.zoom || 1) > 1.02))
  for (let i = 1; i < T.cam.length - 1; i++) {
    const a = T.cam[i], b = T.cam[i + 1]
    if (!push(a) || b.chain) continue
    const pullBack = b.to === 'full' || (b.to?.full && (b.to.zoom || 1) <= 1.02)
    if (pullBack) continue
    const gap = b.t - (a.t + (a.d || 0))
    if (gap < HOLD_AFTER_PUSH) warn(`运镜：${a.t.toFixed(1)} 秒的推近之后只停了 ${Math.max(0, gap).toFixed(1)} 秒就接着动（至少停 ${HOLD_AFTER_PUSH} 秒）`)
  }
}
