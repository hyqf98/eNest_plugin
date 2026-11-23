/**
 * 天翼云相关方法：auth.* 与 share.parse。
 * 登录逻辑在 library/authService.ts；这里只做参数校验与结果整形。
 */

import { BackendError } from '../adapters/types.ts'
import type { AuthInfo, ShareParseResult } from '../contracts.ts'
import { parseShare } from '../cloud189/share.ts'
import { formatSize, optionalBoolean, optionalString, requireString } from '../util.ts'
import type { AuthService } from '../library/authService.ts'

/** 分享链接长度上限：正常链接很短，超长的一定不是链接 */
const MAX_SHARE_INPUT = 2048

export async function shareParse(service: AuthService, rawUrl: unknown, rawCode: unknown): Promise<ShareParseResult> {
  const url = requireString(rawUrl, '分享链接', MAX_SHARE_INPUT).trim()
  const accessCode = optionalString(rawCode, '提取码', 32).trim()
  // 解析分享本身不需要登录
  const parsed = await parseShare(url, accessCode)
  if (!parsed.files.length && !parsed.folders.length) throw new BackendError('SHARE_EMPTY', '分享里没有可下载的文件')
  return {
    title: parsed.title,
    shareId: parsed.shareId,
    files: parsed.files.map(file => ({ id: file.id, name: file.name, size: file.size, sizeText: file.size > 0 ? formatSize(file.size) : '' })),
    folders: parsed.folders.map(folder => ({ id: folder.id, name: folder.name })),
  }
}

export function authInfo(service: AuthService): Promise<AuthInfo> {
  return service.info()
}

export function authSaveSession(service: AuthService, raw: unknown): Promise<{ ok: boolean; removeRefs: string[] }> {
  const input = (raw ?? {}) as Record<string, unknown>
  const accountRef = optionalString(input.accountRef, '账号引用', 512)
  const passwordRef = optionalString(input.passwordRef, '密码引用', 512)
  return service.saveSession({
    sessionRef: requireString(input.sessionRef, '会话引用', 512),
    accountRef: accountRef || undefined,
    passwordRef: passwordRef || undefined,
    account: optionalString(input.account, '账号', 320).trim(),
    rememberPassword: input.rememberPassword === undefined ? true : optionalBoolean(input.rememberPassword, true),
  })
}

export function authLogout(service: AuthService): Promise<{ ok: boolean; removeRefs: string[] }> {
  return service.logout()
}

export function authForget(service: AuthService, rawConfirmed: unknown): Promise<{ ok: boolean; removeRefs: string[] }> {
  return service.forget(optionalBoolean(rawConfirmed, false))
}
