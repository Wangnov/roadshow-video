// 交付导出：node build/deliver.mjs
// 出三样东西，时刻都按全片算（分段之间叠化 X 秒，和 join.mjs 一致，后一段从前一段结尾前 X 秒开始）：
//   out/<片名>.srt       全片字幕，切分规则和画面上的字幕一样（dsl.js 的 subtitles）
//   out/索引.json        每段、每句、每个模块名与关键操作的起止时刻，句子带功能清单的编号（say 的 feature）
//   out/剪辑清单.json    给剪辑软件的分轨清单：画面、旁白、配乐、音效、逐句配音、字幕、标记点。
//                       剪映草稿由 Agent 按这份清单和 pyJianYingDraft 的文档现场生成，见 references/服务与工具文档.md
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportTL } from './export_tl.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default
const { subtitles } = await import(pathToFileURL(path.join(root, 'src/dsl.js')).href)
const readJSON = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)
const probe = f => +(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout || 0)
const VO = readJSON(path.join(root, 'audio/vo/index.json')) || {}
const X = readJSON(path.join(root, 'out/join.json'))?.x ?? 1.0
const warn = []

// 各段在全片里的起点：和 join.mjs 一样，只算已经有分段成片的段
const segFile = s => path.join(root, 'out/分段', `${CFG.name}_${s.name}.mp4`)
const segs = CFG.segments.filter(s => fs.existsSync(segFile(s)))
if (!segs.length) {
  console.error('没有分段成片，先跑 mux.mjs')
  process.exit(1)
}
const one = segs.length === 1
let acc = 0
const S = []
for (const s of segs) {
  const { tl, TL } = await exportTL(root, s.id)
  const dur = probe(segFile(s)) || tl.dur
  S.push({ ...s, start: acc, dur, tl, TL })
  acc += dur - (one ? 0 : X)
}
const total = one ? S[0].dur : acc + X

