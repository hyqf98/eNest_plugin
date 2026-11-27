import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { createDialog } from '@enest/plugin-kit/workbench'
import './style.css'

const emptyState = { installed: [], catalog: [], sources: [], errors: [] }
const markets = new Map()
const formatSize = bytes => Number.isSafeInteger(bytes) && bytes > 0 ? `${(bytes / 1048576).toFixed(bytes < 1048576 ? 2 : 1)} MiB` : ''
const errorText = error => String(error?.message || error || '操作失败').slice(0, 500)

function mount(title, render, onClose) {
  const sheet = createDialog({ title, className: 'driver-market', onClose: () => { root.unmount(); onClose?.() } })
  const root = createRoot(sheet.body)
  root.render(render(sheet.close))
  return sheet
}

function Button({ children, primary, ...props }) {
  return <button type="button" className={`pk-btn${primary ? ' pk-btn-primary' : ''}`} {...props}>{children}</button>
}

function MarketPanel({ target, call, onChange }) {
  const [state, setState] = useState(emptyState)
  const [tab, setTab] = useState('catalog')
  const [search, setSearch] = useState('')
  const [repository, setRepository] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('state')
  const mounted = useRef(false)
  const pending = useRef(false)
  const installMutation = useRef(false)

  async function run(action, input = {}, { changed = false, note = '' } = {}) {
    if (pending.current) return
    pending.current = true
    if (changed) installMutation.current = true
    if (mounted.current) { setBusy(action); setMessage('') }
    try {
      const result = await call(`extensions.${action}`, [input], { timeoutMs: 300000 })
      if (!result || !Array.isArray(result.installed) || !Array.isArray(result.catalog) || !Array.isArray(result.sources)) throw new Error('驱动市场返回了不兼容的数据，请更新工作台。')
      if (mounted.current) { setState(result); if (note) setMessage(note) }
      if (changed) await onChange?.(result)
      return result
    } catch (error) { if (mounted.current) setMessage(errorText(error)) }
    finally { pending.current = false; installMutation.current = false; if (mounted.current) setBusy('') }
  }

  useEffect(() => {
    mounted.current = true
    void (async () => {
      const snapshot = await run('state')
      if (mounted.current && snapshot && !snapshot.catalog.length && !installMutation.current) await run('refresh')
    })()
    return () => { mounted.current = false }
  }, [])

  async function importZip() {
    try {
      const [file] = await window.enest.localFiles.pick({ kind: 'file', access: 'read', multiple: false })
      if (!mounted.current || !file) return
      if (!/\.zip$/i.test(file.name)) throw new Error('请选择标准驱动 ZIP，不是源码包或 .enestplugin。')
      await run('importLocal', { handleId: file.id }, { changed: true, note: '本地包已导入。请在「已安装」中查看来源与信任状态。' })
    } catch (error) { if (mounted.current) setMessage(errorText(error)) }
  }

  const sourceLabel = id => state.sources.find(source => source.id === id)?.label || id || '本地导入'
  const query = search.trim().toLocaleLowerCase()
  const matches = item => !query || [item.name, item.id, item.description, item.source].some(value => String(value || '').toLocaleLowerCase().includes(query))
  const rows = (tab === 'installed' ? state.installed : state.catalog).filter(matches)
  const labels = { catalog: '可安装', installed: `已安装 (${state.installed.length})`, sources: '来源' }
  const remoteErrors = Array.isArray(state.errors) ? state.errors : []

  return <section className="dm-panel" aria-label="驱动管理">
    <p className="dm-lead">{target === 'middleware' ? '中间件' : '数据库'}工作台仅加载你安装并信任的驱动。已安装的版本在离线时仍可使用。</p>
    <div className="dm-toolbar"><ToggleGroup.Root className="pk-segmented" type="single" value={tab} onValueChange={value => { if (value) setTab(value) }} aria-label="市场分类">
      {Object.entries(labels).map(([value, label]) => <ToggleGroup.Item className="pk-segmented-item" key={value} value={value}>{label}</ToggleGroup.Item>)}
    </ToggleGroup.Root><div className="dm-actions"><Button disabled={!!busy} onClick={importZip}>导入 ZIP</Button><Button disabled={!!busy} onClick={() => run('refresh', {}, { note: '目录已刷新。' })}>刷新目录</Button></div></div>
    {tab !== 'sources' && <input className="pk-input dm-search" type="search" aria-label="搜索驱动" placeholder="搜索名称、驱动 ID 或来源" value={search} onChange={event => setSearch(event.target.value)} />}
    <div role="status" aria-live="polite" className="dm-status">{busy ? `${busy === 'refresh' ? '正在刷新在线目录' : busy === 'state' ? '正在读取本机驱动' : '正在处理，请留意原生确认窗口'}…` : message}</div>
    {remoteErrors.length > 0 && <div className="dm-notice" role="status">{remoteErrors.map((error, index) => <div key={index}>{errorText(error?.message || error?.error || error)}</div>)}</div>}
    {tab === 'sources' ? <>
      <ul className="dm-list">{state.sources.map(source => <li key={source.id} className="dm-row"><div className="dm-copy"><strong>{source.label || source.id}</strong><small>{source.official ? '官方 GitHub 发布源' : '用户添加的 GitHub 发布源'} · {source.repository || source.id}</small></div>{!source.official && <Button disabled={!!busy} onClick={() => run('removeSource', { source: source.id })}>移除来源</Button>}</li>)}</ul>
      <form className="dm-add" onSubmit={async event => { event.preventDefault(); if (await run('addSource', { repository: repository.trim() })) setRepository('') }}>
        <label htmlFor="dm-repository">添加第三方 GitHub 仓库</label><div className="dm-toolbar"><input id="dm-repository" className="pk-input" placeholder="owner/repository" value={repository} onChange={event => setRepository(event.target.value)} required maxLength={256} /><button type="submit" className="pk-btn" disabled={!!busy || !repository.trim()}>添加来源</button></div>
        <small>读取仓库的标准发布索引。添加来源并不授权执行其中的代码。</small>
      </form>
    </> : <ul className="dm-list">{rows.map(item => {
      const installed = state.installed.find(entry => entry.id === item.id)
      const same = installed?.version === item.version && installed.source === item.source
      const blocked = !!installed && installed.source !== item.source
      return <li key={`${item.source}:${item.id}:${item.version}`} className="dm-row"><div className="dm-copy"><strong>{item.name || item.id}</strong><small>{[item.version, sourceLabel(item.source), formatSize(item.size)].filter(Boolean).join(' · ')}</small>{item.description && <span>{item.description}</span>}{tab === 'installed' && <small>{!item.trusted ? '未信任，不会执行' : item.enabled ? '已启用' : '已停用'}</small>}</div>
        <div className="dm-actions">{tab === 'installed' ? <>
          {!item.trusted ? <Button primary disabled={!!busy} onClick={() => run('trust', { id: item.id }, { changed: true })}>确认信任</Button> : <Button disabled={!!busy} onClick={() => run(item.enabled ? 'disable' : 'enable', { id: item.id }, { changed: true })}>{item.enabled ? '停用' : '启用'}</Button>}
          {item.previousVersion && <Button disabled={!!busy} onClick={() => run('rollback', { id: item.id }, { changed: true })}>回退版本</Button>}
          <Button disabled={!!busy} onClick={() => run('uninstall', { id: item.id }, { changed: true })}>卸载</Button>
        </> : <Button primary={!same && !blocked} disabled={!!busy || same || blocked} onClick={() => run('install', { id: item.id, source: item.source, version: item.version }, { changed: true, note: '安装完成，请在「已安装」中查看状态。' })}>{same ? '已安装' : blocked ? '已绑定其他来源' : installed ? '安装此版本' : '安装'}</Button>}</div></li>
    })}{!rows.length && <li className="dm-empty">{query ? '没有匹配的驱动。' : tab === 'installed' ? '还没有安装驱动。可从目录选择，也可以导入本地 ZIP。' : '本地目录暂无可用驱动。可刷新目录、添加 GitHub 来源或导入离线 ZIP。'}</li>}</ul>}
  </section>
}

