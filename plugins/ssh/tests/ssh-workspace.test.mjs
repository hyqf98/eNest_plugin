import test from 'node:test'
import assert from 'node:assert/strict'
import { isReservedSshShortcut } from '../src/js/shortcutPolicy.js'
import { sidebarWidth } from '../src/js/workspaceNavigation.js'

test('SSH workbench shortcuts leave native terminal and completion keys available', () => {
  for (const key of ['Tab', 'Enter', 'ArrowUp', 'Escape', 'Alt+Enter', 'Alt+ArrowDown', 'Mod+V', 'Mod+Space', 'Mod+Shift+W']) {
    assert.equal(isReservedSshShortcut(key, true), true, key)
    assert.equal(isReservedSshShortcut(key, false), true, key)
  }
})
test('SSH shortcut modifiers respect platform Control ownership and clearing', () => {
  assert.equal(isReservedSshShortcut('Mod+F', true), false)
  assert.equal(isReservedSshShortcut('Mod+F', false), true)
  assert.equal(isReservedSshShortcut('Mod+Shift+F', false), false)
  assert.equal(isReservedSshShortcut('Mod+Shift+Space', true), false)
  assert.equal(isReservedSshShortcut('', false), false)
})
test('SSH stored connection width remains within usable layout limits', () => {
  assert.equal(sidebarWidth(undefined), 240)
  assert.equal(sidebarWidth('invalid'), 240)
  assert.equal(sidebarWidth(-100), 220)
  assert.equal(sidebarWidth(9999), 360)
  assert.equal(sidebarWidth(290), 290)
})
