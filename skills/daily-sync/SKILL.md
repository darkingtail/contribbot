---
name: contribbot:daily-sync
description: "每日上游同步工作流。按项目模式自动分流：none 走维护日常，fork/upstream 走上游追踪。触发词：'daily sync'、'每日同步'、'日常巡检'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: <owner/repo>
---

# Daily Sync — 每日上游同步

按项目模式（ProjectMode）自动分流的每日工作流。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 需要 `gh` CLI 已认证。

## 步骤

### 1. 检查项目模式

读取 `~/.contribbot/{owner}/{repo}/config.yaml`，根据 fork 和 upstream 字段判断模式：

| fork | upstream | 模式 |
|------|----------|------|
| 有值 | 有值 | fork+upstream |
| 有值 | null | fork |
| null | 有值 | upstream |
| null | null | none |

如果 config.yaml 不存在，提示用户先用 `contribbot:project-onboard` 初始化项目。

---

### 分支 A: none 模式（无上游对齐）

无上游可追踪，执行维护日常：

1. **查看 open issues**：
   ```bash
   gh issue list -R {owner}/{repo} --state open --json number,title,labels,createdAt --limit 20
   ```

2. **查看 open PRs**：
   ```bash
   gh pr list -R {owner}/{repo} --state open --json number,title,state,createdAt --limit 10
   ```

3. **CI 状态**：
   ```bash
   gh run list -R {owner}/{repo} --limit 5 --json status,conclusion,name,headBranch
   ```

4. **安全告警**：
   ```bash
   gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length'
   ```

输出摘要：Open issues / Open PRs / CI 状态 / 安全告警数。

---

### 分支 B: fork 模式（同源对齐）

1. **同步 fork**：
   ```bash
   gh repo sync {owner}/{repo}
   ```

2. **读取追踪状态**：读取 `~/.contribbot/{owner}/{repo}/upstream.yaml`，找到 fork source 的 daily 数据。

3. **拉取新 commits**：
   - 从 config.yaml 获取 fork source repo
   - 如果 upstream.yaml 中该 source 无 sinceTag（首次），列出 releases/tags 供用户选择锚点：
     ```bash
     gh release list -R {fork_source} --limit 10 --json tagName,publishedAt
     ```
     如无 releases，用 tags：
     ```bash
     gh api repos/{fork_source}/tags --jq '.[].name' | head -10
     ```
   - 有锚点后，拉取增量 commits：
     ```bash
     gh api "repos/{fork_source}/compare/{sinceTag}...HEAD" --jq '.commits[] | {sha: .sha[0:7], message: .commit.message, author: .commit.author.name, date: .commit.author.date}'
     ```
   - 将新 commits 写入 upstream.yaml 的 daily 区域（action: pending）

4. **跳噪音**：扫描 pending commits，匹配噪音模式（ci:/build:/chore(deps):/style:/Merge/bump version），将 action 设为 skip。更新 upstream.yaml。

5. **审阅剩余 pending commits**：展示给用户，建议动作：
   - `skip` — 无关
   - `todo` — 记到本地 todo
   - `issue` — 创建 tracking issue
   - 根据用户决策更新 upstream.yaml 中对应 commit 的 action 和 ref 字段

输出摘要：新增 / 跳过 / 已关联 / 待处理 数量。

---

### 分支 C: upstream 模式（跨栈追踪）

与分支 B 类似，但追踪源是 config.yaml 中的 upstream 字段（外部仓库）。

额外评估维度：
- 这个变更在目标技术栈有意义吗？
- 实现难度？（需要从零重写 vs 简单适配）

可选：对比 release 级同步状态：
```bash
gh release list -R {upstream_repo} --limit 5 --json tagName,publishedAt
```
与 upstream.yaml 中的 versions 对比，计算覆盖率。

---

### 分支 D: fork+upstream 模式

依次执行分支 B（fork source）和分支 C（external upstream），输出合并摘要。

---

## 最终输出格式

```
## Daily Sync 摘要 — {repo}

**模式**: {mode}
**日期**: {date}

### Fork Source: {fork_repo}（如有）
| 指标 | 数量 |
|------|------|
| 新增 commits | N |
| 跳过噪音 | N |
| 已关联 issue/todo | N |
| 待处理 | N |

### Upstream: {upstream_repo}（如有）
| 指标 | 数量 |
|------|------|
| 新增 commits | N |
| 跳过噪音 | N |
| 已关联 issue/todo | N |
| 待处理 | N |

### 维护状态（none 模式）
- Open issues: N
- Open PRs: N
- CI: passing/failing
- 安全告警: N
```
