/**
 * com.github.eNest.remote-desktop — 资产存储层
 * 键：rdp.profiles | rdp.groups | rdp.recent | rdp.ui
 * 密码不落 storage：vault.set → secretRef（无明文回读；编辑留空=不改）。
 */
;(function (global) {
  'use strict'

  const api = () => global.enest || global.zapi || null
  const KEYS = {
    profiles: 'rdp.profiles',
    groups: 'rdp.groups',
    recent: 'rdp.recent',
    ui: 'rdp.ui'
  }
  const RECENT_MAX = 30

  const uid = prefix => (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  function defaultProfile() {
    return {
      id: uid('rdp'),
      name: '',
      host: '',
      port: 5901,
      protocol: 'vnc',          // vnc | rdp
      username: '',
      passwordRef: '',          // vault secretRef；空 = 无密码
      hasPassword: false,       // 展示用（存在性，不回读明文）
      groupId: '',
      tags: [],
      tunnel: { enabled: false, sshProfileId: '' },
      viewOnly: false
    }
  }

  function sanitizeProfile(p) {
    const copy = { ...p }
    delete copy.password
    return copy
  }

  function normalizeProfile(raw) {
    const base = defaultProfile()
    if (!raw || typeof raw !== 'object') return null
    const protocol = raw.protocol === 'rdp' ? 'rdp' : 'vnc'
    const host = String(raw.host || '').trim()
    if (!host) return null
    const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : (protocol === 'rdp' ? 3389 : 5901)
    return {
      ...base,
      ...raw,
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('rdp'),
      name: String(raw.name || host).slice(0, 80),
      host: host.slice(0, 200),
      port,
      protocol,
      username: String(raw.username || '').slice(0, 80),
      passwordRef: typeof raw.passwordRef === 'string' ? raw.passwordRef : '',
      hasPassword: raw.hasPassword === true,
      groupId: typeof raw.groupId === 'string' ? raw.groupId : '',
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 8).map(t => String(t).slice(0, 16)) : [],
      tunnel: {
        enabled: raw.tunnel?.enabled === true,
        sshProfileId: String(raw.tunnel?.sshProfileId || '')
      },
      viewOnly: raw.viewOnly === true
    }
  }

  function normalizeGroup(raw) {
    if (!raw || typeof raw !== 'object') return null
    const name = String(raw.name || '').trim().slice(0, 30)
    if (!name) return null
    return { id: typeof raw.id === 'string' && raw.id ? raw.id : uid('grp'), name }
  }

  function normalizeRecent(raw) {
    if (!raw || typeof raw !== 'object') return null
    const when = Number(raw.when)
    if (!Number.isFinite(when)) return null
    return {
      profileId: String(raw.profileId || ''),
      name: String(raw.name || '').slice(0, 80),
      host: String(raw.host || '').slice(0, 200),
      port: Number(raw.port) || 0,
      protocol: raw.protocol === 'rdp' ? 'rdp' : 'vnc',
      when,
      durationMs: Number.isFinite(raw.durationMs) ? raw.durationMs : 0,
      ok: raw.ok !== false
    }
  }

  /** vnc://host:5901 / rdp://user@host:3389?readonly=1 / rdp://host 解析 */
  function parseUri(text) {
    const value = String(text || '').trim()
    const match = /^(vnc|rdp):\/\//i.exec(value)
    if (!match) return null
    try {
      const url = new URL(value)
      const protocol = match[1].toLowerCase()
      const host = url.hostname || ''
      if (!host) return null
      const defaultPort = protocol === 'rdp' ? 3389 : 5901
      const port = url.port ? Number(url.port) : defaultPort
      const username = decodeURIComponent(url.username || '')
      const params = new URLSearchParams(url.search)
      return {
        protocol, host, port, username,
        password: url.password ? decodeURIComponent(url.password) : '',
        name: url.hash ? decodeURIComponent(url.hash.slice(1)) : host,
        viewOnly: params.get('readonly') === '1' || params.get('readonly') === 'true'
      }
    } catch { return null }
  }

  function createStore() {
    const listeners = new Set()
    let state = { profiles: [], groups: [], recent: [], ui: { selectedGroupId: '', search: '' } }

    const notify = () => { for (const fn of listeners) fn(state) }

    async function loadAll() {
      const host = api()
      const get = async (key, fallback) => {
        try {
          const value = await host?.storage?.get?.(key)
          return value == null ? fallback : value
        } catch { return fallback }
      }
      const [rawProfiles, rawGroups, rawRecent, rawUi] = await Promise.all([
        get(KEYS.profiles, []), get(KEYS.groups, []), get(KEYS.recent, []), get(KEYS.ui, {})
      ])
      state = {
        profiles: (Array.isArray(rawProfiles) ? rawProfiles : []).map(normalizeProfile).filter(Boolean),
        groups: (Array.isArray(rawGroups) ? rawGroups : []).map(normalizeGroup).filter(Boolean),
        recent: (Array.isArray(rawRecent) ? rawRecent : []).map(normalizeRecent).filter(Boolean).sort((a, b) => b.when - a.when).slice(0, RECENT_MAX),
        ui: { selectedGroupId: rawUi?.selectedGroupId || '', search: rawUi?.search || '' }
      }
      notify()
      return state
    }

    const persist = (key, value) => api()?.storage?.set?.(key, value).catch?.(() => {}) ?? Promise.resolve()

    async function saveProfiles() { await persist(KEYS.profiles, state.profiles.map(sanitizeProfile)) ; notify() }
    async function saveGroups() { await persist(KEYS.groups, state.groups) ; notify() }
    async function saveRecent() { await persist(KEYS.recent, state.recent) }
    async function saveUi() { await persist(KEYS.ui, state.ui) }

    async function upsertProfile(profile, password) {
      const next = normalizeProfile(profile)
      if (!next) throw new Error('主机不能为空')
      // 密码：非空字符串 → vault.set（新 ref 或复用）；留空且已有 ref → 不改
      if (typeof password === 'string' && password.length > 0) {
        const vaultKey = 'rdp-pass:' + next.id
        try {
          const result = await api()?.vault?.set?.(vaultKey, password)
          next.passwordRef = result?.secretRef || vaultKey
          next.hasPassword = true
        } catch (err) {
          throw new Error('密码保存失败：' + (err?.message || err))
        }
      }
      const index = state.profiles.findIndex(p => p.id === next.id)
      if (index >= 0) state.profiles[index] = next
      else state.profiles.push(next)
      await saveProfiles()
      return next
    }

    async function removeProfile(id) {
      state.profiles = state.profiles.filter(p => p.id !== id)
      if (state.profiles.length === 0) state.recent = state.recent.filter(r => r.profileId !== id)
      await saveProfiles()
      await saveRecent()
    }

    async function upsertGroup(group) {
      const next = normalizeGroup(group)
      if (!next) throw new Error('分组名不能为空')
      const index = state.groups.findIndex(g => g.id === next.id)
      if (index >= 0) state.groups[index] = next
      else state.groups.push(next)
      await saveGroups()
      return next
    }

    async function removeGroup(id) {
      state.groups = state.groups.filter(g => g.id !== id)
      for (const p of state.profiles) if (p.groupId === id) p.groupId = ''
      await saveGroups()
      await saveProfiles()
    }

    async function pushRecent(entry) {
      const next = normalizeRecent(entry)
      if (!next) return
      state.recent = [next, ...state.recent.filter(r => !(r.profileId && r.profileId === next.profileId && r.name === next.name))].slice(0, RECENT_MAX)
      await saveRecent()
      notify()
    }

    async function clearRecent() { state.recent = [] ; await saveRecent() ; notify() }

    async function setUi(patch) { state.ui = { ...state.ui, ...patch } ; await saveUi() }

    /** 导出 JSON：密码字段导出为空并注明（不回读 vault） */
    function exportJson() {
      return JSON.stringify({
        version: 1,
        note: '密码不导出；导入后需重新录入',
        groups: state.groups,
        profiles: state.profiles.map(p => ({ ...sanitizeProfile(p), password: '' }))
      }, null, 2)
    }

    async function importJson(text) {
      let data
      try { data = JSON.parse(text) } catch { throw new Error('JSON 解析失败') }
      const groups = (Array.isArray(data?.groups) ? data.groups : []).map(normalizeGroup).filter(Boolean)
      const profiles = (Array.isArray(data?.profiles) ? data.profiles : []).map(normalizeProfile).filter(Boolean)
      for (const group of groups) {
        const index = state.groups.findIndex(g => g.id === group.id || g.name === group.name)
        if (index >= 0) state.groups[index] = group
        else state.groups.push(group)
      }
      for (const profile of profiles) {
        // 导入的 password 恒为空：hasPassword 保留标记但 ref 清空（需重新录入）
        profile.passwordRef = ''
        const index = state.profiles.findIndex(p => p.id === profile.id || (p.host === profile.host && p.port === profile.port && p.protocol === profile.protocol))
        if (index >= 0) state.profiles[index] = profile
        else state.profiles.push(profile)
      }
      await saveGroups()
      await saveProfiles()
      const imported = { groups: groups.length, profiles: profiles.length }
      return imported
    }

    return {
      loadAll, upsertProfile, removeProfile, upsertGroup, removeGroup,
      pushRecent, clearRecent, setUi, exportJson, importJson,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      get state() { return state },
      KEYS, parseUri, esc, uid
    }
  }

  global.RdpStore = { createStore, parseUri, esc }
})(window)
