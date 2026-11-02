#!/usr/bin/env node
// 第 0 步体检：只探测，不提问。
//   node scripts/doctor.mjs [--app <产品地址或目录>] [--out roadshow/体检.json]
// 查机器、依赖、素材库、凭证（只看有没有，不读值）、工具档案、网络、产品与品牌视觉。
// 结果写进体检.json，终端打印结论和缺的东西怎么装。产品要先起服务、拿到地址，品牌视觉才抓得到。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null)
const OUT = path.resolve(arg('--out') || 'roadshow/体检.json')
const APP = arg('--app')
const HOME = os.homedir()
const CONF = path.join(HOME, '.config/roadshow-video')
const PLAT = process.platform
const sh = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, ...o })
  return r.error ? null : { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const has = cmd => !!sh(PLAT === 'win32' ? 'where' : 'which', [cmd])?.out
const expand = p => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p)
const INSTALL = {
  ffmpeg: { darwin: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg', win32: 'winget install Gyan.FFmpeg' },
  fluidsynth: { darwin: 'brew install fluid-synth', linux: 'sudo apt install fluidsynth', win32: 'choco install fluidsynth' },
  python: { darwin: 'brew install python', linux: 'sudo apt install python3 python3-pip', win32: 'winget install Python.Python.3.12' },
  font: { darwin: 'brew install --cask font-source-han-sans', linux: 'sudo apt install fonts-noto-cjk', win32: '从 https://github.com/adobe-fonts/source-han-sans 下载安装' },
  gh: { darwin: 'brew install gh', linux: 'sudo apt install gh', win32: 'winget install GitHub.cli' },
}
const fix = k => INSTALL[k][PLAT] || INSTALL[k].linux
const R = { at: new Date().toISOString(), machine: {}, deps: [], assets: {}, credentials: {}, profile: {}, network: {}, localTTS: {}, app: null, brand: null }

// ---------- 机器 ----------
{
  const m = R.machine
  m.os = `${PLAT} ${os.release()}`
  m.arch = os.arch()
  m.chip = (PLAT === 'darwin' ? sh('sysctl', ['-n', 'machdep.cpu.brand_string'])?.out : os.cpus()[0]?.model) || ''
  m.cores = os.cpus().length
  m.memGB = Math.round(os.totalmem() / 2 ** 30)
  const nv = sh('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  m.gpu = nv?.code === 0 ? nv.out.split('\n').map(l => ({ name: l.split(',')[0].trim(), memGB: Math.round(+l.split(',')[1] / 1024) })) : []
  try {
    const dir = fs.existsSync(path.dirname(OUT)) ? path.dirname(OUT) : process.cwd()
    const st = fs.statfsSync(dir)
    m.diskFreeGB = Math.round((st.bavail * st.bsize) / 2 ** 30)
  } catch {
    m.diskFreeGB = null
  }
}

// ---------- 依赖 ----------
const dep = (name, ok, version, need, fixCmd, optional = false) => R.deps.push({ name, ok, version: version || null, need, fix: ok ? null : fixCmd, optional })
{
  const nodeMajor = +process.versions.node.split('.')[0]
  dep('Node.js', nodeMajor >= 18, process.version, '18 以上', '装 Node.js 18 以上：https://nodejs.org')

  const ff = sh('ffmpeg', ['-hide_banner', '-version'])
  const ffv = ff?.out.split('\n')[0].replace(/^ffmpeg version /, '').split(' ')[0]
  dep('ffmpeg', !!ff && ff.code === 0, ffv, '渲染编码、混音、检查', fix('ffmpeg'))
  if (ff?.code === 0) {
    const enc = sh('ffmpeg', ['-hide_banner', '-encoders'])?.out || ''
    const flt = sh('ffmpeg', ['-hide_banner', '-filters'])?.out || ''
    dep('ffmpeg libx264', /libx264/.test(enc), null, '分块编码', '换一个带 libx264 的 ffmpeg 版本（' + fix('ffmpeg') + '）')
    const missing = ['ebur128', 'loudnorm', 'xfade', 'acrossfade'].filter(f => !new RegExp(`\\s${f}\\s`).test(flt))
    dep('ffmpeg 滤镜', !missing.length, missing.length ? '缺 ' + missing.join('、') : '齐全', 'ebur128、loudnorm、xfade、acrossfade', '升级 ffmpeg 到 5 以上')
    if (PLAT === 'darwin') dep('ffmpeg 硬件编码', /h264_videotoolbox/.test(enc), null, '拼全片时更快', '可选', true)
  }
  dep('ffprobe', sh('ffprobe', ['-version'])?.code === 0, null, '读时长与流信息', fix('ffmpeg'))

  const PY = process.env.PYTHON || (PLAT === 'win32' ? 'python' : 'python3')
  const pv = sh(PY, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'])
  dep('Python', pv?.code === 0 && +pv.out.split('.')[1] >= 9, pv?.out, '3.9 以上，作曲与回听比对', fix('python'))
  if (pv?.code === 0) {
    const mods = sh(PY, ['-c', 'import importlib.util as u,json,os,sysconfig;print(json.dumps({**{m:bool(u.find_spec(m)) for m in ["numpy","pypinyin","cn2an"]},"managed":os.path.exists(os.path.join(sysconfig.get_path("stdlib"),"EXTERNALLY-MANAGED"))}))'])
    const got = mods?.code === 0 ? JSON.parse(mods.out) : {}
    // Homebrew、Debian 这类受系统管理的 Python 不让 pip 直接装，装到用户目录
    const pip = `${PY} -m pip install${got.managed ? ' --user --break-system-packages' : ''}`
    dep('Python 包 numpy', !!got.numpy, null, '作曲混音', `${pip} numpy`)
    dep('Python 包 pypinyin、cn2an', got.pypinyin && got.cn2an, null, '旁白回听比对', `${pip} pypinyin cn2an`)
  }
  const fsv = sh('fluidsynth', ['--version'])
  dep('FluidSynth', fsv?.code === 0, fsv?.out.split('\n')[0].replace(/^FluidSynth runtime version /, ''), '用音色库把乐谱渲成音频', fix('fluidsynth'))

  // Playwright：工程自己的依赖、PW_NODE_MODULES、全局
  const tries = [path.resolve('roadshow/package.json'), path.resolve('package.json'), process.env.PW_NODE_MODULES && path.join(process.env.PW_NODE_MODULES, 'x.js')]
  const groot = sh('npm', ['root', '-g'], { shell: PLAT === 'win32' })?.out
  if (groot) tries.push(path.join(groot, 'x.js'))
  let pw = null, pwFrom = null
  for (const t of tries.filter(Boolean)) {
    try {
      pw = createRequire(t)('playwright')
      pwFrom = path.dirname(t)
      break
    } catch {}
  }
  let pwv = null
  if (pw) try { pwv = createRequire(path.join(pwFrom, 'x.js'))('playwright/package.json').version } catch {}
  dep('Playwright', !!pw, pwv, '逐帧渲染真实界面', '在片子工程里 npm install；已有的 node_modules 可以用 PW_NODE_MODULES 指过去')
  if (pw) {
    let exe = ''
    try { exe = pw.chromium.executablePath() } catch {}
    dep('Playwright Chromium', !!exe && fs.existsSync(exe), null, '渲染用的浏览器', 'npx playwright install chromium')
  }
  R._pw = pw

  // 中文字体：思源黑体或 Noto Sans CJK，苹方兜底
  let fams = ''
  if (has('fc-list')) fams = sh('fc-list', [':lang=zh', 'family'])?.out || ''
  if (PLAT === 'darwin') for (const d of ['/System/Library/Fonts', '/Library/Fonts', path.join(HOME, 'Library/Fonts')]) if (fs.existsSync(d)) fams += '\n' + fs.readdirSync(d).join('\n')
  const fontOK = /Source Han Sans|SourceHanSans|思源黑体|Noto Sans CJK|NotoSansCJK|Noto Sans SC|NotoSansSC/i.test(fams)
  dep('中文字体', fontOK || /PingFang/i.test(fams), fontOK ? '思源黑体或 Noto Sans CJK' : /PingFang/i.test(fams) ? '只有苹方' : null, '片头卡、章节卡、字幕', fix('font'))
  dep('GitHub CLI', has('gh'), sh('gh', ['--version'])?.out.split('\n')[0], '经验回写时开 PR', fix('gh'), true)
}

// ---------- 素材库 ----------
{
  const sfDir = expand(process.env.ROADSHOW_SOUNDFONTS || '~/.local/share/soundfonts')
  const sfxDir = expand(process.env.ROADSHOW_SFX || '~/.local/share/roadshow-video/sfx')
  const sfNeed = ['MuseScore_General.sf3', 'GeneralUser-GS.sf2']
  R.assets.soundfonts = { dir: sfDir, missing: sfNeed.filter(f => !fs.existsSync(path.join(sfDir, f))) }
  // 作曲脚本里用到的音效编号，从模板里直接读
  const score = fs.readFileSync(path.join(here, '../templates/film/audio/score.py'), 'utf8')
  const need = [...new Set([...score.matchAll(/src\('([a-z]+\d+)'\)/g)].map(m => m[1]))].sort()
  R.assets.sfx = { dir: sfxDir, need: need.length, missing: need.filter(n => !fs.existsSync(path.join(sfxDir, n + '.wav'))) }
}

// ---------- 凭证：只看环境变量的名字 ----------
{
  const P = [
    ['火山引擎（豆包语音、方舟生图生视频）', /^(VOLC|VOLCENGINE|DOUBAO|ARK_|BYTEPLUS)/i],
    ['MiniMax', /MINIMAX/i],
    ['阿里云百炼', /DASHSCOPE/i],
    ['可灵', /KLING/i],
    ['OpenAI', /^OPENAI_API_KEY$/],
    ['Gemini', /^(GEMINI_API_KEY|GOOGLE_API_KEY)$/],
    ['xAI', /^XAI_API_KEY$/],
    ['HeyGen', /HEYGEN/i],
    ['Tripo', /TRIPO/i],
    ['fal、Replicate', /^(FAL_KEY|REPLICATE_API_TOKEN)$/],
  ]
  for (const [name, re] of P) {
    const keys = Object.keys(process.env).filter(k => re.test(k) && process.env[k])
    if (keys.length) R.credentials[name] = keys
  }
}

// ---------- 工具档案 ----------
{
  const pf = path.join(CONF, 'profile.json'), tf = path.join(CONF, 'tools.json'), av = path.join(CONF, 'avatars')
  R.profile = { dir: CONF, profile: fs.existsSync(pf), tools: fs.existsSync(tf), avatars: fs.existsSync(av) ? fs.readdirSync(av).filter(f => !f.startsWith('.')) : [], checks: [] }
  if (R.profile.tools) {
    let T = null
    try { T = JSON.parse(fs.readFileSync(tf, 'utf8')) } catch (e) { R.profile.checks.push({ at: 'tools.json', ok: false, msg: '解析失败：' + e.message }) }
    // 逐项健康检查：key 记的是来源（{ env } 或 { file }），只查在不在；路径查存在
    const walk = (v, at) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`))
      if (v && typeof v === 'object') {
        if (v.env && typeof v.env === 'string') R.profile.checks.push({ at, ok: !!process.env[v.env], msg: `环境变量 ${v.env}` })
        if (v.file && typeof v.file === 'string') R.profile.checks.push({ at, ok: fs.existsSync(expand(v.file)), msg: `文件 ${v.file}` })
        for (const [k, x] of Object.entries(v)) if (k !== 'env' && k !== 'file') walk(x, at ? `${at}.${k}` : k)
        return
      }
      if (typeof v === 'string' && /^(~|\/)[^\s]*$/.test(v) && !/^\/\//.test(v)) R.profile.checks.push({ at, ok: fs.existsSync(expand(v)), msg: `路径 ${v}` })
    }
    if (T) walk(T, '')
  }
}

// ---------- 网络 ----------
async function reach(url) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000), redirect: 'follow' })
    return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '超时' : e.message }
  }
}
R.network.huggingface = await reach('https://huggingface.co/api/models?limit=1')
R.network.modelscope = await reach('https://www.modelscope.cn/')

// ---------- 开源配音能不能本机跑（Qwen3-TTS 1.7B） ----------
{
  const m = R.machine
  const apple = PLAT === 'darwin' && m.arch === 'arm64'
  const nvOK = m.gpu.some(g => g.memGB >= 8)
  R.localTTS = {
    model: 'Qwen3-TTS 1.7B',
    ok: (apple && m.memGB >= 16) || nvOK,
    why: apple ? `Apple Silicon，内存 ${m.memGB} GB，要求 16 GB 以上` : m.gpu.length ? `显卡 ${m.gpu.map(g => `${g.name} ${g.memGB} GB`).join('、')}，要求 8 GB 以上显存` : '没有 Apple Silicon 也没有 N 卡',
    ref: '实测合成 1 分钟语音：Apple M5 32 GB 约 54 秒，Apple M6 16 GB 约 45 秒；首次下载 4.2 GB，峰值内存约 9 GB',
  }
}

// ---------- 产品 ----------
if (APP) {
  if (/^https?:\/\//.test(APP)) {
    const r = await reach(APP)
    R.app = { kind: 'url', url: APP, ...r }
  } else {
    const d = path.resolve(expand(APP))
    const a = (R.app = { kind: 'dir', dir: d, exists: fs.existsSync(d) })
    if (a.exists) {
      const pj = path.join(d, 'package.json')
      a.indexHtml = fs.existsSync(path.join(d, 'index.html'))
      a.git = fs.existsSync(path.join(d, '.git'))
      if (fs.existsSync(pj)) {
        const P = JSON.parse(fs.readFileSync(pj, 'utf8'))
        const deps = { ...P.dependencies, ...P.devDependencies }
        a.scripts = Object.fromEntries(Object.entries(P.scripts || {}).filter(([k]) => /^(dev|start|serve|preview)$/.test(k)))
        a.framework = ['next', 'nuxt', 'vite', 'react-scripts', '@angular/core', 'astro', '@sveltejs/kit', 'vue', 'react'].find(k => deps[k]) || null
      }
      // 只有静态文件、没有启动脚本时，film.config.js 里写 app.dir 就能直接渲染
      a.static = a.indexHtml && !a.scripts
    }
  }
}

// ---------- 品牌视觉：产品地址打得开、有 Playwright 时抓主色、字体、logo ----------
if (R.app?.kind === 'url' && R.app.ok && R._pw) {
  let br
  try {
    br = await R._pw.chromium.launch()
    const pg = await br.newPage({ viewport: { width: 1600, height: 900 } })
    await pg.goto(APP, { waitUntil: 'load', timeout: 20000 })
    await pg.waitForTimeout(1500)
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    const shot = path.join(path.dirname(OUT), '体检_首页.png')
    await pg.screenshot({ path: shot })
    R.brand = await pg.evaluate(() => {
      const vars = {}
      for (const sh of [...document.styleSheets]) {
        let rules
        try { rules = sh.cssRules } catch { continue }
        for (const r of rules || []) {
          if (!r.style || !/(^|,)\s*(:root|html|body)\s*(,|$)/.test(r.selectorText || '')) continue
          for (const p of r.style) if (p.startsWith('--') && /color|primary|brand|accent|theme|main/i.test(p)) vars[p] = r.style.getPropertyValue(p).trim()
        }
      }
      const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null }
      const count = (els, prop) => {
        const m = {}
        for (const e of els) {
          const v = getComputedStyle(e)[prop]
          if (!v || /rgba\(0, 0, 0, 0\)|transparent/.test(v)) continue
          m[v] = (m[v] || 0) + 1
        }
        return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => ({ v, n }))
      }
      const logos = [...document.querySelectorAll('img')].filter(i => /logo/i.test(i.src + ' ' + i.alt + ' ' + i.className)).map(i => i.src)
      const icons = [...document.querySelectorAll('link[rel*=icon]')].map(l => l.href)
      return {
        title: document.title,
        fonts: { body: cs('body')?.fontFamily, h1: cs('h1')?.fontFamily || null, button: cs('button')?.fontFamily || null },
        cssVars: vars,
        buttonColors: count(document.querySelectorAll('button, [class*=primary], [class*=btn]'), 'backgroundColor'),
        linkColors: count(document.querySelectorAll('a'), 'color'),
        logos: [...new Set(logos)].slice(0, 5),
        icons: [...new Set(icons)].slice(0, 5),
        needsLogin: !!document.querySelector('input[type=password]'),
      }
    })
    R.brand.screenshot = path.relative(process.cwd(), shot)
  } catch (e) {
    R.brand = { error: e.message.split('\n')[0] }
  } finally {
    await br?.close()
  }
}

// ---------- 输出 ----------
delete R._pw
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(R, null, 1))

const m = R.machine
const bad = R.deps.filter(d => !d.ok && !d.optional)
const opt = R.deps.filter(d => !d.ok && d.optional)
const creds = Object.entries(R.credentials)
console.log(`机器：${m.chip || m.arch}，${m.cores} 核，内存 ${m.memGB} GB${m.gpu.length ? '，' + m.gpu.map(g => `${g.name} ${g.memGB} GB`).join('、') : ''}，剩余磁盘 ${m.diskFreeGB ?? '?'} GB`)
console.log(`依赖：${bad.length ? `缺 ${bad.map(d => d.name).join('、')}` : '齐全'}${opt.length ? `；可选未装 ${opt.map(d => d.name).join('、')}` : ''}`)
console.log(`素材库：音色库${R.assets.soundfonts.missing.length ? `缺 ${R.assets.soundfonts.missing.join('、')}` : '齐全'}，音效${R.assets.sfx.missing.length ? `缺 ${R.assets.sfx.missing.length}/${R.assets.sfx.need} 个` : '齐全'}`)
console.log(`凭证：${creds.length ? creds.map(([k, v]) => `${k}（${v.join('、')}）`).join('；') : '没有找到'}`)
console.log(`工具档案：${R.profile.tools ? `有，健康检查 ${R.profile.checks.filter(c => c.ok).length}/${R.profile.checks.length} 项正常` : '没有（第一次用）'}${R.profile.avatars.length ? `；数字人 ${R.profile.avatars.join('、')}` : ''}`)
console.log(`开源配音：${R.localTTS.ok ? '本机能跑' : '本机跑不动'}，${R.localTTS.why}`)
console.log(`网络：Hugging Face ${R.network.huggingface.ok ? '通' : '不通'}，ModelScope ${R.network.modelscope.ok ? '通' : '不通'}`)
if (R.app) console.log(`产品：${R.app.kind === 'url' ? `${R.app.url} ${R.app.ok ? `能打开（${R.app.status}）` : `打不开（${R.app.error || R.app.status}）`}` : `${R.app.dir} ${R.app.exists ? `${R.app.framework || (R.app.static ? '静态页面' : '未识别')}${R.app.scripts && Object.keys(R.app.scripts).length ? '，启动脚本 ' + Object.keys(R.app.scripts).join('、') : ''}` : '不存在'}`}`)
if (R.brand && !R.brand.error) console.log(`品牌视觉：字体 ${R.brand.fonts.body}；按钮色 ${R.brand.buttonColors.map(c => c.v).slice(0, 3).join('、') || '无'}；logo ${R.brand.logos.length || R.brand.icons.length ? '找到' : '没找到'}${R.brand.needsLogin ? '；页面要登录' : ''}；截图 ${R.brand.screenshot}`)
else if (R.brand?.error) console.log(`品牌视觉：没抓成（${R.brand.error}）`)
else if (R.app?.kind === 'dir') console.log('品牌视觉：起好产品服务后，用 --app <地址> 再跑一次体检来抓')
if (bad.length || opt.length) {
  console.log('\n怎么装：')
  for (const d of [...bad, ...opt]) console.log(`  ${d.name}${d.optional ? '（可选）' : ''}：${d.fix}`)
}
if (R.assets.soundfonts.missing.length || R.assets.sfx.missing.length) console.log('  音色库与音效：按问题库 Q5.1、Q5.2 处理')
console.log(`\n结果：${path.relative(process.cwd(), OUT)}`)
