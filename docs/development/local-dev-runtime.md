# Local Development Runtime

本页记录 contribbot 在本地开发状态下的调试方式。

## 目标

开发 contribbot 时，需要同时使用：

- 当前仓库源码中的 MCP Server；
- 当前仓库源码中的 Skills；
- 当前本地用户目录下的 contribbot 项目数据。

不要把已经发布到 npm 的 `contribbot-mcp@latest` 当作本地开发版本。

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

这是本机路径示例，其他机器需要替换仓库路径。调整前备份已有配置，只替换
`contribbot` 条目，不覆盖其他 MCP 或模型设置。本次提交没有修改全局配置。

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

已经安装到 `~/.codex/skills` 或其他插件目录的副本可能是旧版本，不能作为开发态源码的验证依据。

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

- 本次提交前 MCP 测试 127 个通过，Agent 测试 30 个通过，MCP 构建通过。
- Agent 测试使用独立的 `--basetemp`，避免本机默认 pytest 临时目录的权限问题。
- Web UI 此前验证过 HTTP/API 和真实项目数据；尚无浏览器交互自动化验收。
- 没有安装或同步全局 Skills，也没有实现自动热重载或开发态安装脚本。
- CLI `init` 输出上下文，不会修改其他 AI 会话，也不会永久设置默认 repo。
- 本地数据仍是真实的 `~/.contribbot` 数据；初始化可能创建配置，巡检会写本地审计文件。
