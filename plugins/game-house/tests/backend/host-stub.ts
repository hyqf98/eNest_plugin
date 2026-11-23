/**
 * 单测用宿主桩：内存 KV + 假 parentPort。
 * runtime.requestHost 走 process.parentPort（正常只在 eNest utility process 里存在）；
 * 这里装一个假的，并手动把 host.response 喂回 receiveHostResponse，让 store.ts /
 * runtime.ts 的存储与密钥读取在无宿主环境下工作。
 */

import { EventEmitter } from 'node:events'
import { receiveHostResponse } from '../../backend/runtime.ts'

interface HostRequestMessage {
  type?: string
  id?: number
  method?: string
  params?: { key?: string; value?: unknown; ref?: string; handleId?: string; access?: string }
}

class FakeHostPort extends EventEmitter {
  readonly kv = new Map<string, unknown>()
  readonly secrets = new Map<string, string>()
  /** confirm 对话框的固定回答；null 表示未设置（返回 true） */
  confirmAnswer: boolean | null = null
  readonly confirms: Array<{ title: string; message: string }> = []
  /** 登记的本地文件句柄：handleId → 绝对路径（模拟用户经选择器授权的目录 / 文件） */
  readonly handles = new Map<string, string>()

  postMessage(message: unknown): void {
    const msg = message as HostRequestMessage
    if (msg.type !== 'host.request' || typeof msg.id !== 'number') return
    const reply = (ok: boolean, data?: unknown, error?: string): void => {
      receiveHostResponse({ type: 'host.response', id: msg.id!, ok, ...(error ? { error } : { data }) })
    }
    switch (msg.method) {
      case 'storage.get': {
        const key = msg.params?.key ?? ''
        reply(true, this.kv.has(key) ? this.kv.get(key) : null)
        return
      }
      case 'storage.set': {
        this.kv.set(msg.params?.key ?? '', msg.params?.value)
        reply(true, null)
        return
      }
      case 'secret.resolve': {
        const ref = msg.params?.ref ?? ''
        reply(true, this.secrets.has(ref) ? this.secrets.get(ref) : null)
        return
      }
      case 'dialog.confirm': {
        this.confirms.push({ title: msg.params && (msg.params as Record<string, unknown>).title as string, message: msg.params && (msg.params as Record<string, unknown>).message as string })
        reply(true, this.confirmAnswer ?? true)
        return
      }
      case 'files.resolve': {
        const handleId = msg.params && (msg.params as Record<string, unknown>).handleId
        const path = typeof handleId === 'string' ? this.handles.get(handleId) : undefined
        if (!path) { reply(false, undefined, 'invalid or expired local file handle'); return }
        reply(true, path)
        return
      }
      case 'activity.acquire':
      case 'activity.release':
      case 'log.write': {
        reply(true, null)
        return
      }
      default:
        reply(true, null)
    }
  }
}

/** 安装假宿主端口并返回桩句柄（幂等：重复调用复用同一个端口） */
export function installHostStub(): FakeHostPort {
  const holder = process as unknown as { parentPort?: unknown }
  if (holder.parentPort instanceof FakeHostPort) return holder.parentPort
  const port = new FakeHostPort()
  holder.parentPort = port
  return port
}

/** 把会话凭据放进保险库桩（模拟页面 vault.set 后后端 resolveSecret 读到） */
export function putSecret(stub: FakeHostPort, ref: string, value: string): void {
  stub.secrets.set(ref, value)
}
