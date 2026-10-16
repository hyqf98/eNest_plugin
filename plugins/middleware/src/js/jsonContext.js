/** A small JSON state scanner for incomplete documents; no execution or dynamic evaluation. */
export function jsonCompletionContext(source, caret) {
  const stack = [{ type: 'root', state: 'value', path: [] }]
  const pathFor = frame => frame.type === 'object' ? [...frame.path, frame.key] : frame.type === 'array' ? [...frame.path, String(frame.index)] : []
  const result = (frame, from, prefix, quoted = false) => {
    if (!['key', 'value'].includes(frame.state)) return null
    let to = caret, closed = false
    if (quoted) {
      let escaped = false
      while (to < source.length) {
        const char = source[to]
        if (!escaped && char === '"') { closed = true; break }
        if (!escaped && /[\r\n]/.test(char)) break
        if (!escaped && char === '\\') escaped = true
        else escaped = false
        to++
      }
    } else while (to < source.length && /[A-Za-z0-9.+-]/.test(source[to])) to++
    return { role: frame.state, field: frame.key || '', path: frame.state === 'key' ? frame.path : pathFor(frame), from, to, prefix, quoted, closed }
  }
  let index = 0
  while (index < caret) {
    const frame = stack.at(-1), char = source[index]
    if (/\s/.test(char)) { index++; continue }
    if (char === '"') {
      const start = index++
      let escaped = false, closed = false
      while (index < caret) {
        const next = source[index++]
        if (!escaped && next === '"') { closed = true; break }
        if (!escaped && next === '\\') escaped = true
        else escaped = false
      }
      if (!closed) {
        const prefix = source.slice(start + 1, caret)
        if (/[\\\r\n]/.test(prefix)) return null
        return result(frame, start + 1, prefix, true)
      }
      if (frame.state === 'key') {
        try { frame.key = JSON.parse(source.slice(start, index)) } catch { return null }
        frame.state = 'colon'
      } else if (frame.state === 'value') frame.state = 'after'
      else return null
      continue
    }
    if (char === '{' || char === '[') {
      if (frame.state !== 'value') return null
      const path = pathFor(frame); frame.state = 'after'
      stack.push({ type: char === '{' ? 'object' : 'array', state: char === '{' ? 'key' : 'value', path, index: 0 })
      index++; continue
    }
    if (char === '}' || char === ']') {
      if (stack.length === 1 || (char === '}') !== (frame.type === 'object')) return null
      stack.pop(); index++; continue
    }
    if (char === ':') { if (frame.state !== 'colon') return null; frame.state = 'value'; index++; continue }
    if (char === ',') { if (frame.state !== 'after' || frame.type === 'root') return null; frame.state = frame.type === 'object' ? 'key' : 'value'; frame.index++; index++; continue }
    if (frame.state !== 'value') return null
    const start = index
    while (index < caret && !/[\s,}\]]/.test(source[index])) index++
    if (index === caret) return result(frame, start, source.slice(start, caret))
    try { JSON.parse(source.slice(start, index)) } catch { return null }
    frame.state = 'after'
  }
  return result(stack.at(-1), caret, '')
}
