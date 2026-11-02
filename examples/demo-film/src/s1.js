// 第一段：巡检员的一天（工作台 → 三号空压机 → 写现场情况 → 生成异常说明 → 提交复查 → 周报）
import { timeline } from './dsl.js'
import { kit } from './kit.js'

export default VO => {
  const S = timeline(VO, { gapPad: 0.2, urlLabel: () => 'inspect.example.com', music: { style: 'brisk' } })
  const K = kit(S, { menu: label => ({ sel: '.side nav a', text: label }) })
  K.chapter({ no: '01', en: 'A day on the rounds', name: '巡检员的一天', sub: '路线 · 读数 · 异常说明' })

  // 工作台
  const a1 = S.say('a1', 0.3)
  S.lower(a1.t + 0.2, '工作台', '今天的路线已经排好')
  S.cam(a1.t - 0.4, 1.6, { target: '.stats', pad: 40, zoom: 1.25 }, { drift: 0.02 })
  S.focus(a1.at('二十三个点位') - 0.2, 2.0, { sel: '.stat', nth: 0 }, { pad: 6 })
  S.cam(a1.at('按路线排好'), 1.5, { target: '.tasks', pad: 30, zoom: 1.3 })
  S.focus(a1.at('上周报过异常'), a1.end - a1.at('上周报过异常') + 0.6, { sel: 'tr.hot', all: true }, { pad: 4 })
  S.callout(a1.at('排在最前面') - 0.3, 2.6, { sel: 'tr.hot', nth: 0 }, '上周异常 · <em>排在最前</em>', { side: 'right', off: [-260, -90] })

  // 打开三号空压机
  const a2 = S.say('a2', 0.6)
  S.tap(a2.at('点开'), { sel: '[data-open="K3"]' }, { d: 0.9 })
  S.cam(a2.at('点开') + 0.4, 1.4, { full: true, zoom: 1.0 })
  S.cam(a2.at('上次的读数'), 1.4, { target: '.drawer .reading', pad: 60, zoom: 1.45 })
  S.focus(a2.at('上次的读数'), a2.end - a2.at('上次的读数') + 0.4, '.drawer .reading', { pad: 8 })

  // 排气温度标黄，写一句现场情况
  const a3 = S.say('a3', 0.5)
  S.focus(a3.at('排气温度'), 2.4, '[data-flag]', { pad: 6 })
  S.callout(a3.at('标黄'), 2.6, '[data-flag]', '比上周高 <em>6 ℃</em>', { side: 'bottom', off: [-40, 80] })
  S.tap(a3.at('写一句'), '#note', { d: 0.8 })
  const typed = S.type(a3.at('写一句') + 0.3, '排气口手感偏烫，冷却风扇有异响。', 10)

  // 生成异常说明，提交复查
  const a4 = S.say('a4', Math.max(0.5, typed - S.now + 0.3))
  S.tap(a4.at('生成异常说明'), '#gen', { d: 0.8 })
  S.cue(a4.at('生成异常说明'), 'key')
  S.reveal(a4.at('生成异常说明') + 0.5, 1.6, '#result')
  S.cam(a4.at('几秒钟'), 1.3, { target: '#result', pad: 50, zoom: 1.5 })
  S.focus(a4.at('几秒钟') + 0.4, a4.at('确认后') - a4.at('几秒钟'), '#result', { pad: 6 })
  S.tap(a4.at('提交复查'), '#submit', { d: 0.8 })
  S.cue(a4.at('提交复查'), 'key', { sfx: 'sent' })
  S.cam(a4.at('提交复查') + 0.4, 1.3, { full: true, zoom: 1.0 })

  // 周报
  const a5 = S.say('a5', 1.0)
  K.go(a5.t + 0.6, '巡检周报', '一个月的记录在同一页')
  S.cam(a5.at('同一页上'), 1.4, { target: '.bars', pad: 40, zoom: 1.3 })
  return K.outro(a5)
}
