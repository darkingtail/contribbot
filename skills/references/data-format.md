# contribbot 数据格式参考

所有 contribbot Skills 共享此数据格式。数据存储在 `~/.contribbot/{owner}/{repo}/` 下。

## 目录结构

```
~/.contribbot/{owner}/{repo}/
├── config.yaml          # 仓库配置
├── todos.yaml           # todo 索引
├── todos/               # todo 实现记录
│   ├── 281.md           # 以 issue 编号命名
│   └── idea-1.md        # 纯想法
├── upstream.yaml        # 上游追踪索引
├── upstream/            # 上游实现记录
│   └── {upstream-owner}/{upstream-repo}/
│       └── {version}.md
├── archive.yaml         # 已完成 todos 归档
├── skills/              # 可复用经验
└── sync/                # 同步记录
```

## config.yaml

```yaml
role: write              # admin | maintain | write | triage | read
org: antdv-next          # 组织名（null = 个人仓库）
fork: owner/repo         # fork 源仓库（null = 非 fork）
upstream: owner/repo     # 外部 upstream（null = 无跨栈追踪）
```

**模式推断**（ProjectMode）：

| fork | upstream | 模式 |
|------|----------|------|
| 有值 | 有值 | fork+upstream |
| 有值 | null | fork |
| null | 有值 | upstream |
| null | null | none |

## todos.yaml

```yaml
todos:
  - ref: "281"           # issue 编号或 idea-N
    title: "修复 XXX"
    type: bug             # bug | feat | chore | refactor | docs | idea
    status: active        # idea | backlog | active | pr_submitted | done
    difficulty: medium     # easy | medium | hard | null
    pr: 285               # 关联 PR 编号（null = 未关联）
    branch: fix/281       # 工作分支（null = 未创建）
    created: "2026-03-01"
    updated: "2026-03-05"
```

## upstream.yaml

```yaml
versions:
  - repo: "ant-design/ant-design"    # 追踪源
    tag: "5.24.0"                     # 锚点版本
    items:                            # 版本同步条目
      - title: "feat: new component"
        status: pending               # pending | tracking | synced | skipped
        pr: null
        difficulty: null

daily:
  "ant-design/ant-design":            # 追踪源
    lastFetched: "2026-03-10"
    sinceTag: "5.24.0"                # 锚点
    commits:
      - sha: "abc1234"
        message: "feat: add Button group"
        author: "afc163"
        date: "2026-03-09"
        action: pending               # pending | skip | todo | issue | pr | synced
        ref: null                     # 关联的 issue/todo 编号
```

## 常用 gh CLI 命令

### 仓库信息
```bash
gh api repos/{owner}/{repo} --jq '{name: .name, fork: .fork, parent: .parent.full_name, description: .description}'
```

### Issues
```bash
gh issue list -R {owner}/{repo} --state open --json number,title,labels,createdAt,author --limit 30
gh issue view {number} -R {owner}/{repo} --json number,title,body,labels,comments,state
gh issue create -R {owner}/{repo} --title "..." --body "..."
gh issue close {number} -R {owner}/{repo}
```

### Pull Requests
```bash
gh pr list -R {owner}/{repo} --state open --json number,title,state,createdAt,author --limit 30
gh pr view {number} -R {owner}/{repo} --json number,title,body,files,reviews,comments,state
gh pr create -R {owner}/{repo} --title "..." --body "..." --head {branch}
```

### CI / Actions
```bash
gh run list -R {owner}/{repo} --limit 5 --json status,conclusion,name,headBranch,createdAt
```

### Releases & Tags
```bash
gh release list -R {owner}/{repo} --limit 10 --json tagName,publishedAt,name
gh api repos/{owner}/{repo}/tags --jq '.[].name' | head -10
```

### Commits（两点对比）
```bash
gh api "repos/{owner}/{repo}/compare/{base}...{head}" --jq '.commits[] | {sha: .sha[0:7], message: .commit.message, author: .commit.author.name, date: .commit.author.date}'
```

### Fork 同步
```bash
gh repo sync {owner}/{repo}
```

### 安全告警
```bash
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length'
```

## 噪音 commit 判断规则

以下 commit 消息模式通常是噪音，可批量跳过：

- `ci:` / `ci(...)` — CI 配置
- `build:` / `build(...)` — 构建配置
- `chore(deps):` / `chore(deps-dev):` — 依赖更新
- `style:` / `style(...)` — 代码风格
- `Merge branch` / `Merge pull request` — 合并提交
- `bump version` / `release:` — 版本发布
