/**
 * com.github.eNest.ssh — 静态命令词典 + 危险规则 + 默认片段
 * 对齐 Spec SSH-E2 / E4 / D5
 */
;(function (global) {
  const CATEGORY_LABEL = {
    system: '系统',
    network: '网络',
    service: '服务',
    text: '文本',
    container: '容器',
    vcs: '版本',
    data: '数据',
    archive: '压缩',
  }

  /** P0 静态词典 */
  const DICT = [
    { cmd: 'ls', desc: '列出目录内容', category: 'system', flags: [
      { name: '-l', desc: '长格式' }, { name: '-a', desc: '显示隐藏文件' }, { name: '-h', desc: '人类可读大小' },
    ] },
    { cmd: 'cd', desc: '切换目录', category: 'system', flags: [] },
    { cmd: 'pwd', desc: '打印当前目录', category: 'system', flags: [] },
    { cmd: 'mkdir', desc: '创建目录', category: 'system', flags: [
      { name: '-p', desc: '递归创建' },
    ] },
    { cmd: 'rm', desc: '删除文件/目录', category: 'system', flags: [
      { name: '-r', desc: '递归' }, { name: '-f', desc: '强制' }, { name: '-rf', desc: '递归强制（危险）' },
    ] },
    { cmd: 'cp', desc: '复制', category: 'system', flags: [{ name: '-r', desc: '递归' }] },
    { cmd: 'mv', desc: '移动/重命名', category: 'system', flags: [] },
    { cmd: 'chmod', desc: '修改权限', category: 'system', flags: [{ name: '-R', desc: '递归' }] },
    { cmd: 'chown', desc: '修改属主', category: 'system', flags: [{ name: '-R', desc: '递归' }] },
    { cmd: 'ps', desc: '进程列表', category: 'system', flags: [{ name: 'aux', desc: 'BSD 风格全量' }, { name: '-ef', desc: 'System V 全量' }] },
    { cmd: 'top', desc: '实时进程', category: 'system', flags: [] },
    { cmd: 'free', desc: '内存使用', category: 'system', flags: [{ name: '-h', desc: '人类可读' }] },
    { cmd: 'df', desc: '磁盘使用', category: 'system', flags: [{ name: '-h', desc: '人类可读' }] },
    { cmd: 'du', desc: '目录占用', category: 'system', flags: [{ name: '-sh', desc: '汇总' }] },
    { cmd: 'uname', desc: '系统信息', category: 'system', flags: [{ name: '-a', desc: '全部' }] },
    { cmd: 'uptime', desc: '负载与运行时长', category: 'system', flags: [] },
    { cmd: 'kill', desc: '结束进程', category: 'system', flags: [{ name: '-9', desc: '强制杀死' }] },
    { cmd: 'nice', desc: '调整优先级启动', category: 'system', flags: [] },

    { cmd: 'ss', desc: '套接字统计', category: 'network', flags: [{ name: '-lntp', desc: '监听 TCP 进程' }] },
    { cmd: 'netstat', desc: '网络连接', category: 'network', flags: [{ name: '-lntp', desc: '监听 TCP' }] },
    { cmd: 'ping', desc: 'ICMP 探测', category: 'network', flags: [{ name: '-c', desc: '次数' }] },
    { cmd: 'curl', desc: 'HTTP 客户端', category: 'network', flags: [
      { name: '-I', desc: '仅头' }, { name: '-s', desc: '静默' }, { name: '-X', desc: '方法' },
    ] },
    { cmd: 'wget', desc: '下载文件', category: 'network', flags: [{ name: '-O', desc: '输出路径' }] },
    { cmd: 'iptables', desc: '防火墙规则', category: 'network', flags: [{ name: '-L', desc: '列出' }] },
    { cmd: 'scp', desc: '远程拷贝', category: 'network', flags: [{ name: '-r', desc: '递归' }, { name: '-P', desc: '端口' }] },
    { cmd: 'rsync', desc: '增量同步', category: 'network', flags: [{ name: '-avz', desc: '归档压缩详细' }] },

    { cmd: 'systemctl', desc: 'systemd 服务', category: 'service', flags: [
      { name: 'status', desc: '状态' }, { name: 'restart', desc: '重启' }, { name: 'stop', desc: '停止' }, { name: 'start', desc: '启动' },
    ] },
    { cmd: 'journalctl', desc: '服务日志', category: 'service', flags: [
      { name: '-u', desc: '按单元' }, { name: '-f', desc: '跟随' }, { name: '-n', desc: '行数' },
    ] },
    { cmd: 'service', desc: 'SysV 服务', category: 'service', flags: [] },

    { cmd: 'grep', desc: '文本搜索', category: 'text', flags: [
      { name: '-r', desc: '递归' }, { name: '-n', desc: '行号' }, { name: '-i', desc: '忽略大小写' }, { name: '-E', desc: '扩展正则' },
    ] },
    { cmd: 'sed', desc: '流编辑器', category: 'text', flags: [{ name: '-n', desc: '静默' }, { name: '-i', desc: '就地' }] },
    { cmd: 'awk', desc: '列处理', category: 'text', flags: [] },
    { cmd: 'tail', desc: '文件尾部', category: 'text', flags: [{ name: '-f', desc: '跟随' }, { name: '-n', desc: '行数' }] },
    { cmd: 'head', desc: '文件头部', category: 'text', flags: [{ name: '-n', desc: '行数' }] },
    { cmd: 'less', desc: '分页查看', category: 'text', flags: [] },
    { cmd: 'cat', desc: '拼接输出', category: 'text', flags: [] },
    { cmd: 'echo', desc: '输出字符串', category: 'text', flags: [] },
    { cmd: 'xargs', desc: '参数拼接执行', category: 'text', flags: [{ name: '-n', desc: '每次参数个数' }] },
    { cmd: 'find', desc: '查找文件', category: 'text', flags: [
      { name: '-name', desc: '文件名' }, { name: '-type', desc: '类型' }, { name: '-mtime', desc: '修改天数' },
    ] },

    { cmd: 'docker', desc: '容器引擎', category: 'container', flags: [
      { name: 'ps', desc: '容器列表' }, { name: 'logs', desc: '日志' }, { name: 'exec', desc: '进入容器' },
    ] },
    { cmd: 'docker-compose', desc: '编排', category: 'container', flags: [
      { name: 'up', desc: '启动' }, { name: 'down', desc: '停止删除' }, { name: 'ps', desc: '状态' },
    ] },
    { cmd: 'kubectl', desc: 'Kubernetes', category: 'container', flags: [
      { name: 'get', desc: '获取资源' }, { name: 'describe', desc: '详情' }, { name: 'logs', desc: 'Pod 日志' },
    ] },
    { cmd: 'helm', desc: 'K8s 包管理', category: 'container', flags: [{ name: 'list', desc: '发布列表' }] },

    { cmd: 'git', desc: '版本控制', category: 'vcs', flags: [
      { name: 'status', desc: '状态' }, { name: 'pull', desc: '拉取' }, { name: 'log', desc: '日志' },
    ] },

    { cmd: 'redis-cli', desc: 'Redis 客户端', category: 'data', flags: [] },
    { cmd: 'mysql', desc: 'MySQL 客户端', category: 'data', flags: [{ name: '-u', desc: '用户' }, { name: '-p', desc: '密码' }] },
    { cmd: 'nginx', desc: 'Nginx', category: 'data', flags: [{ name: '-t', desc: '配置检查' }, { name: '-s', desc: '信号 reload/stop' }] },

    { cmd: 'tar', desc: '归档', category: 'archive', flags: [
      { name: '-czf', desc: 'gzip 打包' }, { name: '-xzf', desc: 'gzip 解包' }, { name: '-tf', desc: '查看列表' },
    ] },
    { cmd: 'gzip', desc: 'gzip 压缩', category: 'archive', flags: [] },
    { cmd: 'gunzip', desc: 'gzip 解压', category: 'archive', flags: [] },
    { cmd: 'zip', desc: 'zip 打包', category: 'archive', flags: [{ name: '-r', desc: '递归' }] },
    { cmd: 'unzip', desc: 'zip 解压', category: 'archive', flags: [] },
  ]

  /** Context grammar is intentionally local: operands and remote paths remain the shell's responsibility. */
  const GRAMMAR = {
    ls: { usage: '[路径]', flags: [{ name: '-l', desc: '长格式，包含权限和大小' }, { name: '-a', desc: '显示隐藏文件' }, { name: '-h', desc: '以易读单位显示大小' }, { name: '-la', desc: '长格式并显示隐藏文件' }, { name: '-lah', desc: '长格式、隐藏文件和易读大小' }, { name: '--color=auto', desc: '按文件类型着色' }] },
    cd: { usage: '[目录]' },
    curl: { usage: '[URL]', flags: [{ name: '-I', desc: '仅请求响应头' }, { name: '-s', desc: '关闭进度输出' }, { name: '-L', desc: '跟随重定向' }, { name: '-v', desc: '显示请求与连接详情' }, { name: '-X', desc: 'HTTP 请求方法', value: '方法', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }, { name: '-H', desc: '添加请求头', value: '请求头' }, { name: '--connect-timeout', desc: '连接超时秒数', value: '秒' }, { name: '-o', desc: '保存到文件', value: '文件' }] },
    systemctl: { flags: [{ name: '--user', desc: '管理当前用户服务' }, { name: '--failed', desc: '只显示失败的单元' }, { name: '--no-pager', desc: '直接输出，不启动分页器' }], subcommands: [
      { name: 'status', desc: '查看服务状态', usage: '[服务]', flags: [{ name: '--no-pager', desc: '不启动分页器' }] }, { name: 'start', desc: '启动服务', usage: '[服务]' }, { name: 'stop', desc: '停止服务', usage: '[服务]' }, { name: 'restart', desc: '重启服务', usage: '[服务]' }, { name: 'reload', desc: '重新加载服务配置', usage: '[服务]' }, { name: 'enable', desc: '设置开机启动', usage: '[服务]' }, { name: 'list-units', desc: '列出服务单元' }, { name: 'daemon-reload', desc: '重新加载 systemd 单元配置' },
    ] },
    journalctl: { flags: [{ name: '-u', desc: '按服务单元过滤', value: '服务' }, { name: '-f', desc: '持续查看新日志' }, { name: '-n', desc: '显示最近的日志行', value: '行数' }, { name: '--since', desc: '从指定时间开始', value: '时间' }, { name: '-b', desc: '只显示本次启动日志' }, { name: '--no-pager', desc: '不启动分页器' }] },
    docker: { flags: [{ name: '--context', desc: '选择 Docker 上下文', value: '上下文' }], subcommands: [
      { name: 'ps', desc: '列出容器', flags: [{ name: '-a', desc: '包括停止的容器' }, { name: '--format', desc: '自定义输出格式', value: '格式' }, { name: '--filter', desc: '按条件筛选', value: '条件' }] },
      { name: 'logs', desc: '查看容器日志', usage: '[容器]', flags: [{ name: '-f', desc: '跟随新日志' }, { name: '--tail', desc: '显示末尾指定行数', value: '行数' }, { name: '--since', desc: '开始时间', value: '时间' }, { name: '-t', desc: '显示时间戳' }] },
      { name: 'exec', desc: '在运行中的容器执行命令', usage: '[容器] [命令]', flags: [{ name: '-it', desc: '交互终端' }, { name: '-u', desc: '使用指定用户', value: '用户' }, { name: '-w', desc: '设置工作目录', value: '目录' }] },
      { name: 'images', desc: '列出镜像' }, { name: 'inspect', desc: '查看容器或镜像详情', usage: '[对象]' }, { name: 'stats', desc: '查看容器资源用量' },
      { name: 'compose', desc: '管理 Compose 服务', subcommands: [{ name: 'up', desc: '创建并启动服务', flags: [{ name: '-d', desc: '后台运行' }, { name: '--build', desc: '启动前构建镜像' }] }, { name: 'down', desc: '停止并移除服务' }, { name: 'ps', desc: '查看服务状态' }, { name: 'logs', desc: '查看服务日志', flags: [{ name: '-f', desc: '跟随新日志' }] }] },
    ] },
    kubectl: { flags: [{ name: '-n', desc: '指定命名空间', value: '命名空间' }, { name: '--context', desc: '指定集群上下文', value: '上下文' }], subcommands: [
      { name: 'get', desc: '查看 Kubernetes 资源', subcommands: ['pods', 'services', 'deployments', 'nodes', 'namespaces', 'configmaps', 'ingresses'].map(name => ({ name, desc: '查看 ' + name, flags: [{ name: '-A', desc: '所有命名空间' }, { name: '-n', desc: '指定命名空间', value: '命名空间' }, { name: '-o', desc: '输出格式', value: '格式', values: ['wide', 'yaml', 'json', 'name'] }, { name: '-w', desc: '持续观察变更' }] })) },
      { name: 'describe', desc: '查看资源详情', usage: '[资源] [名称]' }, { name: 'logs', desc: '查看 Pod 日志', usage: '[Pod]', flags: [{ name: '-f', desc: '跟随日志' }, { name: '--tail', desc: '日志行数', value: '行数' }, { name: '-c', desc: '指定容器', value: '容器' }] }, { name: 'exec', desc: '在 Pod 中执行命令', usage: '[Pod] -- [命令]', flags: [{ name: '-it', desc: '交互终端' }] }, { name: 'config', desc: '查看本地集群配置', subcommands: [{ name: 'get-contexts', desc: '列出上下文' }, { name: 'current-context', desc: '当前上下文' }] },
    ] },
    git: { flags: [{ name: '-C', desc: '在指定目录执行', value: '目录' }], subcommands: [
      { name: 'status', desc: '查看工作区状态', flags: [{ name: '--short', desc: '简洁格式' }, { name: '--branch', desc: '显示分支' }] }, { name: 'log', desc: '查看提交记录', flags: [{ name: '--oneline', desc: '每条提交一行' }, { name: '--graph', desc: '显示分支关系' }, { name: '-n', desc: '限制提交数', value: '数量' }] }, { name: 'diff', desc: '查看修改', flags: [{ name: '--stat', desc: '修改统计' }, { name: '--staged', desc: '查看已暂存修改' }] }, { name: 'branch', desc: '查看分支', flags: [{ name: '-a', desc: '包括远程分支' }] }, { name: 'fetch', desc: '获取远程引用' }, { name: 'pull', desc: '拉取远程修改' }, { name: 'show', desc: '查看提交或对象' }, { name: 'stash', desc: '管理暂存工作区', subcommands: [{ name: 'list', desc: '列出暂存记录' }, { name: 'show', desc: '查看暂存修改' }] },
    ] },
    tail: { usage: '[文件]', flags: [{ name: '-f', desc: '跟随文件新增内容' }, { name: '-F', desc: '按名称跟随并自动重试' }, { name: '-n', desc: '显示末尾行数', value: '行数' }] },
  }
  for (const entry of DICT) if (GRAMMAR[entry.cmd]) Object.assign(entry, GRAMMAR[entry.cmd])

  /**
   * 危险规则（SSH-E4）。
   * match(cmd, profileEnv) → { level: 'danger'|'warn', reason: string } | null
   */
  const DANGER_RULES = [
    {
      id: 'rm-rf-root',
      re: /\brm\s+(-[a-zA-Z]*\s+)*(-\w*r\w*f|-\w*f\w*r)\b[^|;&]*\s(\/|\/\*|\.\s*$)/i,
      level: 'danger',
      reason: 'rm -rf 指向根目录或当前目录，可能导致数据全毁',
    },
    {
      id: 'rm-rf',
      re: /\brm\s+(-[a-zA-Z]*\s+)*(-\w*r\w*f|-\w*f\w*r)\b/i,
      level: 'danger',
      reason: 'rm -rf 递归强制删除',
    },
    {
      id: 'mkfs',
      re: /\bmkfs(\.\w+)?\b/i,
      level: 'danger',
      reason: 'mkfs 将格式化文件系统',
    },
    {
      id: 'dd-dev',
      re: /\bdd\b[^|;&]*\bof=\/dev\//i,
      level: 'danger',
      reason: 'dd 写入块设备',
    },
    {
      id: 'redirect-dev-sd',
      re: />\s*\/dev\/sd[a-z]/i,
      level: 'danger',
      reason: '重定向写入磁盘设备节点',
    },
    {
      id: 'kill-init',
      re: /\bkill\s+(-9\s+)?1\b/i,
      level: 'danger',
      reason: '对 PID 1 发送信号会导致主机重启/崩溃',
    },
    {
      id: 'shutdown',
      re: /\b(shutdown|reboot|poweroff|halt)\b/i,
      level: 'danger',
      reason: '关机/重启命令',
    },
    {
      id: 'drop-db',
      re: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i,
      level: 'danger',
      reason: 'DROP DATABASE/SCHEMA/TABLE',
    },
    {
      id: 'chmod-777-root',
      re: /\bchmod\s+(-R\s+)?777\s+(\/|\s*$)/i,
      level: 'danger',
      reason: 'chmod -R 777 / 过度放开权限',
    },
    {
      id: 'systemctl-stop-prod',
      re: /\bsystemctl\s+stop\b/i,
      level: 'warn',
      reason: 'systemctl stop 会停止服务',
      env: 'prod',
    },
  ]

  function matchDanger(command, profileEnv) {
    const cmd = String(command || '')
    if (!cmd.trim()) return null
    for (const rule of DANGER_RULES) {
      if (rule.env && rule.env !== 'prod' && profileEnv && profileEnv !== 'prod') {
        // env-scoped rules only on prod (or when env unknown on rule)
      }
      if (rule.env && profileEnv && profileEnv !== rule.env) continue
      if (rule.re.test(cmd)) {
        return { id: rule.id, level: rule.level, reason: rule.reason }
      }
    }
    return null
  }

  /** 常用运维片段（首次启动种子） */
  const DEFAULT_SNIPPETS = [
    { id: 'snip-disk', title: '磁盘占用', command: 'df -h', tags: ['运维'], sort: 0, pinned: true },
    { id: 'snip-mem', title: '内存概览', command: 'free -h', tags: ['运维'], sort: 1, pinned: true },
    { id: 'snip-listen', title: '监听端口', command: 'ss -lntp', tags: ['网络'], sort: 2, pinned: false },
    { id: 'snip-docker-ps', title: 'Docker 容器', command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', tags: ['容器'], sort: 3, pinned: false },
    { id: 'snip-journal', title: '服务日志（跟随）', command: 'journalctl -u <service> -f -n 200', tags: ['服务'], sort: 4, pinned: false },
    { id: 'snip-top-mem', title: '内存 Top 进程', command: 'ps aux --sort=-%mem | head -n 11', tags: ['运维'], sort: 5, pinned: false },
  ]

  /**
   * 本地合并补全（SSH-E1 本地源）
   * sources: { prefix, history[], snippets[], userDict[] }
   */
  function localSuggest(prefix, sources = {}) {
    return global.SshCommandCompletion?.suggest(String(prefix || ''), { ...sources, dictionary: DICT }) || []
  }

  global.SshDict = {
    DICT,
    DANGER_RULES,
    DEFAULT_SNIPPETS,
    CATEGORY_LABEL,
    matchDanger,
    localSuggest,
  }
})(window)
