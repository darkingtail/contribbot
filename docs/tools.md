# contribbot 工具集合

> 38 Tools + 1 Resource + 4 Prompts

---

## 项目概览（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `project_dashboard` | 项目全貌：open issues/PRs 统计、labels 分布、近期 commits、最新 release | `repo` |
| `repo_info` | 仓库元信息：stars、forks、topics、license、contributors | `repo` |

---

## 仓库管理（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `repo_config` | 查看/更新仓库配置（role/org/fork/upstream），首次访问自动检测 | `repo`, `upstream?` |
| `sync_fork` | 同步 fork 默认分支到上游最新，从 config.yaml 读取 fork 信息 | `repo`, `branch?` |
| `project_list` | 所有已跟踪项目概况（todos/upstream 统计） | — |
| `contribution_stats` | 个人贡献统计：PRs/issues/reviews 数量 | `days?`, `author?`, `repo` |

---

## Todo 管理（8 Tools）

本地 YAML 结构化任务管理，生命周期：idea → backlog → active → pr_submitted → done → archive

| 工具 | 说明 | 参数 |
|------|------|------|
| `todo_list` | 查看 todos，按 ref# 排序，分 Active/Backlog&Ideas/Done 三组 | `repo`, `status?` |
| `todo_add` | 添加 todo，`ref` 参数可自动从 issue labels 识别类型 | `text`, `ref?`, `repo` |
| `todo_activate` | 激活 todo：拉 issue 详情 + 评论总结、评估难度、创建实现记录文件 | `item`, `repo` |
| `todo_detail` | 查看实现记录，自动刷新 PR reviews（5 分钟缓存） | `item`, `repo` |
| `todo_update` | 更新状态 / 关联 PR / 关联分支 / 追加笔记 | `item`, `status?`, `pr?`, `branch?`, `note?`, `repo` |
| `todo_done` | 标记完成 | `item`, `repo` |
| `todo_delete` | 删除 todo | `item`, `repo` |
| `todo_archive` | 归档所有已完成的 todos | `repo` |

### 枚举值

- **status**: `idea` · `backlog` · `active` · `pr_submitted` · `done`
- **type**: `bug` · `feature` · `docs` · `chore`
- **difficulty**: `easy` · `medium` · `hard`

---

## Issues & PRs（11 Tools）

### Issues（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `issue_list` | 搜索 issues，支持 state/label/关键词过滤 | `repo`, `state?`, `labels?`, `query?` |
| `issue_detail` | Issue 详情：标题、标签、关联 PRs、评论摘要 | `issue_number`, `repo` |
| `issue_create` | 创建 issue，可关联 upstream commit + 自动建 todo | `title`, `body?`, `labels?`, `upstream_sha?`, `upstream_repo?`, `auto_todo?`, `repo` |
| `issue_close` | 关闭 issue，可附评论 + 自动标记 todo done | `issue_number`, `comment?`, `todo_item?`, `repo` |

### Pull Requests（5 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `pr_list` | 搜索 PRs，支持 state/关键词过滤 | `repo`, `state?`, `query?` |
| `pr_summary` | PR 摘要：author、status、变更文件、CI checks、reviews | `pr_number`, `repo` |
| `pr_create` | 创建 PR，可关联 todo（自动设 status 为 pr_submitted） | `title`, `head?`, `base?`, `body?`, `draft?`, `todo_item?`, `repo` |
| `pr_update` | 更新 PR（标题/描述/状态/草稿） | `pr_number`, `title?`, `body?`, `state?`, `draft?`, `repo` |
| `pr_review_comments` | 列出 PR review 评论（含 ID、diff 上下文、内容） | `pr_number`, `repo` |

### 通用（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `pr_review_reply` | 回复 PR review 评论 | `pr_number`, `comment_id`, `body`, `repo` |
| `comment_create` | Issue/PR 通用评论 | `issue_number`, `body`, `repo` |

---

## Discussions（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `discussion_list` | Discussion 列表，可按 category 过滤 | `repo`, `category?` |
| `discussion_detail` | Discussion 详情（含所有评论） | `discussion_number`, `repo` |

---

## 上游追踪（8 Tools）

支持 fork source 和外部 upstream，共用 upstream.yaml，追踪源由 repo key 区分。无 release 的仓库自动 fallback 到 tags。

### 版本同步（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_sync_check` | 对比上游 release 变更与目标仓库同步状态，按 feat/fix 分组 | `upstream_repo`, `repo`, `version?`, `target_branch?`, `save?` |
| `upstream_list` | 版本同步总览 + 每日 commits 摘要 | `repo`, `upstream_repo?` |
| `upstream_detail` | 查看某版本同步详情或实现记录 | `upstream_repo`, `version`, `repo` |
| `upstream_update` | 更新同步条目：状态 / 关联 PR / 难度 | `upstream_repo`, `version`, `item_index`, `status?`, `pr?`, `difficulty?`, `repo` |

