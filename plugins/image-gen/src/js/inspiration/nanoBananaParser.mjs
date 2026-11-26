/**
 * parseNanoBananaReadme — 把 Awesome-Nano-Banana-images 的 README 翻译成灵感条目（纯函数，不联网）。
 *
 * 仓库（Apache-2.0）：https://github.com/PicoTrex/Awesome-Nano-Banana-images
 * README 是固定的 Markdown 结构，中/英/日/韩等语言版本措辞不同但骨架一致：
 *
 *   ## 🍌 Nano Banana Pro 例子                      ← 分组标题：决定条目适用的模型
 *   ### 例 12: [蓬松毛绒玩具](https://x.com/…/…)(by [@author](…))   ← 条目开始
 *   | <img src="images/pro_case12/output.jpg" …> |                    ← 示例图（相对路径）
 *   **输入:** 需上传一张参考图片                                       ← 需要先上传参考图
 *   **提示词:** / **Prompt:**
 *   ```
 *   提示词正文……                                                     ← 紧随其后的第一个代码块
 *   ```
 *   > [!NOTE]  > **需在 [] 中填入要生成的物品名称**                    ← 使用注意
 *
 * 下面所有正则都同时认中英文措辞；遇到认不出的行就跳过，不中断整份解析。
 */

const RAW_BASE = 'https://raw.githubusercontent.com/PicoTrex/Awesome-Nano-Banana-images/main/'

/** 分组标题 → 适用模型。Pro 组对应 Nano Banana Pro，普通组对应 Nano Banana（Gemini 2.5 Flash Image）。 */
const GROUP_MODELS = [
  { test: /^##+\s+.*nano\s*banana\s*pro/i, models: ['Nano Banana Pro', 'Gemini 3 Pro Image'] },
  { test: /^##+\s+.*nano\s*banana/i, models: ['Nano Banana', 'Gemini 2.5 Flash Image'] },
]

const HEADING = /^###\s+(?:例|案例|Example|Case|예|例)\s*(\d+)\s*[:：]\s*\[([^\]]+)\]\(([^)]*)\)\s*(?:[（(]\s*(?:by\s*)?\[?@?([^\]）)]+)\]?(?:\([^)]*\))?\s*[）)])?/i
/* 冒号在星号里面：「**输入:**」「**提示词:**」；个别条目用全角冒号「**输入：**」。两种冒号都认。
   仓库里「输入」「提示词」两类标签各有上百条，格式并不统一，正则必须按真实文件来。 */
const INPUT_LINE = /^\*\*(?:输入|Input)\s*[:：]?\*\*\s*(.*)$/i
const PROMPT_LABEL = /^\*\*(?:提示词|Prompt)\s*[:：]?\*\*\s*$/i
/* 占位符有两种写法：[方括号] 与 {花括号}（同一仓库里两种都在用）。 */
const PLACEHOLDER = /(?:\[[^\]\n]{1,60}\]|\{[^}\n]{1,60}\})/
/* 表格里的图片：alt 含「输入 / input」的是参考图，其余是输出图 */
const INPUT_IMAGE_ALT = /(?:输入|input)/i

/** 解析一份 README 文本。返回条目数组；任何一段认不出都不会抛错。 */
export function parseNanoBananaReadme(markdown) {
  const items = []
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  let models = ['Nano Banana']
  let current = null
  let wantPrompt = false

  const push = () => {
    if (!current) return
    if (current.prompt && current.prompt.trim()) {
      // 没有分组信息（出现在第一个二级标题之前）时沿用上一条的模型
      current.models = current.models?.length ? current.models : models
      items.push(current)
    }
    current = null
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo].trimEnd()
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      push(); wantPrompt = false
      const group = GROUP_MODELS.find(g => g.test.test(line))
      if (group) models = group.models
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      push(); wantPrompt = false
      current = {
        id: '', title: heading[2].trim(), sourceUrl: heading[3] || '', author: (heading[4] || '').trim(),
        image: '', inputImage: '', prompt: '', input: '', note: '', needsReference: false, hasPlaceholder: false, models,
      }
      continue
    }
    if (!current) continue
    // 表格图片行。只有一张图时它就是示例图——仓库里有几条把 alt 误标成「输入图片」（src 其实是 output.jpg），
    // 按 alt 判断会把它们丢掉；同时出现两张时才靠 alt 区分输入图与输出图。
    const imgs = [...line.matchAll(/<img\s+[^>]*?src="([^"]+)"[^>]*?>/gi)]
    if (imgs.length) {
      if (imgs.length === 1) {
        if (!current.image) current.image = toAbsolute(imgs[0][1])
      } else {
        for (const [tag, src] of imgs) {
          const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? ''
          if (INPUT_IMAGE_ALT.test(alt)) { if (!current.inputImage) current.inputImage = toAbsolute(src) }
          else if (!current.image) current.image = toAbsolute(src)
        }
      }
      continue
    }
    const input = INPUT_LINE.exec(line)
    if (input) { current.input = input[1].trim(); current.needsReference = true; continue }
    if (PROMPT_LABEL.test(line)) { wantPrompt = true; continue }
    if (wantPrompt && /^```/.test(line)) { current.prompt = readFence(lines, lineNo); wantPrompt = false; continue }
    if (/^>\s*\[!NOTE\]/i.test(line)) {
      // 「> [!NOTE]」这一行永远没有正文，文案在后续的「> …」行里；读到引用块结束或空行为止。
      const body = []
      for (let j = lineNo + 1; j < lines.length && /^>/.test(lines[j].trim()); j += 1) {
        const text = lines[j].replace(/^>\s?/, '').replace(/\*\*/g, '').trim()
        if (text) body.push(text)
      }
      if (body.length) current.note = body.join(' ')
      continue
    }
  }
  push()

  return items.map((item, index) => {
    item.id = `nb-${index + 1}`
    item.hasPlaceholder = PLACEHOLDER.test(item.prompt)
    item.prompt = item.prompt.trim()
    return item
  })
}

/** 从开栏行起读到闭栏为止，返回代码块正文（不含围栏） */
function readFence(lines, start) {
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^```/.test(lines[i].trim())) break
    body.push(lines[i])
  }
  return body.join('\n')
}

function toAbsolute(src) {
  const value = String(src ?? '').trim()
  if (/^https?:\/\//i.test(value)) return value
  return RAW_BASE + value.replace(/^\.?\//, '')
}
