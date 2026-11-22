/**
 * fabiaoqing — 发表情数据源适配器（搜索扩展源，尽力而为）。
 * 无官方 API，解析列表/搜索页 HTML：图片懒加载，真实 URL 在 data- 属性里。
 * 图片托管在第三方 CDN（alicdn/sinaimg 等），net.fetch 不带 Referer 直取，
 * 失败的图片由前端降级隐藏，不阻塞列表。
 */

import { fetchText } from '../api.mjs'

const HOST = 'https://fabiaoqing.com'
const UA = 'Mozilla/5. (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

let seq = 0

/** 从列表/搜索页 HTML 提取表情条目 */
function parseItems(html) {
  const items = []
  // 懒加载 img：data-original / data-src 里是真实图
  const imgRe = /<img[^>]+>/g
  let match
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0]
    const url = extractAttr(tag, 'data-original') || extractAttr(tag, 'data-src') || extractAttr(tag, 'src')
    if (!url || !/^https?:\/\//.test(url)) continue
    if (!/\.(gif|png|jpe?g|webp)(\?|$)/i.test(url)) continue
    const title = decodeEntities(extractAttr(tag, 'title') || extractAttr(tag, 'alt') || '')
    // 只取表情缩略/列表区，跳过站点 logo 等装饰图
    if (!/(aliyuncs|alicdn|sinaimg|fabiaoqing|hdslb)/i.test(url)) continue
    seq += 1
    items.push({
      id: `fbq:${seq}:${url}`,
      source: 'fbq',
      label: title,
      imageUrl: url.replace(/\\\//g, '/'),
      thumbUrl: url.replace(/\\\//g, '/'),
      width: 0,
      height: 0,
      animated: /\.gif(\?|$)/i.test(url),
      category: '',
    })
  }
  return items
}

function extractAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`)
  const m = re.exec(tag)
  return m ? m[1] : ''
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function hasMorePages(html, page) {
  if (/class="[^"]*disabled[^"]*"[^>]*>\s*(下一页|尾页)/.test(html)) return false
  if (new RegExp(`href="[^"]*page/${page + 1}\\.html"`).test(html)) return true
  return /下一页/.test(html)
}

async function list({ keyword = '', page = 1, pageSize = 0 } = {}) {
  const url = keyword.trim()
    ? `${HOST}/search/bqb/keyword/${encodeURIComponent(keyword.trim())}`
    : `${HOST}/bqb/lists/page/${page}.html`
  // 搜索页无翻页参数：取当页全部；列表页用 page
  const html = await fetchText({ url, headers: { 'User-Agent': UA, Referer: HOST }, timeoutMs: 30000 })
  const items = parseItems(html)
  const more = keyword.trim() ? items.length >= 20 : hasMorePages(html, page)
  return { items, hasMore: more }
}

/** 热门搜索词（首页拉取一次，作 chips 推荐） */
async function getHotWords() {
  try {
    const html = await fetchText({ url: `${HOST}/`, headers: { 'User-Agent': UA, Referer: HOST }, timeoutMs: 20000 })
    const words = []
    const re = /<a[^>]+href="\/search\/bqb\/keyword\/[^"]+"[^>]*>([^<]{1,12})<\/a>/g
    let match
    while ((match = re.exec(html)) !== null) {
      const word = decodeEntities(match[1]).trim()
      if (word && !words.includes(word)) words.push(word)
      if (words.length >= 10) break
    }
    return words
  } catch {
    return []
  }
}

export const fabiaoqingSource = {
  id: 'fbq',
  name: '发表情',
  description: '30 万+ 在线表情库，关键词搜索',
  homepage: 'https://fabiaoqing.com',
  list,
  getFilters: async () => ([
    { key: 'hotword', name: '热门', options: (await getHotWords()).map(word => ({ value: word, name: word })) },
  ]),
  /** 发表情没有分类维度；hotword 视为一次搜索 */
  listKeywordAsFilter: true,
  refresh() {},
}

export { HOST as FBQ_HOST }
