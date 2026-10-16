export function candidate(analysis, properties) {
  const range = properties.range || { from: analysis.identifier.from, to: analysis.identifier.to }
  const text = properties.insertText ?? properties.label
  const editPlan = properties.editPlan || { ...range, text, additionalEdits: [] }
  return {
    id: properties.id || `${properties.kind}:${properties.owner || ''}:${properties.label}`,
    kind: properties.kind, label: properties.label, detail: properties.detail || '',
    doc: properties.doc || properties.detail || '', insertText: text,
    filterText: properties.filterText || properties.label,
    reason: properties.reason || '当前语法位置', source: properties.source || 'catalog',
    confidence: properties.confidence || 'verified', semanticRank: properties.semanticRank ?? 50,
    owner: properties.owner, ...properties, editPlan
  }
}

/** Edits are validated together and applied against one immutable text snapshot. */
export function applyEditPlan(sql, plan) {
  const edits = [{ from: plan.from, to: plan.to, text: plan.text }, ...(plan.additionalEdits || [])].sort((a, b) => a.from - b.from)
  let previousEnd = -1
  for (const edit of edits) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > sql.length || edit.from < previousEnd) throw new Error('补全编辑范围无效或重叠')
    previousEnd = edit.to
  }
  return edits.reverse().reduce((text, edit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to), sql)
}

/** Named template variables are resolved before handing numbered snippets to an editor. */
export function compileSnippet(body, variables = {}) {
  return String(body || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => Object.hasOwn(variables, name) ? String(variables[name]) : match)
}
