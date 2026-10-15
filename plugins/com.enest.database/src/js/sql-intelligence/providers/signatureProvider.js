import { candidate } from '@db/sql-intelligence/edits/editPlanner.js'
import { functionDefinitions } from './functionProvider.js'

/** Bracket depth makes nested calls and commas inside expressions independent. */
export function activeSignature(analysis, config, request, boundTable) {
  if (analysis.suppressed) return null
  const stack = []
  const tokens = analysis.tokens.filter(token => token.start >= analysis.statement.start && token.end <= analysis.cursor && token.kind !== 'comment')
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.value === '(') stack.push({ name: tokens[index - 1]?.value, depth: token.depth, parameter: 0, start: token.start })
    else if (token.value === ')') stack.pop()
    else if (token.value === ',' && stack.length && token.depth === stack.at(-1).depth + 1) stack.at(-1).parameter++
  }
  const active = stack.at(-1)
  if (!active?.name) return null
  const definitions = functionDefinitions(analysis.dialect, config, request, boundTable).filter(fn => fn.name.toLowerCase() === active.name.toLowerCase())
  if (!definitions.length) return null
  return { active, signatures: definitions.map(fn => ({ label: fn.signature || `${fn.name}(${(fn.parameters || []).join(', ')})`, documentation: fn.description || '', parameters: (fn.parameters || []).map(label => ({ label })) })) }
}

export function signatureProvider({ analysis, config, request, boundTable }) {
  const result = activeSignature(analysis, config, request, boundTable)
  if (!result) return []
  const { active, signatures } = result
  return signatures.map((signature, index) => {
    const parameter = signature.parameters[Math.min(active.parameter, signature.parameters.length - 1)]?.label
    const description = parameter ? `当前参数 ${active.parameter + 1}：${parameter}` : '此函数没有参数'
    // A read-only row lives in the existing caret list. Accepting it is a no-op;
    // argument candidates remain available directly below it.
    return candidate(analysis, { id: `signature:${active.start}:${index}`, kind: 'info', source: 'signature', label: signature.label, insertText: '', nonInsert: true, semanticRank: 250, detail: description, presentation: { type: '', description }, editPlan: { from: analysis.cursor, to: analysis.cursor, text: '', additionalEdits: [] } })
  })
}
