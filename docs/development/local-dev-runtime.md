# Local Development Runtime

本页记录 contribbot 在本地开发状态下的调试方式。

## 目标

开发 contribbot 时，需要同时使用：

- 当前仓库源码中的 MCP Server；
- 当前仓库源码中的 Skills；
- 当前本地用户目录下的 contribbot 项目数据。

不要把已经发布到 npm 的 `contribbot-mcp@latest` 当作本地开发版本。

## 一键接入 Codex

首次在仓库根目录执行：

```bash
pnpm deps:install
pnpm dev:setup
```

`pnpm deps:install` 是启动前的一键依赖安装：先执行 `pnpm install`，再执行
`uv sync --project packages/agent --group dev`，安装 MCP/Web 和 Python Agent
（包含开发测试）的依赖。需要先安装 Node.js、pnpm、uv；Agent 要求 Python 3.11+。
此命令不启动服务、不修改 Codex 配置；依赖声明变更后可以再次执行。
只开发 Node 部分时仍可单独使用 `pnpm install`。

以后新增 Skill、切换开发仓库路径或修复开发配置时，再运行 `pnpm dev:setup`。
修改已有 Skill 或 MCP 源文件不需要重新复制，也不需要 build 或发布 npm。

```bash
pnpm dev:setup --dry-run   # 只预览，不写配置、不建立链接
pnpm dev:check             # 只检查；已直连源码返回 0，需要更新返回 1
pnpm test:dev-setup        # 隔离临时目录中的安装与恢复测试
```

脚本只管理本机 Codex 的 contribbot 开发配置：

- MCP：`$CODEX_HOME/config.toml`，未设置时为 `~/.codex/config.toml`。
  `contribbot` 改为当前 Node 的绝对路径 + 仓库内 tsx + TypeScript 入口，启用该服务。
  保留原有 env、超时、其他 MCP 和模型等配置值。
- 仓库覆盖：如果本 contribbot 仓库的 `.codex/config.toml` 已定义 `contribbot`，
  同步更新其启动路径，避免旧 `dist` 配置覆盖全局设置；没有该条目时不新增。
  这份机器专属配置继续保持 Git 忽略，不提交绝对路径。
- Skills：`~/.agents/skills/contribbot-<目录名>` 直接链接到仓库 `skills/<目录名>`。
  Windows 使用 junction，不需要开启开发者模式；其他系统使用目录符号链接。
  此路径是用户级 Skills 位置，不随 `CODEX_HOME` 改变。
- 旧副本：检查上述目录和 `$CODEX_HOME/skills`，仅备份并移出 frontmatter
  `name` 与源码相同的 contribbot Skills，避免重复发现；无关 Skills 原样保留。
- `.mcp.json` 保持发布版本配置，不改 Claude Code、其他宿主或 contribbot 项目数据。

当前命令针对本仓库已有 Skills，不自动清理将来被源码删除或重命名的 Skills。
发现同名但归属不同的目标、无法识别的失效链接、HTTP MCP 或已启用的 contribbot
插件时停止，不猜测归属或自动卸载插件。其他工作区、额外插件目录中的重复安装需要单独检查。

**源码直连不等于已有进程热重载。** MCP 源码改动后需重新连接 MCP 或重启 Codex；
Skill 没有显示更新时也重启 Codex。正在进行的会话可能仍保留旧上下文。
`dev:check` 检查磁盘配置和链接，不证明当前会话已刷新，也不验证 GitHub 登录。
它不遍历其他仓库、父目录或 profile 的配置。其他目录若仍加载旧版本，在该目录执行
`codex mcp get contribbot` 查看最终生效的启动路径，检查是否有更高优先级的覆盖。

### 备份与恢复

有变化才建立备份。原配置与旧 Skills 路径会逐项打印：

```text
~/.codex/contribbot-dev-backups/<时间-UUID>/config.toml
~/.codex/contribbot-dev-backups/<时间-UUID>/<旧 Skill 目录>
~/.agents/contribbot-dev-backups/<时间-UUID>/<旧 Skill 目录>
<contribbot 仓库>/.codex/contribbot-dev-backups/<时间-UUID>/config.toml
```

设置 `CODEX_HOME` 时第一、二项随之改变。备份位于 Skills 扫描目录之外，setup 不自动清理。
如果 Skills 根目录被重定向到其他位置，旧副本备份放在实际 Skills 根目录的同级，
保证目录移动不跨盘。移动前再次核对文件与链接身份，预览后发生变化则停止重算。
配置通过 TOML 解析器保留值；需要更新时会重新序列化，注释和排版会被规范化，
原文保存在备份中。备份可能包含原配置的敏感值，不要提交或分享。

安装中普通错误会撤回已经建立的链接、还原已经移走的副本；配置最后才替换。
断电、强制终止或并发外部修改不保证自动恢复。脚本使用
`$CODEX_HOME/.contribbot-dev-setup.lock` 防止两个 setup 同时运行；异常退出留下锁时，
先确认没有 setup 进程再移除该锁。

