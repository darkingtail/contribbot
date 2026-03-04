# contribbot

个人开源贡献工具集，作为全局 MCP Server 运行。

## 项目结构

```
src/
├── core/
│   ├── clients/
│   │   ├── github.ts          # GitHub API 封装（支持 gh CLI / GITHUB_TOKEN）
│   │   └── npm-registry.ts    # npm registry 查询
│   ├── storage/               # 数据存储层（YAML 持久化）
│   │   ├── todo-store.ts      # TodoStore — todos.yaml 读写
│   │   ├── upstream-store.ts  # UpstreamStore — upstream.yaml 读写
│   │   └── record-files.ts    # RecordFiles — 实现记录文件管理
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
    "contribbot": {
      "command": "node",
      "args": ["--import", "tsx/esm", "/Users/wisedu/Documents/GitHub/contrib/src/mcp/index.ts"]
    }
  }
}
```

## 工具清单

### 项目概览

| 工具 | 说明 |
|------|------|
| `project_dashboard` | 项目概览：issues/PRs/commits/release |
| `repo_info` | 仓库元信息 |

### Todo 管理（YAML 结构化）

| 工具 | 说明 |
|------|------|
| `todo_list` | 查看本地 todos（YAML），按 ref# 排序，分 Active/Backlog&Ideas/Done 表格 |
| `todo_add` | 添加 todo，支持 `ref` 参数自动拉 issue label 识别类型 |
| `todo_activate` | 激活 todo：拉 issue 详情 + 评论总结、评估难度、创建实现记录文件 |
| `todo_detail` | 查看实现记录，自动刷新 PR reviews（5 分钟缓存） |
| `todo_update` | 更新状态 / 关联 PR / 追加笔记 |
| `todo_done` | 标记完成 |

### Issues & PRs

| 工具 | 说明 |
|------|------|
| `issue_detail` | Issue 详情 |
| `issue_create` | 创建 issue，可关联 upstream commit + 自动建 todo |
| `issue_close` | 关闭 issue，可附评论 + 自动标记 todo done |
| `pr_summary` | PR 摘要 |
| `pr_create` | 创建 PR，可关联 todo |
| `pr_update` | 更新 PR（标题/描述/状态/草稿） |
| `pr_review_comments` | 列出 PR review 评论（含 ID、diff、内容） |
| `pr_review_reply` | 回复 PR review 评论 |
| `comment_create` | Issue/PR 通用评论 |
| `discussion_list` | Discussion 列表 |
| `discussion_detail` | Discussion 详情 |

### 上游同步

| 工具 | 说明 |
|------|------|
| `upstream_sync_check` | 对比上游 release 变更同步状态（支持任意上下游仓库） |
| `sync_history` | 查看历史同步记录 |
| `upstream_list` | 版本同步总览 + 每日 commits 摘要 |
| `upstream_detail` | 查看某版本同步详情或实现记录 |
| `upstream_update` | 更新同步条目状态 / 关联 PR / 难度 |
| `upstream_daily` | 拉取上游 master 近期 commits，去重追加，自动检测已有 issue/PR |
| `upstream_daily_act` | 对某条 commit 标记动作（skip/todo/issue/pr） |

### 质量 & 依赖

| 工具 | 说明 |
|------|------|
| `actions_status` | CI 状态 |
| `security_overview` | 安全告警 |
| `vc_dependency_status` | @v-c/* 依赖更新检查 |
| `component_test_coverage` | 组件测试覆盖率扫描 |
| `contribution_stats` | 个人贡献统计（PR/issue/review） |

### 全局

| 工具 | 说明 |
|------|------|
| `project_list` | 所有已跟踪项目概况（todos/upstream 统计） |

### Skills

| 工具 | 说明 |
|------|------|
| `skill_list` | 查看项目 skills |
| `skill_read` | 读取 skill 内容 |
| `skill_write` | 创建/更新 skill |

## 数据存储

所有持久化数据存在 `~/.contribbot/{owner}/{repo}/`：

```
~/.contribbot/{owner}/{repo}/
├── todos.yaml                          # todo 索引（YAML 结构化）
├── todos/                              # todo 实现记录
│   ├── 281.md                          # 本仓库 issue
│   └── idea-1.md                       # 纯想法
├── upstream.yaml                       # 上游同步索引（版本 + 每日 commits）
├── upstream/                           # 上游同步实现记录
│   └── ant-design/ant-design/
│       ├── 6.3.0.md
│       └── 6.3.1.md
├── skills/                             # 可复用经验
└── sync/                               # 旧版同步记录（已迁移到 upstream/）
```

## 设计规范

- 所有列表/表格输出必须带**备注列**（提供上下文信息）
- 工具间数据不共享状态，每次调用独立
- 本地文件类工具需支持 `project_root` 参数，兼容多项目场景
