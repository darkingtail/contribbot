# 项目归档与恢复

项目完成、暂时不再维护时，可以从活跃集合中归档，而不是删除本地数据。
这是本地项目生命周期，不是 GitHub 的仓库 Archive，也不是 Todo 归档。

## 使用

通过 MCP（repo 必须为明确的 `owner/repo`）：

```text
project_archive({ repo: "owner/repo" })
project_list()                         // 仅 active，包含没有 status 的旧项目
project_list({ status: "archived" })    // 仅归档
project_list({ status: "all" })         // 全部
project_restore({ repo: "owner/repo" })
```

也可以直接对 AI 说“归档 owner/repo 项目”或“恢复 owner/repo 项目”。
dashboard Skill 提供对应流程。`project_status({ repo })` 是 Agent 使用的只读
JSON 状态接口，返回 canonical repo、configured、status 和 archived_at，不初始化配置。

## 数据与语义

仅更新 canonical parent 数据目录下的 `config.yaml`：

```yaml
status: archived
archived_at: "2026-09-16T00:00:00.000Z"
```

恢复后为 `status: active`，`archived_at: null`。旧配置没有 status 时按 active 处理，
读取时不迁移、不重写。重复归档/恢复不刷新时间或重写文件。fork 名称解析到同一份状态。
未配置项目不能直接归档/恢复，先用 `project_init` 接入。

归档不会：

- 删除/移动 Todo、知识库、上游追踪、巡检记录或源码。
- 把未完成 Todo 标为 done，取消已领取工作，或结清奖励。
- 写 GitHub、关闭 issue/PR 或修改远端仓库归档状态。
- 撤销其他 MCP 工具的手工读写权限；它是维护状态，不是访问控制。

## 巡检与界面

- 默认 `patrol-all` 发现活跃项目，自动调度下一轮同样生效。
- 单项目 patrol、恢复历史 Run 在第一步检查 canonical 生命周期；
  archived 时在采集、分析和写记录之前停止，并要求显式 project_restore。
- 批量/定时配置显式列出的归档项目记为 skipped，不进入失败告警。
- 已经运行中的巡检不会被强制终止；本版本不是运行时取消机制。
- `project_init` 只显示归档状态，不自动恢复，也不建议直接巡检。
- Web 默认显示 active，概览页面可以切换 active / archived / all；显示状态和历史记录。
  Web 保持只读，归档/恢复通过 MCP 执行。

新增工具需要重连 MCP 才能出现在已开启会话中。Agent 要求 MCP 提供 project_status；
状态工具缺失、响应无效或读取失败时停止，不以“猜测为 active”继续。

## 验证

```text
pnpm test
pnpm build
uv run --project packages/agent --group dev pytest packages/agent/tests
```

自动测试覆盖旧配置兼容、归档/恢复/幂等、fork、数据保留、init 不恢复、
状态错误时停止、单项目和恢复 Run 拒绝执行、显式批量跳过，以及 Web API 的三种筛选。
测试使用临时目录，不恢复或重新初始化真实用户数据。

2026-09-16 本机 Windows 验证：MCP 135 个测试（含 GitHub 离线时 fork 初始化不得绕过归档）、Agent 35 个测试、
Web API 集成测试及构建通过。真实 stdio MCP 在隔离临时 HOME 下完成
active → archived → active，Todo 文件字节未变；工具清单为 62 个。
Web 页面交互尚未进行浏览器验收，macOS/Linux 本轮未实机运行。
