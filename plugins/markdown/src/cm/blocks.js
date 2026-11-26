import { fenceClosing, fenceOpening } from './clickMap.js'
import { parseTable } from '../render/tableOps.js'

const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const setext = /^ {0,3}(=+|-+)[ \t]*$/
const rule = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const quote = /^ {0,3}>/
const list = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
const indent = /^(?: {2,}|\t)/
const openMath = /^ {0,3}\$\$[ \t]*$/
const sameLineMath = /^ {0,3}\$\$(?!\$).+?\$\$[ \t]*$/
const pipe = /(?:^|[^\\])\|/
const divider = /^ {0,3}[:|\-][\t :|\-]*$/
const html = /^ {0,3}(?:<\/?(?:address|article|aside|blockquote|center|details|div|dl|figure|figcaption|footer|form|h[1-6]|header|iframe|main|nav|ol|p|pre|script|section|style|summary|table|ul|video|audio)(?=[\s/>])|<(?:img|br)\b[^>]*\/?\s*>\s*$)/i
const rawHtml = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?=[\s>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/], [/^ {0,3}<\?/, /\?>/], [/^ {0,3}<!\[CDATA\[/, /\]\]>/], [/^ {0,3}<![A-Za-z]/, />/],
]
const rawEnd = line => line.trimStart().startsWith('<') && rawHtml.find(([start]) => start.test(line))?.[1]

export function parseBlocks(doc) {
  const lines = doc.split('\n')
  const offsets = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
  const blocks = []
  let index = 0
  const append = (type, last, attributes) => {
    const from = offsets[index], to = offsets[last] + lines[last].length
    blocks.push({ type, from, to, text: doc.slice(from, to), ...attributes })
    index = last + 1
  }
  const tableAt = row => row + 1 < lines.length && pipe.test(lines[row]) && divider.test(lines[row + 1]) && !!parseTable(`${lines[row]}\n${lines[row + 1]}`)
  const interrupts = row => {
    const line = lines[row]
    return !line.trim() || atx.test(line) || quote.test(line) || list.test(line) || rule.test(line) || fenceOpening(line) || openMath.test(line) || sameLineMath.test(line) || html.test(line) || rawEnd(line) || tableAt(row)
  }
  if (lines[0] === '---') {
    const close = lines.findIndex((line, row) => row > 0 && (line === '---' || line === '...'))
    if (close > 0) append('meta', close)
  }
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const fence = fenceOpening(line)
    if (fence) {
      let end = index + 1
      while (end < lines.length && !fenceClosing(lines[end], fence.marker)) end++
      append('fence', Math.min(end, lines.length - 1), { info: fence.info, incomplete: end === lines.length })
      continue
    }
    if (openMath.test(line)) {
      let end = index + 1
      while (end < lines.length && !openMath.test(lines[end])) end++
      append('math', Math.min(end, lines.length - 1), { incomplete: end === lines.length })
      continue
    }
    if (sameLineMath.test(line)) { append('math', index); continue }
    const heading = atx.exec(line)
    if (heading) { append('heading', index, { level: heading[1].length }); continue }
    if (rule.test(line)) { append('hr', index); continue }
    if (tableAt(index)) {
      let end = index + 2
      while (end < lines.length && pipe.test(lines[end]) && !interrupts(end)) end++
      append('table', end - 1)
      continue
    }
    if (quote.test(line)) {
      let end = index + 1
      while (end < lines.length && (quote.test(lines[end]) || !interrupts(end))) end++
      append('quote', end - 1)
      continue
    }
    if (list.test(line)) {
      let end = index + 1
      while (end < lines.length && lines[end].trim() && (list.test(lines[end]) || indent.test(lines[end]) || !interrupts(end))) end++
      append('list', end - 1)
      continue
    }
    const closeTag = rawEnd(line)
    if (closeTag) {
      let end = index
      while (end + 1 < lines.length && !closeTag.test(lines[end])) end++
      append('html', end, { incomplete: !closeTag.test(lines[end]) })
      continue
    }
    if (html.test(line)) {
      let end = index + 1
      while (end < lines.length && lines[end].trim()) end++
      append('html', end - 1)
      continue
    }
    let end = index + 1
    while (end < lines.length && !setext.test(lines[end]) && !interrupts(end)) end++
    const underline = end < lines.length && setext.exec(lines[end])
    if (underline && !/^(?: {4}|\t)/.test(line)) append('heading', end, { style: 'setext', level: underline[1][0] === '=' ? 1 : 2 })
    else append('paragraph', end - 1)
  }
  return blocks
}

export function firstBlockAtOrAfter(blocks, position) {
  let low = 0, high = blocks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (blocks[middle].to < position) low = middle + 1
    else high = middle
  }
  return low
}

export function blockAt(blocks, position) {
  const block = blocks[firstBlockAtOrAfter(blocks, position)]
  return block && block.from <= position ? block : null
}
