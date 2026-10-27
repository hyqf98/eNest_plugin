import test from 'node:test'
import assert from 'node:assert/strict'
import { MiddlewareCommands, validateBindings, shortcutError, shortcutFromEvent } from '../src/js/commands.js'
import { validateCompletion, namedSuggestions, jsonRuleSuggestions } from '../src/js/completionRules.js'
import { jsonCompletionContext } from '../src/js/jsonContext.js'
import { readProductivity, validateProductivity } from '../src/js/preferences.js'
import { restoreTasks } from '../src/js/workspace.js'

const connection = { id: 'orders', kind: 'kafka', name: '订单消息', env: 'dev' }
const rule = (kind, values = {}) => ({ id: 'rule-a', kind, label: '订单规则', trigger: '', field: '', value: 'order-events', protocol: '', connectionId: '', enabled: true, ...values })
const preference = (...rules) => validateCompletion({ rules })
const edit = (source, item) => source.slice(0, item.from) + item.text + source.slice(item.to)

test('scoped shortcut conflicts distinguish independent message and publish tasks', () => {
  assert.deepEqual(validateBindings({}), {})
  assert.deepEqual(validateBindings({ 'mw.queryMessages': 'Mod+Alt+S', 'mw.send': 'Mod+Alt+S' }), { 'mw.queryMessages': 'Mod+Alt+S', 'mw.send': 'Mod+Alt+S' })
  assert.throws(() => validateBindings({ 'mw.formatJson': 'Mod+Enter' }), /冲突/)
  assert.throws(() => validateBindings({ 'mw.send': 'Mod+F' }), /冲突/)
  assert.deepEqual(validateBindings({ 'mw.send': '' }), { 'mw.send': '' })
  assert.deepEqual(validateBindings({ 'mw.send': 'Mod+Enter' }), {})
  for (const key of ['Enter', 'Tab', 'Escape', 'Mod+V', 'Mod+Z', 'Alt+F4', 'Shift+A']) assert.ok(shortcutError('mw.send', key), key)
  assert.equal(shortcutError('mw.closeTab', 'Mod+W'), '')
  assert.equal(shortcutFromEvent({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true }), 'Mod+Shift+,')
})

test('one command router honors bindings, input ownership, IME and active task changes before dispatch', async () => {
  const commands = new MiddlewareCommands(), jsonInput = {}, topicInput = {}, calls = []
  let active = true
  commands.register('mw.send', { element: { contains: target => target === jsonInput }, isActive: () => active, run: () => calls.push('send') })
  const event = (key = 'Enter', extras = {}) => ({ key, code: key, ctrlKey: true, target: jsonInput, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...extras })
  assert.equal(commands.handle(event('Enter', { isComposing: true })), false)
  assert.equal(commands.handle(event('Enter', { keyCode: 229 })), false)
  assert.equal(commands.handle(event('Enter', { target: topicInput })), false)
  assert.equal(commands.handle(event()), true); active = false
  await Promise.resolve(); assert.deepEqual(calls, [])
  active = true; commands.configure({ 'mw.send': 'Mod+Alt+S' })
  assert.equal(commands.handle(event()), false)
  assert.equal(commands.handle(event('s', { altKey: true })), true)
  await Promise.resolve(); assert.deepEqual(calls, ['send'])
})

test('Topic aliases and templates are local, connection-scoped and plain text', () => {
  const preferences = preference(rule('topic', { label: '订单开发环境', trigger: 'ord', value: 'orders.${environment}.${protocol}', connectionId: 'orders', protocol: 'kafka' }))
  const item = namedSuggestions('ord', 3, { connection, preferences })[0]
  assert.equal(item.text, 'orders.dev.kafka')
  assert.equal(item.to, 3)
  assert.equal(namedSuggestions('ord', 3, { connection: { ...connection, id: 'other' }, preferences }).length, 0)
  assert.equal(namedSuggestions('ord', 3, { connection: { ...connection, kind: 'mqtt' }, preferences }).length, 0)
  assert.throws(() => preference(rule('topic', { value: '${process.exit()}' })), /不支持变量/)
  assert.throws(() => preference(rule('topic', { value: 'foo${input' })), /未闭合/)
  assert.throws(() => preference(rule('header', { value: 'name\nvalue' })), /控制字符/)
})

