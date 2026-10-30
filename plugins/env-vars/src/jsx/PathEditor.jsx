/** PATH 专用编辑器：每行一条、上移/下移/删除/新增；mac 附 /etc/paths 来源视图。 */
import { useEffect, useState } from 'react'
import { Button } from '../ui/index.jsx'
import { originLabel } from '../js/format.js'

export function PathEditor({ mac, entries, sources, loading, onSave, status }) {
  const [rows, setRows] = useState(entries)
  const [dirty, setDirty] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!dirty) setRows(entries)
  }, [entries, dirty])

  if (loading && !rows.length) return <div className="empty path-empty">正在读取 PATH…</div>

  const move = (index, delta) => {
    const next = [...rows]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setRows(next)
    setDirty(true)
  }
  const remove = (index) => { setRows(rows.filter((_, i) => i !== index)); setDirty(true) }
  const add = () => {
    const value = draft.trim()
    if (!value) return
    setRows([...rows, value])
    setDraft('')
    setDirty(true)
  }
  const save = async () => {
    setSaving(true)
    await onSave(rows.filter(Boolean))
    setSaving(false)
    setDirty(false)
  }

  return (
    <div className="path-editor">
      <div className="path-head">
        <div>
          <p className="path-title">PATH 条目 <span className="path-count">{rows.length}</span></p>
          <p className="path-note">每行一条，按顺序拼接；{mac ? '保存即写入受管块中的 PATH 变量' : '保存即写入当前范围的 PATH 变量'}。</p>
        </div>
        <div className="path-head-actions">
          {dirty && <Button variant="ghost" size="sm" onClick={() => { setRows(entries); setDirty(false) }}>还原</Button>}
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</Button>
        </div>
      </div>
      <div className="path-rows">
        {rows.map((entry, index) => (
          <div className="path-row" key={`${entry}#${index}`} style={{ '--i': Math.min(index, 16) }}>
            <span className="path-index mono">{index + 1}</span>
            <span className="path-entry mono" title={entry}>{entry}</span>
            <span className="path-row-actions pk-row-actions">
              <Button variant="ghost" size="sm" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
              <Button variant="ghost" size="sm" aria-label="下移" disabled={index === rows.length - 1} onClick={() => move(index, 1)}>↓</Button>
              <Button variant="ghost" size="sm" className="danger-ghost" aria-label="删除" onClick={() => remove(index)}>删除</Button>
            </span>
          </div>
        ))}
        {!rows.length && <div className="empty">PATH 为空</div>}
      </div>
      <div className="path-add">
        <input
          className="mono" value={draft} placeholder="/usr/local/bin" aria-label="新增 PATH 条目"
          data-input-context="editor"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add() } }}
        />
        <Button size="sm" onClick={add}>添加</Button>
      </div>
      {mac && sources?.length ? (
        <div className="path-sources">
          <p className="path-sources-title">系统来源（只读）</p>
          {sources.map((source) => (
            <div className="source-block" key={source.file}>
              <p className="source-file mono">{originLabel({ origin: source.file })}</p>
              <ul className="source-entries">
                {source.entries.map((entry, index) => <li className="mono" key={`${source.file}#${index}`}>{entry}</li>)}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      <div className="status-inline" data-kind={status.kind}>{status.text}</div>
    </div>
  )
}