### 每日追踪（3 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_daily` | 拉取上游 commits（anchor..HEAD），首次引导选择基准版本，支持 releases 和 tags | `upstream_repo`, `since_tag?`, `repo` |
| `upstream_daily_act` | 标记某条 commit 的动作 | `upstream_repo`, `sha`, `action`, `ref?`, `repo` |
| `upstream_daily_skip_noise` | 批量跳过噪音 commits（CI/deps/build/style） | `upstream_repo`, `repo` |

### 历史记录（1 Tool）

| 工具 | 说明 | 参数 |
|------|------|------|
| `sync_history` | 查看历史同步记录 | `repo` |

### 枚举值

- **upstream item status**: `active` · `pr_submitted` · `done`
- **upstream version status**: `active` · `done`
- **daily commit action**: `skip` · `todo` · `issue` · `pr` · `synced`

### 工作流

```
upstream_daily ──→ upstream_daily_skip_noise ──→ 逐条 upstream_daily_act
       ↓                                              ↓
  首次：选锚点                                  skip / todo / issue / pr / synced
  后续：增量拉取
```

---

## 质量 & 安全（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `actions_status` | GitHub Actions CI 状态，高亮失败 | `repo`, `branch?` |
| `security_overview` | Dependabot 漏洞 + code scanning 告警 | `repo` |

---

## Skills（1 Resource + 1 Tool）

可复用经验沉淀系统，存储在 `~/.contribbot/{owner}/{repo}/skills/` 下。

| 类型 | 标识 | 说明 |
|------|------|------|
| Resource | `skill://{repo}/{skillName}` | 只读访问所有 skills，支持 list + read |
| Tool | `skill_write` | 创建/更新 skill（`name` + `content` + `repo`） |

---

## Prompts（4 Prompts）

预定义的多步工作流模板。

### daily-sync — 每日同步

```
1. repo_config → 查看项目模式
2. If fork: sync_fork → 同步 fork 到上游最新
3. For each tracking source:
   - upstream_daily → 拉取新 commits
   - upstream_daily_skip_noise → 跳过噪音
   - 逐条 triage → upstream_daily_act
4. If none: 跳过追踪，展示 project_dashboard
```

参数：`repo`

### start-task — 开始任务

```
1. project_dashboard → 项目全貌
2. todo_list → 当前 todos
3. todo_activate → 激活指定 todo（或帮选一个）
4. todo_detail → 查看实现记录
5. 总结：任务内容、相关 issues、建议方案
```

参数：`repo`, `item?`

### pre-submit — 提交前检查

```
1. pr_summary → PR 变更概览
2. pr_review_comments → 检查未解决评论
3. actions_status → 确认 CI 通过
4. 必要时 pr_review_reply → 回复评论
5. 报告：CI 状态、未解决评论、合并就绪度
```

参数：`repo`, `pr`

### weekly-review — 周回顾

```
单项目：
1. contribution_stats → 本周贡献数据
2. todo_list → 进展和阻塞
3. upstream_list → 上游同步覆盖率
4. todo_archive → 清理已完成
5. 总结：成果、阻塞、下周重点

跨项目：
1. project_list → 所有项目概况
2. 逐项目检查 stats/todos/upstream
3. 跨项目总结
```

参数：`repo?`

---

## 工具组合逻辑

| 步骤 | 工具组 | 说明 |
|------|--------|------|
| 1. 同步 fork | `sync_fork` | fork/fork+upstream 模式下，开始前同步 |
| 2. 建立上下文 | `project_dashboard` | 项目全貌 |
| 3. 任务管理 | `todo_add` → `todo_activate` → `todo_detail` → `todo_update` → `todo_done` → `todo_archive` | 完整生命周期 |
| 4. 深入调查 | `issue_detail` / `pr_summary` / `discussion_detail` | 了解具体内容 |
| 5. 上游追踪 | `upstream_daily` → `upstream_daily_act` → `upstream_daily_skip_noise` | 抓取 + triage |
| 6. 版本同步 | `upstream_sync_check` → `upstream_list` → `upstream_detail` | 版本级对比 |
| 7. 质量保障 | `actions_status` / `security_overview` | CI + 安全 |
| 8. GitHub 写入 | `issue_create` / `issue_close` / `comment_create` / `pr_create` / `pr_update` / `pr_review_reply` | 写操作 |
| 9. 记录沉淀 | `skill_write` | 可复用经验 |
| 10. 全局视图 | `project_list` / `repo_config` | 跨项目管理 |

---

## Agent 行为规则

- 首次进入项目：`repo_config` 查看模式，决定可用工作流
- 创建 PR 后：如有 active todo，自动 `todo_update` 关联
- 创建 issue 后：如来自 upstream daily，自动 `upstream_daily_act` 关联
- 关闭 issue 时：如有对应 todo，自动标记 done
- 回复 review 前：先用 `pr_review_comments` 获取评论列表
- 所有 repo 参数必须显式传 `"owner/repo"`，无默认值
- 所有输出为 markdown 格式，表格类输出带备注列
