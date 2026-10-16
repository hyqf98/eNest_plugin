import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRequest, normalizeQueryMode } from '../../plugins/middleware/src/js/protocol.js'

// Expectations match src/shared/types/mw-workbench.ts and mwService.ts dispatch,
// including nested payloads passed unchanged to the existing driver methods.
test('Topic, queue and exchange form values meet the nested host action contract', () => {
  assert.deepEqual(normalizeRequest('topic.create', { sessionKey: 'mw:a', name: 'orders', partitions: 3, replicationFactor: 1 }), { sessionKey: 'mw:a', topic: { name: 'orders', partitions: 3, replicationFactor: 1 } })
  assert.deepEqual(normalizeRequest('topic.update', { sessionKey: 'mw:a', name: 'orders', autoDelete: false, arguments: { 'x-message-ttl': 1000 } }), { sessionKey: 'mw:a', name: 'orders', attrs: { autoDelete: false, arguments: { 'x-message-ttl': 1000 } } })
  assert.deepEqual(normalizeRequest('exchange.create', { name: 'events', type: 'topic', durable: true }), { exchange: { name: 'events', type: 'topic', durable: true } })
  const modern = { topic: { name: 'already-adapted' } }
  assert.deepEqual(normalizeRequest('topic.create', modern), modern)
})
test('partition expansion and config operations use host topic/count fields', () => {
  assert.deepEqual(normalizeRequest('partitions.grow', { name: 'orders', partitions: 6 }), { topic: 'orders', count: 6 })
  assert.deepEqual(normalizeRequest('configs.describe', { name: 'orders' }), { topic: 'orders' })
  assert.deepEqual(normalizeRequest('configs.alter', { name: 'orders', configs: { 'retention.ms': '1000' } }), { topic: 'orders', configs: { 'retention.ms': '1000' } })
})
test('host time mode reaches timestamp query and Kafka key filters are not silently lost', () => {
  assert.equal(normalizeQueryMode('time'), 'timestamp')
  assert.equal(normalizeQueryMode('id'), 'id')
  assert.deepEqual(normalizeRequest('messages.query', { topic: 'orders', from: 'key', key: 'customer-4' }, 'kafka'), { topic: 'orders', from: 'key', key: 'customer-4', keyContains: 'customer-4' })
  assert.equal(normalizeRequest('messages.query', { topic: 'orders' }).from, 'latest')
})
test('consumer reset keeps the host to enum for both strategy and timestamp forms', () => {
  assert.deepEqual(normalizeRequest('group.resetOffsets', { groupId: 'worker', topic: 'orders', strategy: 'earliest' }), { groupId: 'worker', topic: 'orders', to: 'earliest' })
  assert.deepEqual(normalizeRequest('group.resetOffsets', { groupId: 'worker', topic: 'orders', timestamp: 123 }), { groupId: 'worker', topic: 'orders', timestamp: 123, to: 'timestamp' })
})
test('RabbitMQ queue publishing routes through its default exchange', () => {
  assert.deepEqual(normalizeRequest('messages.send', { topic: 'orders', payload: 'hello' }, 'rabbitmq'), { topic: 'amq.default', routingKey: 'orders', payload: 'hello' })
  assert.deepEqual(normalizeRequest('messages.send', { topic: 'orders', payload: 'hello', routingKey: 'another-queue' }, 'rabbitmq'), { topic: 'amq.default', routingKey: 'another-queue', payload: 'hello' })
  assert.equal(normalizeRequest('messages.send', { topic: 'orders' }, 'kafka').topic, 'orders')
})
test('resend keeps original envelope and RabbitMQ queue semantics instead of treating queue as exchange', () => {
  const message = { topic: 'orders', payload: '{"id":1}', timestamp: 123, key: 'k', headers: { 'content-type': 'application/json' } }
  assert.deepEqual(normalizeRequest('messages.resend', { message, targetTopic: 'retries' }, 'kafka'), { message, targetTopic: 'retries' })
  assert.deepEqual(normalizeRequest('messages.resend', { message, targetTopic: 'retries' }, 'rabbitmq'), { message: { ...message, topic: 'retries' } })
  assert.equal(message.topic, 'orders')
  assert.throws(() => normalizeRequest('messages.resend', { payload: 'missing-envelope' }), /完整消息/)
})
test('RocketMQ MsgId uses the existing trace key field', () => {
  assert.deepEqual(normalizeRequest('trace.message', { messageId: 'A0BC' }), { key: 'A0BC' })
})
