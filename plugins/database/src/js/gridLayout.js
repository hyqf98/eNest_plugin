/** Shared, DOM-independent geometry for result headers, filters and virtual rows. */
const SAMPLE_LIMIT = 50
const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|uint8|uint16|uint32|uint64|uint128|uint256|int16|int32|int64|int128|int256|hugeint|uhugeint|serial|smallserial|bigserial|serial2|serial4|serial8|decimal|dec|numeric|number|float|float4|float8|float32|float64|double(?:\s+precision)?|real|money|smallmoney|bignum)(?:\s*\([^)]*\))?(?:\s+(?:unsigned|zerofill))*$/i
const BOOLEAN_TYPE = /^(?:bool|boolean)$/i
const TEMPORAL_TYPE = /^(?:date|time|timestamp|timestamptz|timetz|datetime|datetime2|smalldatetime|datetimeoffset|year)(?:\s*\([^)]*\))?(?:\s+(?:with|without)(?:\s+local)?\s+time\s+zone)?$/i

function typeOf(column) {
  // Drivers may expose a numeric wire-protocol code. Do not guess what it means.
  const candidates = [column?.dataType, column?.type]
  const declared = candidates.find(value => typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) || ''
  return declared.trim().replace(/^(?:Nullable|LowCardinality)\((.*)\)$/i, '$1').trim()
}

function validScale(scale) { return Number.isFinite(scale) && scale > 0 ? scale : 1 }
function pixels(value, scale) { return Math.max(1, Math.round(value * scale)) }

/** Alignment is based only on declared types, never the appearance of values. */
export function columnAlignment(column) {
  const type = typeOf(column)
  if (BOOLEAN_TYPE.test(type)) return 'boolean'
  if (NUMERIC_TYPE.test(type)) return 'numeric'
  return 'text'
}

function displayText(value) {
  if (value == null) return 'NULL'
  if (typeof value !== 'object') return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  try { return JSON.stringify(value) || '' } catch { return '[Object]' }
}

function textWidth(text) {
  let longest = 0, current = 0, count = 0
  // Data can contain arbitrarily large JSON or text; a bounded prefix is enough
  // to reach the width cap without making layout scale with payload size.
  for (const char of String(text)) {
    if (++count > 200) break
    if (char === '\n' || char === '\r') { longest = Math.max(longest, current); current = 0; continue }
    if (/\p{Mark}/u.test(char)) continue
    const code = char.codePointAt(0)
    current += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 14 : 7.2
  }
  return Math.max(longest, current)
}

/** Estimate a readable default width from at most 50 values, in actual pixels. */
export function estimateColumnWidth(column, sampleValues = [], scale = 1) {
  scale = validScale(scale)
  const type = typeOf(column)
  const alignment = columnAlignment(column)
  const temporal = TEMPORAL_TYPE.test(type)
  const structured = /^(?:jsonb?|object|array|map)(?:\b|\()/i.test(type)
  const minimum = alignment === 'text' ? temporal ? 180 : structured ? 220 : 160 : 120
  const nameWidth = textWidth(column?.name || '')
  const comment = column?.comment || column?.description || ''
  // A comment is a useful hint, with its full content available in the tooltip.
  // It should not dictate an arbitrarily wide default column.
  const headerWidth = Math.min(224, nameWidth + (comment ? 18 + Math.min(100, textWidth(comment)) : 0)) + 36
  let dataWidth = 0
  for (const value of sampleValues.slice(0, SAMPLE_LIMIT)) dataWidth = Math.max(dataWidth, textWidth(displayText(value)) + 24)
  return pixels(Math.min(280, Math.max(minimum, headerWidth, dataWidth)), scale)
}

/**
 * Create one exact pixel template for all horizontal grid layers.
 * `widths` contains user-resized column widths in actual pixels, keyed by index.
 * Explicit widths never absorb spare viewport space, so dragging stays direct.
 */
export function createGridLayout(columns = [], rows = [], { viewportWidth = 0, scale = 1, widths: overrides = {} } = {}) {
  scale = validScale(scale)
  const selectionWidth = pixels(32, scale)
  const indexWidth = pixels(44, scale)
  const statusWidth = pixels(80, scale)
  const leadingWidth = selectionWidth + indexWidth
  const minimum = pixels(96, scale)
  const flexible = []
  const sample = rows.slice(0, SAMPLE_LIMIT)
  const widths = columns.map((column, index) => {
    const override = overrides instanceof Map ? overrides.get(index) ?? overrides.get(String(index)) : overrides?.[index]
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) return Math.max(minimum, Math.round(override))
    flexible.push(index)
    return estimateColumnWidth(column, sample.map(row => Array.isArray(row) ? row[index] : row?.[column.name]), scale)
  })
  const naturalWidth = leadingWidth + statusWidth + widths.reduce((sum, width) => sum + width, 0)
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, Math.floor(viewportWidth)) : 0
  const extra = Math.max(0, viewport - naturalWidth)
  if (extra && flexible.length) {
    const share = Math.floor(extra / flexible.length), remainder = extra % flexible.length
    flexible.forEach((index, order) => { widths[index] += share + (order < remainder ? 1 : 0) })
  }
  const totalWidth = leadingWidth + statusWidth + widths.reduce((sum, width) => sum + width, 0)
  const template = [selectionWidth, indexWidth, ...widths, statusWidth].map(width => `${width}px`).join(' ')
  return { widths, template, totalWidth, leadingWidth, selectionWidth, indexWidth, statusWidth }
}
