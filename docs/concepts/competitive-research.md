# 竞品调研 (2026-03-09)

## 结论：没有直接竞品

contribbot 的场景 —"个人开源贡献者的上游追踪 + 自主同步 Agent"— 是空白领域。

## 现有工具对比

| 项目 | 方向 | 和 contribbot 的区别 |
|------|------|---------------------|
| GitHub Agentic Workflows | 仓库维护者自动化（triage/review/CI） | 面向维护者，不是贡献者 |
| trIAge | AI issue/PR 分析 | 只读分析，不做同步追踪 |
| wei/pull / Fork-Sync actions | 自动同步 fork 分支 | 只同步代码，不追踪 commits、不做 triage |
| GitHub MCP Server | 通用 GitHub API 的 MCP 封装 | 通用工具，没有贡献工作流 |
| Dosu / Copilot | 仓库内 AI 助手 | 面向维护者/团队 |
| nanobot | 通用个人 AI 助手 | 通用框架，没有贡献领域知识 |

## contribbot 独特价值

1. **贡献者视角** — 从"我要给别人的项目贡献"出发，不是维护自己的项目
2. **上游 commit 级追踪** — 逐条 commit triage + 同步状态管理，没人做这个
3. **项目知识沉淀** — skill 系统让判断标准可积累，Agent 越用越聪明
4. **跨框架 port 场景** — React→Vue 等 port 项目的同步需求无现成工具

## 参考链接

- [GitHub Agentic Workflows](https://github.blog/changelog/2026-02-13-github-agentic-workflows-are-now-in-technical-preview/)
- [trIAge](https://github.com/trIAgelab/trIAge)
- [wei/pull](https://github.com/wei/pull)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [nanobot (HKUDS)](https://github.com/HKUDS/nanobot)
- [nanobot (nanobot-ai)](https://github.com/nanobot-ai/nanobot)
