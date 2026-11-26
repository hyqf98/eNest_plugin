/**
 * 下载确认对话框：选下载/安装路径、自动安装与删除安装包开关、大小提示。
 * 目录必须经宿主选择器授权（拿到句柄）才能提交；缺句柄时后端拒绝创建并显示错误。
 * 提交 tasks.create 成功后关闭并刷新任务；失败保留对话框并提示。
 */

import { useEffect, useMemo, useState } from 'react'
import type { DirTarget, DetailData, ResourcePackage } from '../../shared/contracts'
import { useApp } from '../../js/state'
import { Button, Dialog, DialogContent, DialogDescription, DialogOverlay, DialogTitle, Switch } from '../../ui'
import { PathField } from '../../components/ext'
import * as api from '../../js/api'
import { formatBytes, joinDir, sanitizeLeaf } from '../../js/format'

export function DownloadDialog({ detail, packages, open, onClose, onCreated }: {
  detail: DetailData
  packages: ResourcePackage[]
  open: boolean
  onClose: () => void
  onCreated: (taskId: string) => void
}) {
  const app = useApp()
  const settings = app.settings
  const [downloadDir, setDownloadDir] = useState('')
  const [installDir, setInstallDir] = useState('')
  const [downloadTarget, setDownloadTarget] = useState<DirTarget | null>(null)
  const [installTarget, setInstallTarget] = useState<DirTarget | null>(null)
  const [autoInstall, setAutoInstall] = useState(true)
  const [removePackage, setRemovePackage] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 打开时按条目初始化：默认目录拼资源名（仅展示）；开关记忆全局设置
  useEffect(() => {
    if (!open) return
    setError('')
    setDownloadTarget(null)
    setInstallTarget(null)
    const downloadRoot = settings?.downloadDir || ''
    const installRoot = settings?.installDir || ''
    const leaf = sanitizeLeaf(detail.item.title || detail.item.id)
    setDownloadDir(joinDir(downloadRoot, leaf))
    setInstallDir(joinDir(installRoot, leaf))
    setAutoInstall(settings?.autoInstall ?? true)
    setRemovePackage(settings?.removePackage ?? true)
  }, [open, detail.item.id, detail.item.title, settings])

  const totalBytes = useMemo(() => packages.reduce((sum, pkg) => sum + (pkg.size > 0 ? pkg.size : 0), 0), [packages])
  const sizeHint = useMemo(() => {
    const text = packages.map(pkg => pkg.sizeText).find(Boolean)
    return text || (totalBytes > 0 ? formatBytes(totalBytes) : '')
  }, [packages, totalBytes])

  const pickDownload = async () => {
    const picked = await api.host.pickDirectory()
    if (!picked) return
    setDownloadTarget({ handleId: picked.handleId, displayPath: picked.displayPath })
    setDownloadDir(joinDir(picked.displayPath, sanitizeLeaf(detail.item.title || detail.item.id)))
  }

  const pickInstall = async () => {
    const picked = await api.host.pickDirectory()
    if (!picked) return
    setInstallTarget({ handleId: picked.handleId, displayPath: picked.displayPath })
    setInstallDir(joinDir(picked.displayPath, sanitizeLeaf(detail.item.title || detail.item.id)))
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.tasks.create({
        itemId: detail.item.id,
        packageIds: packages.map(pkg => pkg.id),
        downloadDir,
        installDir,
        downloadTarget: downloadTarget ?? undefined,
        installTarget: installTarget ?? undefined,
        autoInstall,
        removePackage,
      })
      await app.refreshTasks()
      void app.notify('已加入下载队列', 'success')
      onCreated(result.taskId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose() }}>
      <DialogOverlay />
      <DialogContent className="gh-dialog" aria-describedby="gh-dlg-desc">
        <DialogTitle>确认下载</DialogTitle>
        <DialogDescription id="gh-dlg-desc">确认资源与保存位置后开始下载</DialogDescription>

        <div className="gh-dialog-body">
          {packages.length ? (
            <p className="gh-dlg-packages">
              {packages.length === 1 ? `已选资源：${packages[0].name}` : `已选 ${packages.length} 个资源`}
              {sizeHint ? `，下载大小：${sizeHint}` : ''}
              {detail.installedSizeText ? `（安装后约 ${detail.installedSizeText}）` : ''}
            </p>
          ) : null}

          <PathField label="下载路径" value={downloadDir} onPick={() => void pickDownload()} disabled={busy} />
          <p className="gh-field-hint" aria-live="polite">{downloadTarget ? '已确认' : '尚未授权，点击右侧选择以确认目录'}</p>
          {/* 安装路径只在要自动安装时才需要：只下载的话（修改器压缩包、想自己解压的包）不该被一个用不到的目录卡住 */}
          {autoInstall ? (
            <>
              <PathField label="安装路径" value={installDir} onPick={() => void pickInstall()} disabled={busy} />
              <p className="gh-field-hint" aria-live="polite">{installTarget ? '已确认' : '尚未授权，点击右侧选择以确认目录'}</p>
            </>
          ) : null}

          <div className="gh-switch-row">
            <div>
              <strong>下载后自动安装</strong>
              <small>下载完成后自动解压到安装路径</small>
            </div>
            <Switch checked={autoInstall} onCheckedChange={setAutoInstall} disabled={busy} aria-label="下载后自动安装" />
          </div>
          {/* 不自动安装就没有"安装后"，删包这一项也就无从谈起 */}
          {autoInstall ? (
            <div className="gh-switch-row">
              <div>
                <strong>安装后删除安装包</strong>
                <small>解压成功后删除下载的压缩包以释放空间</small>
              </div>
              <Switch checked={removePackage} onCheckedChange={setRemovePackage} disabled={busy} aria-label="安装后删除安装包" />
            </div>
          ) : null}

          {error ? <p className="gh-dlg-error" role="alert">{error}</p> : null}
        </div>

        <div className="gh-dialog-actions">
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !downloadTarget || (autoInstall && !installTarget)} aria-busy={busy || undefined}>
            {busy ? '启动中…' : '开始下载'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
