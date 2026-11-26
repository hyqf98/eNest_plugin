export function calculate(expression) {
  if (!expression.trim()) return '—'
  const compact = expression.replace(/\s+/g, ''), tokens = compact.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]/g) || []
  if (compact.length > 160 || tokens.join('') !== compact) return '表达式无效'
  let cursor = 0
  function atom() {
    const token = tokens[cursor++]
    if (token === '+') return atom()
    if (token === '-') return -atom()
    if (token === '(') { const value = sum(); if (tokens[cursor++] !== ')') throw new Error(); return value }
    if (!token || !/^[.\d]/.test(token)) throw new Error()
    return Number(token)
  }
  function product() {
    let value = atom()
    while (tokens[cursor] === '*' || tokens[cursor] === '/') { const operator = tokens[cursor++], operand = atom(); value = operator === '*' ? value * operand : value / operand }
    return value
  }
  function sum() {
    let value = product()
    while (tokens[cursor] === '+' || tokens[cursor] === '-') { const operator = tokens[cursor++], operand = product(); value = operator === '+' ? value + operand : value - operand }
    return value
  }
  try { const value = sum(); if (cursor !== tokens.length || !Number.isFinite(value)) return '无法计算'; return String(Number(value.toPrecision(12))) } catch { return '…' }
}
