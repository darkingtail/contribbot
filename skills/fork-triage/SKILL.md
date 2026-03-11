---
name: contribbot:fork-triage
description: "Fork 同源追踪决策：评估上游 commits 对二开分支的影响，决定 cherry-pick 策略。适用于场景 #3（fork+二开）和 #5（fork+二开+跨栈）。触发词：'fork triage'、'cherry-pick 评估'、'二开同步'、'上游影响评估'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo>
---

# Fork Triage — 同源追踪决策

评估 fork source 的 commits 对二开分支的影响，辅助 cherry-pick 决策。需要 contribbot MCP Server。

适用场景：
- **#3**: fork + 二开（如 plane/feature-dev）
- **#5**: fork + 二开 + 跨栈（理论存在）

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 项目必须是 fork 模式且有二开分支。

## 与 daily-sync 的关系

`daily-sync` 负责拉取和初步分流（skip noise + 标记动作）。`fork-triage` 在此基础上，对**非噪音的 pending commits** 做深入的二开影响评估。

典型工作流：`daily-sync` → `fork-triage`（对需要决策的 commits）。

## 步骤

### 1. 获取上下文

```
repo_config(repo) → 确认是 fork 模式
upstream_list(repo) → 查看当前追踪状态
```

如果不是 fork 模式，提示用户此 skill 仅适用于 fork 项目。

### 2. 查看 Pending Commits

```
upstream_daily(repo) → 获取 pending commits（已拉取但未标记动作的）
```

如果没有 pending commits，提示"没有待处理的上游变更"并结束。

### 3. 逐条评估

对每条 pending commit，从三个维度评估：

| 维度 | 问题 | 判断依据 |
|------|------|---------|
| **相关性** | 这个变更影响我们使用/修改的代码吗？ | commit 涉及的文件路径、模块 |
| **冲突风险** | 和二开分支有潜在冲突吗？ | 是否修改了我们也改过的文件/逻辑 |
| **价值** | 我们需要这个变更吗？ | bug fix 通常需要，新 feature 看情况 |

### 4. 分类建议

将 commits 分为四类：

| 分类 | 含义 | 建议动作 |
|------|------|---------|
| **必须同步** | bug fix 或安全修复，影响我们的代码 | cherry-pick，优先处理 |
| **建议同步** | 有价值的改进，无冲突风险 | cherry-pick，正常排期 |
| **观察** | 可能相关但需要更多上下文 | 标记 todo，后续评估 |
| **跳过** | 不影响二开分支 | skip |

### 5. 执行标记

对每条 commit 执行标记：

```
upstream_daily_act(repo, commit, action="skip|todo|issue")
```

- **必须同步** → `issue`（创建 tracking issue，标注优先级）
- **建议同步** → `todo` 或 `issue`
- **观察** → `todo`
- **跳过** → `skip`

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
