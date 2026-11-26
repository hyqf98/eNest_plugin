export function fenceOpening(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match || match[1][0] === '`' && match[2].includes('`')) return null
  return { marker: match[1], info: match[2].trim() }
}

export function fenceClosing(line, marker) {
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)
  return !!closing && closing[1][0] === marker[0] && closing[1].length >= marker.length
}

export function fenceContentRange(source) {
  const openingEnd = source.indexOf('\n')
  const firstLine = openingEnd < 0 ? source : source.slice(0, openingEnd)
  const opening = fenceOpening(firstLine)
  if (!opening) return null
  const info = opening.info.split(/\s+/, 1)[0].toLowerCase()
  const from = openingEnd < 0 ? source.length : openingEnd + 1
  const lastBreak = source.lastIndexOf('\n')
  const closed = lastBreak >= 0 && fenceClosing(source.slice(lastBreak + 1), opening.marker)
  return { from, to: closed ? Math.max(from, lastBreak) : source.length, info }
}

export function mathContentStart(source) {
  const opening = /^ {0,3}\$\$[\t ]*(?:\n[\t ]*)?/.exec(source)
  return opening?.[0].length ?? 0
}

function uniqueTextStart(source, text) {
  const from = text ? source.indexOf(text) : -1
  return from >= 0 && source.indexOf(text, from + 1) < 0 ? from : null
}

export function htmlTextStart(source, text) {
  const from = uniqueTextStart(source, text)
  if (from == null) return null
  const to = from + text.length
  return (from === 0 || source[from - 1] === '>') && (to === source.length || source[to] === '<') ? from : null
}

export function diagramLabelStart(source, label) {
  if (!/^\s*(?:graph|flowchart)(?:[\t ]|$)/m.test(source)) return null
  const from = uniqueTextStart(source, label)
  if (from == null) return null
  let left = from - 1, right = from + label.length
  while (left >= 0 && /[\t ]/.test(source[left])) left--
  while (right < source.length && /[\t ]/.test(source[right])) right++
  if (source[left] === '"' && source[right] === '"') { left--; right++ }
  const pair = `${source[left]}${source[right]}`
  return ['[]', '{}', '()', '||'].includes(pair) ? from : null
}
