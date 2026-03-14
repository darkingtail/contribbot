# Todo Claim 工作项领取（2026-03-13）

## 背景

多人维护同一仓库时，upstream triage 的中间状态不共享。每个维护者本地有自己的 upstream tracking，互相不知道谁在做什么，导致重复劳动。

典型场景：一个 issue 包含多个工作项（子任务、表格行、职责范围），多个维护者各自本地追踪，没有公开的领取信号。

## 核心原则

**工具不做定性，也没有定性的能力。**

- 工作项识别交给 LLM（issue 格式不统一：checklist、表格、列表、纯文本）
- 分支命名交给 LLM（不同仓库规范不同：feat/fix/feature/chore...）
- 噪音过滤的项目级判断交给 LLM（工具只做通用噪音检测）
- 工具层只负责：接收数据、写入 GitHub、更新本地存储

## 设计决策

### 1. GitHub issue 评论作为协调机制

不引入额外共享存储，直接用 GitHub issue 评论发布领取信号。其他维护者通过 issue 评论即可看到谁在做什么。

### 2. `todo_add` 与 `todo_claim` 职责分离

- `todo_add` — 纯本地记录，不触碰 GitHub
- `todo_claim` — 公开宣告，写 GitHub 评论 + 本地记录

### 3. `todo_activate` 不自动创建远程分支

不同仓库分支规范不同，硬编码 `feat/xxx` 无法覆盖所有情况。改为：
- 分支命名由 Skill 层的 LLM 分析仓库现有分支规范后建议
- `todo_activate` 接收可选 `branch` 参数，仅记录不创建
- 保留 `generateDefaultBranchName` 作为 LLM 无法判断时的 fallback

### 4. 评论模板用独立文件，不放 config.yaml

- `config.yaml` 的 `templates` 字段太宽泛，混杂不同性质的配置
- YAML 里写多行模板不友好（需转义 `\n`）
- 改为独立文件：`~/.contribbot/{owner}/{repo}/templates/todo_claim.md`
- 文件名与工具名对应，以后扩展一致（如 `templates/issue_create.md`）

### 5. 命名通用化：subtasks → items

`subtasks` 限定了"子任务"语义，但实际可 claim 的范围更广：
- 整个 issue
- 子任务（checklist）
- 表格中的行
- 某个职责范围（"I'll handle the CSS part"）

参数名和字段名统一用 `items`。

## 实现

### 新增工具：`todo_claim`（core 层）

```
todo_claim(
  item: string,     // todo 索引或匹配文本
  items: string[],  // LLM 从 issue body 中识别的工作项描述
  repo?: string
)
```

职责：
1. 验证 issue 未关闭、用户已认证
2. 读取评论模板（`templates/todo_claim.md`，fallback 默认模板）
3. 在 GitHub issue 上发布评论
4. 更新本地 todo 记录（`claimed_items` 字段）
5. 自动将 todo 状态升为 `active`（如尚未 active）
6. 重复 claim 时合并去重 + 返回警告

模板变量：`{{items}}`、`{{user}}`、`{{repo}}`、`{{issue}}`

默认模板：
```markdown
I'll work on the following:

{{items}}

<!-- contribbot:claim @{{user}} -->
```

### `todo_activate` 变更

- 去掉 `createBranch` 调用（不自动创建远程分支）
- 新增 `branch` 可选参数（LLM 建议的分支名）
- 保留 `generateDefaultBranchName` 作为 fallback 并 export

### 数据变更

`TodoItem` 新增字段：`claimed_items: string[] | null`

向后兼容：`TodoStore.list()` 规范化 `claimed_items ?? null`

### 交互流程

```
todo_activate(#123, branch="feat/259-cascader") → 返回 issue body + 评论摘要
       ↓
LLM 从返回内容中识别可领取的工作项
       ↓
展示清单，用户选择要领取的
       ↓
todo_claim(item, items=[...]) → 评论 + 本地记录 + 自动升 active
```

### Skill 变更

- **start-task**：步骤 3 增加 LLM 分析分支规范；新增步骤 4（工作项识别 → 选择 → claim）
- **todo**：新增 `claim` 动作路由

### 边界处理

- 重复 claim：合并去重，返回替换警告
- 用户认证失败：直接报错（不用 "unknown" fallback）
- issue 已关闭：拒绝 claim
- `todo_detail` 展示 claimed items 列表
- 文档工具计数 38 → 39

## 状态

- [x] `TodoItem` 新增 `claimed_items` 字段 + 向后兼容
- [x] `todo_claim` 工具实现（`tools/core/todo-claim.ts`）
- [x] `todo_activate` 去掉自动创建分支，加 `branch` 参数
- [x] 评论模板从独立文件读取（`templates/todo_claim.md`）
- [x] `config.yaml` 不加 `templates` 字段
- [x] `server.ts` 注册 + `index.ts` 导出
- [x] `start-task` skill 更新（分支命名 + claim 流程）
- [x] `todo` skill 更新（claim 动作）
- [x] `todo_detail` 显示 claimed items
- [x] CLAUDE.md / package.json / INSTRUCTIONS 更新（39 tools）
- [x] 构建通过