// ---------- 字幕 ----------
const subs = S.flatMap(s => subtitles(s.TL, VO, CFG.subtitle?.maxChars ?? 20).map(u => ({ start: s.start + u.t, end: s.start + u.t + u.d + 0.05, text: u.text })))
subs.sort((a, b) => a.start - b.start)
for (let i = 0; i < subs.length - 1; i++) if (subs[i].end > subs[i + 1].start - 0.01) subs[i].end = subs[i + 1].start - 0.01
const ts = t => {
  const ms = Math.round(t * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
const srt = path.join(root, 'out', `${CFG.name}.srt`)
fs.writeFileSync(srt, subs.map((u, i) => `${i + 1}\n${ts(u.start)} --> ${ts(u.end)}\n${u.text}\n`).join('\n'))

// ---------- 时间索引 ----------
const r3 = x => Math.round(x * 1000) / 1000
const index = {
  name: CFG.name,
  dur: r3(total),
  xfade: one ? 0 : X,
  segments: S.map(s => ({ id: s.id, name: s.name, start: r3(s.start), end: r3(s.start + s.dur) })),
  sentences: S.flatMap(s => s.TL.vo.map(v => ({ id: v.id, seg: s.id, start: r3(s.start + v.t), end: r3(s.start + v.t + (VO[v.id]?.dur ?? 0)), text: VO[v.id]?.text ?? '', ...(v.feature ? { feature: v.feature } : {}) }))),
  chapters: S.flatMap(s => s.TL.cards.filter(c => c.kind === 'chap' || c.kind === 'title').map(c => ({ seg: s.id, t: r3(s.start + c.t), name: c.name || c.h || '' }))),
  modules: S.flatMap(s => s.TL.cards.filter(c => c.kind === 'lower').map(c => ({ seg: s.id, t: r3(s.start + c.t), name: c.name, sub: c.sub || '' }))),
  keys: S.flatMap(s => (s.TL.cues || []).filter(c => c.kind === 'key').map(c => ({ seg: s.id, t: r3(s.start + c.t) }))),
}
fs.writeFileSync(path.join(root, 'out/索引.json'), JSON.stringify(index, null, 1))

// ---------- 剪辑清单 ----------
const abs = rel => path.join(root, rel)
const exists = rel => fs.existsSync(abs(rel))
const video = S.map(s => {
  const clean = `out/video_${s.id}_nosub.mp4`
  const burned = !exists(clean)
  if (burned) warn.push(`${s.id} 没有不烧字幕的画面，剪辑清单里用的是带字幕的 out/video_${s.id}.mp4；出剪映草稿前先跑 render.mjs --seg ${s.id} --master --nosub，不然会有两层字幕`)
  const meta = readJSON(abs(burned ? `out/video_${s.id}.json` : `out/video_${s.id}_nosub.json`))
  return { seg: s.id, file: abs(burned ? `out/video_${s.id}.mp4` : clean), burnedSubs: burned, master: !!meta?.master, start: r3(s.start), dur: r3(s.dur) }
})
const stem = k =>
  S.map(s => {
    const rel = `audio/stems_${s.id}/mix_${k}.wav`
    if (!exists(rel)) return warn.push(`${s.id} 缺分轨 ${rel}，重跑 score.py`), null
    // 作曲分轨会比画面略长，合成时按画面截齐，这里也一样
    return { seg: s.id, file: abs(rel), start: r3(s.start), dur: r3(Math.min(probe(abs(rel)), s.dur)) }
  }).filter(Boolean)
const voFile = id => ['wav', 'mp3'].map(e => `audio/vo/${id}.${e}`).find(exists)
const list = {
  name: CFG.name,
  root,
  width: 1920,
  height: 1080,
  fps: readJSON(abs(`out/video_${S[0].id}.json`))?.fps ?? CFG.render?.master?.fps ?? 60,
  dur: r3(total),
  xfade: one ? 0 : X,
  说明: [
    '时刻单位是秒，按全片算。相邻两段重叠 xfade 秒：画面在重叠处叠化，各条声音在重叠处交叉淡化。',
    'audio 下三轨是成品拆开的样子，乘过成品的实际增益曲线，三轨原样叠加就是成品（-16 LUFS），误差在 -30 dB 以下。',
    'voClips 是逐句的原始配音，没有经过成品里的均衡和压缩，只在要换掉某一句时用。',
  ],
  video,
  audio: { vo: stem('vo'), music: stem('music'), sfx: stem('sfx') },
  voClips: S.flatMap(s => s.TL.vo.map(v => ({ id: v.id, seg: s.id, file: voFile(v.id) ? abs(voFile(v.id)) : null, start: r3(s.start + v.t), dur: VO[v.id]?.dur ?? null, text: VO[v.id]?.text ?? '' }))),
  subtitles: { srt, items: subs.map(u => ({ start: r3(u.start), end: r3(u.end), text: u.text })) },
  markers: [...index.chapters.map(c => ({ t: c.t, name: c.name })), ...index.modules.map(m => ({ t: m.t, name: m.name })), ...index.keys.map(k => ({ t: k.t, name: '关键操作' }))].sort((a, b) => a.t - b.t),
}
fs.writeFileSync(path.join(root, 'out/剪辑清单.json'), JSON.stringify(list, null, 1))

const qa = readJSON(path.join(root, 'out/qa.json'))
if (!qa) warn.push('还没跑交付前检查 build/qa.mjs')
else if (qa.rows.some(r => r.status === 'fail')) warn.push('交付前检查有未通过的项，先修完再交付')
console.log(`全片 ${total.toFixed(1)} 秒，${S.length} 段，${index.sentences.length} 句旁白，${subs.length} 条字幕`)
console.log(`→ out/${CFG.name}.srt、out/索引.json、out/剪辑清单.json`)
for (const w of warn) console.log('注意：' + w)
