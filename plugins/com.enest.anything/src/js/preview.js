/** 预览面板：文本（编码探测）与图片；其余类型给出去系统打开的引导。 */
import { backend } from './backend.js'
import { fileKind } from './icons.js'
import { formatSize, formatWhen } from './query.js'

const TEXT_KINDS = new Set(['code', 'doc', 'sheet'])
const TEXT_EXT_EXTRA = 'log ini conf env gitignore npmrc editorconfig properties'

function textReadable(ext) {
  return TEXT_KINDS.has(fileKind({ ext, isDirectory: false })) || TEXT_EXT_EXTRA.includes(String(ext || ''))
}

export function createPreview(root) {
  let seq = 0

  const node = (tag, className, text) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text != null) element.textContent = text
    return element
  }

  function placeholder(text) {
    root.replaceChildren(node('div', 'empty', text))
  }

  function renderHeader(file, metaText) {
    const head = node('div', 'preview-head')
    head.append(node('strong', 'preview-name', file.name), node('span', 'preview-meta', metaText))
    return head
  }

  async function load(file) {
    const token = ++seq
    const metaBits = [formatSize(file.size, file.isDirectory), formatWhen(file.mtimeMs)].filter(Boolean).join(' · ')
    if (file.isDirectory) {
      const head = renderHeader(file, metaBits)
      const body = node('div', 'empty', '目录双击或回车在访达中打开')
      root.replaceChildren(head, body)
      return
    }
    const kind = fileKind(file)
    if (kind === 'image') {
      root.replaceChildren(renderHeader(file, metaBits), node('div', 'preview-loading', '读取图片…'))
      try {
        const { dataUrl } = await backend.readImage(file.path)
        if (token !== seq) return
        const image = node('img', 'preview-image')
        image.src = dataUrl
        image.alt = file.name
        root.replaceChildren(renderHeader(file, metaBits), image)
      } catch (error) {
        if (token !== seq) return
        root.replaceChildren(renderHeader(file, metaBits), node('div', 'empty', error.message))
      }
      return
    }
    if (textReadable(file.ext)) {
      root.replaceChildren(renderHeader(file, metaBits), node('div', 'preview-loading', '读取内容…'))
      try {
        const { content, encoding, truncated, size } = await backend.readText(file.path)
        if (token !== seq) return
        const pre = node('pre', 'preview-text')
        pre.textContent = content
        const foot = node('div', 'preview-note', `${encoding}${truncated ? ` · 已截断（文件 ${formatSize(size)}）` : ''}`)
        root.replaceChildren(renderHeader(file, metaBits), pre, foot)
      } catch (error) {
        if (token !== seq) return
        root.replaceChildren(renderHeader(file, metaBits), node('div', 'empty', error.message))
      }
      return
    }
    root.replaceChildren(renderHeader(file, metaBits), node('div', 'empty', '该类型暂不支持内嵌预览，回车用系统应用打开'))
  }

  placeholder('选择左侧文件查看预览')
  return { load, placeholder }
}
