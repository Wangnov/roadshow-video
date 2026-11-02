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
| `build/qa.mjs`、`inputs.mjs` | 引擎 | 交付前检查，写验收报告的机器检查一栏；输入指纹 |
| `build/deliver.mjs` | 引擎 | 交付导出：全片字幕 SRT、时间索引、给剪辑软件的剪辑清单 |
| `audio/score.py`、`score_orch.py` | 引擎 | 按时间轴作曲并混音，出 `audio/mix_<段>.wav`；前者流行商务风格族，后者管弦铺底风格族，一部片子选一个 |
| `audio/asr_check.py` | 引擎 | 旁白回听结果和原稿按拼音比对，交付检查调用 |
| `audio/vo/asr.json` | 项目 | 逐句回听的识别结果，格式见 `references/服务与工具文档.md` 回听一节 |

## 命令

```bash
npm install                          # 装 Playwright；本机已有时可以用 PW_NODE_MODULES 指过去
node build/check.mjs s1              # 检查帧：每 5 秒一帧，联系表 frames/chk_s1.png
node build/check.mjs s1 2,8.5,13     # 指定秒数
node build/render.mjs --seg s1       # 草稿画面 out/video_s1.mp4（配置里的 draft：30 帧、1 倍）
node build/render.mjs --seg s1 --master   # 母版画面（master：60 帧、2 倍超采样）
node build/export_tl.mjs s1          # 导出时间轴节点 audio/tl_s1.json
python3 audio/score.py s1            # 作曲、混旁白与音效，出 audio/mix_s1.wav（-16 LUFS）；管弦铺底换成 score_orch.py
node build/mux.mjs                   # 合声音，出 out/分段/
node build/join.mjs                  # 叠化拼全片
node build/qa.mjs                    # 交付前检查，写 验收报告.md 与 out/qa.json
node build/deliver.mjs               # 交付导出：out/<片名>.srt、out/索引.json、out/剪辑清单.json
```

要交剪映草稿时，先出不烧字幕的画面：`node build/render.mjs --seg s1 --master --nosub`，出 `out/video_<段>_nosub.mp4`，剪辑清单会优先用它。作曲脚本同时在 `audio/stems_<段>/` 留下 `mix_vo`、`mix_music`、`mix_sfx` 三条分轨，三轨叠加约等于成品。草稿本身怎么生成见 `references/服务与工具文档.md` 第五节。

渲染常用参数：`--workers` 并行进程数，`--start`、`--end` 只渲一段区间，`--strict` 只走接口缓存（第二台机器上用），`--png` 截帧用 PNG。

## 字幕样式

白字黑描边，和剪映第一个预设样式一致，浅色界面和深色卡片上都看得清；交剪映草稿时字幕轨用同一个样式。要改颜色或描边粗细，在 `src/theme.css` 的 `:root` 里设 `--sub-color`、`--sub-stroke`、`--sub-stroke-w`（默认 `#fff`、`#000`、`6px`，描边一半在字外，看到的约 3 像素）。

字号按会场后排看得清来定，默认够最远观众在画面高度 6 倍处看清。大会场（8 倍）或交付检查报“后排看不清”时，在 `:root` 里调大：

| 变量 | 管哪些字 | 默认 | 8 倍视距建议 |
|---|---|---|---|
| `--sub-size` | 字幕 | 34px | 40px |
| `--co-size` | 标注 | 30px | 38px |
| `--card-small-size` | 片头模块、片头说明 | 30px | 38px |

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

- **风格族**：一部片子选一个作曲脚本，各段都用它，怎么挑见 `references/配乐风格库.md`：
  - `score.py` 流行商务：按下面的段落风格换编法。
  - `score_orch.py` 管弦铺底：不看段落风格，模块切换（左下角模块名）处换乐段，乐段之间轮换和声与配器。
  - 下面的关键操作、发出提示音、音色库与音效两个脚本都认；二级点击、提示音关键词、环境声只有 `score.py` 认。
  - 两个脚本都在 `audio/stems_<段>/` 出 `mix_vo`、`mix_music`、`mix_sfx` 三条剪辑分轨，按成品的实际增益曲线算，三轨叠加和成品差不到 -30 dB。
- **段落风格**（`score.py`）：写在时间轴里，`timeline(VO, { music: { style: 'brisk' } })`，可选 `title` 片头、`brisk` 日常操作、`lively` 现场与高能、`steady` 办公与平稳（默认）、`leader` 管理层、`close` 收尾。
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
| SUB OVERFLOW | 一条字幕超过 `subtitle.maxChars` 字，或者折行、出画 |
| CALLOUT CLIPPED | 标注出画 |
| OVERLAP | 标注压住字幕区，或者挡住它指的目标 |
| PAGEERROR | 产品页面报错 |
| API MISS | 接口没有缓存，录了一次（`--strict` 时直接失败） |

