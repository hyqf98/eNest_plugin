/* batch-rename 规则引擎（纯函数，node 可直接自测）：
   applyRules(entries, rules) → 预览行（新名/非法/冲突标注）。
   规则类型：replace（查找替换，可正则/大小写）、number（序号）、date（日期）、
   case（大小写转换）、ext（扩展名替换）、insert（插入片段，支持位置锚点）、
   remove（删除片段：按位置删除 N 个字符）。
   链式按序应用，作用于「基础名」与扩展名分离处理。 */

const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/

/** 拆基础名/扩展名：.tar.gz 这类双段扩展不算；无扩展名 → ext='' */
export function splitName(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) }
}

export function joinName(base, ext) {
  return ext ? `${base}.${ext}` : base
}

/** 校验新名合法性（与宿主 fs.rename 校验对齐，仅前端预览用） */
export function validateName(name) {
  if (!name || name.length > 255) return '文件名需为 1–255 个字符'
  if (INVALID_NAME.test(name)) return '含非法字符 \\ / : * ? " < > |'
  if (name === '.' || name === '..' || name.startsWith('.')) return '不能以点开头'
  if (/^[a-zA-Z]:/.test(name)) return '不能包含盘符'
  if (['con', 'nul', 'aux'].includes(name.toLowerCase())) return '系统保留名'
  return null
}

function pad(n, width) {
  return String(n).padStart(Math.max(1, Math.min(10, width)), '0')
}

function formatDate(ts, pattern) {
  const d = new Date(ts)
  const map = {
    YYYY: String(d.getFullYear()).padStart(4, '0'),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0')
  }
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (m) => map[m])
}

/** 应用单条规则到 { base, ext }；mtime 为当前条目原文件时间（date 规则用）；
    抛错 = 规则参数非法（如坏正则） */
function applyOne(part, rule, index, mtime) {
  switch (rule.type) {
    case 'replace': {
      const find = rule.find ?? ''
      if (!find) return part.base
      if (rule.regex) {
        const re = new RegExp(find, rule.caseSensitive ? 'g' : 'gi')
        return part.base.replace(re, rule.replaceWith ?? '')
      }
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re2 = new RegExp(escaped, rule.caseSensitive ? 'g' : 'gi')
      return part.base.replace(re2, rule.replaceWith ?? '')
    }
    case 'number': {
      const start = Number(rule.start ?? 1) || 1
      const step = Number(rule.step ?? 1) || 1
      const width = Number(rule.width ?? 2) || 2
      const token = pad(start + index * step, width)
      if (rule.keepBase === false) return token
      return rule.position === 'prefix' ? `${token}${rule.separator ?? '_'}${part.base}` : `${part.base}${rule.separator ?? '_'}${token}`
    }
    case 'date': {
      const ts = rule.source === 'now' ? Date.now() : (mtime ?? Date.now())
      const token = formatDate(ts, rule.pattern || 'YYYYMMDD')
      if (rule.position === 'prefix') return `${token}${rule.separator ?? '_'}${part.base}`
      return `${part.base}${rule.separator ?? '_'}${token}`
    }
    case 'case': {
      if (rule.mode === 'upper') return part.base.toUpperCase()
      if (rule.mode === 'lower') return part.base.toLowerCase()
      if (rule.mode === 'title') return part.base.replace(/\b\w/g, (c) => c.toUpperCase())
      return part.base
    }
    case 'insert': {
      // 在指定锚点插入片段：head / tail / 按序数定位（第 n 个字符前，负数从尾部计）
      const text = String(rule.text ?? '')
      if (!text) return part.base
      const pos = Number(rule.at ?? 0)
      if (rule.position === 'head') return text + part.base
      if (rule.position === 'tail') return part.base + text
      const anchor = Math.trunc(pos)
      if (anchor < 0) {
        const cut = Math.max(0, part.base.length + anchor)
        return part.base.slice(0, cut) + text + part.base.slice(cut)
      }
      const cut = Math.min(part.base.length, anchor)
      return part.base.slice(0, cut) + text + part.base.slice(cut)
    }
    case 'remove': {
      // 删除片段：position 为 start 时从第 start 个字符起删 length 个；position 为 end 时从尾部起算
      const length = Math.max(0, Math.trunc(Number(rule.length ?? 1)))
      if (!length) return part.base
      const from = Math.trunc(Number(rule.start ?? 0))
      const begin = rule.position === 'end'
        ? Math.max(0, part.base.length + from)
        : Math.min(part.base.length, Math.max(0, from))
      return part.base.slice(0, begin) + part.base.slice(begin + length)
    }
    default:
      return part.base
  }
}

/**
 * 应用规则链到条目列表。
 * entries: [{ id, name, mtime?, dir? }]（dir 用于冲突分组：同名仅在同目录冲突）
 * 返回 [{ id, oldName, newName, dir, changed, error }]：
 *   changed = 新旧名不同；error = 非法名 / 与现存文件冲突（含撞上批内未改名条目）/
 *   与队列内其他改名条目冲突（后写标注，先到者胜）。规则参数非法整体抛错。
 */
export function applyRules(entries, rules) {
  const list = Array.isArray(entries) ? entries : []
  const chain = (Array.isArray(rules) ? rules : []).filter(Boolean)
  // 先整体跑一遍让坏正则尽早抛出（错误提示在规则编辑处）
  const drafts = list.map((entry, index) => {
    let { base, ext } = splitName(entry.name)
    for (const rule of chain) {
      if (rule.type === 'ext') {
        ext = String(rule.ext ?? '').replace(/^\.+/, '')
        continue
      }
      base = applyOne({ base, ext }, rule, index, entry.mtime)
    }
    const newName = joinName(base, ext)
    return { id: entry.id, oldName: entry.name, newName, dir: entry.dir ?? '', changed: newName !== entry.name, error: null }
  })

  // 冲突检测（同目录内）：
  //   1) 目标撞「批内保持原名」的条目 → 与现有文件同名（宿主必拒）
  //   2) 目标撞「批内另一条改名结果」→ 批内同名目标（后者标注，先到者胜）
  const seen = new Map()
  for (const d of drafts) {
    const key = `${d.dir}\u0000${d.newName}`
    const holder = seen.get(key)
    if (holder) {
      if (d.changed) {
        d.error = holder.changed ? '冲突：同名目标' : '冲突：与现有文件同名'
      }
    } else {
      seen.set(key, d)
    }
  }

  // 非法名校验（结果名含非法字符 / 点开头 / 保留名）
  for (const d of drafts) {
    if (d.error) continue
    const invalid = validateName(d.newName)
    if (invalid) d.error = invalid
  }
  return drafts
}

/** 是否存在会阻止执行的行（非法 / 冲突） */
export function hasBlocked(rows) {
  return (rows || []).some((r) => r.error)
}
