import { validateBindings } from './commands.js'
import { validateCompletion, defaultCompletion } from './completionRules.js'

export function validateProductivity(value = {}) {
  return { version: 1, shortcuts: validateBindings(value.shortcuts || {}), completion: validateCompletion(value.completion || {}) }
}

/** Invalid legacy entries cannot disable the editor; retain each independently valid rule. */
export function readProductivity(value = {}) {
  try { return validateProductivity(value) } catch { /* Recover usable entries without evaluating them. */ }
  const shortcuts = {}, rules = [], ids = new Set()
  for (const [id, key] of Object.entries(value?.shortcuts || {})) {
    try { Object.assign(shortcuts, validateBindings({ ...shortcuts, [id]: key })) } catch { /* Unsupported saved binding. */ }
  }
  for (const rule of Array.isArray(value?.completion?.rules) ? value.completion.rules.slice(0, 200) : []) {
    try { const valid = validateCompletion({ rules: [rule] }).rules[0]; if (!ids.has(valid.id)) { rules.push(valid); ids.add(valid.id) } } catch { /* Unsupported saved rule. */ }
  }
  return { version: 1, shortcuts, completion: { ...defaultCompletion(), autoSuggest: value?.completion?.autoSuggest !== false, builtins: value?.completion?.builtins !== false, rules } }
}
