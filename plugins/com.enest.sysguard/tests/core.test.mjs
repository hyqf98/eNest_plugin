/**
 * sysguard core 单测：格式化 / 系统进程判定 / 搜索 / 联动映射 / SampleRing / sparkline 数据 /
 * ps 与 lsof 样本解析（mock 宿主 parsePsOutput / parseLsofOutput 的同构样本）
 * 运行：node --test plugins/com.enest.sysguard/tests/core.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatKb, formatPct, isSystemProc, searchProc, searchPort,
  linkPortsToProc, SampleRing, shortName,
  thresholdLevel, summarize, topProcesses
} from '../src/js/core.js'

// ———— 格式化 ————

test('formatKb / formatPct', () => {
  assert.equal(formatKb(512), '512 KB')
  assert.equal(formatKb(2048), '2.0 MB')
  assert.equal(formatKb(3 * 1024 * 1024), '3.00 GB')
  assert.equal(formatPct(12.34), '12.3%')
  assert.equal(formatPct(undefined), '0.0%')
})

// ———— 系统进程判定 ————

test('isSystemProc：root 与 _ 数字 uid', () => {
  assert.equal(isSystemProc('root'), true)
  assert.equal(isSystemProc('_windowserver'), true)
  assert.equal(isSystemProc('_26'), true)
  assert.equal(isSystemProc('_500'), false)
  assert.equal(isSystemProc('haijun'), false)
  assert.equal(isSystemProc(''), false)
})

// ———— 进程搜索 ————

const procs = [
  { pid: 1, pcpu: 0.1, pmem: 0.0, rss: 1024, user: 'root', command: '/sbin/launchd' },
  { pid: 2345, pcpu: 88.2, pmem: 3.1, rss: 512000, user: 'haijun', command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  { pid: 8080, pcpu: 1.0, pmem: 0.5, rss: 64000, user: 'haijun', command: 'node /srv/echo-server.mjs' }
]

test('searchProc：名称子串 / pid 匹配 / 空 query 直通', () => {
  assert.equal(searchProc(procs, 'chrom').length, 1)
  assert.equal(searchProc(procs, '2345')[0].pid, 2345)
  assert.equal(searchProc(procs, '').length, 3)
  assert.equal(searchProc(procs, '不存在的').length, 0)
})

// ———— 端口搜索 / 联动 ————

const ports = [
  { command: 'node', pid: 8080, user: 'haijun', protocol: 'TCP', address: '127.0.0.1', port: 7000, name: '127.0.0.1:7000' },
  { command: 'rapportd', pid: 512, user: '_rapportd', protocol: 'TCP', address: '0.0.0.0', port: 59345, name: '*:59345' }
]

test('searchPort：端口 / pid / 名称', () => {
  assert.equal(searchPort(ports, '7000').length, 1)
  assert.equal(searchPort(ports, '8080')[0].pid, 8080)
  assert.equal(searchPort(ports, 'node').length, 1)
  assert.equal(searchPort(ports, '99999').length, 0)
})

test('linkPortsToProc：pid → 端口数组映射', () => {
  const map = linkPortsToProc(ports)
  assert.equal(map.get(8080).length, 1)
  assert.equal(map.get(8080)[0].port, 7000)
  assert.equal(map.get(404), undefined)
})

// ———— SampleRing ————

test('SampleRing：容量截断（60s / 1.5s ≈ 40 点 < 64 容量）', () => {
  const r = new SampleRing(64)
  for (let i = 0; i < 70; i++) r.push(i)
  assert.equal(r.length, 64)
  assert.equal(r.items[0], 6)
  assert.equal(r.items.at(-1), 69)
  r.clear()
  assert.equal(r.length, 0)
})

// ———— shortName ————

test('shortName：路径末段', () => {
  assert.equal(shortName('/Applications/Chromium.app/Contents/MacOS/Chromium'), 'Chromium')
  assert.equal(shortName('node /srv/echo.mjs'), 'echo.mjs')
  assert.equal(shortName(''), '(unknown)')
})

// ———— 宿主解析样本（与 src/main/sys/sysInspectService 同构样本）———

/**
 * 复刻宿主 parsePsOutput（sysInspectService.ts 公开算法），验证插件消费的数据形状：
 * `ps -axo pid,pcpu,pmem,rss,user,comm`
 */
function parsePsOutput(stdout) {
  const out = []
  for (const line of stdout.split('\n').slice(1)) {
    if (!line.trim()) continue
    const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    out.push({ pid, pcpu: Number(m[2]) || 0, pmem: Number(m[3]) || 0, rss: Number(m[4]) || 0, user: m[5], command: m[6].trim() })
  }
  return out
}

test('ps 样本解析：darwin comm 与 Linux args 形态', () => {
  const darwin = `  PID  %CPU  %MEM     RSS  USER      COMMAND
      1   0.0   0.1   10240  root      /sbin/launchd
    421   7.2   1.4  246800  haijun    /Applications/eNest.app/Contents/MacOS/eNest
   4299  12.5   0.8  131072  haijun    node

`
  const rows = parsePsOutput(darwin)
  assert.equal(rows.length, 3)
  assert.equal(rows[1].command, '/Applications/eNest.app/Contents/MacOS/eNest')
  assert.equal(rows[2].pcpu, 12.5)
})

/**
 * 复刻宿主 parseLsofOutput：`lsof -nP -iTCP -sTCP:LISTEN`
 * 列：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
 */
