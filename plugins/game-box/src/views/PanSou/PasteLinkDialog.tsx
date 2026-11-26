/**
 * 粘贴链接下载对话框：粘贴天翼云盘分享链接 → 解析出文件列表 → 选择文件与
 * 下载选项 → 建任务。目录经宿主选择器拿到句柄才算授权，路径文本只用于展示；
 * 选中的分享文件 id 走 shareFileIds，分享场景 itemId 传空串由后端处理。
 */

import { useEffect, useMemo, useState } from 'react'
import { Check, FileArrowDown, FolderOpen, Link, SpinnerGap } from '@phosphor-icons/react'
import type { DirTarget, ShareFileEntry } from '../../shared/contracts'
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Input, Switch } from '../../ui'
import { Spinner } from '../../components/base'
import { Glyph } from '../../components/Glyph'
import { useApp } from '../../js/state'
import * as api from '../../js/api'
import { formatBytes, joinDir, sanitizeLeaf } from '../../js/format'
import { parseAccessCode } from '../../js/taskLabels'

export function PasteLinkDialog({ open, onClose, initialUrl = '', initialCode = '' }: {
  open: boolean
  onClose: () => void
  initialUrl?: string
  initialCode?: string
}) {
  const app = useApp()
  const settings = app.settings
  const [url, setUrl] = useState(initialUrl)
  const [code, setCode] = useState(initialCode)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState('')
  const [share, setShare] = useState<{ title: string; files: ShareFileEntry[] } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState('')
  const [step, setStep] = useState<'input' | 'confirm'>('input')

  const [downloadDir, setDownloadDir] = useState('')
  const [installDir, setInstallDir] = useState('')
  const [downloadTarget, setDownloadTarget] = useState<DirTarget | null>(null)
  const [installTarget, setInstallTarget] = useState<DirTarget | null>(null)
  const [autoInstall, setAutoInstall] = useState(true)
  const [removePackage, setRemovePackage] = useState(true)
  const [picking, setPicking] = useState<'download' | 'install' | ''>('')
  const [submitting, setSubmitting] = useState(false)

  // 打开时重置：目录句柄作废，显示文本回退到默认目录预填
  useEffect(() => {
    if (!open) return
    setUrl(initialUrl)
    setCode(initialCode || parseAccessCode(initialUrl))
    setShare(null); setSelected(new Set()); setTitle('')
    setDownloadTarget(null); setInstallTarget(null)
    setDownloadDir(''); setInstallDir('')
    setParseError(''); setStep('input'); setSubmitting(false)
  }, [open, initialUrl, initialCode])

  // 同步全局设置里的默认目录（只预填展示文本，授权句柄仍需在对话框里选择）
  useEffect(() => {
    if (!settings) return
    setDownloadDir(current => current || settings.downloadDir)
    setInstallDir(current => current || settings.installDir)
    setAutoInstall(settings.autoInstall)
    setRemovePackage(settings.removePackage)
  }, [settings, open])

  const allSelected = useMemo(
    () => share !== null && share.files.length > 0 && share.files.every(file => selected.has(file.id)),
    [share, selected],
  )

  function toggle(id: string): void {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(): void {
    if (!share) return
    setSelected(allSelected ? new Set() : new Set(share.files.map(file => file.id)))
  }

  async function parse(): Promise<void> {
    const trimmed = url.trim()
    if (!trimmed) return
    setParsing(true)
    setParseError('')
    try {
      const result = await api.share.parse(trimmed, code.trim())
      if (!result.files.length) throw new Error('分享里没有可下载的文件')
      setShare(result)
      setTitle(result.title)
      setSelected(new Set(result.files.map(file => file.id)))
    } catch (error) {
      setParseError(error instanceof Error ? error.message : String(error))
    } finally { setParsing(false) }
  }

  async function pick(kind: 'download' | 'install'): Promise<void> {
    setPicking(kind)
    try {
      const picked = await api.host.pickDirectory()
      if (picked) {
        const target: DirTarget = { handleId: picked.handleId, displayPath: picked.displayPath }
        // 后端会在所选根目录下按分享标题建子目录；展示文本跟上，避免看起来和实际落盘位置不一致
        const shown = joinDir(picked.displayPath, sanitizeLeaf(title.trim() || share?.title || 'Download'))
        if (kind === 'download') {
          setDownloadTarget(target)
          setDownloadDir(shown)
        } else {
          setInstallTarget(target)
          setInstallDir(shown)
        }
      }
    } catch (error) {
      void app.notify(`选择目录失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setPicking('') }
  }

  async function submit(): Promise<void> {
    if (!share || !selected.size || !downloadTarget || !installTarget) return
    setSubmitting(true)
    try {
      await api.tasks.create({
        itemId: '',
        packageIds: [],
        downloadDir: downloadTarget.displayPath,
        installDir: installTarget.displayPath,
        downloadTarget,
        installTarget,
        autoInstall,
        removePackage,
        share: { url: url.trim(), accessCode: code.trim(), title: title.trim() || share.title },
        shareFileIds: [...selected],
      })
      void app.notify('已创建下载任务', 'success')
      onClose()
    } catch (error) {
      void app.notify(`创建任务失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally { setSubmitting(false) }
  }

  // 句柄即授权：两个目录都有句柄才能建任务
  const canSubmit = step === 'confirm' && Boolean(downloadTarget && installTarget) && selected.size > 0

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !submitting && !parsing) onClose() }}>
      <DialogOverlay />
      <DialogContent className="gh-dialog gh-dialog-wide" aria-describedby="gh-paste-desc">
        <DialogTitle>粘贴链接下载</DialogTitle>
        <DialogDescription id="gh-paste-desc">粘贴天翼云盘分享链接，解析后选择需要的文件创建下载任务。</DialogDescription>

        {step === 'input' ? (
          <div className="gh-dialog-body">
            <div className="gh-field">
              <span className="gh-field-label">分享链接</span>
              <div className="gh-field-row">
                <Input
                  value={url}
                  placeholder="https://cloud.189.cn/t/…"
                  onChange={event => setUrl(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && url.trim()) void parse() }}
                  aria-label="粘贴天翼云盘分享链接"
                />
              </div>
            </div>
            <div className="gh-field">
              <span className="gh-field-label">提取码（可自动从链接解析）</span>
              <div className="gh-field-row">
                <Input
                  value={code}
                  placeholder="4 位提取码"
                  maxLength={8}
                  onChange={event => setCode(event.target.value)}
                  aria-label="提取码"
                  style={{ maxWidth: 160 }}
                />
                <Button onClick={() => void parse()} disabled={parsing || !url.trim()}>
                  <Glyph icon={parsing ? SpinnerGap : Link} size={13} />
                  <span>{parsing ? '解析中…' : '解析'}</span>
                </Button>
              </div>
            </div>
            {parseError ? <div className="gh-set-error" role="alert">{parseError}</div> : null}
            {parsing ? <Spinner label="正在解析分享链接…" /> : null}
            {share ? (
              <div className="gh-ps-files">
                <label className="gh-ps-file-row gh-ps-file-all">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label={allSelected ? '取消全选' : '全选'}
                  />
                  <span>全选（共 {share.files.length} 个文件）</span>
                </label>
                <div className="gh-ps-file-list" role="listbox" aria-label="分享文件列表" aria-multiselectable="true">
                  {share.files.map(file => (
                    <label key={file.id} className="gh-ps-file-row">
                      <Checkbox
                        checked={selected.has(file.id)}
                        onCheckedChange={() => toggle(file.id)}
                        aria-label={file.name}
                      />
                      <span className="gh-ps-file-name">{file.name}</span>
                      <span className="gh-ps-file-size">{file.sizeText || (file.size > 0 ? formatBytes(file.size) : '')}</span>
                    </label>
                  ))}
                </div>
                <div className="gh-field">
                  <span className="gh-field-label">任务名称</span>
                  <Input value={title} onChange={event => setTitle(event.target.value)} aria-label="任务名称" placeholder="默认使用分享标题" />
                </div>
                <div className="gh-dialog-actions">
                  <Button onClick={() => setStep('confirm')} disabled={selected.size === 0}>
                    <Glyph icon={FileArrowDown} size={13} />
                    <span>下一步</span>
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="gh-dialog-body">
            <div className="gh-ps-confirm-summary">
              已选择 {selected.size} / {share?.files.length ?? 0} 个文件{title ? ` · ${title}` : ''}
            </div>
            <div className="gh-field">
              <span className="gh-field-label">下载目录</span>
              <div className="gh-field-row">
                <input className="pk-input gh-path-input" value={downloadDir} placeholder="尚未选择" readOnly aria-label="下载目录" />
                <Button size="sm" onClick={() => void pick('download')} disabled={picking !== ''}>
                  <Glyph icon={FolderOpen} size={13} /><span>选择</span>
                </Button>
              </div>
              {downloadTarget ? null : <p className="gh-field-hint">点击选择以授权目录</p>}
            </div>
            <div className="gh-field">
              <span className="gh-field-label">安装目录</span>
              <div className="gh-field-row">
                <input className="pk-input gh-path-input" value={installDir} placeholder="尚未选择" readOnly aria-label="安装目录" />
                <Button size="sm" onClick={() => void pick('install')} disabled={picking !== ''}>
                  <Glyph icon={FolderOpen} size={13} /><span>选择</span>
                </Button>
              </div>
              {installTarget ? null : <p className="gh-field-hint">点击选择以授权目录</p>}
            </div>
            <label className="gh-switch-row">
              <div>
                <strong>下载后自动安装</strong>
                <small>下载完成后自动解压到安装目录</small>
              </div>
              <Switch checked={autoInstall} onCheckedChange={setAutoInstall} aria-label="下载后自动安装" />
            </label>
            <label className="gh-switch-row">
              <div>
                <strong>安装后删除安装包</strong>
                <small>解压成功后清理下载的压缩包</small>
              </div>
              <Switch checked={removePackage} onCheckedChange={setRemovePackage} aria-label="安装后删除安装包" />
            </label>
            <div className="gh-dialog-actions">
              <Button variant="ghost" onClick={() => setStep('input')} disabled={submitting}>上一步</Button>
              <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit || submitting}>
                <Glyph icon={submitting ? SpinnerGap : Check} size={13} />
                <span>{submitting ? '正在创建…' : '开始下载'}</span>
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
