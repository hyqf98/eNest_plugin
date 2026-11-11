/** Declarative defaults. A disabled item remains addressable by its stable ID. */
export const DEFAULT_CONFIG = deepFreeze({
  schemaVersion: 1,
  behavior: {
    automatic: true, delayMs: 70, minPrefixLength: 1,
    /* acceptOnEnter 只在候选弹窗展开时截获 Enter，不影响空行换行；默认开启让键盘流程连贯。 */
    acceptOnEnter: true, acceptOnTab: true, keywordCase: 'upper',
    autoAlias: true, starExpansion: 'suggest', learnUsage: true,
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
  /* 四项提醒默认全开：默认帮用户发现 SELECT *、重复别名、未知字段和会误伤全表的写操作。 */
  diagnostics: { selectStar: 'hint', duplicateAlias: 'warning', unknownColumn: 'hint', unsafeMutation: 'warning' },
  profiles: []
})

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
