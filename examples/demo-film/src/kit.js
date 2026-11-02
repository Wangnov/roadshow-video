// 各段共用的写法：切模块、章节卡、段尾。项目相关的选择器与素材从 opts 传进来。
// opts.menu: 文字 → 菜单项目标，比如 label => ({ sel: '.sider a', text: label })
// opts.seq: 空镜名 → 帧序列，比如 name => ({ dir: `assets/seq/${name}`, n: 300, fps: 60, rate: 0.8 })
export function kit(S, opts = {}) {
  const menu = opts.menu || (label => ({ sel: 'nav a, nav button, [role=menuitem]', text: label }))
  const seq = opts.seq || (name => (name ? { dir: `assets/seq/${name}`, n: 300, fps: 60, rate: 0.8 } : null))
  return {
    // 切模块：先拉回全景再点菜单，模块名从左下角浮出，观众看得到“去了哪里”
    go(t, label, sub, k = opts.lowerK || '') {
      S.cam(t - 1.9, 1.1, { full: true, zoom: 1.0 })
      S.tap(t, menu(label), { at: [0.3, 0.5] })
      if (sub) S.lower(t + 0.5, label, sub, { k })
      return t
    },
    // 段首：黑场淡入，章节卡从第 0 帧遮盖，遮盖期间完成切页，第 4 秒左右开始第一句旁白
    chapter({ no, en, name, sub, bg, url, ready, mark }) {
      S.fade(0, 0.6, 1, 0)
      const s = typeof bg === 'string' && !bg.includes('.') ? seq(bg) : null
      S.card({ kind: 'chap', t: 0, d: 3.4, outD: 0.9, cover: true, ...(s ? { seq: s } : bg ? { bg } : {}), no, en, name, sub, mark })
      S.cue(0, 'chapter')
      if (url) S.nav(2.6, url, ready)
      S.cam(0, 0, { full: true, zoom: 1.1, dy: 8 })
      S.cam(3.0, 0.1, { full: true, zoom: 1.12, dy: 8 }, { drift: -0.03, driftD: 4, chain: true })
      S.to(4.0)
    },
    // 段尾：最后一句念完留 0.8 秒，再黑场淡出；hold 是段间讲解时额外留给讲者的静默
    outro(L, d = 1.4, hold = opts.hold ?? 0) {
      S.fade(L.end + 0.8, d, 0, 1)
      return S.end(L.end + 0.8 + d + 0.2 + hold)
    },
  }
}
