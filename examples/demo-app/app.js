// 虚构的设备巡检助手：只用来演示与回归测试，数据都是示意。
const TASKS = [
  { id: 'K3', point: '空压站 A-03', device: '三号空压机', order: 1, hot: true, status: '待巡检', last: '上周排气温度偏高' },
  { id: 'P7', point: '泵房 B-07', device: '七号循环泵', order: 2, hot: true, status: '待巡检', last: '上周振动值偏大' },
  { id: 'C1', point: '冷却塔 C-01', device: '一号冷却塔', order: 3, status: '待巡检', last: '正常' },
  { id: 'F2', point: '风机房 D-02', device: '二号引风机', order: 4, status: '待巡检', last: '正常' },
  { id: 'T5', point: '变配电 E-05', device: '五号变压器', order: 5, status: '待巡检', last: '正常' },
]
const READINGS = {
  K3: [
    ['排气温度', '86 ℃', '92 ℃', true],
    ['排气压力', '0.78 MPa', '0.79 MPa', false],
    ['油位', '正常', '正常', false],
    ['运行电流', '182 A', '185 A', false],
  ],
}
const main = document.querySelector('#main')
const drawer = document.querySelector('#drawer')
const toast = document.querySelector('#toast')

function home() {
  main.innerHTML = `<h1>工作台</h1><p class="sub">11 月 3 日 星期一 · 早班</p>
  <div class="stats">
    <div class="stat"><small>今日点位</small><b>23</b></div>
    <div class="stat"><small>已完成</small><b>0</b></div>
    <div class="stat warn"><small>上周异常</small><b>2</b></div>
    <div class="stat"><small>待复查</small><b>1</b></div>
  </div>
  <div class="row">
    <div class="panel tasks"><h2>今日路线</h2><table><thead><tr><th>顺序</th><th>点位</th><th>设备</th><th>上次情况</th><th></th></tr></thead>
      <tbody>${TASKS.map(t => `<tr class="${t.hot ? 'hot' : ''}" data-task="${t.id}"><td>${t.order}</td><td>${t.point}</td><td>${t.device}</td><td>${t.hot ? `<span class="tag warn">${t.last}</span>` : `<span class="tag">${t.last}</span>`}</td><td><button class="ghost" data-open="${t.id}">查看</button></td></tr>`).join('')}</tbody></table></div>
    <div class="panel remind"><h2>今日提醒</h2><ul><li>七号循环泵 上周振动值偏大，今天重点看轴承温度</li><li>空压站 A-03 下午两点停机检修，上午先巡</li><li>周五前提交本周巡检周报</li></ul></div>
  </div>`
  main.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTask(b.dataset.open)))
}

function openTask(id) {
  const t = TASKS.find(x => x.id === id)
  const rs = READINGS[id] || []
  drawer.innerHTML = `<h2>${t.device}</h2><p class="sub">${t.point} · 第 ${t.order} 站</p>
    <div class="reading"><b>项目</b><b>上次</b><b>本次</b>${rs.map(([k, a, b, flag]) => `<span>${k}</span><span>${a}</span><span class="${flag ? 'flag' : ''}" ${flag ? 'data-flag' : ''}>${b}${flag ? '　<span class="tag warn">比上周高 6 ℃</span>' : ''}</span>`).join('')}</div>
    <h3>现场情况</h3><textarea id="note" placeholder="写一句现场情况"></textarea>
    <div class="actions"><button id="gen">生成异常说明</button><button class="ghost" id="close">关闭</button></div>
    <div class="result" id="result"></div>`
  requestAnimationFrame(() => drawer.classList.add('open'))
  drawer.querySelector('#close').onclick = () => drawer.classList.remove('open')
  drawer.querySelector('#gen').onclick = async () => {
    const note = drawer.querySelector('#note').value
    const r = await fetch('/api/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: t.device, note }) })
    const j = await r.json()
    const box = drawer.querySelector('#result')
    box.innerHTML = `<p><b>异常说明</b></p>${j.lines.map(l => `<p>${l}</p>`).join('')}<div class="actions"><button id="submit">提交复查</button></div>`
    box.classList.add('show')
    box.querySelector('#submit').onclick = () => {
      drawer.classList.remove('open')
      toast.textContent = '已提交复查，设备主管会收到提醒'
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 2600)
    }
  }
}

function weekly() {
  const days = [['周一', 23], ['周二', 23], ['周三', 22], ['周四', 23], ['周五', 21]]
  main.innerHTML = `<h1>巡检周报</h1><p class="sub">10 月 27 日至 10 月 31 日</p>
  <div class="row"><div class="panel"><h2>每日完成点位</h2><div class="bars">${days.map(([d, n]) => `<div style="height:${(n / 23) * 100}%"><span>${d}</span></div>`).join('')}</div></div>
  <div class="panel"><h2>本周异常</h2><ul><li>三号空压机 排气温度偏高，已复查</li><li>七号循环泵 振动值偏大，跟进中</li></ul></div></div>`
}

function simple(title) {
  main.innerHTML = `<h1>${title}</h1><div class="panel fade-in">这一页在演示里不展开。</div>`
}

function route() {
  const r = (location.hash.replace(/^#\//, '') || 'home').split('/')[0]
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === r))
  drawer.classList.remove('open')
  if (r === 'home') home()
  else if (r === 'weekly') weekly()
  else simple({ tasks: '巡检任务', devices: '设备档案' }[r] || '工作台')
  main.firstElementChild?.classList.add('fade-in')
  document.body.dataset.ready = r
}
window.addEventListener('hashchange', route)
route()
