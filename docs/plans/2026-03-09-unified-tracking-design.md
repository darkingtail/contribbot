# 统一追踪设计（2026-03-09）

## 背景

contribbot 支持三种项目模式（由 config.yaml 的 fork + upstream 字段推断）：

| fork | upstream | 模式 | 对齐方式 |
|------|----------|------|---------|
| 有 | 有 | fork+upstream | fork 同步 + 跨栈复刻 |
| 有 | 无 | fork | 同源对齐，选择性 cherry-pick |
| 无 | 无 | own | 不需要对齐 |

完整 6 种场景（fork × upstream × 二开分支）：

| # | fork | upstream | 二开 | 场景 | 例子 |
|---|------|----------|------|------|------|
| 1 | 无 | 无 | 无 | own | contribbot |
| 2 | 有 | 无 | 无 | 纯 fork 贡献 | fork React 修 bug |
| 3 | 有 | 无 | 有 | fork + 二开 | plane / feature/dev |
| 4 | 有 | 有 | 无 | fork + 跨栈复刻 | antdv-next 对齐 ant-design |
| 5 | 有 | 有 | 有 | fork + 二开 + 跨栈 | 理论存在 |
| 6 | 无 | 有 | 无 | 非 fork 跨栈 | 从零建库追踪外部仓库 |

三层核心能力：
1. **基础** — issue/PR/todo 管理（所有模式）
2. **同源追踪** — fork commit cherry-pick 决策（#3、#5）
3. **跨栈追踪** — 外部仓库 commit 复刻决策（#4、#5、#6）

## 设计决策

### 1. 统一存储：upstream.yaml 不改

fork 追踪和跨栈追踪共用 upstream.yaml。理由：

- 数据结构几乎一样：commits 列表 + triage 决策
- 来源 repo key 天然区分（`makeplane/plane` vs `ant-design/ant-design`）
- 一套 store、一套工具、一个心智模型

### 2. config.yaml 不改

保持四个字段：`role`、`org`、`fork`、`upstream`。

- 不加 branch 信息 — 二开分支是 sync 层关注的，不是追踪配置
- 不加 mode 字段 — 从 fork + upstream 推断

### 3. 追踪源类型从 config 推断

upstream.yaml 不存 type 字段。工具层判断逻辑：

```
config.upstream === tracking_repo_key → 跨栈复刻
config.fork parent === tracking_repo_key → 同源追踪
```

### 4. action 枚举不改

`skip | todo | issue | pr | synced` 足够覆盖 fork 和跨栈两种场景。

skip 不区分原因（不相关/冲突/以后再说），如果将来需要可加 `reason` 字段扩展。

### 5. cherry-pick / branch 信息不存

追踪层只管 triage 决策（要不要、为什么）。cherry-pick 到哪个分支是 sync 操作的事。

## 变更范围

**数据结构：无变更。** 现有 upstream.yaml / config.yaml 已能支持。

**工具层需扩展：**

- `upstream_daily` — 支持对 fork source 拉 commits（现在只对 config.upstream）
- `upstream_sync_check` — 支持对 fork source 做版本对比
- 工具展示 — 根据 config 推断关系类型，调整措辞（"同步" vs "复刻"）

## 数据结构参考（不变）

### config.yaml

```yaml
role: write
org: antdv-next
fork: darkingtail/antdv-next    # 有值 = 有 fork 关系
upstream: ant-design/ant-design  # 有值 = 跨栈追踪
```

### upstream.yaml

```yaml
"ant-design/ant-design":        # key = 追踪源 repo
  versions:
    - version: "6.3.0"
      status: active
      items:
        - title: "feat: xxx"
          type: feature
          difficulty: null
          status: active
          pr: null
  daily:
    last_checked: "2026-03-09"
    commits:
      - sha: abc123
        message: "fix: xxx"
        type: fix
        date: "2026-03-08"
        action: null              # skip | todo | issue | pr | synced
        ref: null                 # 关联的 issue/PR
```

fork 追踪时，key 变成 fork source（如 `makeplane/plane`），结构完全一样。
