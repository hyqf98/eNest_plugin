/** 右侧详情：字段逐行展示；密码默认掩码，「显示」调 backend.revealSecret，复制走 clipboard。 */
import { useEffect, useState } from 'react'
import { Button } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { Icon } from './icons.jsx'
import { StrengthBadge, relTime } from './EntryList.jsx'

const MASK = '••••••••'

const api = () => window.enest || window.zapi

function Field({ label, mono, children, actions }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <span className={'field-value' + (mono ? ' mono' : '')}>{children}</span>
      <span className="field-actions">{actions}</span>
    </div>
  )
}

export function EntryDetail({ entry, categoryText, onEdit, onDelete, onCopy, toast }) {
  const [secret, setSecret] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    setSecret('')
    setRevealed(false)
    setRevealing(false)
  }, [entry?.id])

  if (!entry) {
    return (
      <div className="detail-empty">
        {Icon.shield(28)}
        <p>选择左侧条目查看详情</p>
        <p className="sub">密码加密存储于本机保险库，仅在明确操作时解密</p>
      </div>
    )
  }

  const reveal = async () => {
    if (revealed) { setRevealed(false); setSecret(''); return }
    if (!entry.secretRef) { toast('该条目没有存储密码', 'error'); return }
    setRevealing(true)
    try {
      const { secret: text } = await backend.revealSecret(entry.secretRef)
      setSecret(text)
      setRevealed(true)
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      setRevealing(false)
    }
  }

  const copySecret = async () => {
    if (!revealed) {
      if (!entry.secretRef) { toast('该条目没有存储密码', 'error'); return }
      try {
        const { secret: text } = await backend.revealSecret(entry.secretRef)
        onCopy(text, { excludeFromHistory: true })
      } catch (error) {
        toast(error.message, 'error')
      }
      return
    }
    onCopy(secret, { excludeFromHistory: true })
  }

  return (
    <section className="detail" aria-label={`条目详情 ${entry.title}`}>
      <header className="detail-head">
        <div className="detail-head-main">
          <h2>{entry.title}</h2>
          <div className="detail-badges">
            <StrengthBadge level={entry.strength} />
            <span className="badge cat">{categoryText}</span>
          </div>
        </div>
        <div className="detail-head-actions">
          <Button onClick={() => onEdit(entry)}>{Icon.edit(13)} 编辑</Button>
          <Button variant="danger" onClick={() => onDelete(entry)}>{Icon.trash(13)} 删除</Button>
        </div>
      </header>
      <div className="detail-body">
        <Field label="站点">{entry.site || '—'}</Field>
        <Field label="用户名" mono>{entry.username || '—'}</Field>
        <Field
          label="密码" mono
          actions={
            <>
              <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => void reveal()} disabled={revealing} title={revealed ? '隐藏' : '显示'}>
                {revealed ? Icon.eyeOff() : Icon.eye()} {revealing ? '解密中…' : revealed ? '隐藏' : '显示'}
              </button>
              <button type="button" className="pk-btn pk-btn-ghost pk-btn-sm" onClick={() => void copySecret()} title="复制密码">{Icon.copy()} 复制</button>
            </>
          }
        >
          {revealed ? secret : MASK}
        </Field>
        <Field label="备注">{entry.notes || '—'}</Field>
        <Field label="创建时间" mono>{new Date(entry.createdAt).toLocaleString('zh-CN')}</Field>
        <Field label="更新时间" mono>{relTime(entry.updatedAt)}</Field>
      </div>
      <footer className="detail-note">
        {Icon.lock(12)} 密码通过后端 secret.resolve 解密，不落本地存储；复制使用剪贴板并排除历史记录
      </footer>
    </section>
  )
}
