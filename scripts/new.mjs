#!/usr/bin/env node
// 从模板初始化一部片子的工程，或刷新已有工程里的引擎文件。
//   node scripts/new.mjs <工程目录>            新建：复制模板，已有的文件不覆盖
//   node scripts/new.mjs <工程目录> --update   刷新：只覆盖引擎文件（导演页、引擎、编排写法、渲染与后期脚本），不动配置与时间轴
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TPL = path.resolve(here, '../templates/film')
const dst = process.argv[2]
if (!dst) {
  console.error('用法：node scripts/new.mjs <工程目录> [--update]')
  process.exit(1)
}
const update = process.argv.includes('--update')
const target = path.resolve(dst)
// 引擎文件：模板升级时随 --update 覆盖。其余文件属于项目，只在新建时复制一次
const ENGINE = ['src/director.html', 'src/engine.js', 'src/dsl.js', 'src/kit.js', 'build/render.mjs', 'build/check.mjs', 'build/export_tl.mjs', 'build/inputs.mjs', 'build/mux.mjs', 'build/join.mjs', 'build/qa.mjs', 'build/deliver.mjs', 'audio/score.py', 'audio/score_orch.py', 'audio/asr_check.py']

let n = 0
function copy(rel) {
  const from = path.join(TPL, rel), to = path.join(target, rel)
  const exists = fs.existsSync(to)
  if (exists && !(update && ENGINE.includes(rel))) return
  if (exists && fs.readFileSync(from).equals(fs.readFileSync(to))) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log(`${exists ? '更新' : '新建'} ${rel}`)
  n++
}
function walk(dir) {
  for (const e of fs.readdirSync(path.join(TPL, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.name === '__pycache__' || e.name === '.DS_Store') continue
    if (e.isDirectory()) walk(rel)
    else copy(rel)
  }
}
if (update && !fs.existsSync(path.join(target, 'film.config.js'))) {
  console.error(`${target} 不是片子工程（没有 film.config.js）`)
  process.exit(1)
}
walk('.')
for (const d of ['assets', 'audio/vo', 'frames', 'out']) fs.mkdirSync(path.join(target, d), { recursive: true })
console.log(n ? `完成，${update ? '更新' : '新建'}了 ${n} 个文件：${target}` : `没有需要${update ? '更新' : '新建'}的文件：${target}`)
if (!update) console.log('下一步：在工程目录里运行 npm install（装 Playwright），按产品改 film.config.js 与 src/theme.css，写 src/s0.js 起的时间轴。')
