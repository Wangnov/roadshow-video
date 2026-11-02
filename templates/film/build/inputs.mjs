// 一段画面的输入指纹，渲染时记进 out/video_<段>.json，交付检查拿它判断画面是不是按最新的输入渲的：
//   inputsHash          配置、导演页与引擎、本段时间轴、本段用到的配音数据、项目路由
//   productFingerprint  被录的产品源码（app.repo 或 app.dir）
//   assetsFingerprint   本段时间轴和配置里引用到的 assets/ 文件
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export function inputsHash(root, CFG, seg, TL) {
  const h = createHash('sha1')
  const others = new Set(CFG.segments.map(s => `${s.id}.js`).filter(f => f !== `${seg}.js`))
  // 配置里的 qa（检查阈值与放行）和 render（渲染参数，另记在渲染记录里）不影响画面内容
  const { qa, render, ...look } = CFG
  h.update('config\0' + JSON.stringify(look))
  const files = ['build/hooks.mjs', ...fs.readdirSync(path.join(root, 'src')).filter(f => !others.has(f)).sort().map(f => 'src/' + f)]
  for (const f of files) {
    const p = path.join(root, f)
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue
    h.update(f + '\0').update(fs.readFileSync(p))
  }
  const idx = path.join(root, 'audio/vo/index.json')
  const VO = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')) : {}
  for (const v of TL.vo || []) h.update(v.id + '\0' + JSON.stringify(VO[v.id] ?? null))
  return h.digest('hex').slice(0, 16)
}

// 大文件的快速指纹：大小加首尾各 1 MB。合成、拼接时记下用的是哪一版画面与声音
export function fingerprint(f) {
  if (!fs.existsSync(f)) return null
  const size = fs.statSync(f).size, n = Math.min(size, 1 << 20)
  const fd = fs.openSync(f, 'r'), head = Buffer.alloc(n), tail = Buffer.alloc(n)
  fs.readSync(fd, head, 0, n, 0)
  fs.readSync(fd, tail, 0, n, size - n)
  fs.closeSync(fd)
  return `${size}:` + createHash('sha1').update(head).update(tail).digest('hex').slice(0, 16)
}

// 小文件的快速指纹：大小加开头 64 KB
function quick(f) {
  const size = fs.statSync(f).size, n = Math.min(size, 1 << 16), buf = Buffer.alloc(n), fd = fs.openSync(f, 'r')
  fs.readSync(fd, buf, 0, n, 0)
  fs.closeSync(fd)
  return `${size}:` + createHash('sha1').update(buf).digest('hex').slice(0, 12)
}
function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}

// 产品源码：在 git 仓库里时，取产品目录最后一次提交，加上这个目录里还没提交的改动；
// 不在 git 里的目录逐个文件取快速指纹。没登记源码位置（只有开发服务器地址）时返回 null
export function productFingerprint(root, CFG) {
  const dir = CFG.app?.repo || CFG.app?.dir
  const d = dir && path.resolve(root, dir)
  if (!d || !fs.existsSync(d)) return null
  const git = (...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() === 'true') {
    const rev = git('log', '-1', '--format=%h', '--', '.').stdout.trim() || '无提交'
    const diff = git('diff', 'HEAD', '--binary', '--', '.').stdout
    const untracked = git('ls-files', '--others', '--exclude-standard', '--', '.').stdout.split('\n').filter(Boolean)
    if (!diff && !untracked.length) return { kind: 'git', id: rev, rev, dirty: false }
    const h = createHash('sha1').update(diff)
    for (const f of untracked) h.update(f + '\0' + quick(path.join(d, f)))
    const id = h.digest('hex').slice(0, 12)
    return { kind: 'git', id: `${rev}+${id}`, rev, dirty: true }
  }
  const h = createHash('sha1')
  let files = 0
  for (const f of walk(d)) h.update(path.relative(d, f) + '\0' + quick(f)), files++
  return { kind: 'files', id: h.digest('hex').slice(0, 16), files }
}

// 本段用到的素材：时间轴和配置里所有带 assets/ 的路径（帧序列目录、背景、实物照片、角标、场景照片）
export function assetsFingerprint(root, CFG, TL) {
  const refs = new Set(), seen = new WeakSet()
  const scan = v => {
    if (typeof v === 'string') {
      const i = v.indexOf('assets/')
      if (i >= 0) refs.add(v.slice(i).split(/[?#)"'\s]/)[0].replace(/\/$/, ''))
    } else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v)
      Object.values(v).forEach(scan)
    }
  }
  scan(CFG)
  scan(TL)
  const h = createHash('sha1')
  let files = 0
  for (const r of [...refs].sort()) {
    const p = path.join(root, r)
    if (!fs.existsSync(p)) {
      h.update(r + '\0缺')
      continue
    }
    for (const f of fs.statSync(p).isDirectory() ? walk(p) : [p]) h.update(path.relative(root, f) + '\0' + quick(f)), files++
  }
  return { id: h.digest('hex').slice(0, 16), refs: [...refs].sort(), files }
}
