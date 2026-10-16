/** Declarative defaults. A disabled item remains addressable by its stable ID. */
export const DEFAULT_CONFIG = deepFreeze({
  schemaVersion: 1,
  behavior: {
    automatic: true, delayMs: 70, minPrefixLength: 1,
    acceptOnEnter: false, acceptOnTab: true, keywordCase: 'upper',
    autoAlias: false, starExpansion: 'suggest', learnUsage: true,
    commentSearch: true, maxItems: 100
  },
  columnSets: [],
  templates: [
    { id: 'builtin.select-all', label: '查询全部字段', trigger: 'sel', language: 'sql', contexts: ['statementStart'], generator: 'select', projection: { source: 'allColumns' }, limit: { value: 200, syntax: 'dialect' } },
    { id: 'builtin.select-common', label: '查询常用字段', trigger: 'selc', language: 'sql', contexts: ['statementStart'], generator: 'select', projection: { source: 'columnSet' }, limit: { value: 200, syntax: 'dialect' } }
  ],
  functions: [],
  enums: [],
  ranking: { pinned: [], usageWeight: 8 },
  metadata: { ttlMs: 300000, maxObjects: 500, prefetch: 'referenced' },
  diagnostics: { selectStar: 'hint', duplicateAlias: 'warning', unknownColumn: 'off', unsafeMutation: 'warning' },
  profiles: []
})

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
