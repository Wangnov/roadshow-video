// 检查帧：在指定秒数各截一帧，拼成联系表，附上引擎警告。
//   node build/check.mjs s1               每 5 秒一帧
//   node build/check.mjs s1 2,5.5,12      指定秒数
//   node build/check.mjs all              全部段落
// 结果：frames/chk_<段>.png（联系表），frames/issues_<段>.json（问题汇总）
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CFG = (await import(pathToFileURL(path.join(root, 'film.config.js')).href)).default
const FPS = +(process.env.FPS || 20)
const segs = process.argv[2] === 'all' || !process.argv[2] ? CFG.segments.map(s => s.id) : [process.argv[2]]

function pw() {
  for (const t of [path.join(root, 'package.json'), process.env.PW_NODE_MODULES && path.join(process.env.PW_NODE_MODULES, 'x.js')].filter(Boolean)) {
    try {
      return createRequire(t)('playwright')
    } catch {}
  }
  throw new Error('找不到 playwright')
}

for (const seg of segs) {
  spawnSync('node', [path.join(root, 'build/export_tl.mjs'), seg], { stdio: 'inherit' })
  const tl = JSON.parse(fs.readFileSync(path.join(root, 'audio', `tl_${seg}.json`), 'utf8'))
  const times = process.argv[3] ? process.argv[3].split(',').map(Number) : Array.from({ length: Math.floor((tl.dur - 2) / 5) + 1 }, (_, i) => 2 + i * 5).filter(t => t < tl.dur)
  const outDir = path.join(root, 'frames', `chk_${seg}`)
  const r = spawnSync('node', [path.join(root, 'build/render.mjs'), '--seg', seg, '--fps', String(FPS), '--only', times.join(','), '--out', outDir], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)

  // 联系表：用浏览器排版截图，不依赖额外的图像库
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.png')).sort()
  const cells = files.map(f => {
    const t = (+f.slice(1, 6) / FPS).toFixed(1)
    return `<figure><img src="${pathToFileURL(path.join(outDir, f)).href}"><figcaption>${t} 秒</figcaption></figure>`
  })
  const issues = JSON.parse(fs.readFileSync(path.join(root, 'frames', `issues_${seg}.json`), 'utf8'))
  const lines = Object.entries(issues).filter(([k, v]) => !['seg', 'fps', 'dpr'].includes(k) && (Array.isArray(v) ? v.length : v)).map(([k, v]) => `<li><b>${k}</b> ${Array.isArray(v) ? v.slice(0, 6).join('；') + (v.length > 6 ? ` 等 ${v.length} 条` : '') : v}</li>`)
  const html = `<html><body style="margin:0;background:#fff;font:14px system-ui"><div style="padding:10px 14px"><b>${seg}</b>　时长 ${tl.dur} 秒　${lines.length ? `<ul style="margin:6px 0;color:#b42318">${lines.join('')}</ul>` : '<span style="color:#1f7a3a">没有发现问题</span>'}</div>
    <div style="display:grid;grid-template-columns:repeat(4,640px);gap:6px;padding:0 6px 6px">${cells.join('')}</div>
    <style>figure{margin:0}img{width:640px;height:360px;display:block}figcaption{padding:2px 4px}</style></body></html>`
  const sheet = path.join(root, 'frames', `chk_${seg}.html`)
  fs.writeFileSync(sheet, html)
  const { chromium } = pw()
  const br = await chromium.launch()
  const pg = await br.newPage({ viewport: { width: 4 * 646 + 6, height: 400 } })
  await pg.goto(pathToFileURL(sheet).href)
  await pg.screenshot({ path: path.join(root, 'frames', `chk_${seg}.png`), fullPage: true })
  await br.close()
  console.log(`联系表：frames/chk_${seg}.png`)
}
