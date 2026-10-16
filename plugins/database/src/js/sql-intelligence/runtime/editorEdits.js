import { applyEditPlan } from '@db/sql-intelligence/edits/editPlanner.js'

/** Textarea keeps the first numbered placeholder selected; Monaco owns full tab navigation. */
export function plainSnippet(snippet) {
  let first = null, text = '', last = 0
  const source = String(snippet)
  const pattern = /(?<!\\)\$\{(\d+)(?::([^}]*))?\}|(?<!\\)\$(\d+)/g
  const matches = [...source.matchAll(pattern)], defaults = new Map()
  for (const match of matches) if (match[2] !== undefined && !defaults.has(Number(match[1]))) defaults.set(Number(match[1]), match[2])
  const unescape = value => value.replace(/\\([\\$}])/g, '$1')
  for (const match of matches) {
    text += unescape(source.slice(last, match.index))
    const index = Number(match[1] ?? match[3]), value = unescape(defaults.get(index) || ''), start = text.length
    text += value
    if (!first || index > 0 && (first.index === 0 || index < first.index)) first = { index, from: start, to: text.length }
    last = match.index + match[0].length
  }
  text += unescape(source.slice(last))
  return { text, selection: first }
}
export function prepareEdits(source, item, replace) {
  const plan = item.editPlan || { ...replace, text: item.insertText || item.label }
  const snippet = plan.snippet ? plainSnippet(plan.snippet) : { text: plan.text, selection: null }
  const plain = { ...plan, text: snippet.text }
  const result = applyEditPlan(source, plain)
  const before = (plan.additionalEdits || []).filter(edit => edit.to <= plan.from).reduce((sum, edit) => sum + edit.text.length - (edit.to - edit.from), 0)
  return { plan, plain, result, selection: { from: before + plan.from + (snippet.selection?.from ?? snippet.text.length), to: before + plan.from + (snippet.selection?.to ?? snippet.text.length) } }
}
