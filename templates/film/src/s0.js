// 片头段的写法示例：片头卡加一两句开场旁白。改成自己片子的内容。
import { timeline } from './dsl.js'

export default VO => {
  const S = timeline(VO, { music: { style: 'title' } })
  S.fade(0, 0.8, 1, 0)
  S.card({ kind: 'title', t: 0, d: 6.5, outD: 1.0, cover: true, k: 'PRODUCT DEMO', h: '产品名称', en: 'One line in English', items: ['模块一', '模块二', '模块三'], foot: '演示信息均为示意' })
  S.cue(0, 'chapter')
  S.cam(0, 0, 'full')
  S.to(1.2)
  const o1 = S.say('o1', 0)
  return S.end(Math.max(o1.end + 1.0, 8.0))
}