export function openDriverMarket({ target, call, onChange }) {
  if (typeof call !== 'function' || !['database', 'middleware'].includes(target)) throw new Error('无效的驱动市场上下文')
  const current = markets.get(target)
  if (current?.dialog.open) { current.dialog.focus(); return current }
  const sheet = mount('驱动市场', () => <MarketPanel target={target} call={call} onChange={onChange} />, () => markets.delete(target))
  markets.set(target, sheet)
  return sheet
}

const validField = field => field && typeof field.key === 'string' && /^[a-z][\w.-]{0,79}$/i.test(field.key) && !['constructor', 'prototype', '__proto__'].includes(field.key) && ['text', 'number', 'select', 'boolean'].includes(field.type)

function SettingsForm({ fields, values, onSave, close }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map(field => [field.key, values[field.key] ?? field.default ?? (field.type === 'boolean' ? false : '')])))
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  return <form className="dm-settings" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try {
      const output = { ...draft }
      for (const field of fields) if (field.type === 'number') {
        if (output[field.key] === '') { delete output[field.key]; continue }
        const number = Number(output[field.key]); if (!Number.isFinite(number)) throw new Error(`请检查「${field.label}」`); output[field.key] = number
      }
      await onSave(output); close()
    } catch (reason) { setError(errorText(reason)); setBusy(false) }
  }}>
    {fields.map(field => <label className="dm-field" key={field.key}><span>{field.label || field.key}</span>
      {field.type === 'boolean' ? <input type="checkbox" checked={draft[field.key] === true} onChange={event => set(field.key, event.target.checked)} /> : field.type === 'select' ? <select className="pk-input" value={draft[field.key]} required={field.required} onChange={event => set(field.key, event.target.value)}>{(field.options || []).map(option => <option key={String(option.value)} value={option.value}>{option.label}</option>)}</select> : <input className="pk-input" type={field.type} value={draft[field.key]} min={field.min} max={field.max} required={field.required} maxLength={2048} onChange={event => set(field.key, event.target.value)} />}
      {field.description && <small>{field.description}</small>}</label>)}
    {error && <p role="alert">{error}</p>}<div className="dm-actions"><Button disabled={busy} onClick={close}>取消</Button><button className="pk-btn pk-btn-primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
  </form>
}

export function openDriverSettings({ title, fields, values = {}, onSave }) {
  if (!Array.isArray(fields) || fields.length > 64 || !fields.every(validField) || new Set(fields.map(field => field.key)).size !== fields.length || typeof onSave !== 'function') throw new Error('驱动设置声明无效')
  return mount(title || '驱动设置', close => <SettingsForm {...{ fields, values, onSave, close }} />)
}