需要恢复时，先退出 Codex，检查备份与执行后的配置是否又被修改：

1. 仅移除新建的 `contribbot-*` **链接本身**，不要递归删除链接目标。
2. 将打印出的旧 Skill 备份移回原目录，遇到已有目录先检查，不覆盖。
3. 对照备份恢复 `mcp_servers.contribbot`。只有确认没有后续配置改动时才恢复整份配置；
   全局与仓库覆盖配置分别处理。首次安装原本没有配置的情况，只移除本次新增的 MCP 条目。
4. 重启 Codex。

### 一键移除开发环境

```bash
pnpm dev:remove --dry-run       # 预览移除范围，不修改任何文件
pnpm dev:remove                 # 备份、移除、验证，成功后清理本次配置备份
pnpm dev:remove --keep-backups  # 移除并验证，但保留本次配置备份
```

移除不是恢复整份历史配置，也不是切回 npm 版本：

- 只从全局及本仓库 `.codex/config.toml` 移除启动参数指向当前源码的
  `mcp_servers.contribbot`；其他 MCP、模型、项目等配置值保留。
- 只解除 `~/.agents/skills/contribbot-*` 中指向当前仓库对应 Skill 的链接。
  不递归删除，不删除源码、依赖或 `~/.contribbot` 项目数据。
- 指向其他仓库、npm、HTTP 的 MCP，或被替换成普通目录的 Skills，保持原样并提示。
- 不自动恢复 setup 时备份的旧 Skills，否则会重新启用旧版。
- 即使移除后 config 为空，也保留该文件，不删除用户配置文件本身。
- 在写配置前保存原文备份；写完重新读取、解析并核对预期值，确认链接已移除，
  然后才删除**本次移除**生成且内容未变的 `config.toml` 备份。
  历史 setup 备份和旧 Skills 备份不会被批量清理，可能留下空的备份目录。
- 校验或更新失败时尝试恢复本次已改动内容，并保留备份；遇到并发修改则拒绝覆盖，
  报告需要人工恢复。备份清理失败不撤回已验证的移除，输出保留路径。

验证范围是磁盘配置和链接，不是宿主内存中的连接状态。移除后重启 Codex，
让已有连接退出。重新接入仍执行 `pnpm dev:setup`。

### 为什么会显示仓库内的 config.toml

`MCP: OK <仓库>/.codex/config.toml` 表示发现并检查了一份**原本存在**的仓库覆盖配置，
不是 setup 新建了它。本机原有条目指向 `dist/mcp/index.js`，优先于全局开发配置，
因此 setup 更新了这个已有条目。没有仓库配置或没有 contribbot 条目时，
setup 只安装全局 MCP，不新增仓库条目。`OK` 只表示磁盘启动参数符合预期。

## 清空自测数据

```bash
pnpm data:reset             # 默认只预览绝对路径、文件数和字节数
pnpm data:reset --dry-run   # 同上
pnpm data:reset --yes       # 确认永久删除当前用户的 ~/.contribbot
pnpm test:data-reset       # 仅在隔离临时 HOME 中测试
```

适合开发期间反复从空状态开始。**执行前停止使用该数据目录的 MCP、Web 和巡检进程。**
旧备份不包含备份之后新增的数据；此命令不会再备份，也不会自动恢复旧备份。
需要保留当前数据时，先另行备份再执行。

- 只处理 `os.homedir()` 下精确的 `.contribbot` 目录；不接受任意删除路径。
- 会删除其中的所有本地项目配置、Todo、知识、上游记录和 Agent 配置/运行记录。
  下一次 init 可重新生成配置，但不会自动找回已删除的数据。
- 不删除相邻 `.contribbot-backups`，不修改 `.codex`、Skills、源码或项目 `.catpaw`。
- 拒绝根目录/嵌套 symlink、junction、特殊文件、含 `.git` 的仓库/worktree，
  以及具有 `HEAD`、`objects`、`refs` 结构的疑似裸 Git 仓库。
  遇到这些情况先单独核对与保留，不提供 `--force` 绕过。
- Node 文件 API 跨平台实现；先检查绝对路径和完整清单，再核对状态，
  逐个删除已列出的文件，最后只移除空目录，不通过 shell 执行递归删除。
- 无数据时安全退出；默认预览和未知参数不会删除。运行中发生变化或权限错误时停止，
  **可能已有部分文件删除**，不承诺原子回滚，也不是恶意并发进程的安全沙箱。
  若其他进程在检查与删除之间主动把祖先目录换成指向外部的链接，仍可能越界删除；
  必须在可信本地环境、停止并发写入/路径修改后使用。
- 多 worktree 目前仍共享用户数据，此命令不是“只清理当前工作空间”。
  分工与隔离方案见 `docs/development/worktree-workflow.md`。

## 本地 MCP Server

`.mcp.json` 适合普通用户安装发布版本：

```json
{
  "contribbot": {
    "command": "npx",
    "args": ["-y", "contribbot-mcp@latest"]
  }
}
```

