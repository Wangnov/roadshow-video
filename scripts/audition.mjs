#!/usr/bin/env node
// 试听页：node scripts/audition.mjs <试听目录> [--lufs -18] [--no-norm]
// 挑旁白音色用；挑音效候选也用它，这时不写 text，页面不显示试听稿、不算念速。
// 读 <试听目录>/试听.json，把每段音频统一到同一响度，生成 <试听目录>/index.html。
// 页面是本地文件，直接用浏览器打开，不发布到网上。用户点“喜欢”，再一键复制选择发回来。
//
// 试听.json：
// {
//   "title": "旁白音色试听",
//   "lede": "页面开头的一两句说明",
//   "text": "试听稿：这部片子旁白稿的前两三句",
//   "bgm": "bgm.mp3",                       可选：试听时可以垫一层配乐，听音色放进成片里的样子
//   "groups": [
//     { "id": "female", "name": "女声", "note": "可选的分组说明", "items": [
//       { "id": "f_zhixing", "name": "知性女声 2.0 · 语气指令", "provider": "豆包语音合成 2.0",
//         "voice": "zh_female_zhixingnv_uranus_bigtts", "desc": "指令原文或官方场景",
//         "file": "audio/f_zhixing.mp3", "needsBgm": false, "check": "读音正常" }
//     ] }
//   ]
// }
// 音频由 Agent 按 references/服务与工具文档.md 现场查文档合成，这个脚本只做统一响度和页面。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const dir = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--lufs')
if (!dir) {
  console.error('用法：node scripts/audition.mjs <试听目录> [--lufs -18] [--no-norm]')
  process.exit(1)
}
const D = path.resolve(dir)
const M = JSON.parse(fs.readFileSync(path.join(D, '试听.json'), 'utf8'))
const LUFS = argv.includes('--lufs') ? +argv[argv.indexOf('--lufs') + 1] : -18
const NORM = !argv.includes('--no-norm') && spawnSync('ffmpeg', ['-version']).status === 0

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const plain = s => [...String(s || '').replace(/[\s，。、；：？！“”‘’（）《》【】,.;:?!"'()…·]/g, '')].length
const probe = f => +(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout || 0)
function loud(f) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = r.stderr.slice(r.stderr.lastIndexOf('Summary:')).match(/I:\s+(-?[\d.]+) LUFS/)
  return m ? +m[1] : null
}
// 统一响度：按实测响度整体增益，再限一下峰值，放进 norm/。音色之间比的是声音本身，不是谁更响
function norm(rel) {
  const src = path.join(D, rel)
  if (!fs.existsSync(src)) throw new Error('找不到音频 ' + rel)
  if (!NORM) return { file: rel, dur: probe(src) }
  const I = loud(src)
  const out = path.join('norm', rel.replace(/\.[^.]+$/, '.mp3'))
  fs.mkdirSync(path.dirname(path.join(D, out)), { recursive: true })
  const gain = I == null ? 0 : LUFS - I
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=false`, '-ar', '48000', '-b:a', '192k', path.join(D, out)])
  if (r.status) throw new Error('统一响度失败：' + rel)
  return { file: out, dur: probe(path.join(D, out)), I }
}

const groups = M.groups.map(g => ({
  ...g,
  items: g.items.map(it => {
    const n = norm(it.file)
    const txt = it.text || M.text
    return { ...it, src: n.file, dur: n.dur, rate: n.dur && txt ? plain(txt) / n.dur : null }
  }),
}))
const bgm = M.bgm ? norm(M.bgm).file : null
const key = 'audition:' + (M.title || path.basename(D))

const card = it => `<article class="clip" data-tag="${esc(it.id)}">
<header><span class="name"><b>${esc(it.name)}</b><span class="sub">${esc([it.provider, it.voice].filter(Boolean).join(' · '))}</span></span>
<button class="like" type="button" aria-pressed="false">喜欢</button></header>
${it.desc ? `<p class="desc">${esc(it.desc)}</p>` : ''}
<audio controls preload="none" src="${esc(it.src)}"></audio>
<div class="meta"><span>${it.dur ? it.dur.toFixed(1) + ' 秒' : ''}</span><span>${it.rate ? it.rate.toFixed(1) + ' 字/秒' : ''}</span>${it.needsBgm ? '<span class="tag">需配 BGM</span>' : ''}${it.check ? `<span class="chk${/正常|通过/.test(it.check) ? ' ok">读音正常' : ` bad">读音：${esc(it.check)}`}</span>` : ''}</div>
</article>`

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(M.title || '旁白音色试听')}</title>
<style>
:root {
  --bg: #f4f6f3; --surface: #ffffff; --ink: #1b2421; --muted: #5d6a65; --line: #dce2de;
  --accent: #0f6e5c; --accent-soft: #e2efea; --ok: #1f7a3a; --bad: #b42318; --warm: #8a5a00; --warm-soft: #fbf0d9;
  --f-body: "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --f-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #101513; --surface: #171f1c; --ink: #e5ece9; --muted: #98a6a0; --line: #2a3531;
  --accent: #52c4a6; --accent-soft: #1b2e28; --ok: #5cc47c; --bad: #f2786b; --warm: #e8b65a; --warm-soft: #2c2614; color-scheme: dark } }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.7 var(--f-body); }
.wrap { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; display: flex; flex-direction: column; gap: 28px; }
h1 { font-size: clamp(24px, 4vw, 32px); line-height: 1.25; margin: 0; }
h2 { font-size: 20px; margin: 0; padding-bottom: 6px; border-bottom: 2px solid var(--ink); }
.lede { color: var(--muted); max-width: 68ch; margin: 8px 0 0; }
.passage { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 18px; font-size: 16px; }
.passage b { display: block; font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: .06em; margin-bottom: 4px; }
.bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--bg); padding: 10px 0; border-bottom: 1px solid var(--line); }
.bar a { color: var(--ink); text-decoration: none; font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--line); }
.bar a:hover { border-color: var(--accent); color: var(--accent); }
.bar label { font-size: 13px; display: flex; gap: 6px; align-items: center; color: var(--muted); }
.picks { margin-left: auto; font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; min-width: 0; }
button { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
section { display: flex; flex-direction: column; gap: 12px; scroll-margin-top: 64px; }
.note { margin: 0; color: var(--muted); font-size: 14px; max-width: 72ch; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: 12px; }
.clip { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.clip header { display: flex; gap: 10px; align-items: flex-start; }
.name { display: flex; flex-direction: column; line-height: 1.35; min-width: 0; }
.name b { font-size: 16px; }
.sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.like { margin-left: auto; flex: none; color: var(--muted); }
.like[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--surface); }
.desc { margin: 0; font-size: 13px; color: var(--muted); }
.clip audio { width: 100%; height: 36px; }
.meta { display: flex; flex-wrap: wrap; gap: 10px; font: 500 12px/1.4 var(--f-mono); color: var(--muted); align-items: center; }
.tag { color: var(--warm); background: var(--warm-soft); border-radius: 999px; padding: 1px 8px; font-family: var(--f-body); }
.chk { font-family: var(--f-body); } .chk.ok { color: var(--ok); } .chk.bad { color: var(--bad); cursor: help; }
#picked { color: var(--ink); max-width: 46ch; overflow-wrap: anywhere; }
</style></head><body><div class="wrap">
<div><h1>${esc(M.title || '旁白音色试听')}</h1>${M.lede ? `<p class="lede">${esc(M.lede)}</p>` : ''}<p class="lede">${NORM ? `每段都统一到 ${LUFS} LUFS 响度，` : ''}同一时间只放一段。</p></div>
${M.text ? `<div class="passage"><b>试听稿</b>${esc(M.text)}</div>` : ''}
<div class="bar">${groups.map(g => `<a href="#${esc(g.id)}">${esc(g.name)}</a>`).join('')}${bgm ? '<label><input type="checkbox" id="withbgm">垫上配乐</label>' : ''}<div class="picks"><span>喜欢：</span><span id="picked">还没有</span><button id="copy" type="button">复制</button></div></div>
${groups.map(g => `<section id="${esc(g.id)}"><h2>${esc(g.name)}</h2>${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}<div class="grid">${g.items.map(card).join('\n')}</div></section>`).join('\n')}
${bgm ? `<audio id="bgm" loop preload="auto" src="${esc(bgm)}"></audio>` : ''}
</div><script>
(() => {
  const KEY = ${JSON.stringify(key)};
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };
  const clips = [...document.querySelectorAll(".clip")];
  const name = (c) => c.querySelector(".name b").textContent;
  const label = (c) => name(c) + "（" + c.querySelector(".sub").textContent + "）";
  const liked = () => clips.filter((c) => read().includes(c.dataset.tag));
  const render = () => {
    const v = read();
    clips.forEach((c) => c.querySelector(".like").setAttribute("aria-pressed", v.includes(c.dataset.tag)));
    document.getElementById("picked").textContent = liked().map(name).join("、") || "还没有";
  };
  clips.forEach((c) => c.querySelector(".like").addEventListener("click", () => {
    const v = read(), i = v.indexOf(c.dataset.tag);
    i < 0 ? v.push(c.dataset.tag) : v.splice(i, 1);
    write(v); render();
  }));
  // 同一时间只放一段；勾了“垫上配乐”时，配乐跟着人声从头放，人声停它就停
  const bgm = document.getElementById("bgm"), withBgm = document.getElementById("withbgm");
  document.addEventListener("play", (e) => {
    if (e.target === bgm) return;
    document.querySelectorAll(".clip audio").forEach((x) => { if (x !== e.target) x.pause(); });
    if (bgm && withBgm.checked) { bgm.currentTime = 0; bgm.volume = 0.3; bgm.play().catch(() => {}); }
  }, true);
  const stop = (e) => { if (bgm && e.target !== bgm && ![...document.querySelectorAll(".clip audio")].some((x) => !x.paused)) bgm.pause(); };
  document.addEventListener("pause", stop, true);
  document.addEventListener("ended", stop, true);
  if (withBgm) withBgm.addEventListener("change", () => { if (!withBgm.checked) bgm.pause(); });
  document.getElementById("copy").addEventListener("click", () => {
    const t = "我喜欢的：" + (liked().map(label).join("；") || "还没有");
    navigator.clipboard.writeText(t).then(() => { document.getElementById("copy").textContent = "已复制"; }, () => {
      const r = document.createRange(); r.selectNodeContents(document.getElementById("picked"));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  });
  render();
})();
</script></body></html>
`
fs.writeFileSync(path.join(D, 'index.html'), html)
const n = groups.reduce((k, g) => k + g.items.length, 0)
console.log(`${n} 段${NORM ? `，已统一到 ${LUFS} LUFS` : ''}${bgm ? '，带配乐开关' : ''} → ${path.join(D, 'index.html')}`)
