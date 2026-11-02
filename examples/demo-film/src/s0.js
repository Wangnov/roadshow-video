// 片头：片头卡加开场旁白
import { timeline } from './dsl.js'

export default VO => {
  const S = timeline(VO, { music: { style: 'title' } })
  S.fade(0, 0.8, 1, 0)
  S.card({ kind: 'title', t: 0, d: 8.5, outD: 1.0, cover: true, k: 'FIELD INSPECTION', h: '设备巡检助手', en: 'From paper rounds to one page', items: ['路线排好', '异常标黄', '记录可查'], foot: '演示信息均为示意' })
  S.cue(0, 'chapter')
  S.cam(0, 0, 'full')
  S.to(1.6)
  const o1 = S.say('o1', 0)
  return S.end(Math.max(o1.end + 1.2, 10.0))
}
