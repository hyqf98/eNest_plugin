/** 输出侧转义：净化器重建 HTML 时，所有文本与属性值都经过这里重新编码 */

const TEXT_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const ATTR_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, char => TEXT_MAP[char])
}

/** 属性值转义后仍只应放在双引号里；换行等控制字符一并编码，避免逃出属性 */
export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"'`\n\r\t]/g, char => ATTR_MAP[char] ?? `&#${char.charCodeAt(0)};`)
}
