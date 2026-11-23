/**
 * 下载设置：默认目录（只存显示路径，用于建任务时预填）、并发与连接数滑杆、
 * 限速滑杆、自动安装与删包开关。所有修改即时保存，失败 toast 并回滚显示。
 */

import { useEffect, useState } from 'react'
import { FolderOpen, Gauge, SlidersHorizontal } from '@phosphor-icons/react'
import type { AppSettings } from '../../shared/contracts'
import { LIMITS } from '../../shared/contracts'
import { Slider, Switch } from '../../ui'
import { PathField } from '../../components/ext'
import { Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'

const MB = 1024 * 1024

export function DownloadSettings() {
  const app = useApp()
  const settings = app.settings
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState<'download' | 'install' | ''>('')

  // 本地草稿：滑杆拖动过程中只在松手或值稳定后保存
  const [concurrent, setConcurrent] = useState(settings?.concurrentTasks ?? LIMITS.concurrentTasksMin)
  const [connections, setConnections] = useState(settings?.connectionsPerTask ?? LIMITS.connectionsMin)
  const [limitMb, setLimitMb] = useState(Math.round((settings?.speedLimit ?? 0) / MB))

  useEffect(() => {
    if (!settings) return
    setConcurrent(settings.concurrentTasks)
    setConnections(settings.connectionsPerTask)
    setLimitMb(Math.round(settings.speedLimit / MB))
  }, [settings])

  async function save(patch: Partial<AppSettings>): Promise<void> {
    setSaving(true)
    try {
      await app.updateSettings(patch)
    } catch (error) {
      // 失败回滚显示
      const current = app.settings
      if (current) {
        setConcurrent(current.concurrentTasks)
        setConnections(current.connectionsPerTask)
        setLimitMb(Math.round(current.speedLimit / MB))
      }
      void app.notify(`保存设置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setSaving(false) }
  }

  async function pick(kind: 'download' | 'install'): Promise<void> {
    setPicking(kind)
    try {
      const picked = await api.host.pickDirectory()
      if (!picked) return
      // 默认目录只保存显示路径用于预填；建任务时的授权句柄在对话框里重新选择
      await save(kind === 'download' ? { downloadDir: picked.displayPath } : { installDir: picked.displayPath })
    } catch (error) {
      void app.notify(`选择目录失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setPicking('') }
  }

  if (!settings) return <Spinner label="正在读取设置…" />

  return (
    <section className="gh-panel gh-set-panel" aria-label="下载设置">
      <h2><Glyph icon={SlidersHorizontal} size={15} /> 下载设置</h2>

      <div className="gh-set-grid">
        <PathField
          label="默认下载目录"
          value={settings.downloadDir}
          onPick={() => void pick('download')}
          disabled={picking !== '' || saving}
        />
        <PathField
          label="默认安装目录"
          value={settings.installDir}
          onPick={() => void pick('install')}
          disabled={picking !== '' || saving}
        />
      </div>

      <div className="gh-set-slider" data-double>
        <span className="gh-set-slider-label">同时下载任务数</span>
        <div className="gh-set-slider-row" onPointerUp={() => void save({ concurrentTasks: concurrent })} onKeyUp={() => void save({ concurrentTasks: concurrent })}>
          <Slider
            value={[concurrent]}
            min={LIMITS.concurrentTasksMin}
            max={LIMITS.concurrentTasksMax}
            step={1}
            onValueChange={value => setConcurrent(value[0] ?? concurrent)}
            aria-label="同时下载任务数"
          />
          <span className="gh-set-slider-value">{concurrent}</span>
        </div>
      </div>

      <div className="gh-set-slider" data-double>
        <span className="gh-set-slider-label">单任务连接数</span>
        <div className="gh-set-slider-row" onPointerUp={() => void save({ connectionsPerTask: connections })} onKeyUp={() => void save({ connectionsPerTask: connections })}>
          <Slider
            value={[connections]}
            min={LIMITS.connectionsMin}
            max={LIMITS.connectionsMax}
            step={1}
            onValueChange={value => setConnections(value[0] ?? connections)}
            aria-label="单任务连接数"
          />
          <span className="gh-set-slider-value">{connections}</span>
        </div>
      </div>

      <div className="gh-set-slider" data-double>
        <span className="gh-set-slider-label">下载限速（0 为不限速）</span>
        <div className="gh-set-slider-row" onPointerUp={() => void save({ speedLimit: limitMb * MB })} onKeyUp={() => void save({ speedLimit: limitMb * MB })}>
          <Slider
            value={[limitMb]}
            min={0}
            max={50}
            step={1}
            onValueChange={value => setLimitMb(value[0] ?? limitMb)}
            aria-label="下载限速"
          />
          <span className="gh-set-slider-value">
            <Glyph icon={Gauge} size={12} />
            {limitMb > 0 ? `${limitMb} MB/s` : '不限速'}
          </span>
        </div>
      </div>

      <label className="gh-switch-row">
        <div>
          <strong>下载后自动安装</strong>
          <small>新任务默认自动解压，可在建任务时修改</small>
        </div>
        <Switch
          checked={settings.autoInstall}
          onCheckedChange={value => void save({ autoInstall: value })}
          disabled={saving}
          aria-label="下载后自动安装"
        />
      </label>

      <label className="gh-switch-row">
        <div>
          <strong>安装后删除安装包</strong>
          <small>解压成功后清理下载的压缩包</small>
        </div>
        <Switch
          checked={settings.removePackage}
          onCheckedChange={value => void save({ removePackage: value })}
          disabled={saving}
          aria-label="安装后删除安装包"
        />
      </label>

      {picking !== '' || saving ? <Spinner label={picking ? '请选择目录…' : '正在保存…'} /> : null}
      <p className="gh-set-note">
        <Glyph icon={FolderOpen} size={12} />
        默认目录只用于预填；创建任务时需在对话框里点击选择以确认授权。
      </p>
    </section>
  )
}
