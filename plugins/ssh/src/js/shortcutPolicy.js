/** Workbench keys must not intercept remote shell editing or completion navigation. */
export function isReservedSshShortcut(value, mac = false, commandId = '') {
  if (!value) return false
  if ({ 'completion-previous': 'Alt+ArrowUp', 'completion-next': 'Alt+ArrowDown', 'completion-accept': 'Alt+Enter' }[commandId] === value) return false
  const parts = String(value).split('+'), key = parts.at(-1)
  if (!parts.includes('Mod')) return true
  if (['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Delete','Backspace'].includes(key)) return true
  if (['Mod+Space','Mod+Q','Mod+W','Mod+C','Mod+V','Mod+X','Mod+A','Mod+Shift+Q','Mod+Shift+W'].includes(value)) return true
  return !mac && !parts.includes('Shift')
}

export function displaySshShortcut(value, mac = false) {
  const labels = { Mod: mac ? 'Command' : 'Ctrl', Alt: mac ? 'Option' : 'Alt', Shift: 'Shift', ArrowUp: '↑', ArrowDown: '↓', Enter: 'Enter', Space: 'Space' }
  return String(value || '').split('+').map(part => labels[part] || part).join('+')
}
