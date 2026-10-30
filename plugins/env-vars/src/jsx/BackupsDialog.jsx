/** 备份管理 Dialog：列出 ~/.zsh* 的 eNest 自动备份，支持恢复（含确认）。 */
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/index.jsx'
import { formatSize, formatWhen } from '../js/format.js'

export function BackupsDialog({ open, backups, onRefresh, onRestore, onClose }) {
  if (!open) return null
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="backups-dialog" aria-describedby="backups-desc">
        <DialogTitle>备份管理</DialogTitle>
        <DialogDescription id="backups-desc">每次写入前的自动备份（按目标文件保留最近 5 份）</DialogDescription>
        <div className="backups-list">
          {!backups.length && <div className="empty">暂无备份</div>}
          {backups.map((item) => (
            <div className="backup-row" key={item.file}>
              <span className="backup-name mono" title={item.file}>{item.file.replace(/^\/Users\/[^/]+/, '~')}</span>
              <span className="backup-meta">{formatSize(item.size)} · {formatWhen(item.createdAt)}</span>
              <Button variant="ghost" size="sm" onClick={() => onRestore(item.file)}>恢复</Button>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => void onRefresh()}>刷新</Button>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
