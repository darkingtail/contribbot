---
name: contribbot:fork-triage
description: "Fork 同源追踪决策：评估上游 commits 对二开分支的影响，决定 cherry-pick 策略。适用于场景 #3（fork+二开）和 #5（fork+二开+跨栈）。触发词：'fork triage'、'cherry-pick 评估'、'二开同步'、'上游影响评估'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: <owner/repo>
---

# Fork Triage — 同源追踪决策

评估 fork source 的 commits 对二开分支的影响，辅助 cherry-pick 决策。

数据格式参考：`references/data-format.md`

适用场景：
- **#3**: fork + 二开（如 plane/feature-dev）
- **#5**: fork + 二开 + 跨栈（理论存在）

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 项目必须是 fork 模式且有二开分支。
- 需要 `gh` CLI 已认证。

## 与 daily-sync 的关系

`contribbot:daily-sync` 负责拉取和初步分流（skip noise + 标记动作）。`contribbot:fork-triage` 在此基础上，对**非噪音的 pending commits** 做深入的二开影响评估。

典型工作流：`contribbot:daily-sync` → `contribbot:fork-triage`。

## 步骤

### 1. 获取上下文

读取 `~/.contribbot/{owner}/{repo}/config.yaml`，确认是 fork 模式（fork 字段有值）。
如果不是 fork 模式，提示此 skill 仅适用于 fork 项目。

读取 `~/.contribbot/{owner}/{repo}/upstream.yaml`，获取 fork source 的 daily commits。

### 2. 查看 Pending Commits

筛选 upstream.yaml 中 fork source 的 daily commits，action = pending 的条目。

如果没有 pending commits，提示"没有待处理的上游变更"并结束。

### 3. 逐条评估

对每条 pending commit，从三个维度评估：

| 维度 | 问题 | 判断依据 |
|------|------|---------|
| **相关性** | 影响我们使用/修改的代码吗？ | commit 涉及的文件路径、模块 |
| **冲突风险** | 和二开分支有潜在冲突吗？ | 是否修改了我们也改过的文件/逻辑 |
| **价值** | 我们需要这个变更吗？ | bug fix 通常需要，新 feature 看情况 |

如需查看 commit 详情：
```bash
gh api repos/{fork_source}/commits/{sha} --jq '{message: .commit.message, files: [.files[].filename]}'
```

### 4. 分类建议

将 commits 分为四类：

| 分类 | 含义 | 建议动作 |
|------|------|---------|
| **必须同步** | bug fix 或安全修复，影响我们的代码 | cherry-pick，优先处理 |
| **建议同步** | 有价值的改进，无冲突风险 | cherry-pick，正常排期 |
| **观察** | 可能相关但需要更多上下文 | 记为 todo，后续评估 |
| **跳过** | 不影响二开分支 | skip |

### 5. 执行标记

根据用户确认的分类，更新 upstream.yaml 中对应 commit 的 action 和 ref 字段：

- **必须同步** → action: `issue`，创建 tracking issue：
  ```bash
  gh issue create -R {owner}/{repo} --title "Sync: {commit_message}" --body "上游 commit {sha}，需要 cherry-pick"
  ```
  将 issue 编号写入 ref 字段
- **建议同步** → action: `todo` 或 `issue`
- **观察** → action: `todo`
- **跳过** → action: `skip`

写回 upstream.yaml。

### 6. 输出报告

```
## Fork Triage Report — {repo}

**Fork Source**: {fork_source_repo}
**Pending Commits 评估**: {total} 条

### 评估结果
| Commit | 消息 | 分类 | 动作 | 理由 |
|--------|------|------|------|------|
| {sha7} | {message} | 必须同步 | issue #{n} | {理由} |
| {sha7} | {message} | 跳过 | skip | {理由} |

### 摘要
| 分类 | 数量 |
|------|------|
| 必须同步 | {n} |
| 建议同步 | {n} |
| 观察 | {n} |
| 跳过 | {n} |

### 下一步
- {列出需要优先处理的 cherry-pick 任务}
```
