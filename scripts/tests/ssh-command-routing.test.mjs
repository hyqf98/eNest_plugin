import test from 'node:test'
import assert from 'node:assert/strict'

const previousWindow = globalThis.window
globalThis.window = { addEventListener() {} }
const { isSshCompositionEvent, canRouteSshShortcut } = await import('../../plugins/ssh/src/js/workbench.js')
if (previousWindow === undefined) delete globalThis.window
else globalThis.window = previousWindow

test('IME-confirmation keys do not become SSH palette or workbench actions', () => {
  assert.equal(isSshCompositionEvent({ key: 'Enter', isComposing: true }), true)
  assert.equal(isSshCompositionEvent({ key: 'ArrowDown', keyCode: 229 }), true)
  assert.equal(isSshCompositionEvent({ key: 'Process' }), true)
  assert.equal(isSshCompositionEvent({ key: 'Enter', isComposing: false, keyCode: 13 }), false)
})

test('terminal shortcuts require their current terminal, preserving forms and remote editor shortcuts', () => {
  const terminalInput = {}, otherTerminalInput = {}, remoteEditor = {}, formInput = {}
  const session = { term: { el: { contains: target => target === terminalInput } } }
  const action = { terminalShortcut: true }
  assert.equal(canRouteSshShortcut(action, terminalInput, session), true)
  for (const target of [otherTerminalInput, remoteEditor, formInput]) assert.equal(canRouteSshShortcut(action, target, session), false)
  assert.equal(canRouteSshShortcut(action, terminalInput, null), false)
  assert.equal(canRouteSshShortcut({ id: 'palette' }, formInput, session), true)
})
