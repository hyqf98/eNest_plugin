/** 变量编辑/新增 Dialog：名称（编辑时只读）+ 值 textarea + mac 受管目标提示。 */
import { useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from '../ui/index.jsx'

const MAC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_() .-]*$/

export function VarDialog({ dialog, isMac, targetPath, existing, onClose, onSave }) {
  const open = dialog?.kind === 'edit' || dialog?.kind === 'create'
  const editing = dialog?.kind === 'edit'
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(editing ? dialog.item.name : '')
    setValue(editing ? dialog.item.value : '')
    setError('')
  }, [open, editing, dialog])

  if (!open) return null

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('变量名不能为空'); return }
    const pattern = isMac ? MAC_NAME_RE : WIN_NAME_RE
    if (!pattern.test(trimmed)) {
      setError(isMac ? '变量名仅允许字母、数字、下划线，且以字母或下划线开头' : '变量名仅允许字母、数字、下划线、括号、点、空格、连字符')
      return
    }
    if (!editing && existing.includes(trimmed)) {
      setError('该名称已存在于当前数据中，请直接编辑原条目')
      return
    }
    setSaving(true)
    const ok = await onSave({ name: trimmed, value })
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="var-dialog" aria-describedby="var-dialog-desc">
        <DialogTitle>{editing ? '编辑变量' : '新增变量'}</DialogTitle>
        <DialogDescription id="var-dialog-desc">
          {editing ? `修改 ${dialog.item.name} 的值` : '新建一个环境变量'}
          {isMac && `，写入 ${targetPath} 的 eNest 受管块`}
        </DialogDescription>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">名称</span>
            <Input
              value={name} aria-label="变量名" className="mono"
              readOnly={editing} placeholder="如 JAVA_HOME"
              onChange={(e) => { setName(e.target.value); setError('') }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submit() } }}
            />
          </label>
          <label className="field">
            <span className="field-label">值</span>
            <textarea
              className="value-input mono" rows={4} value={value} aria-label="变量值"
              placeholder="如 /Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); void submit() } }}
            />
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          {isMac && <p className="field-note">写入前自动备份目标文件；块外已有同名定义会与新值叠加，以最终加载顺序为准。</p>}
        </div>
        <div className="dialog-actions">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
