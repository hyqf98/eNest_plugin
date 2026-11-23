/**
 * 视图逻辑冒烟测试：验证任务状态到文案/色调的映射（taskLabels）。
 * node --test 无法直接解析插件的无扩展名 TS 导入，因此把被测文件
 * 拷贝到 .smoke-tmp 下补全扩展名后再加载；不影响源码与构建产物。
 *
 * 运行：node --test --experimental-strip-types tests/render-smoke.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, '.smoke-tmp')

// 准备：拷贝源文件并补全相对导入的 .ts 扩展名（仅测试运行期）
mkdirSync(tmp, { recursive: true })
copyFileSync(join(here, '../src/shared/contracts.ts'), join(tmp, 'contracts.ts'))
copyFileSync(join(here, '../src/js/taskLabels.ts'), join(tmp, 'taskLabels.ts'))
{
  const file = join(tmp, 'taskLabels.ts')
  const source = readFileSync(file, 'utf8')
  writeFileSync(file, source.replaceAll("'../shared/contracts'", "'./contracts.ts'"))
}

export async function cleanup(): Promise<void> {
  rmSync(tmp, { recursive: true, force: true })
}

process.on('exit', () => { rmSync(tmp, { recursive: true, force: true }) })

const { taskLabel, taskPercent, taskProgressTone, taskTone, parseAccessCode } = await import(`file://${tmp.replaceAll('\\', '/')}/taskLabels.ts`)
const { STATE_LABELS } = await import(`file://${tmp.replaceAll('\\', '/')}/contracts.ts`)

test('taskTone：各状态映射到正确色调', () => {
  assert.equal(taskTone('queued'), 'neutral')
  assert.equal(taskTone('resolving'), 'accent')
  assert.equal(taskTone('downloading'), 'accent')
  assert.equal(taskTone('installing'), 'accent')
  assert.equal(taskTone('paused'), 'neutral')
  assert.equal(taskTone('failed'), 'danger')
  assert.equal(taskTone('install_failed'), 'danger')
  assert.equal(taskTone('login_expired'), 'warn')
  assert.equal(taskTone('complete'), 'ok')
})

test('taskLabel：与契约 STATE_LABELS 一致', () => {
  for (const state of Object.keys(STATE_LABELS) as Array<keyof typeof STATE_LABELS>) {
    assert.equal(taskLabel(state), STATE_LABELS[state])
  }
})

test('taskPercent：下载中按字节比例，解压与完成为 100', () => {
  assert.equal(taskPercent({ state: 'downloading', totalBytes: 200, completedBytes: 50 }), 25)
  assert.equal(taskPercent({ state: 'installing', totalBytes: 0, completedBytes: 0 }), 100)
  assert.equal(taskPercent({ state: 'complete', totalBytes: 100, completedBytes: 100 }), 100)
  assert.equal(taskPercent({ state: 'downloading', totalBytes: 0, completedBytes: 0 }), 0)
})

test('taskProgressTone：完成/解压成功色，失败危险色', () => {
  assert.equal(taskProgressTone('complete'), 'ok')
  assert.equal(taskProgressTone('installing'), 'ok')
  assert.equal(taskProgressTone('failed'), 'danger')
  assert.equal(taskProgressTone('install_failed'), 'danger')
  assert.equal(taskProgressTone('downloading'), 'accent')
  assert.equal(taskProgressTone('paused'), 'accent')
})

test('parseAccessCode：从分享链接解析提取码', () => {
  assert.equal(parseAccessCode('https://cloud.189.cn/t/abc?pwd=a1b2'), 'a1b2')
  assert.equal(parseAccessCode('https://cloud.189.cn/t/abc'), '')
  assert.equal(parseAccessCode('https://cloud.189.cn/t/abc?entry=1&pwd=x9y8'), 'x9y8')
})

// 保留 execFileSync 引用避免 noUnusedLocals 误报（types 里未启用，这里显式使用）
void execFileSync
void cleanup
