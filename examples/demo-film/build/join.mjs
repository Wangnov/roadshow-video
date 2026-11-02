// 分段叠化拼成全片：node build/join.mjs [--x 1.0]
// 每处接缝做 1 秒画面叠化与声音交叉淡化；结果 out/<片名>_全片.mp4；out/join.json 记着用的是哪几版分段
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fingerprint } from './inputs.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default
const X = +(process.argv[process.argv.indexOf('--x') + 1] || 1.0) || 1.0
const files = CFG.segments.map(s => path.join(root, 'out/分段', `${CFG.name}_${s.name}.mp4`)).filter(f => fs.existsSync(f))
if (files.length < 2) {
  console.error('分段不足两段，不用拼')
  process.exit(0)
}
const probe = (f, q) => spawnSync('ffprobe', ['-v', 'error', ...q, '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim()
const dur = files.map(f => +probe(f, ['-show_entries', 'format=duration']))
const hasAudio = files.every(f => probe(f, ['-select_streams', 'a', '-show_entries', 'stream=index']).length > 0)
const fps = Math.round(eval(probe(files[0], ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate'])))
const args = ['-y', '-loglevel', 'error']
for (const f of files) args.push('-i', f)
const fc = files.map((_, i) => `[${i}:v]fps=${fps},settb=AVTB[n${i}]`)
let vlast = 'n0', alast = '0:a', acc = dur[0]
for (let i = 1; i < files.length; i++) {
  fc.push(`[${vlast}][n${i}]xfade=transition=fade:duration=${X}:offset=${(acc - X).toFixed(3)}[v${i}]`)
  if (hasAudio) fc.push(`[${alast}][${i}:a]acrossfade=d=${X}:c1=tri:c2=tri[a${i}]`)
  vlast = `v${i}`
  alast = `a${i}`
  acc += dur[i] - X
}
args.push('-filter_complex', fc.join(';'), '-map', `[${vlast}]`)
if (hasAudio) args.push('-map', `[${alast}]`, '-c:a', 'aac', '-b:a', '256k')
// macOS 上用硬件编码器，快很多；其他平台用 libx264
const venc = os.platform() === 'darwin' ? ['-c:v', 'h264_videotoolbox', '-b:v', '18M', '-maxrate', '28M', '-bufsize', '36M'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16']
args.push(...venc, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', path.join(root, 'out', `${CFG.name}_全片.mp4`))
const r = spawnSync('ffmpeg', args, { stdio: 'inherit' })
if (r.status) process.exit(r.status)
fs.writeFileSync(path.join(root, 'out', 'join.json'), JSON.stringify({ x: X, parts: Object.fromEntries(files.map(f => [path.basename(f), fingerprint(f)])) }, null, 1))
console.log(`全片 ${acc.toFixed(1)} 秒（${(acc / 60).toFixed(2)} 分钟）→ out/${CFG.name}_全片.mp4`)
