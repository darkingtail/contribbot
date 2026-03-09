# 项目模式与核心能力

## 6 种场景（fork × upstream × 二开）

| # | fork | upstream | 二开 | 场景 | 例子 |
|---|------|----------|------|------|------|
| 1 | 无 | 无 | 无 | **own** — 自己的项目 | contribbot |
| 2 | 有 | 无 | 无 | **纯 fork 贡献** — 修 bug 提 PR，不消费 | fork React 修个 issue |
| 3 | 有 | 无 | 有 | **fork + 二开** — 下游消费者 | plane / feature/dev |
| 4 | 有 | 有 | 无 | **fork + 跨栈复刻** — 贡献 + 对齐另一个上游 | antdv-next 对齐 ant-design |
| 5 | 有 | 有 | 有 | **fork + 二开 + 跨栈** — 最复杂，消费 + 复刻 | 理论存在，暂无实例 |
| 6 | 无 | 有 | 无 | **非 fork 跨栈追踪** — 从零建项目但追踪外部仓库 | 从零写 Vue 库追踪 Material UI |

排除的不现实组合：
- 无 fork + 有 upstream + 有二开：没 fork 谁，二开不成立
- 无 fork + 无 upstream + 有二开：自己的项目自己的分支，不算二开

## 模式推断

由 `config.yaml` 的 fork + upstream 字段自动推断（`inferMode`），无需额外 mode 字段：

| fork | upstream | 推断模式 |
|------|----------|---------|
| 有 | 有 | fork+upstream |
| 有 | 无 | fork |
| 无 | 有 | upstream |
| 无 | 无 | own |

二开分支不存在 config 中，是用户的 git 分支策略，contribbot 不管。

## 三层核心能力

| 层 | 能力 | 覆盖场景 |
|----|------|---------|
| 1. 基础 | issue/PR/todo 管理 | 所有模式 |
| 2. 同源追踪 | fork commit cherry-pick 决策 | #3、#5 |
| 3. 跨栈追踪 | 外部仓库 commit 复刻决策 | #4、#5、#6 |

场景合并关系：
- **#2 ≈ #1 + sync_fork** — 纯 fork 贡献不需要 commit 级追踪，差别很小
- **#4 和 #6 追踪机制相同** — 都是跨栈复刻追踪，#4 额外需要 sync_fork
- **#5 = 同源追踪 + 跨栈追踪叠加**

## 两种追踪的本质区别

| | 同源追踪（层2） | 跨栈追踪（层3） |
|---|---|---|
| 关系 | 上游 → 下游消费者 | 上游 → 跨栈复刻 |
| 视角 | "影响我吗？和二开冲突吗？我需要吗？" | "要不要在另一个技术栈实现？难度多大？" |
| 代码关系 | 同源，可直接 cherry-pick | 异源，必须重写 |
| 对齐单位 | commit / PR | feature / bugfix 意图 |

## 数据结构

两种追踪共用 `upstream.yaml`，由追踪源 repo key 区分。类型从 config 推断，不冗余存储。

详见 [统一追踪设计](../plans/2026-03-09-unified-tracking-design.md)。
