/**
 * 设置：天翼云盘账号（扫码 / 账号密码登录）、下载设置、网盘搜索服务地址、关于。
 * 分组面板铺满宽度；所有修改即时保存。
 */

import { useEffect, useState } from 'react'
import { Input } from '../../ui'
import { useApp } from '../../js/state'
import { AccountPanel } from './AccountPanel'
import { DownloadSettings } from './DownloadSettings'

export function SettingsView() {
  // TooltipProvider 由 App 根部提供，这里不再嵌套，避免内层丢失延迟分组配置
  return (
    <div className="gh-set">
      <DownloadSettings />
      {/* 登录表单不宽，单独占一行会在右边空出一大块：账号面板占左列，网盘搜索与关于叠在右列 */}
      <div className="gh-set-columns">
        <AccountPanel />
        <div className="gh-set-column">
          <PanSouPanel />
          <AboutPanel />
        </div>
      </div>
    </div>
  )
}

/* ---------------- 网盘搜索 ---------------- */

function PanSouPanel() {
  const app = useApp()
  const settings = app.settings
  const [url, setUrl] = useState(settings?.pansouBaseUrl ?? '')

  useEffect(() => {
    if (settings && !url) setUrl(settings.pansouBaseUrl)
  }, [settings, url])

  // 地址改变即时保存（失焦或回车后仍保留草稿，避免每敲一个字符都写库）。
  // 不提供"测试连接"：服务是否可用由网盘搜索页在搜索时提示，这里只负责地址本身。
  async function commit(): Promise<void> {
    const value = url.trim()
    if (!settings || value === settings.pansouBaseUrl) return
    try {
      await app.updateSettings({ pansouBaseUrl: value })
    } catch (error) {
      setUrl(settings.pansouBaseUrl)
      void app.notify(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  return (
    <section className="gh-panel gh-set-panel" aria-label="网盘搜索">
      <h2>网盘搜索</h2>
      <div className="gh-field">
        <span className="gh-field-label">服务地址</span>
        <Input
          value={url}
          placeholder="https://…"
          onChange={event => setUrl(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={event => { if (event.key === 'Enter') void commit() }}
          aria-label="网盘搜索服务地址"
        />
        <p className="gh-field-hint">留空使用默认服务。搜索时如果连不上，网盘搜索页会给出提示。</p>
      </div>
    </section>
  )
}

/* ---------------- 关于 ---------------- */

function AboutPanel() {
  return (
    <section className="gh-panel gh-set-panel" aria-label="关于">
      <h2>关于</h2>
      <div className="gh-set-about">本项目为非盈利项目，完全免费开源，禁止任何形式的商用行为</div>
    </section>
  )
}
