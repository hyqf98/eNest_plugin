import { sshExec, requireOwnedSshSession } from './sshSessionManager'
import type { SshPortInfo, SshProcessInfo, SshRemotePlatform, SshSystemSnapshot } from './contracts'

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
export const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`
export const powershell = (script: string): string => `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$ErrorActionPreference='Stop';${script}`, 'utf16le').toString('base64')}`
const platforms = new Map<string, Promise<SshRemotePlatform>>()
export type SystemCounters = { ts: number; cpu?: number[]; net: Map<string, [number, number]>; sectorsRead?: number; sectorsWritten?: number; cores?: number[][] }
const counters = new Map<string, SystemCounters>()

/** Runs one command on a connection and returns its stdout; rejects when the command fails. */
export type RemoteRunner = (command: string, timeoutMs?: number) => Promise<string>
const terminalRunner = (pluginId: string, sessionId: string): RemoteRunner => (command, timeoutMs) => runRemote(pluginId, sessionId, command, timeoutMs)

export async function runRemote(pluginId: string, sessionId: string, command: string, timeoutMs = 12000): Promise<string> {
  const result = await sshExec(pluginId, { sessionId, command, timeoutMs })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `远程命令失败 (${result.exitCode})`)
  return result.stdout
}

export function remotePlatform(pluginId: string, sessionId: string): Promise<SshRemotePlatform> {
  requireOwnedSshSession(pluginId, sessionId)
  return detectPlatform(sessionId, terminalRunner(pluginId, sessionId))
}

/** Platform detection is cached per counter key; a failed probe is dropped so the next sample retries. */
function detectPlatform(key: string, run: RemoteRunner): Promise<SshRemotePlatform> {
  if (!platforms.has(key)) platforms.set(key, (async () => {
    try {
      const value = (await run('uname -s', 5000)).trim()
      if (value === 'Linux') return 'linux'
      if (value === 'Darwin') return 'darwin'
    } catch { /* OpenSSH on Windows usually uses cmd or PowerShell. */ }
    const value = await run(powershell('[Environment]::OSVersion.Platform.ToString()'), 8000)
    if (value.includes('Win32NT')) return 'win32'
    throw new Error('当前服务器系统暂不支持资源采集；终端和 SFTP 仍可使用')
  })().catch(error => { platforms.delete(key); throw error }))
  return platforms.get(key)!
}

export function releaseSystemState(sessionId: string): void { platforms.delete(sessionId); counters.delete(sessionId) }

