/**
 * net-kit core 单测：curl 解析 / JSONPath 子集 / 编解码策略（长度前缀·分隔符·hex）往返 /
 * hexdump 格式化 / RingBuffer 环形丢弃 / 环境变量替换 / 断言执行
 * 运行：node --test plugins/net-kit/tests/core.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCurl, shellSplit, toCurl,
  jsonPathQuery, jsonPathExists, runAssertions,
  envResolve, buildUrl,
  RingBuffer, formatHexDump, RX_BUFFER_MAX,
  applyDecoder, encodeSend, hexDecode, base64Encode, base64Decode, testDecoder,
  classifyStatus, netError, formatBytes,
  HistoryStore, CollectionStore, wsUrlKind, flattenJson
} from '../src/js/core.js'

// ———— shellSplit ————

test('shellSplit：引号 / 转义 / 续行', () => {
  assert.deepEqual(shellSplit(`curl -X POST 'http://a.b' -d '{"k":"v"}'`),
    ['curl', '-X', 'POST', 'http://a.b', '-d', '{"k":"v"}'])
  assert.deepEqual(shellSplit(`curl "http://a.b?q=\\"x\\"" `), ['curl', 'http://a.b?q="x"'])
  assert.deepEqual(shellSplit('curl \\\n  http://a.b'), ['curl', 'http://a.b'])
  assert.deepEqual(shellSplit(`curl -H $'a: line\\nnext' http://x`), ['curl', '-H', 'a: line\nnext', 'http://x'])
})

// ———— parseCurl ————

test('parseCurl：基础 POST JSON', () => {
  const r = parseCurl(`curl -X POST 'https://api.example.com/v1/users?src=test' -H 'content-type: application/json' -H 'Authorization: Bearer tk' --data-raw '{"name": "张三"}' -s`)
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://api.example.com/v1/users?src=test')
  assert.equal(r.bodyKind, 'json')
  assert.equal(r.body, '{"name": "张三"}')
  assert.ok(r.headers.some(([k, v]) => k.toLowerCase() === 'authorization' && v === 'Bearer tk'))
})

test('parseCurl：-d 隐式 POST + 表单推断', () => {
  const r = parseCurl(`curl http://127.0.0.1:3000/login -d 'user=a&pass=b'`)
  assert.equal(r.method, 'POST')
  assert.equal(r.bodyKind, 'raw')
  assert.equal(r.body, 'user=a&pass=b')
})

test('parseCurl：GET + -G 时 -d 并入 query 语义保持 body 不动（不崩）', () => {
  const r = parseCurl(`curl -X GET https://a.b/api -H 'accept: application/json'`)
  assert.equal(r.method, 'GET')
  assert.equal(r.bodyKind, 'none')
})

test('parseCurl：-u Basic 与 -m 超时与 -k', () => {
  const r = parseCurl(`curl -u alice:s3cret -m 7.5 -k https://a.b`)
  assert.equal(r.headers.find(([k]) => k === 'authorization')[1], 'Basic ' + Buffer.from('alice:s3cret').toString('base64'))
  assert.equal(r.timeoutMs, 7500)
  assert.equal(r.insecure, true)
})

test('parseCurl：@file 拒绝并提示', () => {
  assert.throws(() => parseCurl(`curl http://a.b -d @payload.json`), /@file|文件/)
  assert.throws(() => parseCurl(`curl http://a.b -F @img.png`), /-F|文件/)
})

test('parseCurl：非 curl 输入拒绝 / 缺 URL 拒绝', () => {
  assert.throws(() => parseCurl(`wget http://a.b`), /curl/)
  assert.throws(() => parseCurl(`curl -X GET`), /URL/)
})

test('toCurl 往返：导出再解析等价', () => {
  const orig = { method: 'PUT', url: 'https://a.b/x?y=1', headers: [['content-type', 'application/json']], body: '{"a":1}' }
  const round = parseCurl(toCurl(orig))
  assert.equal(round.method, 'PUT')
  assert.equal(round.url, orig.url)
  assert.equal(round.body, orig.body)
  assert.ok(round.headers.some(([k, v]) => k === 'content-type' && v === 'application/json'))
})

// ———— JSONPath ————

const sample = { a: { b: [1, 2, { c: 'x' }] }, list: [{ id: 1 }, { id: 2 }], deep: { inner: { c: 'y' } } }

test('jsonPathQuery：键路径 / 数组索引 / 负索引', () => {
  assert.deepEqual(jsonPathQuery(sample, '$.a.b[0]'), [1])
  assert.deepEqual(jsonPathQuery(sample, '$.a.b[2].c'), ['x'])
  assert.deepEqual(jsonPathQuery(sample, '$.a.b[-1].c'), ['x'])
  assert.deepEqual(jsonPathQuery(sample, "$['list'][1].id"), [2])
})

test('jsonPathQuery：[*] 与递归 ..', () => {
  assert.deepEqual(jsonPathQuery(sample, '$.list[*].id'), [1, 2])
  assert.ok(jsonPathQuery(sample, '$..c').includes('x') && jsonPathQuery(sample, '$..c').includes('y'))
  assert.equal(jsonPathQuery(sample, '$..missing').length, 0)
})

test('jsonPathExists / 非法路径', () => {
  assert.equal(jsonPathExists(sample, '$.a.b'), true)
  assert.equal(jsonPathExists(sample, '$.zzz'), false)
  assert.throws(() => jsonPathQuery(sample, 'a.b'), /\$/)
})

// ———— 断言 ————

test('runAssertions：状态码 / 耗时 / JSONPath / 包含', () => {
  const ctx = { status: 200, elapsedMs: 120, bodyText: '{"ok":true,"data":{"list":[1]}}', json: JSON.parse('{"ok":true,"data":{"list":[1]}}') }
  const rs = runAssertions([
    { type: 'statusEq', expected: '200' },
    { type: 'statusIn', expected: '200, 201' },
    { type: 'maxMs', expected: '500' },
    { type: 'jsonPathExists', target: '$.data.list[0]' },
    { type: 'jsonPathNotExists', target: '$.error' },
    { type: 'bodyContains', expected: '"ok"' }
  ], ctx)
  assert.equal(rs.filter((r) => r.pass).length, 6)
  const fail = runAssertions([{ type: 'statusEq', expected: '404' }], ctx)
  assert.equal(fail[0].pass, false)
})

// ———— 环境变量 / URL ————

test('envResolve：替换与缺失收集', () => {
  const { text, missing } = envResolve('{{host}}/api?tk={{token}}&x=1', { host: 'http://127.0.0.1:3000' })
  assert.equal(text, 'http://127.0.0.1:3000/api?tk={{token}}&x=1')
  assert.deepEqual(missing, ['token'])
})

test('buildUrl：params 合并覆盖', () => {
  assert.equal(buildUrl('https://a.b/?x=1', [{ key: 'x', value: '2', enabled: true }, { key: 'y', value: '3', enabled: true }]), 'https://a.b/?x=2&y=3')
  assert.equal(buildUrl('https://a.b/', [{ key: 'z', value: '1', enabled: false }]), 'https://a.b/')
})

// ———— RingBuffer / hexdump ————

test('RingBuffer：上限环形丢弃计数', () => {
  const rb = new RingBuffer(16)
  rb.push(new Uint8Array([1, 2, 3]))
  rb.push(Uint8Array.from({ length: 20 }, (_, i) => i))
  assert.equal(rb.length, 16)
  assert.equal(rb.dropped, 7)
  const snap = rb.snapshot()
  assert.equal(snap.length, 16)
  // 丢弃的是最旧字节（1,2,3 全丢 + 20 字节中的前 4 字节）
  assert.equal(snap[0], 4)
})

test('RingBuffer：单块超限', () => {
  const rb = new RingBuffer(8)
  rb.push(Uint8Array.from({ length: 100 }, (_, i) => i))
  assert.equal(rb.length, 8)
  assert.equal(rb.dropped, 92)
})

test('formatHexDump：列宽与 ASCII 折叠', () => {
  const bytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x0a, 0x00, 0xff])
  const out = formatHexDump(bytes)
  assert.match(out, /^00000000 {2}48 65 6c 0a 00 ff/)
  assert.match(out, /\|Hel\.\.\.\|/)
  assert.equal(formatHexDump(new Uint8Array(0)), '(空)')
  assert.equal(RX_BUFFER_MAX, 4 * 1024 * 1024)
})

// ———— 编解码策略 ————

test('encodeSend/applyDecoder：长度前缀帧（大端 4）往返', () => {
  const bytes = encodeSend('PING: hello', 'len-be4')
  assert.equal(bytes[0], 0)
  assert.equal(bytes[1], 0)
  assert.equal(bytes[2], 0)
  assert.equal(bytes[3], 11)
  const out = applyDecoder('len-be4', bytes, [])
  assert.match(out, /帧长 11 B/)
  assert.match(out, /PING: hello/)
})

test('encodeSend/applyDecoder：长度前缀帧（小端 2）往返', () => {
  const bytes = encodeSend('AB', 'len-le2')
  assert.deepEqual([...bytes.slice(0, 2)], [2, 0])
  const out = applyDecoder('len-le2', bytes, [])
  assert.match(out, /帧长 2 B/)
})

test('encodeSend/applyDecoder：分隔符帧（\\r\\n）多帧拆分', () => {
  const bytes = encodeSend('a\\r\\nb\\r\\n', 'sep-crlf')
  const out = applyDecoder('sep-crlf', bytes, [])
  assert.match(out, /#1 1B a/)
  assert.match(out, /#2 1B b/)
})

test('encodeSend：hex 字面与转义', () => {
  assert.deepEqual([...encodeSend('48 65', 'hex')], [0x48, 0x65])
  assert.deepEqual([...encodeSend('\\x41\\n', 'text')], [0x41, 0x0a])
  assert.throws(() => hexDecode('abc'), /偶数/)
})

test('applyDecoder：utf8 / json / base64 / ascii', () => {
  const utf8 = new TextEncoder().encode('{"a":1}')
  assert.match(applyDecoder('json', utf8, []), /"a": 1/)
  assert.equal(applyDecoder('base64', utf8, []), Buffer.from('{"a":1}').toString('base64'))
  assert.equal(applyDecoder('ascii', Uint8Array.from([0x41, 0x00, 0xff]), []), 'A..')
  assert.equal(applyDecoder('utf8', utf8, []), '{"a":1}')
  // 非法 JSON 行内报错
  assert.throws(() => applyDecoder('json', new TextEncoder().encode('nope'), []))
})

test('自定义解码器：编译与测试', () => {
  const code = `return 'len=' + bytes.length`
  const res = testDecoder(code, new Uint8Array([1, 2, 3]))
  assert.equal(res.ok, true)
  assert.equal(res.output, 'len=3')
  const bad = testDecoder('return {{{', new Uint8Array(0))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /语法错误|Unexpected/)
})

// ———— 其它 ————

test('classifyStatus / netError / formatBytes / wsUrlKind', () => {
  assert.equal(classifyStatus(200), 'ok')
  assert.equal(classifyStatus(302), 'neutral')
  assert.equal(classifyStatus(404), 'danger')
  assert.equal(classifyStatus(500), 'danger')
  assert.match(netError('connect failed: connection refused (127.0.0.1:1)'), /拒绝/)
  assert.match(netError('socket limit reached (8 per plugin)'), /8 条并发/)
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(wsUrlKind('wss://a.b'), 'direct')
  assert.equal(wsUrlKind('ws://a.b'), 'plain')
  assert.equal(wsUrlKind('ftp://a.b'), 'invalid')
})

test('HistoryStore：50 条上限 / CollectionStore：增删', () => {
  const h = new HistoryStore()
  for (let i = 0; i < 60; i++) h.push({ method: 'GET', url: `/u/${i}` })
  assert.equal(h.items.length, 50)
  assert.equal(h.items[0].url, '/u/59')
  const c = new CollectionStore(null)
  c.add('g-default', { method: 'GET', url: 'https://a' })
  c.addGroup('work')
  c.add('work', { method: 'POST', url: 'https://b' })
  assert.equal(c.groups.length, 2)
  c.removeGroup('g-default')
  c.removeGroup('work') // 仅剩一组时拒绝删除
  assert.equal(c.groups.length, 1)
})

test('flattenJson：深度与节点裁剪', () => {
  const rows = flattenJson({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 })
  assert.ok(rows.every((r) => r.depth <= 2))
  const many = flattenJson(Array.from({ length: 5000 }, (_, i) => i), { maxNodes: 100 })
  assert.equal(many.length, 100)
})