以下 JSON 只表示启动参数；不同宿主的配置包装格式不同，不能直接作为 Codex 配置使用。
开发时，让 MCP 客户端运行当前源码：

```json
{
  "contribbot": {
    "command": "node",
    "args": [
      "D:/dev/darkingtail/contribbot/packages/mcp/node_modules/tsx/dist/cli.mjs",
      "D:/dev/darkingtail/contribbot/packages/mcp/src/mcp/index.ts"
    ]
  }
}
```

### Codex

本机 `codex mcp add --help` 确认其配置文件为 `~/.codex/config.toml`。
开发态条目示例：

```toml
[mcp_servers.contribbot]
command = "node"
args = [
  "D:/dev/darkingtail/contribbot/packages/mcp/node_modules/tsx/dist/cli.mjs",
  "D:/dev/darkingtail/contribbot/packages/mcp/src/mcp/index.ts"
]
```

这是手工配置示例；推荐使用 `pnpm dev:setup` 自动生成实际机器路径并备份配置。
脚本使用当前 Node 的绝对路径，避免宿主 PATH 与终端不同。

先在 contribbot 仓库根目录安装依赖：

```bash
pnpm install
```

也可以直接启动本地 MCP Server 做 stdio 调试：

```bash
pnpm dev
```

修改 `packages/mcp/src/**` 后，重启 AI 会话或 MCP 连接，使宿主重新加载源码。

## 本地 Skills

开发态 Skills 位于：

```text
D:\dev\darkingtail\contribbot\skills\
```

例如：

```text
skills/init/SKILL.md
skills/dashboard/SKILL.md
skills/project-onboard/SKILL.md
```

新建会话后确认实际读取的 Skill 路径。也可以在当前会话中明确要求读取仓库内的 Skill 文件：

```text
请读取并使用 D:/dev/darkingtail/contribbot/skills/init/SKILL.md。
```

执行 `pnpm dev:setup` 后，`~/.agents/skills/contribbot-init` 等目录应链接到上述源码。
`pnpm dev:check` 会确认所有当前 Skills 的链接目标，旧副本不作为开发态验证依据。

## 推荐调试流程

在目标仓库目录中执行初始化：

```bash
uv run --project D:/dev/darkingtail/contribbot/packages/agent contribbot init
```

`init` 会：

1. 从当前 Git 仓库的 `origin` 推导 `owner/repo`；
2. 调用 MCP 的 `project_init` 工具；
3. 初始化或读取 `config.yaml`；
4. 解析 fork 项目的 canonical parent；
5. 输出当前项目、数据目录和全局已跟踪项目；
6. 不执行 Patrol，不创建 Todo，不写 Knowledge，不修改 GitHub。

针对 fork 仓库，数据目录以 parent 为准。例如：

```text
请求仓库：darkingtail/antdv-next
canonical：antdv-next/antdv-next
数据目录：~/.contribbot/antdv-next/antdv-next/
```

初始化后再执行只读巡检：

```bash
uv run --project D:/dev/darkingtail/contribbot/packages/agent contribbot patrol darkingtail/antdv-next --no-input
```

## 会话内测试提示词

```text
请使用当前开发态 contribbot MCP。
请读取 D:/dev/darkingtail/contribbot/skills/init/SKILL.md。
初始化当前仓库上下文，然后执行只读检查。
不要创建 Todo，不写 Knowledge，不创建 Issue/PR，不修改 GitHub。
```

## Web UI

本地 Web UI 读取同一份 `~/.contribbot` 数据：

```bash
pnpm web
```

打开：

```text
http://127.0.0.1:4173
```

当前 Web UI 是 report-only，只展示项目、Todo 和 Patrol 报告，不执行 GitHub 写操作。

## 验证与限制

- 基础功能此前验证：MCP 测试 127 个、Agent 测试 30 个通过，MCP 构建通过。
- 开发安装脚本有独立测试，覆盖配置保留、备份、重复执行、冲突拒绝、失败恢复和源码链接。
- 2026-09-15 本机验收：安装测试 15 个、MCP 测试 127 个通过，构建通过；
  11 个 Skills 源码链接通过检查，真实 MCP 握手列出 59 个工具（包含 `project_init`）。
  `codex mcp get contribbot` 已确认仓库覆盖配置最终使用 TypeScript 源码入口。
  这不等于当前已打开会话的工具目录已刷新；仍需重连或重启宿主。
- Agent 测试使用独立的 `--basetemp`，避免本机默认 pytest 临时目录的权限问题。
- Web UI 此前验证过 HTTP/API 和真实项目数据；尚无浏览器交互自动化验收。
- 开发安装命令会修改本机 Codex 配置并链接全局 Skills，但不实现自动进程热重载。
- CLI `init` 输出上下文，不会修改其他 AI 会话，也不会永久设置默认 repo。
- 本地数据仍是真实的 `~/.contribbot` 数据；初始化可能创建配置，巡检会写本地审计文件。
