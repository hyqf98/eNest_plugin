/**
 * 关闭期间宿主请求的准入：保存状态（storage.*）与释放租约必须仍然可用——任务收尾正是靠它们
 * 把 paused 状态与进度落盘；网络、句柄、确认框等一律拒绝。
 * 背景：以前关闭期间所有宿主请求都被拒绝，于是关闭时控制文件写成了、任务记录却还是旧的 downloading。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedWhileClosing } from '../../backend/runtime.ts'

test('关闭期间：保存状态与释放租约可用，发起网络 / 取句柄 / 弹确认框被拒绝', () => {
  for (const method of ['storage.get', 'storage.set', 'activity.release', 'log.write']) {
    assert.equal(allowedWhileClosing(method), true, `${method} 在关闭期间应仍可用`)
  }
  for (const method of ['network.resolveProxy', 'files.resolve', 'dialog.confirm', 'secret.resolve', 'endpoint.allow', 'activity.acquire', 'process.track']) {
    assert.equal(allowedWhileClosing(method), false, `${method} 在关闭期间应被拒绝`)
  }
})
