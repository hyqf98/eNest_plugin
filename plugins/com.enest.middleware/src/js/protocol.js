/**
 * Page form values -> existing MwWorkbenchRequest contract.
 * Keep the host contract unchanged; identity is bound by workspace.js after adaptation.
 */
export function normalizeRequest(action, input = {}, kind) {
  const { sessionKey, surface, ...values } = input
  const context = { ...(sessionKey ? { sessionKey } : {}), ...(surface ? { surface } : {}) }
  if (action === 'topic.create') return { ...context, topic: typeof values.topic === 'object' ? values.topic : values }
  if (action === 'exchange.create') return { ...context, exchange: values.exchange || values }
  if (action === 'binding.create') return { ...context, binding: values.binding || values }
  if (action === 'topic.update') {
    const { name, attrs, ...fields } = values
    return { ...context, name, attrs: attrs || fields }
  }
  if (action === 'partitions.grow') return { ...context, topic: values.topic ?? values.name, count: values.count ?? values.partitions }
  if (action === 'configs.describe' || action === 'configs.alter') {
    const { name, ...fields } = values
    return { ...context, ...fields, topic: fields.topic ?? name }
  }
  if (action === 'group.resetOffsets') {
    const { strategy, ...fields } = values
    return { ...context, ...fields, to: fields.to ?? strategy ?? (fields.timestamp !== undefined ? 'timestamp' : undefined) }
  }
  if (action === 'messages.query') {
    return { ...context, ...values, from: values.from || 'latest', ...(values.from === 'key' && values.keyContains === undefined ? { keyContains: values.key } : {}) }
  }
  if (action === 'messages.send' && kind === 'rabbitmq') {
    // The form names a queue. RabbitMQ's existing driver publishes through an exchange.
    return { ...context, ...values, topic: 'amq.default', routingKey: values.routingKey || values.topic }
  }
  if (action === 'messages.resend') {
    if (!values.message || typeof values.message !== 'object') throw new Error('重发需要完整消息内容')
    if (kind === 'rabbitmq') {
      // Omit targetTopic so the existing driver uses the default exchange and queue route.
      return { ...context, message: { ...values.message, topic: values.routingKey || values.targetTopic || values.message.topic } }
    }
    return { ...context, message: values.message, ...(values.targetTopic ? { targetTopic: values.targetTopic } : {}) }
  }
  if (action === 'trace.message') return { ...context, key: values.key ?? values.messageId }
  return input
}

export const normalizeQueryMode = mode => mode === 'time' ? 'timestamp' : mode