const LINUX = `printf '\\n---CPU---\\n'; head -n 1 /proc/stat
printf '\\n---MEM---\\n'; cat /proc/meminfo
printf '\\n---LOAD---\\n'; cat /proc/loadavg
printf '\\n---UPTIME---\\n'; cat /proc/uptime
printf '\\n---DISK---\\n'; df -Pk
printf '\\n---NET---\\n'; cat /proc/net/dev
printf '\\n---EXTRA---\\n'
printf 'model=%s\\n' "$(LC_ALL=C grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
printf 'cores=%s\\n' "$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
printf 'swapTotal=%s\\n' "$(awk '/^SwapTotal/{print $2}' /proc/meminfo 2>/dev/null)"
printf 'swapFree=%s\\n' "$(awk '/^SwapFree/{print $2}' /proc/meminfo 2>/dev/null)"
printf 'load5=%s\\n' "$(cut -d' ' -f2 /proc/loadavg 2>/dev/null)"
printf 'load15=%s\\n' "$(cut -d' ' -f3 /proc/loadavg 2>/dev/null)"
printf 'procs=%s\\n' "$(cut -d' ' -f4 /proc/loadavg 2>/dev/null)"
printf 'temp=%s\\n' "$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)"
for z in /sys/class/hwmon/hwmon*/name; do
  [ -f "$z" ] || continue
  case "$(cat "$z" 2>/dev/null)" in coretemp|k10temp|cpu_thermal|soc_thermal|acpitz) ;; *) continue ;; esac
  d=$(dirname "$z")
  for f in "$d"/temp1_input "$d"/temp2_input; do [ -f "$f" ] && { printf 'temp=%s\\n' "$(cat "$f" 2>/dev/null)"; break; } ; done
  [ -f "$d/temp1_input" ] || [ -f "$d/temp2_input" ] && break
done
printf '\\n---DISKSTATS---\\n'; cat /proc/diskstats 2>/dev/null
printf '\\n---CORES---\\n'; grep '^cpu[0-9]' /proc/stat 2>/dev/null
printf '\\n---GPU---\\n'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>&1 | head -n 16
else
  printf 'no-tool\\n'
fi`
const MAC = `printf '\\n---CPU---\\n'; top -l 1 -n 0 | head -n 12
printf '\\n---MEM---\\n'; sysctl -n hw.memsize; vm_stat
printf '\\n---LOAD---\\n'; sysctl -n vm.loadavg
printf '\\n---UPTIME---\\n'; sysctl -n kern.boottime; date +%s
printf '\\n---DISK---\\n'; df -Pk
printf '\\n---NET---\\n'; netstat -ibn
printf '\\n---EXTRA---\\n'
printf 'model=%s\\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
printf 'cores=%s\\n' "$(sysctl -n hw.ncpu 2>/dev/null)"
printf 'swapTotal=%s\\n' "$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*total = \\([0-9.]*\\)M.*/\\1/p')"
printf 'swapUsed=%s\\n' "$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*used = \\([0-9.]*\\)M.*/\\1/p')"
printf 'load5=%s\\n' "$(sysctl -n vm.loadavg 2>/dev/null | cut -d' ' -f3)"
printf 'load15=%s\\n' "$(sysctl -n vm.loadavg 2>/dev/null | cut -d' ' -f4)"
printf 'procs=%s\\n' "$(ps -A 2>/dev/null | wc -l | tr -d ' ')"
printf '\\n---GPU---\\n'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>&1 | head -n 16
else
  printf 'no-tool\\n'
fi`
export function parseUnixSnapshot(raw: string, platform: 'linux' | 'darwin', previous?: { ts: number; cpu?: number[]; net: Map<string, [number, number]>; sectorsRead?: number; sectorsWritten?: number; cores?: number[][] }, now = Date.now()): { snapshot: SshSystemSnapshot; counters: { ts: number; cpu?: number[]; net: Map<string, [number, number]>; sectorsRead?: number; sectorsWritten?: number; cores?: number[][] } } {
  const parts = raw.split(/^---(\w+)---\s*$/m)
  const sections = new Map<string, string>()
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i], parts[i + 1]?.trim() ?? '')
  const get = (name: string): string => sections.get(name) ?? ''
  const snapshot: SshSystemSnapshot = { platform, ts: now, disks: [], net: [], gpus: [] }
  let cpu: number[] | undefined, cores: number[][] | undefined, sectorsRead: number | undefined, sectorsWritten: number | undefined
  if (platform === 'linux') {
    cpu = get('CPU').split(/\s+/).slice(1).map(Number)
    if (previous?.cpu && cpu.length >= 4) {
      const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0) - previous.cpu.slice(0, 8).reduce((a, b) => a + b, 0)
      const idle = (cpu[3] + (cpu[4] || 0)) - (previous.cpu[3] + (previous.cpu[4] || 0))
      if (total > 0) snapshot.cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100))
    }
    snapshot.memTotal = Number(/MemTotal:\s+(\d+)/.exec(get('MEM'))?.[1]) * 1024
    const available = /MemAvailable:\s+(\d+)/.exec(get('MEM'))?.[1]
    const free = available ? Number(available) : ['MemFree', 'Buffers', 'Cached'].reduce((sum, key) => sum + Number(new RegExp(`${key}:\\s+(\\d+)`).exec(get('MEM'))?.[1] || 0), 0)
    snapshot.memUsed = snapshot.memTotal - free * 1024
    snapshot.load1 = Number(get('LOAD').split(/\s+/)[0])
    snapshot.uptimeSec = Number(get('UPTIME').split(/\s+/)[0])
    cores = get('CORES').split('\n').flatMap(line => {
      const values = line.trim().split(/\s+/).slice(1).map(Number)
      return values.length >= 4 ? [values] : []
    })
    if (previous?.cores && cores.length && cores.length === previous.cores.length) {
      snapshot.cpuCoresUsage = cores.map((values, index) => {
        const old = previous.cores![index]
        const total = values.slice(0, 8).reduce((a, b) => a + b, 0) - old.slice(0, 8).reduce((a, b) => a + b, 0)
        const idle = (values[3] + (values[4] || 0)) - (old[3] + (old[4] || 0))
        return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0
      })
    }
    const stats = get('DISKSTATS').split('\n').map(line => line.trim().split(/\s+/))
      .filter(fields => /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|mmcblk[0-9]+|dm-[0-9]+)$/.test(fields[2] || '') && fields.length >= 10)
    const sumSectors = (at: number): number => stats.reduce((total, fields) => total + (Number(fields[at]) || 0), 0)
    sectorsRead = sumSectors(5); sectorsWritten = sumSectors(9)
    if (previous && Number.isFinite(previous.sectorsRead) && previous.sectorsRead != null && sectorsRead != null) {
      const seconds = (now - previous.ts) / 1000
      // Kernel counters are in 512-byte sectors.
      if (seconds > 0) {
        snapshot.diskReadMbps = Math.max(0, (sectorsRead - previous.sectorsRead) * 512 / seconds / 1e6)
        snapshot.diskWriteMbps = Math.max(0, (sectorsWritten! - previous.sectorsWritten!) * 512 / seconds / 1e6)
      }
    }
  } else {
    const user = /([\d.]+)%\s*user/.exec(get('CPU'))?.[1]
    const sys = /([\d.]+)%\s*sys/.exec(get('CPU'))?.[1]
    if (user !== undefined && sys !== undefined) snapshot.cpuPercent = Number(user) + Number(sys)
    snapshot.memTotal = Number(get('MEM').split('\n')[0])
    const pageSize = Number(/page size of (\d+) bytes/.exec(get('MEM'))?.[1] || 4096)
    const free = Number(/Pages free:\s+(\d+)/.exec(get('MEM'))?.[1] || 0)
    const inactive = Number(/Pages inactive:\s+(\d+)/.exec(get('MEM'))?.[1] || 0)
    snapshot.memUsed = Math.max(0, snapshot.memTotal - (free + inactive) * pageSize)
    snapshot.load1 = Number(/[\d.]+/.exec(get('LOAD'))?.[0])
    const boot = Number(/sec\s*=\s*(\d+)/.exec(get('UPTIME'))?.[1])
    const remoteNow = Number(get('UPTIME').split('\n').pop())
    if (boot && remoteNow) snapshot.uptimeSec = remoteNow - boot
  }
  applyExtras(snapshot, get('EXTRA'), platform)
  if (snapshot.memTotal) snapshot.memPercent = (snapshot.memUsed || 0) / snapshot.memTotal * 100
  for (const line of get('DISK').split('\n').slice(1)) {
    const c = line.trim().split(/\s+/)
    const percentIndex = c.findIndex((x, i) => i >= 4 && /^\d+%$/.test(x))
    if (percentIndex < 0) continue
    snapshot.disks.push({ mount: c[c.length - 1], total: Number(c[1]) * 1024, used: Number(c[2]) * 1024, usedPercent: Number(c[percentIndex].slice(0, -1)) })
  }
  const net = new Map<string, [number, number]>()
  if (platform === 'linux') {
    for (const line of get('NET').split('\n')) {
      const m = /^\s*([^:]+):\s*(.*)/.exec(line)
      if (!m) continue
      const c = m[2].split(/\s+/).map(Number)
      if (c.length >= 9) net.set(m[1].trim(), [c[0], c[8]])
    }
  } else {
    const lines = get('NET').split('\n')
    const header = lines[0]?.trim().split(/\s+/) || []
    const input = header.indexOf('Ibytes'), output = header.indexOf('Obytes')
    if (input >= 0 && output >= 0) for (const line of lines.slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c[2]?.startsWith('<Link#')) net.set(c[0], [Number(c[input]), Number(c[output])])
    }
  }
  const seconds = previous ? (now - previous.ts) / 1000 : 0
  for (const [iface, value] of net) {
    const old = previous?.net.get(iface)
    if (old && seconds > 0) snapshot.net.push({ iface, rxKbps: Math.max(0, value[0] - old[0]) / seconds / 1024, txKbps: Math.max(0, value[1] - old[1]) / seconds / 1024 })
  }
  parseGpus(snapshot, get('GPU'))
  return { snapshot, counters: { ts: now, cpu, net, sectorsRead, sectorsWritten, cores } }
}

