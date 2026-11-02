// 把时间轴里和声音、检查有关的时刻导出成 JSON：node build/export_tl.mjs s1 → audio/tl_s1.json
// 配乐按这里的节点卡点，交付检查拿它核对配乐是不是按最新的时间轴做的，交付时的时间索引也从这里来。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 返回 { tl: 导出的内容, TL: 时间轴原样 }
export async function exportTL(root, name) {
  const voFile = path.join(root, 'audio/vo/index.json')
  const VO = fs.existsSync(voFile) ? JSON.parse(fs.readFileSync(voFile, 'utf8')) : {}
  const MOD = (await import(pathToFileURL(path.join(root, 'src', name + '.js')).href)).default
  const TL = typeof MOD === 'function' ? MOD(VO) : MOD
  const clickTarget = i => JSON.stringify([...TL.cur.slice(0, i)].reverse().find(m => m.to)?.to?.target ?? '')
  const tl = {
    dur: TL.dur,
    vo: TL.vo.map(v => ({ ...v, d: VO[v.id]?.dur ?? null, text: VO[v.id]?.text ?? '' })),
    warnings: TL.warnings || [],
    // 配乐节点：章节（一级）与显式标出的关键操作（二级）
    cues: TL.cues || [],
    // 普通界面操作（三级）
    taps: TL.cur.map((c, i) => (c.click ? { t: c.t, target: clickTarget(i) } : null)).filter(Boolean),
    types: (TL.acts || []).filter(a => a.type).map(a => ({ t: a.t, d: [...a.type].length / a.cps })),
    reveals: (TL.acts || []).filter(a => a.reveal).map(a => ({ t: a.t, d: a.d })),
    navs: (TL.acts || []).filter(a => a.nav).map(a => a.t),
    touch: ['phone', 'scene'].includes(TL.layout?.kind),
    cards: TL.cards.map(c => ({ kind: c.kind, t: c.t, d: c.d, outD: c.outD, name: c.name || c.h || '' })),
    cam: TL.cam.slice(1).map(m => ({ t: m.t, d: m.d, zoom: m.to?.zoom || null })),
    callouts: (TL.callouts || []).map(c => ({ t: c.t, text: c.text })),
    focus: (TL.focus || []).map(f => f.t),
    fades: TL.fades || [],
    holds: TL.holds || [],
    nodes: TL.cards.flatMap(c => [...(c.nodes || []), ...(c.boxes || []), ...(c.edges || [])].map(n => ({ t: c.t + (n.t ?? 0), core: !!n.core, edge: !!n.d }))).filter(n => n.t != null),
    music: TL.music || null,
  }
  return { tl, TL }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const name = process.argv[2] || 's0'
  const { tl } = await exportTL(root, name)
  fs.mkdirSync(path.join(root, 'audio'), { recursive: true })
  fs.writeFileSync(path.join(root, 'audio', `tl_${name}.json`), JSON.stringify(tl, null, 1))
  for (const w of tl.warnings) console.error('时间轴', name, w)
}