function parseLsofOutput(stdout) {
  const out = []
  const seen = new Set()
  for (const line of stdout.split('\n').slice(1)) {
    if (!line.trim()) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const nameCol = cols[8]
    const nameMatch = /^(.+):(\d+)$/.exec(nameCol)
    if (!nameMatch) continue
    const pid = Number(cols[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    const key = `${pid}/${nameCol}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      command: cols[0], pid, user: cols[2], protocol: 'TCP',
      address: nameMatch[1] === '*' ? '0.0.0.0' : nameMatch[1].replace(/^\[|\]$/g, ''),
      port: Number(nameMatch[2]), name: nameCol
    })
  }
  return out
}

test('lsof 样本解析：IPv4 / IPv6 / 通配地址去重', () => {
  const sample = `COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node     8080 haijun   23u  IPv4  0x1a2b3c4d5e6f      0t0  TCP 127.0.0.1:7000 (LISTEN)
node     8080 haijun   23u  IPv4  0x1a2b3c4d5e6f      0t0  TCP 127.0.0.1:7000 (LISTEN)
rapportd  512 _rapportd 8u  IPv6  0x2b3c4d5e6f7a      0t0  TCP *:59345 (LISTEN)
WindowSer 376 _windowserver 6u IPv4 0x3c4d5e6f7a8b      0t0  TCP [::1]:49155 (LISTEN)
`
  const rows = parseLsofOutput(sample)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { command: 'node', pid: 8080, user: 'haijun', protocol: 'TCP', address: '127.0.0.1', port: 7000, name: '127.0.0.1:7000' })
  assert.equal(rows[1].address, '0.0.0.0')
  assert.equal(rows[2].address, '::1')
  // 端口直达：7000 → node #8080（Quick 场景核心链路）
  const hit = searchPort(rows, '7000')
  assert.equal(hit[0].pid, 8080)
})

// ———— 阈值分级（v1.1 仪表盘告警）———

test('thresholdLevel：ok / warn / danger 与非法值', () => {
  assert.equal(thresholdLevel(10), 'ok')
  assert.equal(thresholdLevel(70), 'warn')
  assert.equal(thresholdLevel(85, 70, 90), 'warn')
  assert.equal(thresholdLevel(90, 70, 90), 'danger')
  assert.equal(thresholdLevel(99.5), 'danger')
  assert.equal(thresholdLevel(NaN), 'ok')
  assert.equal(thresholdLevel(undefined), 'ok')
  // 自定义阈值
  assert.equal(thresholdLevel(50, 40, 60), 'warn')
  assert.equal(thresholdLevel(60, 40, 60), 'danger')
})

// ———— summarize（仪表盘指标派生）———

test('summarize：总 CPU / 总内存 / pmem / Top 引用 / 端口去重', () => {
  const procs = [
    { pid: 1, pcpu: 10, pmem: 1, rss: 1024 * 1024, user: 'root', command: '/usr/sbin/kerneltask' },
    { pid: 2, pcpu: 45.5, pmem: 6.5, rss: 2 * 1024 * 1024, user: 'haijun', command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { pid: 3, pcpu: 0, pmem: 0.2, rss: 64000, user: 'haijun', command: 'node server.mjs' }
  ]
  const ports = [
    { pid: 3, port: 7000 }, { pid: 3, port: 7001 }, { pid: 99, port: 9000 }
  ]
  const s = summarize(procs, ports)
  assert.equal(s.procCount, 3)
  assert.equal(s.totalCpu, 55.5)
  assert.equal(s.totalMemKb, 1024 * 1024 + 2 * 1024 * 1024 + 64000)
  assert.ok(Math.abs(s.memPct - 7.7) < 0.001)
  assert.equal(s.cpuTop.pid, 2)
  assert.equal(s.memTop.pid, 2)
  assert.equal(s.portCount, 3)
  assert.equal(s.listenCount, 2)
})

test('summarize：空输入与异常裁剪', () => {
  const s = summarize([], [])
  assert.equal(s.procCount, 0)
  assert.equal(s.totalCpu, 0)
  assert.equal(s.memTop, null)
  // pcpu 总和超 100 时 clamp（防御异常样本）
  const s2 = summarize([{ pid: 1, pcpu: 80, rss: 1, pmem: 1 }, { pid: 2, pcpu: 80, rss: 1, pmem: 1 }], [])
  assert.equal(s2.totalCpu, 100)
})

// ———— topProcesses ————

test('topProcesses：降序截取与短名', () => {
  const procs = [
    { pid: 1, pcpu: 2, rss: 100, command: '/usr/lib/systemd/a' },
    { pid: 2, pcpu: 50, rss: 500000, command: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    { pid: 3, pcpu: 12, rss: 300000, command: 'node server.mjs' }
  ]
  const cpu = topProcesses(procs, 'pcpu', 2)
  assert.deepEqual(cpu.map((p) => p.pid), [2, 3])
  assert.equal(cpu[0].name, 'Chromium')
  assert.equal(cpu[0].value, 50)
  const mem = topProcesses(procs, 'rss', 5)
  assert.equal(mem[0].pid, 2)
  assert.equal(mem.length, 3)
  assert.deepEqual(topProcesses([], 'pcpu', 5), [])
})

// ———— SampleRing.setCapacity（刷新频率切换保留样本）———

test('SampleRing.setCapacity：缩容保留末尾、扩容不变', () => {
  const r = new SampleRing(64)
  for (let i = 0; i < 40; i++) r.push(i)
  r.setCapacity(20)
  assert.equal(r.length, 20)
  assert.equal(r.items[0], 20)
  assert.equal(r.items.at(-1), 39)
  r.setCapacity(64)
  r.push(40)
  assert.equal(r.length, 21)
  assert.equal(r.items.at(-1), 40)
})