type SnapshotCounters = { ts: number; cpu?: number[]; net: Map<string, [number, number]>; sectorsRead?: number; sectorsWritten?: number; cores?: number[][] }
/** Reads the `key=value` EXTRA block. Every line is optional: missing tools or restricted shells leave fields unset. */
export function applyExtras(snapshot: SshSystemSnapshot, block: string, platform: 'linux' | 'darwin'): void {
  const values = new Map<string, string>()
  for (const line of block.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0 && !values.has(line.slice(0, at))) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const number = (key: string): number | undefined => { const n = Number(values.get(key)); return values.has(key) && n >= 0 ? n : undefined }
  if (values.get('model')) snapshot.cpuModel = values.get('model')!.slice(0, 96)
  snapshot.cpuCores = number('cores')
  snapshot.load5 = number('load5'); snapshot.load15 = number('load15'); snapshot.processCount = number('procs')
  // Linux reports milli-degrees, macOS would report whole degrees; nothing else reaches here today.
  const temp = number('temp')
  if (temp != null && temp > 0) snapshot.tempC = temp > 1000 ? temp / 1000 : temp
  const swapTotal = number('swapTotal'), swapFree = number('swapFree'), swapUsed = number('swapUsed')
  if (swapTotal != null && swapTotal > 0) {
    const scale = platform === 'darwin' ? 1048576 : 1024
    snapshot.swapTotal = swapTotal * scale
    const used = swapUsed ?? (swapFree != null ? swapTotal - swapFree : undefined)
    if (used != null) snapshot.swapUsed = Math.max(0, used * scale)
  }
}
/** CSV rows from `nvidia-smi --format=csv,noheader,nounits`; "no-tool" and error text both leave gpus empty. */
export function parseGpus(snapshot: SshSystemSnapshot, block: string): void {
  const text = block.trim()
  if (!text || text === 'no-tool') return
  if (/NVIDIA-SMI|NVIDIA driver|not found/i.test(text) && !/^\d+,\s/m.test(text)) { snapshot.gpuError = text.split('\n')[0].slice(0, 160); return }
  for (const line of text.split('\n')) {
    const c = line.split(',').map(field => field.trim())
    if (c.length < 2 || !/^\d+$/.test(c[0])) continue
    const used = Number(c[3]), total = Number(c[4])
    snapshot.gpus.push({
      index: Number(c[0]), name: c[1].slice(0, 96),
      utilPercent: c[2] && Number.isFinite(Number(c[2])) ? Number(c[2]) : undefined,
      vramUsed: Number.isFinite(used) ? used * 1048576 : undefined,
      vramTotal: Number.isFinite(total) && total > 0 ? total * 1048576 : undefined,
      tempC: Number.isFinite(Number(c[5])) && c[5] ? Number(c[5]) : undefined,
      powerW: Number.isFinite(Number(c[6])) && c[6] ? Number(c[6]) : undefined,
    })
  }
  for (const gpu of snapshot.gpus) if (gpu.vramUsed != null && gpu.vramTotal) gpu.memPercent = gpu.vramUsed / gpu.vramTotal * 100
}

