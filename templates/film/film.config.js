// 一部片子的项目配置。新建工程时由 scripts/new 生成，Agent 按产品情况改。
// 这里只放可序列化的值，导演页和渲染器都会读它。
export default {
  // 片名：用在成片文件名里
  name: '产品名称演示',

  // 产品：
  //   base 是产品的地址，导演页挂在同源的 /__v/ 下，才能读写 iframe 里的应用。
  //   产品是静态文件时写 dir，渲染器直接按目录提供，不用另起服务；产品有自己的开发服务器时只写 base。
  //   repo 是产品源码所在的目录：渲染时记下它的版本，渲完之后产品改过，交付检查会要求重渲。写了 dir 时可以不写。
  app: {
    base: 'http://127.0.0.1:5173',
    dir: null,
    repo: null,
    url0: '/',
    ready: 'body',
  },

  // 版式：browser（浏览器窗口）、phone（手机外框）、scene（场景照片里嵌屏幕，见 references/运镜与编排.md）
  layout: { kind: 'browser', aw: 1600, ah: 900 },

  // 虚拟时钟起点、时区、语言、随机种子：每次渲染、每个进程结果一样
  clock: '2026-01-05T09:00:00+08:00',
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  seed: 20260105,

  // 开拍前写进页面的会话与本地存储：登录态、访问口令、引导页已读等
  storage: { session: {}, local: {} },
  // 段间接力：后一段从前一段结束时的应用状态开始，状态存在这个 localStorage 键里
  stateKey: null,

  // 模型接口：检查阶段录一次回放，正式渲染全部走缓存。match 是路径前缀，methods 是要缓存的请求方法
  api: { match: '/api/', methods: ['POST'] },

  // 片中隐藏的界面元素：选择器，加上（可选）要包含的文字
  hide: { selectors: [], texts: [] },

  // 合成点击在导演页里偶尔不生效的控件，tap 时默认再用脚本点一次（选择器的正则）
  jsTap: 'segmented|tabs-tab|tab\\b',

  // 常驻角标（品牌 logo），放在 assets/ 下；不要就留空
  badge: { src: '' },

  // 字幕：每条最多几个字
  subtitle: { maxChars: 20 },

  // 段落：id 对应 src/<id>.js，name 用在分段成片的文件名里
  segments: [
    { id: 's0', name: '00_开场' },
  ],

  // 渲染默认值：迭代用草稿（dpr 1、30 帧），母版在审核点 2 通过后再出（dpr 2、60 帧）
  render: { draft: { fps: 30, dpr: 1 }, master: { fps: 60, dpr: 2 }, workers: 4 },
}
