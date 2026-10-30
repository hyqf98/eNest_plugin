/** 新建/编辑双用 Dialog + 生成器小 Dialog + 分类管理 Dialog。 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Checkbox, Select, Slider, Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/index.jsx'
import { backend } from '../js/backend.js'
import { BUILTIN_CATEGORIES, builtinCategoryIds } from '../js/store.js'
import { Icon } from './icons.jsx'
import { StrengthBadge } from './EntryList.jsx'

const NEW_CATEGORY = '__new__'

function GeneratorDialog({ open, onOpenChange, onAdopt }) {
  const [length, setLength] = useState(20)
  const [symbols, setSymbols] = useState(true)
  const [digits, setDigits] = useState(true)
  const [uppercase, setUppercase] = useState(true)
  const [ambiguous, setAmbiguous] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const regen = async () => {
    setError('')
    try { setResult((await backend.generatePassword({ length, symbols, digits, uppercase, ambiguous })).password) }
    catch (e) { setError(e.message) }
  }

  useEffect(() => { if (open) void regen() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pb-dialog pb-generator" aria-label="生成密码">
        <DialogTitle>生成密码</DialogTitle>
        <DialogDescription>使用系统级安全随机源生成，可复制或直接采用。</DialogDescription>
        <div className="gen-result mono" aria-live="polite">{result || (error ? `生成失败：${error}` : '生成中…')}</div>
        <div className="gen-controls">
          <label className="gen-length">
            <span>长度 <span className="mono">{length}</span></span>
            <Slider min={8} max={64} step={1} value={[length]} onValueChange={([v]) => setLength(v)} aria-label="密码长度" />
          </label>
          <div className="gen-flags">
            <label className="gen-flag" htmlFor="gen-upper"><Checkbox id="gen-upper" checked={uppercase} onCheckedChange={(v) => setUppercase(v === true)} /><span>大写字母</span></label>
            <label className="gen-flag" htmlFor="gen-digits"><Checkbox id="gen-digits" checked={digits} onCheckedChange={(v) => setDigits(v === true)} /><span>数字</span></label>
            <label className="gen-flag" htmlFor="gen-symbols"><Checkbox id="gen-symbols" checked={symbols} onCheckedChange={(v) => setSymbols(v === true)} /><span>符号</span></label>
            <label className="gen-flag" htmlFor="gen-ambiguous"><Checkbox id="gen-ambiguous" checked={ambiguous} onCheckedChange={(v) => setAmbiguous(v === true)} /><span>包含易混淆字符</span></label>
          </div>
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => void regen()}>{Icon.refresh(13)} 重新生成</Button>
          <span className="spacer" />
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" disabled={!result} onClick={() => { onAdopt(result); onOpenChange(false) }}>采用</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EntryDialog({ open, onOpenChange, entry, categories, onSave, onCreateCategory }) {
  const editing = Boolean(entry?.id)
  const [title, setTitle] = useState('')
  const [site, setSite] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [category, setCategory] = useState('default')
  const [newCategory, setNewCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [genOpen, setGenOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(entry?.title || '')
    setSite(entry?.site || '')
    setUsername(entry?.username || '')
    setPassword('')
    setCategory(entry?.category || 'default')
    setNewCategory('')
    setNotes(entry?.notes || '')
    setReport(null)
    setError('')
  }, [open, entry])

  // 密码强度实时打分（防抖 200ms；空 = 不显示）
  useEffect(() => {
    if (!password) { setReport(null); return }
    const timer = setTimeout(() => {
      backend.strength(password).then(setReport).catch(() => setReport(null))
    }, 200)
    return () => clearTimeout(timer)
  }, [password])

  const options = useMemo(() => [
    ...categories.map((item) => ({ value: item.id, label: item.name })),
    { value: NEW_CATEGORY, label: '+ 新建分类' }
  ], [categories])

  const submit = async () => {
    setError('')
    if (!title.trim()) { setError('标题不能为空'); return }
    if (!username.trim()) { setError('用户名不能为空'); return }
    if (!editing && !password) { setError('密码不能为空，可点击「生成」创建'); return }
    setBusy(true)
    try {
      let categoryId = category
      if (category === NEW_CATEGORY) {
        if (!newCategory.trim()) throw new Error('请输入新分类名称')
        categoryId = (await onCreateCategory(newCategory.trim())).id
      }
      await onSave({
        id: entry?.id,
        title: title.trim(),
        site: site.trim(),
        username: username.trim(),
        password: password || undefined,
        category: categoryId,
        notes: notes.trim(),
        strength: report?.label
      })
      onOpenChange(false)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="pb-dialog" aria-label={editing ? '编辑条目' : '新建条目'}>
          <DialogTitle>{editing ? '编辑条目' : '新建条目'}</DialogTitle>
          <DialogDescription>{editing ? '密码留空表示不修改当前密码。' : '密码将加密保存到本机保险库，不会以明文存储。'}</DialogDescription>
          <div className="form">
            <label className="form-row"><span>标题 *</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} placeholder="如 GitHub" autoFocus />
            </label>
            <label className="form-row"><span>站点</span>
              <Input value={site} onChange={(e) => setSite(e.target.value)} maxLength={256} placeholder="如 github.com" />
            </label>
            <label className="form-row"><span>用户名 *</span>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={128} placeholder="登录账号 / 邮箱" className="mono" />
            </label>
            <label className="form-row"><span>{editing ? '密码' : '密码 *'}</span>
              <span className="password-line">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={256}
                  placeholder={editing ? '留空 = 不修改' : '输入或生成'} className="mono" autoComplete="new-password" />
                <Button onClick={() => setGenOpen(true)}>{Icon.key(13)} 生成</Button>
              </span>
            </label>
            {password && report && (
              <div className="form-strength">
                <StrengthBadge level={report.label} />
                <span className="score mono">{report.score} 分</span>
                {report.issues.length > 0 && <span className="issues">{report.issues.join('；')}</span>}
              </div>
            )}
            <label className="form-row"><span>分类</span>
              <span className="category-line">
                <Select value={category} options={options} onChange={setCategory} ariaLabel="分类" />
                {category === NEW_CATEGORY && <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} maxLength={32} placeholder="新分类名称" />}
              </span>
            </label>
            <label className="form-row"><span>备注</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1024} rows={3} placeholder="恢复邮箱、2FA 备份码提示等（不存放明文密码）" />
            </label>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <span className="spacer" />
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? '保存中…' : '保存'}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <GeneratorDialog open={genOpen} onOpenChange={setGenOpen} onAdopt={(text) => setPassword(text)} />
    </>
  )
}

export function CategoryDialog({ open, onOpenChange, categories, onRename, onDelete, onCreate, counts }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { if (!open) { setName(''); setError('') } }, [open])
  const custom = categories.filter((item) => !builtinCategoryIds().includes(item.id))
  const add = () => {
    setError('')
    if (!name.trim()) { setError('请输入分类名称'); return }
    onCreate(name.trim()).then(() => setName('')).catch((e) => setError(e.message))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pb-dialog pb-categories" aria-label="分类管理">
        <DialogTitle>分类管理</DialogTitle>
        <DialogDescription>内置分类（{BUILTIN_CATEGORIES.map((item) => item.name).join('、')}）不可修改；删除自定义分类时其中条目归入「默认」。</DialogDescription>
        {custom.length ? (
          <ul className="cat-list">
            {custom.map((item) => (
              <li key={item.id}>
                <span className="cat-name">{Icon.folder(13)} {item.name}</span>
                <span className="badge count">{counts[item.id] || 0} 条</span>
                <span className="cat-actions">
                  <Button variant="ghost" size="sm" onClick={() => {
                    setError('')
                    if (!name.trim()) { setError('请先在下方输入新名称'); return }
                    onRename(item.id, name.trim()).then(() => setName('')).catch((e) => setError(e.message))
                  }}>{Icon.edit(12)} 重命名</Button>
                  <Button variant="ghost" size="sm" className="danger" onClick={() => {
                    setError('')
                    onDelete(item.id).catch((e) => setError(e.message))
                  }}>{Icon.trash(12)} 删除</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="cat-empty">暂无自定义分类。</p>}
        <label className="form-row"><span>新分类</span>
          <span className="category-line">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="新建分类名称" />
            <Button variant="ghost" onClick={add}>{Icon.plus(13)} 新建</Button>
          </span>
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
