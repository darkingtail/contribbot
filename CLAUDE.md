# contrib

个人开源贡献工具集，作为全局 MCP Server 运行。

## 项目结构

```
src/
├── core/
│   ├── clients/
│   │   ├── github.ts          # GitHub API 封装（支持 gh CLI / GITHUB_TOKEN）
│   │   └── npm-registry.ts    # npm registry 查询
│   ├── tools/                 # 所有工具实现（纯函数）
│   └── utils/
│       ├── config.ts          # 默认 repo 配置、项目路径工具
│       └── format.ts          # markdown table 等输出格式化
├── mcp/
│   ├── index.ts               # MCP Server 入口（stdio）
│   └── server.ts              # 注册所有工具
└── index.ts                   # 统一导出
```

## 开发

```bash
pnpm dev          # tsx 直接运行 MCP Server（用于调试）
pnpm build        # tsdown 构建
```

## 全局 MCP 配置

已配置在 `~/.claude/mcp.json`，通过 `tsx` 直接运行源码：

```json
{
  "mcpServers": {
    "contrib": {
      "command": "node",
      "args": ["--import", "tsx/esm", "/Users/wisedu/Documents/GitHub/contrib/src/mcp/index.ts"]
    }
  }
}
```

## 工具清单

| 工具 | 说明 |
|------|------|
| `project_dashboard` | 项目概览：issues/PRs/commits/release |
| `repo_info` | 仓库元信息 |
| `my_missions` | 我的活跃任务（PR/assigned/commented/mentioned） |
| `todo_list` | 查看本地 todos |
| `todo_add` | 添加 todo |
| `todo_done` | 完成 todo |
| `issue_detail` | Issue 详情 |
| `pr_summary` | PR 摘要 |
| `discussion_list` | Discussion 列表 |
| `discussion_detail` | Discussion 详情 |
| `actions_status` | CI 状态 |
| `security_overview` | 安全告警 |
| `upstream_sync_check` | 对比上游 release 同步状态（支持任意上下游仓库） |
| `sync_history` | 查看历史同步记录 |
| `vc_dependency_status` | @v-c/* 依赖更新检查 |
| `component_test_coverage` | 组件测试覆盖率扫描 |
| `skill_list` | 查看项目 skills |
| `skill_read` | 读取 skill 内容 |
| `skill_write` | 创建/更新 skill |

## 数据存储

所有持久化数据存在 `~/.contrib/{owner}/{repo}/`：

```
~/.contrib/
├── antdv-next/antdv-next/
│   ├── todos.md
│   ├── skills/
│   └── sync/
└── darkingtail/plane/
    └── sync/
```

## 设计规范

- 所有列表/表格输出必须带**备注列**（提供上下文信息）
- 工具间数据不共享状态，每次调用独立
- 本地文件类工具需支持 `project_root` 参数，兼容多项目场景