function parseJson<T>(raw: string): T { return JSON.parse(raw.replace(/^\uFEFF/, '').trim()) as T }
function array<T>(value: T | T[] | null): T[] { return value == null ? [] : Array.isArray(value) ? value : [value] }
const WINDOWS_SNAPSHOT = `$os=Get-CimInstance Win32_OperatingSystem;$cpu=@(Get-CimInstance Win32_Processor);$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{mount=$_.DeviceID;total=[double]$_.Size;used=[double]($_.Size-$_.FreeSpace);usedPercent=if($_.Size){100*($_.Size-$_.FreeSpace)/$_.Size}else{0}} });$net=@(Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object {@{iface=$_.Name;rx=[double]$_.ReceivedBytes;tx=[double]$_.SentBytes}});$gpus=@(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {@{name=$_.Name}});@{cpuPercent=($cpu|Measure-Object LoadPercentage -Average).Average;cpuModel=($cpu|Select-Object -First 1).Name;cpuCores=($cpu|Measure-Object NumberOfLogicalProcessors -Sum).Sum;memTotal=[double]$os.TotalVisibleMemorySize*1024;memUsed=[double]($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)*1024;swapTotal=[double]($os.TotalVirtualMemorySize)*1024;swapUsed=[double]($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)*1024;uptimeSec=((Get-Date)-$os.LastBootUpTime).TotalSeconds;processCount=@(Get-Process).Count;disks=$disks;network=$net;videoControllers=$gpus}|ConvertTo-Json -Depth 5 -Compress`
type WindowsRaw = SshSystemSnapshot & { swapTotal?: number; swapUsed?: number; processCount?: number; videoControllers?: Array<{ name?: string }>; network: Array<{ iface: string; rx: number; tx: number }> }

