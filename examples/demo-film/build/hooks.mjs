// 示例产品没有后端，这里充当它的“模型接口”。真实产品不要这样做：回放缓存必须来自真实调用。
export async function route({ ctx }) {
  await ctx.route('**/api/summary', async r => {
    const body = JSON.parse(r.request().postData() || '{}')
    await new Promise(res => setTimeout(res, 300))
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lines: [`${body.device} 排气温度 92 ℃，比上周高 6 ℃。`, `现场：${body.note || '未填写'}`, '建议：今天下午停机检修时检查冷却风扇与散热片。'] }) })
  })
}
