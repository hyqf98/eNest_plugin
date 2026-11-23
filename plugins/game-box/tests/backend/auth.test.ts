/**
 * 登录服务里"引用生命周期"的单测：换会话、取消记住密码、退出登录之后，
 * 哪些保险库条目不再被后端引用、必须交回页面删除。
 * 背景：后端写不了保险库，只有页面能删。后端把引用记录一清，条目就再也没人找得到，
 * 于是旧密码会变成删不掉的孤儿。不联网（云盘客户端换成假的）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Cloud189Client } from '../../backend/cloud189/index.ts'
import { BackendError } from '../../backend/adapters/types.ts'
import { AuthService, mockCloudClients, replacedSecrets } from '../../backend/library/authService.ts'
import { flushStore, loadAuthMeta, saveAuthMeta, type AuthMeta } from '../../backend/store.ts'
import { installHostStub, putSecret, type FakeHostPort } from './host-stub.ts'

/** 只实现登录服务会用到的那几个方法；任何网络访问都会直接抛错 */
function fakeClient(state: 'logged-in' | 'logged-out' = 'logged-in'): Cloud189Client {
  const calls = { checkLogin: 0, logout: 0 }
  const client = {
    calls,
    async checkLogin() { calls.checkLogin++; return { state, nickname: '测试用户' } },
    logout() { calls.logout++ },
  }
  return client as unknown as Cloud189Client
}

async function resetAuth(stub: FakeHostPort): Promise<void> {
  saveAuthMeta({ sessionRef: '', accountRef: '', passwordRef: '', nickname: '', account: '', loginAt: 0 })
  await flushStore()
  stub.kv.delete('auth.meta')
  stub.secrets.clear()
}

async function withAuth(run: (context: { stub: FakeHostPort; service: AuthService; clients: Cloud189Client[] }) => Promise<void>): Promise<void> {
  const stub = installHostStub()
  const made: Cloud189Client[] = []
  const restore = mockCloudClients(() => { const client = fakeClient(); made.push(client); return client })
  await resetAuth(stub)
  try {
    await run({ stub, service: new AuthService(), clients: made })
  } finally {
    restore()
    await resetAuth(stub)
  }
}

test('replacedSecrets：旧引用不等于新引用才算被替换', () => {
  const before: AuthMeta = { sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', nickname: '', account: '', loginAt: 0 }
  assert.deepEqual(replacedSecrets(before, { sessionRef: 's2', accountRef: 'a1', passwordRef: 'p1' }), ['s1'])
  assert.deepEqual(replacedSecrets(before, { sessionRef: 's1', accountRef: '', passwordRef: '' }), ['a1', 'p1'])
  assert.deepEqual(replacedSecrets(before, { sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1' }), [])
  assert.deepEqual(replacedSecrets({ ...before, passwordRef: '' }, { sessionRef: 's2', accountRef: 'a1', passwordRef: '' }), ['s1'])
})

test('首次登录没有任何旧引用', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1')
    const result = await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    assert.deepEqual(result, { ok: true, removeRefs: [] })
  })
})

test('扫码登录顶掉账密登录：不再记住的账号密码引用必须交回页面', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1'); putSecret(stub, 's2', 'session-2')
    await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    // 页面在扫码成功后就是这样调用的：没有账号密码可记，rememberPassword 为 false
    const result = await service.saveSession({ sessionRef: 's2', rememberPassword: false })
    // 缺陷版本在这里返回 []：记录被清空，保险库里的旧密码却没人删
    assert.deepEqual(result.removeRefs.sort(), ['a1', 'p1', 's1'])
    const meta = await loadAuthMeta()
    assert.equal(meta.passwordRef, '')
    assert.equal(meta.sessionRef, 's2')
    assert.equal(meta.account, '', '取消记住密码后账号也不保留')
  })
})

test('重新账号密码登录：换了密码时旧密码引用交回，账号不变则保留', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1'); putSecret(stub, 's2', 'session-2')
    await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    const result = await service.saveSession({ sessionRef: 's2', accountRef: 'a1', passwordRef: 'p2', account: '13800138000' })
    assert.deepEqual(result.removeRefs.sort(), ['p1', 's1'])
    const meta = await loadAuthMeta()
    assert.equal(meta.passwordRef, 'p2')
    assert.equal(meta.accountRef, 'a1')
    assert.equal(meta.account, '13800138000')
  })
})

test('退出登录：旧会话引用交回页面删除，记住的账号密码保留', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1')
    await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    const result = await service.logout()
    assert.deepEqual(result, { ok: true, removeRefs: ['s1'] })
    const meta = await loadAuthMeta()
    assert.equal(meta.sessionRef, '')
    assert.equal(meta.accountRef, 'a1', '退出登录不等于忘记密码')
    assert.equal(meta.passwordRef, 'p1')
    // 退出后再退一次：没有会话，不产生待删引用
    assert.deepEqual(await service.logout(), { ok: true, removeRefs: [] })
  })
})

test('saveSession 拒绝解不出来的会话引用，且不动已有记录', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1')
    await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1' })
    await assert.rejects(service.saveSession({ sessionRef: 'nope' }), (error: BackendError) => error.code === 'INVALID_ARGUMENT')
    const meta = await loadAuthMeta()
    assert.equal(meta.sessionRef, 's1')
    assert.equal(meta.passwordRef, 'p1')
  })
})

test('忘记密码：两步之间记录不变，确认后才清', async () => {
  await withAuth(async ({ stub, service }) => {
    putSecret(stub, 's1', 'session-1')
    await service.saveSession({ sessionRef: 's1', accountRef: 'a1', passwordRef: 'p1', account: '13800138000' })
    const first = await service.forget()
    assert.deepEqual(first, { ok: true, removeRefs: ['a1', 'p1'] })
    assert.equal((await loadAuthMeta()).passwordRef, 'p1', '第一步不清记录')
    assert.deepEqual(await service.forget(true), { ok: true, removeRefs: [] })
    const meta = await loadAuthMeta()
    assert.equal(meta.passwordRef, '')
    assert.equal(meta.accountRef, '')
    assert.equal(meta.sessionRef, 's1', '忘记密码不影响登录状态')
  })
})