export async function systemSnapshot(pluginId: string, sessionId: string): Promise<SshSystemSnapshot> {
  return snapshotWith(sessionId, terminalRunner(pluginId, sessionId))
}

/**
 * Samples one connection. Terminal sessions and background monitors share this path so the
 * overview list and the workbench strip can never disagree about how a metric is computed.
 */
export async function snapshotWith(key: string, run: RemoteRunner): Promise<SshSystemSnapshot> {
  const platform = await detectPlatform(key, run)
  if (platform !== 'win32') {
    const raw = await run(platform === 'linux' ? LINUX : MAC)
    const result = parseUnixSnapshot(raw, platform, counters.get(key))
    counters.set(key, result.counters)
    return result.snapshot
  }
  const data = parseJson<WindowsRaw>(await run(powershell(WINDOWS_SNAPSHOT)))
  const now = Date.now(), previous = counters.get(key), net = new Map<string, [number, number]>()
  data.net = []
  data.gpus = []
  // Win32_VideoController reports neither load nor real VRAM (the field is 32-bit capped), so only the name is shown.
  for (const [index, gpu] of (data.videoControllers || []).entries()) if (gpu?.name) data.gpus.push({ index, name: String(gpu.name).slice(0, 96) })
  delete data.videoControllers
  for (const n of data.network || []) {
    net.set(n.iface, [n.rx, n.tx])
    const old = previous?.net.get(n.iface)
    if (old && previous && now > previous.ts) data.net.push({ iface: n.iface, rxKbps: Math.max(0, n.rx - old[0]) / ((now - previous.ts) / 1000) / 1024, txKbps: Math.max(0, n.tx - old[1]) / ((now - previous.ts) / 1000) / 1024 })
  }
  counters.set(key, { ts: now, net })
  return { ...data, platform, ts: now, memPercent: data.memTotal ? (data.memUsed || 0) / data.memTotal * 100 : undefined }
}

export async function listProcesses(pluginId: string, sessionId: string): Promise<SshProcessInfo[]> {
  const platform = await remotePlatform(pluginId, sessionId)
  if (platform === 'win32') {
    return array(parseJson<SshProcessInfo | SshProcessInfo[] | null>(await runRemote(pluginId, sessionId, powershell(`@(Get-CimInstance Win32_Process | ForEach-Object {@{pid=[int]$_.ProcessId;name=$_.Name;memoryBytes=[double]$_.WorkingSetSize;startTime=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''}}})|ConvertTo-Json -Compress`))))
  }
  const raw = await runRemote(pluginId, sessionId, 'LC_ALL=C ps -axo pid=,user=,pcpu=,rss=,lstart=,comm=')
  return raw.split('\n').flatMap(line => {
    const c = line.trim().split(/\s+/)
    if (c.length < 10) return []
    return [{ pid: Number(c[0]), user: c[1], cpuPercent: Number(c[2]), memoryBytes: Number(c[3]) * 1024, startTime: c.slice(4, 9).join(' '), name: c.slice(9).join(' ') }]
  })
}

