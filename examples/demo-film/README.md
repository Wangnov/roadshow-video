# 片子工程模板

一部路演片一个工程。用 `node scripts/new.mjs <工程目录>` 从这里复制出来；模板升级后，用 `--update` 只刷新引擎文件，不动配置与时间轴。

## 文件

| 文件 | 归谁 | 内容 |
|---|---|---|
| `film.config.js` | 项目 | 产品地址、版式、虚拟时钟、存储预置、接口缓存、隐藏规则、段落清单、渲染默认值 |
| `src/theme.css` | 项目 | 品牌色与字体，从产品里抓来改 |
| `src/s0.js`、`s1.js`…… | 项目 | 每段的时间轴，写法见 `references/运镜与编排.md` |
| `build/hooks.mjs`（可选） | 项目 | 项目自己的路由，比如模拟推送数据 |
| `audio/vo/index.json` | 项目 | 配音数据，格式见下 |
| `src/director.html`、`engine.js`、`dsl.js`、`kit.js` | 引擎 | 导演页、运镜引擎、时间轴写法、段落工具 |
| `build/render.mjs` | 引擎 | 逐帧渲染：检查帧或成片画面 |
| `build/check.mjs` | 引擎 | 检查帧与联系表 |
| `build/export_tl.mjs` | 引擎 | 导出时间轴节点，配乐与检查用 |
| `build/mux.mjs`、`join.mjs` | 引擎 | 画面合声音、分段叠化拼全片 |
| `audio/score.py` | 引擎 | 按时间轴作曲并混音（流行商务风格族），出 `audio/mix_<段>.wav` |

## 命令

```bash
npm install                          # 装 Playwright；本机已有时可以用 PW_NODE_MODULES 指过去
node build/check.mjs s1              # 检查帧：每 5 秒一帧，联系表 frames/chk_s1.png
node build/check.mjs s1 2,8.5,13     # 指定秒数
node build/render.mjs --seg s1       # 草稿画面 out/video_s1.mp4（配置里的 draft：30 帧、1 倍）
node build/render.mjs --seg s1 --master   # 母版画面（master：60 帧、2 倍超采样）
node build/export_tl.mjs s1          # 导出时间轴节点 audio/tl_s1.json
python3 audio/score.py s1            # 作曲、混旁白与音效，出 audio/mix_s1.wav（-16 LUFS）
node build/mux.mjs                   # 合声音，出 out/分段/
node build/join.mjs                  # 叠化拼全片
```

渲染常用参数：`--workers` 并行进程数，`--start`、`--end` 只渲一段区间，`--strict` 只走接口缓存（第二台机器上用），`--png` 截帧用 PNG。

## 配音数据

`audio/vo/index.json`，每句一条：

```json
{
  "a1": {
    "text": "早上八点，巡检员打开工作台。",
    "dur": 3.62,
    "words": [{ "c": "早", "s": 0.15, "e": 0.32 }, { "c": "上", "s": 0.32, "e": 0.47 }]
  }
}
```

- `text`：原文，字幕用。
- `dur`：这句音频的时长，秒。
- `words`：逐字强制对齐的结果。`c` 可以是一个字或一个词，不含标点；`s`、`e` 是相对本句音频开头的秒数。
  - 时间轴的锚词从这里取时刻，字幕也按它出入。
  - 没有这一项时，引擎按字数比例估算并报警告。

音频文件本身（`audio/vo/<id>.wav` 或 `.mp3`）由配乐脚本混进成片，不入库。用豆包语音合成 2.0 时，打开字幕参数就能直接拿到 `words`，不用另外对齐。

配音和对齐用哪个服务、怎么调，见 `references/服务与工具文档.md`，每次现场查文档。

## 配乐

- **段落风格**：写在时间轴里，`timeline(VO, { music: { style: 'brisk' } })`，可选 `title` 片头、`brisk` 日常操作、`lively` 现场与高能、`steady` 办公与平稳（默认）、`leader` 管理层、`close` 收尾。
- **关键操作**：`S.cue(t, 'key')` 显式标出，配乐在这里落二级节点；发出、提交这类再加 `{ sfx: 'sent' }`，会配上发出提示音。
- **二级点击与提示音**：`music.uiTaps` 写点击目标里的片段，这些点击算二级；`music.chimeWords` 写标注里的词，出现时加提示音。
- **环境声**：`music.ambience` 写音效名（比如展会人群 `crowd3515`），`music.ambienceFrom` 写从第几秒起。
- **音色库与音效**：
  - 音色库默认在 `~/.local/share/soundfonts/`，音效默认在 `~/.local/share/roadshow-video/sfx/`，按 BigSoundBank 编号命名；可以用 `ROADSHOW_SOUNDFONTS`、`ROADSHOW_SFX` 改位置。
  - 缺音色库直接报错，缺个别音效会跳过并在最后列出。

## 引擎会报的问题

渲染结束会打印问题汇总，并写进 `frames/issues_<段>.json`：

| 问题 | 意思 |
|---|---|
| TIMELINE | 时间轴自检：锚词没有对齐数据、推近后没停住、旁白缺配音数据 |
| no target | 选择器找不到元素 |
| FOCUS EMPTY、CALLOUT EMPTY | 聚焦或标注的目标在那一刻不可见 |
| FOCUS TINY | 聚焦的目标太小 |
| CLICK OFFSCREEN、CLICK OUTSIDE APP | 点击落在画面外或应用外 |
| PAGEERROR | 产品页面报错 |
| API MISS | 接口没有缓存，录了一次（`--strict` 时直接失败） |

全部清零再出母版。

## 段间接力

后一段要从前一段结束时的应用状态开始时：

1. 在配置里写 `stateKey`（产品存状态用的 localStorage 键）。
2. 渲染前一段的最后一帧时导出状态：`DUMP_STATE=build/state_s1.json node build/render.mjs --seg s1 --only <最后一秒>`。
3. 后一段的时间轴里写 `timeline(VO, { preload: 'build/state_s1.json' })`。

## 两台机器

1. 第一台把各段的检查帧跑一遍，模型接口的回放缓存录全（`build/apicache/`）。
2. 工程同步到第二台，不带密钥文件。
3. 第二台只起产品前端，渲染时加 `--strict`。
4. 各自渲染分到的段落，`out/video_<段>.mp4` 回传到第一台，再 mux、join。