test('declarative JSON fields and typed values use their object path and preserve quotes', () => {
  const preferences = preference(rule('jsonKey', { value: 'status', field: 'customer' }), rule('jsonValue', { id: 'value', label: '已创建', trigger: 'cr', field: 'customer.status', value: '"created"' }))
  assert.equal(jsonRuleSuggestions('{"st', 4, preferences, connection).length, 0)
  const keySource = '{"customer":{"st'
  assert.equal(edit(keySource, jsonRuleSuggestions(keySource, keySource.length, preferences, connection)[0]), '{"customer":{"status"')
  const source = '{"customer":{"status":"cr"},"other":1}'
  const caret = source.indexOf('cr') + 2
  assert.equal(edit(source, jsonRuleSuggestions(source, caret, preferences, connection)[0]), '{"customer":{"status":"created"},"other":1}')
  const bare = '{"customer":{"status":cr'
  assert.equal(edit(bare, jsonRuleSuggestions(bare, bare.length, preferences, connection)[0]), '{"customer":{"status":"created"')
  assert.equal(jsonRuleSuggestions('{"other":"cr', 12, preferences, connection).length, 0)
  const escaped = preference(rule('jsonValue', { field: 'name', value: '"a\\\"b"' }))
  assert.equal(edit('{"name":"', jsonRuleSuggestions('{"name":"', 9, escaped, connection)[0]), '{"name":"a\\\"b"')
})

test('JSON scalar and array/object values remain typed and malformed prefixes do not match', () => {
  const preferences = preference(rule('jsonValue', { field: 'active', value: 'true' }), rule('jsonValue', { id: 'object', field: 'data', value: '{"count":1}' }))
  assert.equal(edit('{"active":', jsonRuleSuggestions('{"active":', 10, preferences, connection)[0]), '{"active":true')
  assert.equal(jsonRuleSuggestions('{"active":"', 11, preferences, connection).length, 0)
  const source = '{"rows":[{"data":'
  assert.deepEqual(jsonCompletionContext(source, source.length).path, ['rows', '0', 'data'])
  assert.equal(jsonRuleSuggestions(source, source.length, preferences, connection)[0].text, '{"count":1}')
  assert.equal(jsonCompletionContext('{"a" 4', 6), null)
  assert.throws(() => preference(rule('jsonValue', { value: 'unquoted' })), /指定 JSON 字段/)
  assert.throws(() => preference(rule('jsonValue', { field: 'a', value: 'unquoted' })), /有效 JSON/)
})

test('disabled providers and invalid stored entries cannot widen rule scope or execute code', () => {
  const config = readProductivity({ shortcuts: { 'mw.send': 'Enter', 'mw.preview': 'Mod+Alt+P' }, completion: { autoSuggest: false, builtins: false, rules: [rule('topic'), rule('jsonValue', { id: 'bad', field: 'name', value: 'eval("x")' })] } })
  assert.equal(config.shortcuts['mw.send'], undefined)
  assert.equal(config.shortcuts['mw.preview'], 'Mod+Alt+P')
  assert.equal(config.completion.rules.length, 1)
  assert.equal(config.completion.autoSuggest, false)
  assert.equal(namedSuggestions('payment', 7, { connection, preferences: config.completion, names: ['payment-events'] }).length, 0)
  assert.equal(matchingDisabled().length, 0)
  function matchingDisabled() { return namedSuggestions('order', 5, { connection, preferences: preference(rule('topic', { enabled: false })) }) }
  assert.equal(validateProductivity(config).version, 1)
})

test('settings restore as one connection-independent work tab without creating a runtime session', () => {
  assert.deepEqual(restoreTasks({ workspace: { tabs: [{ pageId: 'settings' }, { connectionId: 'old', pageId: 'settings' }] } }, []), [{ id: 'workspace:settings', pageId: 'settings', connectionId: null }])
})

test('explicit settings save is serialized with layouts and failed persistence does not replace live preferences', async () => {
  const { default: api } = await import('../src/js/api.js')
  const { default: store } = await import('../src/js/store.js')
  const storage = api.storage, calls = []
  let fail = true, release
  api.storage = { get: async key => key === 'mw.connections' ? [connection] : { extraSetting: 'kept' }, set: async (key, value) => { if (fail) throw new Error('空间不足'); calls.push(structuredClone(value)); if (!release) await new Promise(resolve => { release = resolve }) } }
  try {
    await store.load()
    const next = validateProductivity({ shortcuts: { 'mw.send': 'Mod+Alt+S' }, completion: { rules: [rule('topic')] } })
    await assert.rejects(store.saveProductivity(next), /空间不足/)
    assert.equal(store.ui.productivity.shortcuts['mw.send'], undefined)
    fail = false
    const pending = store.saveProductivity(next)
    while (!release) await Promise.resolve()
    store.setUi('treeWidth', 320)
    const flush = store.flush()
    release(); await pending; await flush
    assert.equal(store.ui.productivity.shortcuts['mw.send'], 'Mod+Alt+S')
    assert.equal(calls.at(-1).productivity.shortcuts['mw.send'], 'Mod+Alt+S')
    assert.equal(calls.at(-1).treeWidth, 320)
    assert.equal(calls.at(-1).extraSetting, 'kept')
    // Exercise the real debounce callback as well as explicit flush: it must
    // serialize the latest live preferences and layout without a timer error.
    store.setUi('treeWidth', 330)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(calls.at(-1).treeWidth, 330)
    assert.equal(calls.at(-1).productivity.shortcuts['mw.send'], 'Mod+Alt+S')
  } finally { await store.flush(); api.storage = storage }
})
