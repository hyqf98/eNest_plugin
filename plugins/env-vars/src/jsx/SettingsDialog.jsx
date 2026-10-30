/** 设置 Dialog：mac 写入目标 Segmented + launchctl 同步 Switch；win 显示说明。 */
import { useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Segmented, Switch } from '../ui/index.jsx'

const MAC_TARGETS = [
  { value: 'zshenv', label: '.zshenv' },
  { value: 'zprofile', label: '.zprofile' },
  { value: 'zshrc', label: '.zshrc' }
]

export function SettingsDialog({ open, isMac, settings, onApply, onClose }) {
  const [macTarget, setMacTarget] = useState(settings.macTarget)
  const [launchctlSync, setLaunchctlSync] = useState(settings.launchctlSync)

  useEffect(() => {
    if (open) { setMacTarget(settings.macTarget); setLaunchctlSync(settings.launchctlSync) }
  }, [open, settings])

  if (!open) return null

  const apply = async () => {
    await onApply({ macTarget, launchctlSync })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent aria-describedby="settings-desc">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription id="settings-desc">{isMac ? 'macOS 写入行为' : 'Windows 写入行为'}</DialogDescription>
        {isMac ? (
          <div className="settings-grid">
            <div className="settings-row">
              <div className="settings-text">
                <p className="settings-title">写入目标文件</p>
                <p className="settings-note">eNest 受管块所在文件；已存在的块会被整体替换，文件其余内容不动。</p>
              </div>
              <Segmented value={macTarget} options={MAC_TARGETS} onChange={setMacTarget} ariaLabel="写入目标文件" />
            </div>
            <div className="settings-row">
              <div className="settings-text">
                <p className="settings-title">同步 launchctl</p>
                <p className="settings-note">写入后执行 launchctl setenv，GUI 应用立即读取到新值；重启后失效。</p>
              </div>
              <Switch checked={launchctlSync} onCheckedChange={setLaunchctlSync} aria-label="同步 launchctl" />
            </div>
          </div>
        ) : (
          <div className="settings-grid">
            <p className="settings-note">
              用户变量直接写入当前用户注册表；系统变量写入需要管理员权限，失败时插件会请求提权（系统 UAC 确认）。
            </p>
          </div>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void apply()}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
