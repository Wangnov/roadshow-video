// 画面加混好的声音，合成分段成片：node build/mux.mjs [s0 s1 ...]
//   画面：out/video_<段>.mp4（render.mjs 出）
//   声音：audio/mix_<段>.wav（配乐、旁白、音效混好的成品）；没有时只出无声版并提示
//   结果：out/分段/<片名>_<段名>.mp4；out/mux_<段>.json 记着用的是哪一版画面和混音
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fingerprint } from './inputs.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default
const want = process.argv.slice(2)
const segs = CFG.segments.filter(s => !want.length || want.includes(s.id))
fs.mkdirSync(path.join(root, 'out/分段'), { recursive: true })
const probe = f => +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim()
for (const s of segs) {
  const v = path.join(root, 'out', `video_${s.id}.mp4`)
  if (!fs.existsSync(v)) {
    console.error(`${s.id}：没有画面 ${path.relative(root, v)}，先跑 render.mjs`)
    continue
  }
  const mix = path.join(root, 'audio', `mix_${s.id}.wav`)
  const dst = path.join(root, 'out/分段', `${CFG.name}_${s.name}.mp4`)
  const args = ['-y', '-loglevel', 'error', '-i', v]
  if (fs.existsSync(mix)) args.push('-i', mix, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '256k', '-shortest')
  else console.error(`${s.id}：没有声音 ${path.relative(root, mix)}，先出无声版`)
  args.push('-c:v', 'copy', '-movflags', '+faststart', dst)
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
  // 记下用的是哪一版画面和混音，交付检查用
  fs.writeFileSync(path.join(root, 'out', `mux_${s.id}.json`), JSON.stringify({ video: fingerprint(v), mix: fingerprint(mix) }, null, 1))
  console.log(`${s.id} → ${path.relative(root, dst)}（${probe(dst).toFixed(1)} 秒）`)
}
