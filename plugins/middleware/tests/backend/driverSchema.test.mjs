import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../backend/', import.meta.url))

/** 离线打包驱动注册表（重依赖 external，http 客户端 stub） */
async function registry() {
  const adapters = {
    kafkajs: 'export default {}',
    amqplib: 'export default {}',
    mqtt: 'export default {}',
    ioredis: 'export default {}',
    ws: 'export default {}'
  }
  const result = await build({
    entryPoints: [root + 'drivers/index.ts'],
    bundle: true, write: false, platform: 'node', format: 'esm',
    tsconfig: root + 'tsconfig.json', logLevel: 'silent',
    plugins: [{
      name: 'offline-drivers',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'stub' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
      }
    }]
  })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64'))
}

const KNOWN_CAP_KEYS = ['topicCrud', 'partitions', 'exchanges', 'bindings', 'consumerGroups', 'offsetReset', 'clients', 'clientKick', 'messageQuery', 'tail', 'publish', 'resend', 'trace', 'retained', 'configMgmt', 'monitor', 'dlqBrowse', 'dlqTemplates', 'delayQueue']
const KNOWN_FIELD_TYPES = ['text', 'password', 'select', 'switch', 'number']
const KNOWN_FORMATS = ['text', 'mono', 'num', 'compact', 'bytes', 'ms', 'datetime', 'chip', 'bool', 'lag', 'health', 'type', 'entity']
const KNOWN_UNITS = ['count', 'bytes', 'ms', 'percent', 'rate', 'text']
const KNOWN_PATTERNS = ['https-url', 'mqtt-url', 'host-ports', 'redis-url']

test('driver registry exposes seven kinds with schema descriptors and stable method surface', async () => {
  const { mwDriverDescriptors, MW_DRIVER_REGISTRY } = await registry()
  const descriptors = mwDriverDescriptors()
  assert.deepEqual(descriptors.map(d => d.kind), ['kafka', 'rabbitmq', 'mqtt', 'rocketmq', 'activemq', 'redis', 'pulsar'])
  assert.equal(Object.keys(MW_DRIVER_REGISTRY).length, 7)
  for (const descriptor of descriptors) {
    assert.ok(descriptor.label, `${descriptor.kind} 缺 label`)
    assert.ok(Array.isArray(descriptor.connectionFields) && descriptor.connectionFields.length, `${descriptor.kind} 缺 connectionFields`)
    // 每个驱动必须有 topics 列声明（页面主表）
    assert.ok(descriptor.pageColumns?.some(p => p.page === 'topics' || p.page === 'queues' || p.page === 'subscriptions'), `${descriptor.kind} 缺 topics/queues 列声明`)
    assert.ok(Array.isArray(descriptor.metricsSpec) && descriptor.metricsSpec.length, `${descriptor.kind} 缺 metricsSpec`)
    // 能力键必须在已知集合内（防拼写漂移）
    for (const key of Object.keys(descriptor.capabilities)) assert.ok(KNOWN_CAP_KEYS.includes(key), `${descriptor.kind} 未知能力键 ${key}`)
    for (const field of descriptor.connectionFields) {
      assert.ok(KNOWN_FIELD_TYPES.includes(field.type), `${descriptor.kind}.${field.key} 未知字段类型 ${field.type}`)
      if (field.pattern) assert.ok(KNOWN_PATTERNS.includes(field.pattern), `${descriptor.kind}.${field.key} 未知 pattern ${field.pattern}`)
      if (field.type === 'select') assert.ok(field.options?.length, `${descriptor.kind}.${field.key} select 缺 options`)
      if (field.type === 'password') assert.ok(field.vaultSlot, `${descriptor.kind}.${field.key} password 缺 vaultSlot`)
    }
    for (const page of descriptor.pageColumns ?? []) {
      for (const column of page.columns) {
        if (column.format) assert.ok(KNOWN_FORMATS.includes(column.format), `${descriptor.kind} ${page.page}.${column.key} 未知 format ${column.format}`)
      }
    }
    for (const metric of descriptor.metricsSpec) {
      assert.ok(metric.label, `${descriptor.kind} 指标 ${metric.key} 缺 label`)
      if (metric.unit) assert.ok(KNOWN_UNITS.includes(metric.unit), `${descriptor.kind} 指标 ${metric.key} 未知 unit ${metric.unit}`)
    }
  }
})

test('every driver implements the full MwDriver method surface including queueTemplate', async () => {
  const { MW_DRIVER_REGISTRY } = await registry()
  const required = ['test', 'open', 'close', 'overview', 'topicsList', 'topicDescribe', 'topicCreate', 'topicUpdate', 'topicDelete', 'topicPurge', 'partitionsGrow', 'exchangesList', 'exchangeCreate', 'exchangeDelete', 'bindingsList', 'bindingCreate', 'bindingDelete', 'groupsList', 'groupDescribe', 'groupResetOffsets', 'clientsList', 'clientKick', 'messagesQuery', 'messageGet', 'messageSend', 'messageResend', 'configsDescribe', 'configsAlter', 'traceMessage', 'retainedList', 'retainedDelete', 'queueTemplate', 'tailStart']
  for (const [kind, driver] of Object.entries(MW_DRIVER_REGISTRY)) {
    for (const method of required) assert.equal(typeof driver[method], 'function', `${kind} 缺方法 ${method}`)
  }
})

test('connection fields declare required endpoint keys the drivers validate', async () => {
  const { mwDriverDescriptors } = await registry()
  const endpoints = {
    kafka: 'bootstrapServers',
    rabbitmq: 'managementUrl',
    mqtt: 'brokerUrl',
    rocketmq: 'dashboardUrl',
    activemq: 'jolokiaUrl',
    redis: 'redisUrl',
    pulsar: 'serviceUrl'
  }
  for (const descriptor of mwDriverDescriptors()) {
    const requiredKey = endpoints[descriptor.kind]
    const field = descriptor.connectionFields.find(f => f.key === requiredKey)
    assert.ok(field, `${descriptor.kind} 连接表单缺必填字段 ${requiredKey}`)
    assert.equal(field.required, true, `${descriptor.kind}.${requiredKey} 未标 required`)
    assert.ok(field.pattern, `${descriptor.kind}.${requiredKey} 缺 pattern 预检`)
  }
})

test('mutating actions stay in sync with the workbench permission mapping', async () => {
  const policy = await build({ entryPoints: [root + 'workbench.ts'], bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: root + 'tsconfig.json', logLevel: 'silent' })
  const { mwWorkbenchPermission } = await import('data:text/javascript;base64,' + Buffer.from(policy.outputFiles[0].text).toString('base64'))
  assert.equal(mwWorkbenchPermission('queue.template'), 'net.messaging.admin')
  assert.throws(() => mwWorkbenchPermission('schema.unknown'), /Unknown/)
})
