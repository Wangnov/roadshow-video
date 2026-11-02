# roadshow-video

一个 Agent Skill：把能在浏览器里运行的产品，做成路演现场播放的演示片。

- **画面**：在浏览器里真实操作你的产品，加镜头推拉、聚焦压暗、引线标注、章节卡，逐帧渲染，每次渲染结果一样。
- **声音**：旁白配音按逐字时刻和画面对齐；配乐按时间轴现场作曲，用真实乐器音色库渲染，在关键操作上卡点；点击、打字、转场配真实录音音效。
- **交付**：分段版与全片、SRT 字幕、时间索引、验收报告，可选剪映草稿。
- **场合**：政府汇报、客户提案、投资路演、述标。宣传片、品牌短片、展会循环视频不在范围内。

支持 Claude Code 与 Codex。拿不准的地方，Agent 会用选择题问你；你的选择记下来，下次直接沿用。

## 安装

```bash
# Claude Code（个人范围；只给某个项目用就放到项目的 .claude/skills/ 下）
git clone https://github.com/Wangnov/roadshow-video.git ~/.claude/skills/roadshow-video

# Codex
git clone https://github.com/Wangnov/roadshow-video.git ~/.codex/skills/roadshow-video
```

然后对 Agent 说“用 roadshow-video 给我的产品做一部路演片”，把产品的仓库、启动方式或线上地址给它。

## 需要什么

开工第一步，Agent 会跑体检 `node scripts/doctor.mjs`，缺什么按你的系统给出安装命令。大致是：

- Node.js 18 以上、Python 3.9 以上（numpy、pypinyin、cn2an）、ffmpeg、FluidSynth、Playwright 的 Chromium、中文字体。
- 配音：豆包语音合成 2.0（推荐）或 MiniMax 的凭证；也可以本机跑开源的 Qwen3-TTS（Apple Silicon 16 GB 以上，或 8 GB 以上显存的 N 卡），或者自己录。
- 配乐用的开源乐器音色库、CC0 音效，第一次用时问你要不要下载，下载后放在共用目录，以后的片子直接用。
- 生图、生视频工具可选，网页工具也行，Agent 会操作浏览器。

## 怎么工作

流程写在 [`SKILL.md`](SKILL.md)：体检，问定位与口径，跑产品、写旁白，审核旁白，配音与试听，视觉与风格帧，试片审核，全片，交付前检查，交付，经验回写。用户要拍板的地方只有几处审核点，其余由 Agent 按规范自己做。

几条原则：

- **外部服务不写适配代码**。配音、生图生视频、剪映草稿这些服务的接口总在变，仓库里只维护一份精确到章节的官方文档索引和实测设置（[`references/服务与工具文档.md`](references/服务与工具文档.md)），Agent 每次现场查文档写调用。
- **审美题先出样本**。音色、配乐、视觉风格，先做成本地试听页或风格帧，你听过看过再选。
- **交付前机器检查加人工复查**。黑帧、闪帧、长时间静止、字幕与标注版面、远看可读性、音画对齐、响度、旁白逐句回听对稿，全部通过才交付；验收报告分“机器检查过的、看过听过的、未验证”三栏，没看过的不冒充看过。

## 文件

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 入口：管什么、整体流程、提问方式、质量线 |
| `references/问题库.md` | 每一步问什么、何时问、怎么问，哪些由 Agent 自主 |
| `references/旁白文风.md` | 客户背调、文风画像与分档写法、禁用清单、读音规范、自检 |
| `references/运镜与编排.md` | 时间轴写法、镜头语言、段落结构、配乐节点、节奏参数 |
| `references/配乐风格库.md` | 风格族与轮换、编法、混音、音色库、音效与选材 |
| `references/素材生成.md` | 生图与生视频的用途、提示词、规格处理 |
| `references/坑与兜底.md` | 渲染、配音、配乐、协作里踩过的坑 |
| `references/服务与工具文档.md` | 外部服务与工具的官方文档链接、实测设置、踩过的坑 |
| `templates/film/` | 片子工程模板：运镜引擎、时间轴写法、逐帧渲染、作曲混音（流行商务、管弦铺底两个风格族）、合成拼接、交付前检查、交付导出，说明见其中的 README |
| `scripts/` | `doctor.mjs` 体检，`new.mjs` 初始化或刷新片子工程，`audition.mjs` 试听页 |
| `examples/` | 虚构的设备巡检助手（`demo-app`）和用它做的示例片子工程（`demo-film`，两段，约 1 分钟） |
| `docs/` | 调研与设计稿 |

## 试跑示例

```bash
cd examples/demo-film && npm install      # 装 Playwright
npx playwright install chromium
node build/check.mjs s1                   # 检查帧联系表 frames/chk_s1.png
node build/render.mjs --seg s0 && node build/render.mjs --seg s1
```

示例的配音只入库了文字和逐字时刻，音频要自己合成一遍（见 `templates/film/README.md` 的配音数据一节），之后才能作曲、合成有声版：

```bash
node build/export_tl.mjs s0 && node build/export_tl.mjs s1
python3 audio/score.py s0 && python3 audio/score.py s1
node build/mux.mjs && node build/join.mjs && node build/qa.mjs
```

## 经验回写

每部片子交付后，Agent 会把新踩的坑和新的偏好整理成条目，问你要不要提交回这个仓库。欢迎 PR，条目里不要有客户名、人名和项目细节。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。乐器音色库、音效、配音与生成模型不随仓库分发，各自的许可见 `references/配乐风格库.md` 与 `references/服务与工具文档.md`。
