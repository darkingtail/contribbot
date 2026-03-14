# 三层工具分类（2026-03-13）

## 背景

contribbot 38 tools 与 GitHub MCP Server 存在功能重叠。需要明确哪些是核心能力、哪些是 GitHub 操作封装，以便：
- 架构上清晰分层
- 未来决策时知道哪些可替代、哪些不可替代
- 避免盲目追加 GitHub MCP 的全部能力（70+ tools 会导致 LLM 性能下降）

## 分析

GitHub MCP Server（github.com/github/github-mcp-server）提供 ~30 tools，覆盖 issues、PRs、branches、files、repos、users 等纯 GitHub 操作。

contribbot 38 tools 中：
- 部分是 contribbot 独有（todo、upstream tracking、skills、config）
- 部分是 GitHub 操作 + 本地数据联动（创建 issue 时自动建 todo）
- 部分是纯 GitHub 封装（issue_list、pr_summary 等）

## 设计决策

### 三层分类

| 层 | 数量 | 工具 | 说明 |
|---|---|---|---|
| **核心层（core）** | ~16 | todo_list, todo_add, todo_done, todo_delete, todo_archive, todo_activate, todo_detail, todo_update, upstream_sync_check, sync_history, upstream_list, upstream_detail, upstream_update, upstream_daily, upstream_daily_act, upstream_daily_skip_noise, repo_config, project_list, contribution_stats, skill_write | contribbot 独有能力，GitHub MCP 无替代 |
| **联动层（linkage）** | ~4 | issue_create, issue_close, pr_create, sync_fork | GitHub 操作 + 自动更新本地数据（todo/upstream 联动） |
| **兼容层（compat）** | ~18 | issue_list, issue_detail, pr_list, pr_summary, pr_update, pr_review_comments, pr_review_reply, comment_create, discussion_list, discussion_detail, actions_status, security_overview, repo_info, project_dashboard | 纯 GitHub 封装，保证开箱即用 |

### 为什么保留兼容层

- 不是所有用户都安装了 GitHub MCP
- Skills 编排依赖这些工具名，移除会破坏 skill 逻辑
- 保证"装 contribbot 即可用"的开箱即用体验

### 为什么不追加更多 GitHub 能力

- GitHub MCP 有 ~30 tools，全部复制过来总计 70+ tools
- LLM 处理大量工具时性能下降（工具选择准确率降低）
- 兼容层已覆盖开源协作最常用的 GitHub 操作

## 实施

### 目录结构

```
packages/mcp/src/core/tools/
├── core/           # contribbot 独有能力（12 文件）
├── linkage/        # GitHub + 本地数据联动（4 文件）
└── compat/         # 纯 GitHub 封装（12 文件）
```

### 改动

1. 创建 `core/`、`linkage/`、`compat/` 三个子目录
2. 按分类移动 28 个工具文件
3. 更新 `server.ts` 所有 import 路径（分三组注释标注）
4. 更新 `index.ts` 导出路径（分三层注释标注）
5. 修复跨层引用（`sync-fork.ts` → `core/repo-config-tool.js`，`project-dashboard.ts` → `core/skill-resources.js`）
6. 修复动态 import（`pr-create.ts` 中的 `import('../storage/repo-config.js')`）
7. 更新 CLAUDE.md 项目结构说明

### 状态

- [x] 目录创建 & 文件迁移
- [x] import 路径更新
- [x] 构建通过
- [x] CLAUDE.md 更新