export async function signalProcess(pluginId: string, sessionId: string, pid: number, startTime: string, signal: 'TERM' | 'KILL'): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || !startTime) throw new Error('需要有效的 PID 与进程启动时间，请刷新进程列表')
  const platform = await remotePlatform(pluginId, sessionId)
  if (platform === 'win32') {
    await runRemote(pluginId, sessionId, powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if(!$p -or $p.CreationDate.ToUniversalTime().ToString('o') -ne ${psQuote(startTime)}){throw '进程已变化，请刷新列表'};Stop-Process -Id ${pid}${signal === 'KILL' ? ' -Force' : ''}`))
  } else {
    await runRemote(pluginId, sessionId, `actual=$(LC_ALL=C ps -p ${pid} -o lstart= | awk '{$1=$1;print}'); [ "$actual" = ${shellQuote(startTime)} ] || { echo '进程已变化，请刷新列表' >&2; exit 1; }; kill -${signal === 'KILL' ? 'KILL' : 'TERM'} ${pid}`)
  }
  return true
}

export async function listPorts(pluginId: string, sessionId: string): Promise<SshPortInfo[]> {
  const platform = await remotePlatform(pluginId, sessionId)
  if (platform === 'win32') return array(parseJson<SshPortInfo | SshPortInfo[] | null>(await runRemote(pluginId, sessionId, powershell(`$tcp=@(Get-NetTCPConnection -State Listen | ForEach-Object {@{protocol='tcp';address=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}});$udp=@(Get-NetUDPEndpoint | ForEach-Object {@{protocol='udp';address=$_.LocalAddress;port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}});@($tcp+$udp)|ConvertTo-Json -Compress`))))
  if (platform === 'linux') {
    const raw = await runRemote(pluginId, sessionId, 'ss -H -lntup')
    return raw.split('\n').flatMap(line => {
      const c = line.trim().split(/\s+/), endpoint = c[4] || '', at = endpoint.lastIndexOf(':')
      if (at < 0) return []
      return [{ protocol: c[0], address: endpoint.slice(0, at), port: Number(endpoint.slice(at + 1)), pid: Number(/pid=(\d+)/.exec(line)?.[1]) || undefined, process: /users:\(\("([^"]+)/.exec(line)?.[1] }]
    })
  }
  const raw = await runRemote(pluginId, sessionId, 'lsof -nP -iTCP -sTCP:LISTEN -iUDP || [ $? -eq 1 ]')
  return raw.split('\n').slice(1).flatMap(line => {
    const c = line.trim().split(/\s+/), protocolAt = c.findIndex(x => x === 'TCP' || x === 'UDP')
    if (protocolAt < 0) return []
    const address = c[protocolAt + 1] || '', at = address.lastIndexOf(':')
    return [{ protocol: c[protocolAt].toLowerCase(), address: address.slice(0, at), port: Number(address.slice(at + 1)), pid: Number(c[1]), process: c[0] }]
  })
}

export async function listServices(pluginId: string, sessionId: string): Promise<Array<{ name: string; state: string; description?: string }>> {
  const platform = await remotePlatform(pluginId, sessionId)
  if (platform === 'win32') return array(parseJson(await runRemote(pluginId, sessionId, powershell(`@(Get-Service|ForEach-Object {@{name=$_.Name;state=$_.Status.ToString();description=$_.DisplayName}})|ConvertTo-Json -Compress`))))
  if (platform === 'darwin') return (await runRemote(pluginId, sessionId, 'launchctl list')).split('\n').slice(1).filter(Boolean).map(line => { const c = line.trim().split(/\s+/); return { name: c[2], state: c[0] === '-' ? `stopped (${c[1]})` : `running (${c[0]})` } })
  return (await runRemote(pluginId, sessionId, 'systemctl list-units --type=service --all --no-pager --no-legend --plain')).split('\n').filter(Boolean).map(line => { const c = line.trim().split(/\s+/); return { name: c[0], state: `${c[2]} ${c[3]}`, description: c.slice(4).join(' ') } })
}

export async function serviceAction(pluginId: string, sessionId: string, name: string, operation: string): Promise<boolean> {
  if (!['start', 'stop', 'restart'].includes(operation) || !name || name.length > 256 || /[\r\n\0]/.test(name)) throw new Error('服务操作无效')
  const platform = await remotePlatform(pluginId, sessionId)
  let command: string
  if (platform === 'win32') command = powershell(`${({ start: 'Start', stop: 'Stop', restart: 'Restart' } as Record<string, string>)[operation]}-Service -Name ${psQuote(name)}`)
  else if (platform === 'darwin') {
    if (operation === 'restart') command = `launchctl kickstart -k "gui/$(id -u)/"${shellQuote(name)}`
    else command = `launchctl ${operation} ${shellQuote(name)}`
  } else command = `systemctl ${operation} -- ${shellQuote(name)}`
  await runRemote(pluginId, sessionId, command, 30000)
  return true
}

export async function dockerOperation(pluginId: string, sessionId: string, operation: string, id?: string): Promise<unknown> {
  const platform = await remotePlatform(pluginId, sessionId)
  const quote = platform === 'win32' ? psQuote : shellQuote
  const command = operation === 'list' ? `docker ps -a --no-trunc --format ${quote('{{json .}}')}` : (() => {
    if (!['start', 'stop', 'restart', 'logs', 'inspect'].includes(operation) || !id || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('容器操作无效')
    return `docker ${operation}${operation === 'logs' ? ' --tail 200' : ''} ${id}`
  })()
  const raw = await runRemote(pluginId, sessionId, platform === 'win32' ? powershell(command) : command, 45000)
  return operation === 'list' ? raw.split('\n').filter(Boolean).map(line => parseJson(line)) : raw
}
