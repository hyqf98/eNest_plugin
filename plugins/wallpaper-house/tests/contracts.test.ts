import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampInteger,
  formatBytes,
  isWallpaperFit,
  parseWallpaperError,
  resolutionLabel,
} from '../src/shared/contracts.ts'

test('formatBytes keeps units bounded', () => {
  assert.equal(formatBytes(0), '—')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.match(formatBytes(5 * 1024 * 1024), /^5\.0 MB$/)
})

test('resolutionLabel handles missing dimensions', () => {
  assert.equal(resolutionLabel({}), '—')
  assert.equal(resolutionLabel({ width: 3840, height: 2160 }), '3840 × 2160')
})

test('parseWallpaperError preserves codes and rejects unknown prefixes', () => {
  assert.deepEqual(parseWallpaperError('SOURCE_KEY_REQUIRED: need key'), { code: 'SOURCE_KEY_REQUIRED', message: 'need key' })
  assert.deepEqual(parseWallpaperError('plain failure'), { code: 'INTERNAL', message: 'plain failure' })
})

test('fit and integer helpers reject invalid values', () => {
  assert.equal(isWallpaperFit('fill'), true)
  assert.equal(isWallpaperFit('cover'), false)
  assert.equal(clampInteger(3.7, 1, 5, 1), 4)
  assert.equal(clampInteger(Number.NaN, 1, 5, 2), 2)
})
