# 开发环境管理

统一管理本机构建环境：Node / Python / UV / Conda / Java / Maven / Gradle / Go / Rust 自动探测、全局依赖管理、缓存清理、磁盘占用分析，并接管 Homebrew 与 winget / scoop / choco 包管理，macOS / Windows 双平台。

## 环境家族

| 家族 | 探测来源 | 依赖管理 | 清理 | 配置 | 迁移 |
|------|----------|----------|------|------|------|
| Node.js | PATH + nvm / fnm / volta 多版本 | npm 全局包 | npm cache verify | .npmrc / globalconfig | 缓存目录搬迁 + .npmrc |
| Python | python3/python + pyenv + `py -0p` | pip 全局包 | pip cache purge | pip.conf / pip.ini | — |
| uv | PATH | uv tool | uv cache clean | — | — |
| Conda | conda info + 目录探测 | conda list（base） | conda clean --all | .condarc | — |
| Java | java_home -V / JAVA_HOME / sdkman / where | — | — | — | 只读展示 JAVA_HOME |
| Maven | mvn -v + sdkman | —（本地仓库枚举过重） | *.lastUpdated 残留 | settings.xml | localRepository + 仓库搬迁 |
| Gradle | gradle -v + sdkman | — | modules-2 / 旧 dists | gradle.properties | 数据搬迁 + GRADLE_USER_HOME 手动提示 |
| Go | go version + go env | GOPATH/bin 工具 | go clean -modcache/-cache | go env 文件 | — |
| Rust | cargo / rustup 多 toolchain | cargo install --list | registry / 旧 toolchain | config.toml | — |

## 包管理器

- **macOS**：Homebrew（formula / cask 双轨、搜索安装、升级、`brew update`、cleanup / autoremove、Cellar 与缓存占用分析）
- **Windows**：winget（--exact --silent 协议）、Scoop（update / cleanup / cache rm、--purge 卸载）、Chocolatey（-r 机器可读输出），检测到哪个显示哪个

## 特性

- **多实例**：nvm / fnm / volta / pyenv / sdkman / rustup toolchain / conda 环境逐一列出，版本徽章 + 磁盘占用一目了然
- **磁盘占用**：目录占用并发限制 + 30s 缓存，mac 用 `du -sk` 秒级出结果；详情页分项列出缓存 / 仓库 / 工具链占用
- **长任务流式输出**：安装、升级、清理、迁移在底部任务条实时滚动输出，可随时取消（SIGTERM → SIGKILL）
- **清理分级**：safe / cautious 两级风险徽章，执行前可 dry-run 预览将要删除的内容
- **迁移**：生成方案预览（步骤 / 配置变更 / 数据量），复制 → 校验 → 清理旧目录分步执行；`GRADLE_USER_HOME` 等环境变量类变更明确标注「需手动」，不代改系统设置
- **自定义路径**：非常规位置的环境可手动登记（保存在插件私有存储），一并纳入探测

## 安全边界

- 所有命令经参数数组直传（不走 shell），名字类参数拒绝 shell 元字符
- 配置文件只读查看（前 4KB），路径仅限本插件清单内
- 不写系统环境变量、不改 shell 配置文件；迁移前目标目录必须为空，复制后按字节数校验才删除旧目录
