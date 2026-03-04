# Per-Repo Config 设计

[TOC]

## 目标

为每个贡献仓库提供 `config.yaml` 配置文件，记录贡献者角色、fork 关系、上游仓库等信息，让工具自动适配工作流，减少重复传参。

## 数据结构

文件位置：`~/.contrib/{owner}/{repo}/config.yaml`

```yaml
role: member                         # external | member | collaborator
org: antdv-next                      # 组织名，个人仓库为 null
fork: darkingtail/antdv-next         # 我的 fork 全名，无 fork 为 null
upstream: ant-design/ant-design      # 上游源仓库，无上游为 null
```

### 字段说明

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `role` | `external \| member \| collaborator` | 自动检测 | 基于 push 权限 + 组织成员身份 |
| `org` | `string \| null` | 自动检测 | owner 的 type=Organization 则填组织名 |
| `fork` | `string \| null` | 自动检测 | `{currentUser}/{repo}` 是否为 fork |
| `upstream` | `string \| null` | 手动补充 | 上游源仓库，需要版本/每日对齐时填写 |

### role 判定逻辑

```
permissions.push = true → collaborator
org member check 200    → member
otherwise               → external
```

1. `gh api repos/{owner}/{repo}` → `permissions.push`
2. 如果 owner 是 Organization → `gh api orgs/{org}/members/{currentUser}` → 200 = member
3. 否则 → external

## 自动初始化

工具首次访问某仓库时，如果 `config.yaml` 不存在：

1. 获取当前用户: `gh api user` → login
2. 检测 owner 类型: `gh api users/{owner}` → type
3. 检测权限: `gh api repos/{owner}/{repo}` → permissions.push
4. 检测组织成员: `gh api orgs/{org}/members/{user}` (仅 org 类型)
5. 检测 fork: `gh api repos/{user}/{repo}` → fork + parent
6. 写入 `config.yaml`，upstream 留 null

## 工具联动

| 工具 | 读取字段 | 效果 |
|------|---------|------|
| `sync_fork` | fork | 自动知道同步哪个 fork，无需传参 |
| `upstream_daily` | upstream | 自动知道上游仓库 |
| `upstream_sync_check` | upstream | 自动知道上下游对应关系 |
| `project_dashboard` | fork, upstream | 可展示对齐状态摘要 |
| `repo_config`（新增） | 全部 | 查看/修改 config.yaml |

## 新增工具

### repo_config

查看或修改仓库配置。

- `repo_config(repo?)` — 查看配置（不存在则自动初始化）
- `repo_config(repo?, upstream?)` — 设置 upstream 字段

## 实际数据

```yaml
# ~/.contrib/antdv-next/antdv-next/config.yaml
role: member
org: antdv-next
fork: darkingtail/antdv-next
upstream: ant-design/ant-design

# ~/.contrib/makeplane/plane/config.yaml
role: external
org: makeplane
fork: darkingtail/plane
upstream: null

# ~/.contrib/agentscope-ai/CoPaw/config.yaml
role: external
org: agentscope-ai
fork: darkingtail/CoPaw
upstream: null
```
