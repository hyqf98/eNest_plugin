export function changedText(before, after) {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from++
  if (from > 0 && /[\uD800-\uDBFF]/.test(before[from - 1])) from--
  let to = before.length
  let end = after.length
  while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end-- }
  if (to < before.length && /[\uDC00-\uDFFF]/.test(before[to])) { to++; end++ }
  return { from, to, insert: after.slice(from, end) }
}