全部清零再出母版。同一条问题只记一次。出成片画面时另写一份 `out/video_<段>.json`：渲染参数、区间、输入指纹和这些问题，交付检查读它。

## 交付前检查

`node build/qa.mjs` 逐项检查，`--seg s1,s2` 只查其中几段：

| 检查 | 怎么查 | 不通过时 |
|---|---|---|
| 成片齐全、按最新输入渲染 | 渲染记录里的输入指纹和现在的比：配置、时间轴、配音数据，被录的产品源码，本段引用的 `assets/` 文件；混音、分段、全片各自记着用的是哪一版 | 按提示重渲、重新作曲、重跑 mux 或 join |
| 界面目标、点击与页面 | 成片渲染时引擎报的问题 | 改时间轴里的目标或时刻 |
| 字幕与标注版面 | 同上 | 旁白补标点或拆句；标注换 `side`、调 `off` |
| 远看可读性 | 引擎在渲染时记下要看清的字（字幕、标注、模块名、章节名、片头、示意图节点名、字幕卡）在成片上的字号，按最远观众的视距换算：字高不到 15 角分算看不清；聚焦的界面内容只提醒，聚焦期间有标注说出要点就不提醒 | 按上面“字幕样式”调大字号；界面上的小字靠推近或加标注 |
| 黑帧 | 逐帧灰度，98% 的像素接近纯黑算黑帧，淡入淡出里的不算 | 查那一刻的界面或卡片 |
| 闪帧 | 一两帧和前后都差很多、前后却很像 | 多半是切页露出空白页，加就绪等待或用章节卡遮住 |
| 长时间静止 | 字幕带以上半秒内几乎没变化，连续超过 `staticMax` 秒；片头卡、章节卡在场的时间不算 | 加镜头、标注或拆段；确实要停住的用 `S.hold(t, d, '理由')` 标出 |
| 时长与音画 | 画面帧数对时间轴时长，声音对画面 | 重跑 mux |
| 响度与峰值 | 全片 EBU R128 | 重跑 score.py |
| 旁白逐句回听对稿 | `audio/vo/asr.json` 对原稿，无调拼音逐字比 | 回听那一句；念错就改 `tts` 读音重合成，ASR 听错就放行 |
| 编排规范（只提醒） | 打字每秒 8 到 15 字，镜头运动 0.9 到 2.4 秒，标注不超过 14 字、停留不少于 2 秒，念速每秒不超过 5.8 字，“点一下”全片不超过 3 次 | 看一眼，按需要改 |

阈值和放行写在 `film.config.js` 的 `qa` 里，都可以不写，默认值如下：

```js
qa: {
  lufs: -16, lufsTol: 1,   // 总响度目标与容差
  tpMax: -1,               // 真峰值上限，dBTP
  staticMax: 6,            // 静止多少秒算长
  blackLuma: 4,            // 灰度不高于这个值算黑（0 到 255）
  flashDiff: 8,            // 闪帧判定的帧间差
  viewRatio: 6,            // 最远观众到屏幕的距离是画面高度的几倍：会场投影 6，大会场 8，自己在屏幕上看 3
  minArcmin: 15,           // 要看清的字，在最远观众眼里至少多少角分
  // 人工确认没问题的项：check 是上表的检查（files、engine、layout、read、black、flash、static、sync、loudness、asr），
  // 再用 seg、id（句子）、t（秒，前后 1 秒内）、match（问题原文里的一段）定位到具体哪一条
  waive: [{ check: 'asr', id: 'a3', why: '回听确认念的是“标黄”，ASR 听成了“标红”' }],
}
```

结果：

- `验收报告.md`：只覆盖“机器检查过的”一栏，“看过、听过的”和“未验证”两栏由 Agent 填，重跑不动。
- `out/qa.json`：每项的结果与明细。
- 退出码：1 有未通过的项，2 有没跑成的项，0 全部通过。
- 改了 `qa` 和 `render` 两项配置不算改了画面输入，不用重渲。
- 产品源码的版本：产品在 git 仓库里时，取产品目录最后一次提交加上这个目录里没提交的改动；不在 git 里时逐个文件取指纹。产品跑在开发服务器上时，在 `film.config.js` 的 `app.repo` 写源码目录，不写就核对不了，检查会提醒。
- 素材只核对本段时间轴和配置里引用到的 `assets/` 路径，换了别的素材不要求这一段重渲。

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
