function matching(label, prefix) {
  if (!prefix) return { rank: 1, reason: '当前上下文' }
  label = String(label).toLowerCase(); prefix = prefix.toLowerCase()
  if (label === prefix) return { rank: 5, reason: '名称完全匹配' }
  if (label.startsWith(prefix)) return { rank: 4, reason: '名称前缀匹配' }
  if (label.includes(prefix)) return { rank: 3, reason: '名称包含匹配' }
  if (prefix.length < 3) return null
  let offset = 0
  for (const char of prefix) { offset = label.indexOf(char, offset); if (offset < 0) return null; offset++ }
  return { rank: 2, reason: '名称缩写匹配' }
}

export function rankCandidates(items, analysis, config, usage = {}) {
  const seen = new Set(), prefix = analysis.identifier.prefix.toLowerCase()
  const ranked = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    const nameMatch = matching(item.label, prefix)
    const filters = Array.isArray(item.filterText) ? item.filterText : [item.filterText || item.label]
    const extraMatch = filters.map(filter => matching(filter, prefix)).find(Boolean)
    const match = nameMatch || extraMatch
    if (!match && item.source !== 'projection' && !item.nonInsert) continue
    seen.add(item.id)
    const usageEntry = usage.entries?.[item.id] ?? usage[item.id] ?? 0
    const count = typeof usageEntry === 'number' ? usageEntry : usageEntry.count || 0
    const weight = config.ranking?.usageWeight === undefined ? 8 : Math.max(0, Number(config.ranking.usageWeight) || 0)
    const learned = config.behavior?.learnUsage === false ? 0 : Math.min(weight, Math.log2(1 + Math.max(0, count)))
    const pinned = config.ranking?.pinned?.includes(item.id) ? 10 : 0
    const semantic = item.semanticRank || 0
    const matchRank = match?.rank || 1
    const scoreBreakdown = { semantic, match: matchRank, nameMatch: !!nameMatch, pinned, learned }
    ranked.push({ ...item, scoreBreakdown, matchReason: nameMatch ? match.reason : prefix ? '备注或别名匹配' : item.reason, _score: [Math.floor(semantic / 50), nameMatch ? matchRank + 2 : matchRank, semantic + learned + pinned] })
  }
  ranked.sort((a, b) => {
    for (let index = 0; index < a._score.length; index++) if (a._score[index] !== b._score[index]) return b._score[index] - a._score[index]
    return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
  })
  return ranked.map(({ _score, ...item }, index) => ({ ...item, sortText: String(index).padStart(6, '0') }))
}
