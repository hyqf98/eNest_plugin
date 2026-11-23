/**
 * 当前适配层的注入点。业务模块一律 `getAdapter()`，不直接 import mock 或 live：
 * - 生产：index.ts 在 init 时 setAdapter(createLiveAdapter())
 * - 单测：setAdapter((await createMockAdapter()).adapter)
 */

import { createLiveAdapter } from './live.ts'
import type { Adapter } from './types.ts'

let current: Adapter | null = null

export function getAdapter(): Adapter {
  if (!current) current = createLiveAdapter()
  return current
}

export function setAdapter(adapter: Adapter): void {
  current = adapter
}
