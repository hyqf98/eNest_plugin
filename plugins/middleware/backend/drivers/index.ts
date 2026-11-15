/** 驱动注册表 + kinds.list 描述符派生。仅运行于 mwUtility。
 * 各驱动文件实现 MwDriver（含 connectionFields/pageColumns/metricsSpec 描述符），汇总为 MwDriverDescriptor。
 * 新增中间件 = 新驱动文件 + 在此注册，前后端其余部分零改动。 */
import type { MwDriverDescriptor, MwKind } from '@backend/contracts/mw-workbench'
import type { MwDriver } from '@backend/types'
import { kafkaDriver } from '@backend/drivers/kafka'
import { rabbitmqDriver } from '@backend/drivers/rabbitmq'
import { mqttDriver } from '@backend/drivers/mqtt'
import { rocketmqDriver } from '@backend/drivers/rocketmq'
import { activemqDriver } from '@backend/drivers/activemq'
import { redisDriver } from '@backend/drivers/redis'
import { pulsarDriver } from '@backend/drivers/pulsar'

export const MW_DRIVER_REGISTRY: Record<MwKind, MwDriver> = {
  kafka: kafkaDriver,
  rabbitmq: rabbitmqDriver,
  mqtt: mqttDriver,
  rocketmq: rocketmqDriver,
  activemq: activemqDriver,
  redis: redisDriver,
  pulsar: pulsarDriver
}

export function getMwDriver(kind: string): MwDriver {
  const driver = MW_DRIVER_REGISTRY[kind as MwKind]
  if (!driver) throw new Error(`unknown middleware kind: ${kind}`)
  return driver
}

export function mwDriverDescriptors(): MwDriverDescriptor[] {
  return Object.values(MW_DRIVER_REGISTRY).map(driver => ({
    kind: driver.kind,
    label: driver.label,
    transport: driver.transport,
    defaultPort: driver.defaultPort,
    messageQueryModes: driver.messageQueryModes,
    capabilities: driver.capabilities,
    connectionFields: driver.connectionFields,
    ...(driver.pageColumns ? { pageColumns: driver.pageColumns } : {}),
    ...(driver.metricsSpec ? { metricsSpec: driver.metricsSpec } : {}),
    ...(driver.sendFields ? { sendFields: driver.sendFields } : {})
  }))
}
