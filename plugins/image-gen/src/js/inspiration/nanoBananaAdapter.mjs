/**
 * nanoBananaAdapter — Awesome-Nano-Banana-images 的灵感数据源适配器。
 *
 * 内容许可 Apache-2.0（仓库 LICENSE）；条目来自社区在 X / 微博上分享的用法，作者在各条目标题里。
 * 优先取中文 README（提示词是中文的，一键带入输入框最顺）；取不到或解析为空时退回英文版。
 */

import { parseNanoBananaReadme } from './nanoBananaParser.mjs'
import { requestJson } from '../netFetch.mjs'

const OWNER = 'PicoTrex/Awesome-Nano-Banana-images'
const BRANCH = 'main'
const raw = (file) => `https://raw.githubusercontent.com/${OWNER}/${BRANCH}/${file}`

export const nanoBananaAdapter = {
  id: 'nano-banana',
  label: 'Nano Banana 案例集',
  license: 'Apache-2.0',
  homeUrl: `https://github.com/${OWNER}`,
  /** 案例最初在哪个模型上做的；条目自己带的 models 更细（Pro / 普通两组） */
  models: ['Nano Banana', 'Nano Banana Pro'],

  async loadIndex() {
    for (const file of ['README.md', 'README_en.md']) {
      try {
        const markdown = await fetchText(raw(file))
        const items = parseNanoBananaReadme(markdown)
        // 只要有条目就用；两份都解析不出才算失败
        if (items.length) return items.map((item) => ({ ...item, lang: file === 'README.md' ? 'zh' : 'en', sourceId: this.id }))
      } catch {
        // 这一份取不到就换下一份
      }
    }
    throw new Error('灵感数据源暂时无法访问，请稍后重试')
  },

  imageUrlOf(item) {
    return item.image ?? ''
  },
}

/** requestJson 会把响应体按 JSON.parse 解析，README 是 Markdown，这里只要文本。 */
async function fetchText(url) {
  const enest = window.enest || window.zapi
  if (!enest?.net?.fetch) throw new Error('宿主网络接口不可用')
  const res = await enest.net.fetch({ url, method: 'GET', timeoutMs: 30000 })
  if (res.status < 200 || res.status >= 300) throw new Error(`读取灵感数据源失败（HTTP ${res.status}）`)
  return String(res.body ?? '')
}
