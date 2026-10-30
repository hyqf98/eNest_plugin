import { createIndexedView, createLaunchIndex } from '@enest/plugin-kit/launch-index'

const api = window.enest || window.zapi
export const SSH_CONNECT_CODE = 'connect-profile'

export function savedProfileId(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('连接标识无效')
  }
  return value
}

export function profileLaunchEntries(profiles) {
  if (!Array.isArray(profiles)) throw new Error('已保存的 SSH 连接格式无效')
  const ids = new Set()
  return profiles.map(profile => {
    const id = savedProfileId(profile?.id)
    if (ids.has(id)) throw new Error('已保存的 SSH 连接标识重复')
    ids.add(id)
    const title = (typeof profile.name === 'string' ? profile.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 256) : '') || 'SSH 连接'
    return { id, title, subtitle: 'SSH · 已保存连接', aliases: [title], code: SSH_CONNECT_CODE, payload: { profileId: id } }
  })
}

function report(message) {
  const result = api?.ui?.toast?.({ message, type: 'error' })
  result?.catch?.(() => {})
}

export const sshLaunchIndex = createLaunchIndex({
  api, storageKey: 'ssh.profiles', toEntries: profileLaunchEntries,
  onIndexError: () => report('连接已保存，Quick 目录同步失败，正在重试')
})

export const sshIndexedView = createIndexedView({
  api, index: sshLaunchIndex,
  acceptsEnter: event => event?.code === SSH_CONNECT_CODE,
  onError: error => report(error?.message || 'SSH 工作台启动失败，请重新打开插件')
})
