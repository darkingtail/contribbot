import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TODO_STATUSES, UPSTREAM_ITEM_STATUSES, TODO_DIFFICULTIES, DAILY_COMMIT_ACTIONS } from '../core/enums.js'
import { componentTestCoverage } from '../core/tools/component-test-coverage.js'
import { vcDependencyStatus } from '../core/tools/vc-dependency-status.js'
import { issueDetail } from '../core/tools/issue-detail.js'
import { prSummary } from '../core/tools/pr-summary.js'
import { projectDashboard } from '../core/tools/project-dashboard.js'
import { upstreamSyncCheck, syncHistory } from '../core/tools/upstream-sync-check.js'
import { todoList, todoAdd, todoDone, todoDelete, todoArchive } from '../core/tools/todos.js'
import { todoActivate } from '../core/tools/todo-activate.js'
import { todoDetail } from '../core/tools/todo-detail.js'
import { todoUpdate } from '../core/tools/todo-update.js'
import { upstreamList, upstreamDetail, upstreamUpdate } from '../core/tools/upstream-manage.js'
import { upstreamDaily, upstreamDailyAct, upstreamDailySkipNoise } from '../core/tools/upstream-daily.js'
import { discussionList, discussionDetail } from '../core/tools/discussion-list.js'
import { actionsStatus } from '../core/tools/actions-status.js'
import { securityOverview } from '../core/tools/security-overview.js'
import { repoInfo } from '../core/tools/repo-info.js'
import { syncFork } from '../core/tools/sync-fork.js'
import { projectList } from '../core/tools/project-list.js'
import { repoConfig } from '../core/tools/repo-config-tool.js'
import { commentCreate } from '../core/tools/comment-create.js'
import { issueClose } from '../core/tools/issue-close.js'
import { issueCreate } from '../core/tools/issue-create.js'
import { prUpdate } from '../core/tools/pr-update.js'
import { prCreate } from '../core/tools/pr-create.js'
import { prReviewComments } from '../core/tools/pr-review-comments.js'
import { prReviewReply } from '../core/tools/pr-review-reply.js'
import { contributionStats } from '../core/tools/contribution-stats.js'
import { issueList, prList } from '../core/tools/issue-list.js'
import { skillWrite } from '../core/tools/skills.js'
import { listAllSkills, readSkill } from '../core/tools/skill-resources.js'

const repoParam = z.string().optional().describe('GitHub repo "owner/name". Default: antdv-next/antdv-next')

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<string> | string) {
  return async (args: Record<string, unknown>) => {
    try {
      const text = await fn(args)
      return { content: [{ type: 'text' as const, text }] }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text' as const, text: `## Error\n\n${msg}` }], isError: true }
    }
  }
}

const INSTRUCTIONS = `
contribbot 是开源贡献助手，帮助开发者高效参与开源项目维护。

## 工具组合逻辑

工具围绕贡献工作流设计，不是孤立使用的：

1. **同步 fork**：sync_fork → 开始工作前先同步上游
2. **建立上下文**：project_dashboard → 了解项目全貌（issues/PRs/commits/release）
3. **确认任务**：todo_list → 本地待办
4. **任务管理**：todo_add → 添加待办；todo_activate → 激活并创建实施记录；todo_detail → 查看实施详情；todo_update → 更新状态/关联PR/添加笔记；todo_done → 完成待办；todo_delete → 永久删除；todo_archive → 归档所有已完成
5. **深入调查**：issue_detail / pr_summary / discussion_detail → 具体问题的完整上下文
6. **同步上游**：upstream_sync_check → 对比上游 release 变更同步状态；sync_history → 历史记录
7. **上游版本管理**：upstream_list → 版本同步总览；upstream_detail → 版本详情；upstream_update → 更新同步条目
8. **上游每日追踪**：upstream_daily → 抓取上游最新提交并去重；upstream_daily_act → 标记提交动作（skip/todo/issue/pr）；upstream_daily_skip_noise → 批量跳过噪音
9. **质量保障**：actions_status → CI 状态；security_overview → 安全告警；component_test_coverage → 测试覆盖
10. **依赖管理**：vc_dependency_status → @v-c/* 包版本对比
11. **记录沉淀**：skill_write → 沉淀可复用经验；skills 以 MCP Resource 暴露（skill://{repo}/{name}），连接时自动可见
12. **GitHub 写入**：issue_create / issue_close / comment_create / pr_create / pr_update / pr_review_reply → 完整读写闭环
13. **全局视图**：project_list → 跨项目概况；repo_config → 仓库配置
14. **贡献统计**：contribution_stats → 个人贡献节奏
15. **搜索**：issue_list / pr_list → 按状态/标签/关键词搜索

## Agent 行为规则

- 创建 PR 后，如果有对应的 active todo，自动调 todo_update 关联
- 创建 issue 后，如果来自 upstream daily，自动调 upstream_daily_act 关联
- 关闭 issue 时，如果有对应的 todo，自动标记 done
- 回复 review 前，先用 pr_review_comments 获取评论列表

## 注意事项

- 大多数工具的 repo 参数默认 antdv-next/antdv-next，跨项目时需显式传 "owner/repo"
- vc_dependency_status 和 component_test_coverage 作为全局 MCP 运行时，需要传 project_root 参数
- 所有输出为 markdown 格式，表格类输出带备注列提供上下文
`.trim()

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'contribbot', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )

  // ── Project ──────────────────────────────────────────────

  server.tool(
    'project_dashboard',
    'Project overview: open issues/PRs stats, labels distribution, recent commits, latest release',
    { repo: repoParam },
    wrapHandler(async ({ repo }) => projectDashboard(repo as string | undefined)),
  )

  server.tool(
    'repo_info',
    'Repository metadata: stars, forks, topics, license, contributors',
    { repo: repoParam },
    wrapHandler(async ({ repo }) => repoInfo(repo as string | undefined)),
  )

  server.tool(
    'repo_config',
    'View or update repo config (role, org, fork, upstream). Auto-detects on first access.',
    {
      repo: repoParam,
      upstream: z.string().optional().describe('Set upstream repo, e.g. "ant-design/ant-design"'),
    },
    wrapHandler(async ({ repo, upstream }) => repoConfig(repo as string | undefined, upstream as string | undefined)),
  )

  server.tool(
    'sync_fork',
    'Sync fork default branch with upstream. Reads fork from config.yaml automatically.',
    {
      repo: repoParam,
      branch: z.string().optional().describe('Branch to sync. Default: repo default branch (usually main)'),
    },
    wrapHandler(async ({ repo, branch }) => syncFork(repo as string | undefined, branch as string | undefined)),
  )

  server.tool(
    'project_list',
    'List all tracked projects with todo and upstream stats',
    {},
    wrapHandler(() => projectList()),
  )

  // ── Todos ──────────────────────────────────────────────

  server.tool(
    'todo_list',
    'List personal todos stored locally in ~/.contribbot/{owner}/{repo}/todos.yaml (YAML-based)',
    {
      repo: repoParam,
      status: z.enum(TODO_STATUSES).optional().describe('Filter by status'),
    },
    wrapHandler(({ repo, status }) => todoList(repo as string | undefined, status as string | undefined)),
  )

  server.tool(
    'todo_add',
    'Add a personal todo. Optionally reference an issue to auto-detect type from labels.',
    {
      text: z.string().describe('Todo title, e.g. "研究 Cascader showSearch + loadData 共存方案"'),
      ref: z.string().optional().describe('标识：issue 编号（如 #259）或自定义名称（如 playground）'),
      repo: repoParam,
    },
    wrapHandler(async ({ text, ref, repo }) => todoAdd(text as string, ref as string | undefined, repo as string | undefined)),
  )

  server.tool(
    'todo_done',
    'Mark a todo as done. Pass the 1-based index number (of open todos) or a text substring to match.',
    {
      item: z.string().describe('Todo index (1, 2, 3…) or text substring to match'),
      repo: repoParam,
    },
    wrapHandler(({ item, repo }) => todoDone(item as string, repo as string | undefined)),
  )

  server.tool(
    'todo_delete',
    'Delete a todo permanently. Pass the 1-based index number (of open todos) or a text substring to match.',
    {
      item: z.string().describe('Todo index (1, 2, 3…) or text substring to match'),
      repo: repoParam,
    },
    wrapHandler(({ item, repo }) => todoDelete(item as string, repo as string | undefined)),
  )

  server.tool(
    'todo_archive',
    'Archive all done todos: move from todos.yaml to archive.yaml',
    { repo: repoParam },
    wrapHandler(({ repo }) => todoArchive(repo as string | undefined)),
  )

  server.tool(
    'todo_activate',
    'Activate a todo: fetch issue details, assess difficulty, create implementation record file',
    {
      item: z.string().describe('Todo index (1-based) or text substring to match'),
      repo: repoParam,
    },
    wrapHandler(async ({ item, repo }) => todoActivate(item as string, repo as string | undefined)),
  )

  server.tool(
    'todo_detail',
    'View todo implementation record with auto-refreshed PR reviews',
    {
      item: z.string().describe('Todo index (1-based) or text substring to match'),
      repo: repoParam,
    },
    wrapHandler(async ({ item, repo }) => todoDetail(item as string, repo as string | undefined)),
  )

  server.tool(
    'todo_update',
    'Update todo: change status, link PR, add notes',
    {
      item: z.string().describe('Todo index (1-based) or text substring to match'),
      status: z.enum(TODO_STATUSES).optional().describe('New status'),
      pr: z.number().optional().describe('PR number to link'),
      branch: z.string().optional().describe('Branch name to associate with the todo'),
      note: z.string().optional().describe('Note to append to implementation record'),
      repo: repoParam,
    },
    wrapHandler(({ item, status, pr, branch, note, repo }) =>
      todoUpdate(item as string, { status: status as string | undefined, pr: pr as number | undefined, branch: branch as string | undefined, note: note as string | undefined }, repo as string | undefined),
    ),
  )

  // ── Issues & PRs ─────────────────────────────────────────

  server.tool(
    'issue_list',
    'Search issues by state, labels, or keywords',
    {
      repo: repoParam,
      state: z.enum(['open', 'closed']).optional().describe('Filter: open | closed (default: open)'),
      labels: z.string().optional().describe('Comma-separated labels, e.g. "bug,sync"'),
      query: z.string().optional().describe('Additional search keywords'),
    },
    wrapHandler(async ({ repo, state, labels, query }) =>
      issueList(repo as string | undefined, state as string | undefined, labels as string | undefined, query as string | undefined),
    ),
  )

  server.tool(
    'pr_list',
    'Search pull requests by state or keywords',
    {
      repo: repoParam,
      state: z.enum(['open', 'closed', 'merged']).optional().describe('Filter: open | closed | merged (default: open)'),
      query: z.string().optional().describe('Additional search keywords'),
    },
    wrapHandler(async ({ repo, state, query }) =>
      prList(repo as string | undefined, state as string | undefined, query as string | undefined),
    ),
  )

  server.tool(
    'issue_detail',
    'Issue details: title, labels, linked PRs, antd references, comments summary',
    {
      issue_number: z.number().describe('GitHub issue number'),
      repo: repoParam,
    },
    wrapHandler(async ({ issue_number, repo }) => issueDetail(issue_number as number, repo as string | undefined)),
  )

  server.tool(
    'pr_summary',
    'PR summary: author, status, changed files grouped by component, CI checks, reviews',
    {
      pr_number: z.number().describe('GitHub PR number'),
      repo: repoParam,
    },
    wrapHandler(async ({ pr_number, repo }) => prSummary(pr_number as number, repo as string | undefined)),
  )

  server.tool(
    'comment_create',
    'Create a comment on an issue or PR',
    {
      issue_number: z.number().describe('Issue or PR number'),
      body: z.string().describe('Comment body (markdown)'),
      repo: repoParam,
    },
    wrapHandler(async ({ issue_number, body, repo }) =>
      commentCreate(issue_number as number, body as string, repo as string | undefined),
    ),
  )

  server.tool(
    'issue_close',
    'Close a GitHub issue, optionally with a comment and auto-complete todo',
    {
      issue_number: z.number().describe('Issue number to close'),
      comment: z.string().optional().describe('Closing comment'),
      todo_item: z.string().optional().describe('Todo index or text to mark as done'),
      repo: repoParam,
    },
    wrapHandler(async ({ issue_number, comment, todo_item, repo }) =>
      issueClose(issue_number as number, comment as string | undefined, todo_item as string | undefined, repo as string | undefined),
    ),
  )

  server.tool(
    'issue_create',
    'Create a GitHub issue, optionally link to upstream commit and auto-create todo',
    {
      title: z.string().describe('Issue title'),
      body: z.string().optional().describe('Issue body (markdown)'),
      labels: z.string().optional().describe('Comma-separated labels, e.g. "bug,sync"'),
      upstream_sha: z.string().optional().describe('Upstream daily commit SHA to link'),
      upstream_repo: z.string().optional().describe('Upstream repo for the commit, e.g. "ant-design/ant-design"'),
      auto_todo: z.boolean().optional().describe('Auto-create a todo for this issue (default: true)'),
      repo: repoParam,
    },
    wrapHandler(async ({ title, body, labels, upstream_sha, upstream_repo, auto_todo, repo }) =>
      issueCreate(
        title as string, body as string | undefined, labels as string | undefined,
        upstream_sha as string | undefined, upstream_repo as string | undefined,
        auto_todo as boolean | undefined, repo as string | undefined,
      ),
    ),
  )

  server.tool(
    'pr_update',
    'Update a pull request (title, body, state, draft)',
    {
      pr_number: z.number().describe('PR number'),
      title: z.string().optional().describe('New title'),
      body: z.string().optional().describe('New body'),
      state: z.enum(['open', 'closed']).optional().describe('New state'),
      draft: z.boolean().optional().describe('Draft status'),
      repo: repoParam,
    },
    wrapHandler(async ({ pr_number, title, body, state, draft, repo }) =>
      prUpdate(pr_number as number, { title, body, state, draft } as Record<string, unknown>, repo as string | undefined),
    ),
  )

  server.tool(
    'pr_create',
    'Create a pull request, optionally link to a todo',
    {
      title: z.string().describe('PR title'),
      head: z.string().optional().describe('Source branch (e.g. "user:feature-branch"). Auto-filled from linked todo branch if omitted.'),
      base: z.string().optional().describe('Target branch (default: main)'),
      body: z.string().optional().describe('PR description (markdown)'),
      draft: z.boolean().optional().describe('Create as draft PR (default: false)'),
      todo_item: z.string().optional().describe('Todo index or text to link (auto-sets status to pr_submitted)'),
      repo: repoParam,
    },
    wrapHandler(async ({ title, head, base, body, draft, todo_item, repo }) =>
      prCreate(
        title as string, head as string, base as string | undefined,
        body as string | undefined, draft as boolean | undefined,
        todo_item as string | undefined, repo as string | undefined,
      ),
    ),
  )

  server.tool(
    'pr_review_comments',
    'List all review comments on a PR with comment IDs, diff context, and content',
    {
      pr_number: z.number().describe('PR number'),
      repo: repoParam,
    },
    wrapHandler(async ({ pr_number, repo }) => prReviewComments(pr_number as number, repo as string | undefined)),
  )

  server.tool(
    'pr_review_reply',
    'Reply to a specific review comment on a PR',
    {
      pr_number: z.number().describe('PR number'),
      comment_id: z.number().describe('Review comment ID (from pr_review_comments)'),
      body: z.string().describe('Reply content (markdown)'),
      repo: repoParam,
    },
    wrapHandler(async ({ pr_number, comment_id, body, repo }) =>
      prReviewReply(pr_number as number, comment_id as number, body as string, repo as string | undefined),
    ),
  )

  // ── Discussions ───────────────────────────────────────────

  server.tool(
    'discussion_list',
    'List GitHub Discussions, optionally filtered by category',
    {
      repo: repoParam,
      category: z.string().optional().describe('Filter by category name, e.g. "Q&A"'),
    },
    wrapHandler(async ({ repo, category }) => discussionList(repo as string | undefined, category as string | undefined)),
  )

  server.tool(
    'discussion_detail',
    'Discussion details with all comments',
    {
      discussion_number: z.number().describe('Discussion number'),
      repo: repoParam,
    },
    wrapHandler(async ({ discussion_number, repo }) => discussionDetail(discussion_number as number, repo as string | undefined)),
  )

  // ── Actions ───────────────────────────────────────────────

  server.tool(
    'actions_status',
    'GitHub Actions workflow runs: recent CI status, failures highlight',
    {
      repo: repoParam,
      branch: z.string().optional().describe('Filter by branch name'),
    },
    wrapHandler(async ({ repo, branch }) => actionsStatus(repo as string | undefined, branch as string | undefined)),
  )

  // ── Security ──────────────────────────────────────────────

  server.tool(
    'security_overview',
    'Security alerts: Dependabot vulnerabilities, code scanning alerts',
    { repo: repoParam },
    wrapHandler(async ({ repo }) => securityOverview(repo as string | undefined)),
  )

  // ── Sync & Dependencies ───────────────────────────────────

  server.tool(
    'upstream_sync_check',
    'Compare upstream release changelog with fork sync status. Groups by feat/fix. Can save record per version.',
    {
      version: z.string().optional().describe('Release version, e.g. "5.24.0". Omit to check the latest release.'),
      upstream_repo: z.string().optional().describe('Upstream repo, e.g. "makeplane/plane". Default: ant-design/ant-design'),
      target_repo: z.string().optional().describe('Your fork, e.g. "darkingtail/plane". Default: antdv-next/antdv-next'),
      target_branch: z.string().optional().describe('Branch in target repo to check sync status against, e.g. "feature/dev". Omit to search all branches.'),
      save: z.boolean().optional().describe('Save the result to ~/.contribbot/{target}/sync/{version}.md for historical tracking'),
    },
    wrapHandler(async ({ version, upstream_repo, target_repo, target_branch, save }) =>
      upstreamSyncCheck(
        version as string | undefined, upstream_repo as string | undefined,
        target_repo as string | undefined, (save as boolean | undefined) ?? false,
        target_branch as string | undefined,
      ),
    ),
  )

  server.tool(
    'sync_history',
    'List all saved upstream sync records for a repo',
    { repo: repoParam },
    wrapHandler(({ repo }) => syncHistory(repo as string | undefined)),
  )

  server.tool(
    'upstream_list',
    'List upstream sync status: versions + daily commits summary',
    {
      repo: repoParam,
      upstream_repo: z.string().optional().describe('Filter by upstream repo, e.g. "ant-design/ant-design"'),
    },
    wrapHandler(({ repo, upstream_repo }) => upstreamList(repo as string | undefined, upstream_repo as string | undefined)),
  )

  server.tool(
    'upstream_detail',
    'View upstream version sync details or implementation record',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "ant-design/ant-design"'),
      version: z.string().describe('Release version, e.g. "6.3.1"'),
      repo: repoParam,
    },
    wrapHandler(async ({ upstream_repo, version, repo }) =>
      upstreamDetail(upstream_repo as string, version as string, repo as string | undefined),
    ),
  )

  server.tool(
    'upstream_update',
    'Update upstream sync item: status, PR, difficulty',
    {
      upstream_repo: z.string().describe('Upstream repo'),
      version: z.string().describe('Release version'),
      item_index: z.number().describe('Item index (1-based)'),
      status: z.enum(UPSTREAM_ITEM_STATUSES).optional().describe('New status'),
      pr: z.number().optional().describe('PR number'),
      difficulty: z.enum(TODO_DIFFICULTIES).optional().describe('Difficulty'),
      repo: repoParam,
    },
    wrapHandler(({ upstream_repo, version, item_index, status, pr, difficulty, repo }) =>
      upstreamUpdate(
        upstream_repo as string, version as string, item_index as number,
        { status: status as string | undefined, pr: pr as number | undefined, difficulty: difficulty as string | undefined },
        repo as string | undefined,
      ),
    ),
  )

  server.tool(
    'upstream_daily',
    'Fetch upstream commits since last tracked version. First run: shows releases to pick baseline.',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "ant-design/ant-design"'),
      since_tag: z.string().optional().describe('Baseline version tag for first-time init, e.g. "5.20.0"'),
      repo: repoParam,
    },
    wrapHandler(async ({ upstream_repo, since_tag, repo }) =>
      upstreamDaily(upstream_repo as string, repo as string | undefined, since_tag as string | undefined),
    ),
  )

  server.tool(
    'upstream_daily_act',
    'Mark a daily commit with an action: skip, todo, issue, pr, or synced',
    {
      upstream_repo: z.string().describe('Upstream repo'),
      sha: z.string().describe('Commit SHA (or prefix)'),
      action: z.enum(DAILY_COMMIT_ACTIONS).describe('Action'),
      ref: z.string().optional().describe('Related issue/PR reference, e.g. "#42"'),
      repo: repoParam,
    },
    wrapHandler(({ upstream_repo, sha, action, ref, repo }) =>
      upstreamDailyAct(upstream_repo as string, sha as string, action as string, ref as string | undefined, repo as string | undefined),
    ),
  )

  server.tool(
    'upstream_daily_skip_noise',
    'Batch skip all noise commits (CI, deps, build, React-only, sponsor, etc.)',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "ant-design/ant-design"'),
      repo: repoParam,
    },
    wrapHandler(({ upstream_repo, repo }) => upstreamDailySkipNoise(upstream_repo as string, repo as string | undefined)),
  )

  server.tool(
    'vc_dependency_status',
    'Check @v-c/* dependency updates vs npm latest',
    {
      component: z.string().optional().describe('Filter by name, e.g. "select"'),
      project_root: z.string().optional().describe('Absolute path to project root. Required when running as global MCP server.'),
    },
    wrapHandler(async ({ component, project_root }) =>
      vcDependencyStatus(component as string | undefined, project_root as string | undefined),
    ),
  )

  server.tool(
    'component_test_coverage',
    'Scan component test coverage: unit / semantic / demo tests per component',
    {
      component: z.string().optional().describe('Component name, e.g. "button". Omit for all.'),
      project_root: z.string().optional().describe('Absolute path to project root. Omit to auto-detect.'),
      components_dir: z.string().optional().describe('Absolute or relative-to-root path to components directory. Default: packages/antdv-next/src. For ant-design use: components'),
      tests_subdir: z.string().optional().describe('Name of tests subdirectory inside each component. Default: tests. For ant-design use: __tests__'),
    },
    wrapHandler(async ({ component, project_root, components_dir, tests_subdir }) =>
      componentTestCoverage(
        component as string | undefined, project_root as string | undefined,
        components_dir as string | undefined, tests_subdir as string | undefined,
      ),
    ),
  )

  server.tool(
    'contribution_stats',
    'Personal contribution stats: PRs created, issues opened, reviews given',
    {
      days: z.number().optional().describe('Stats period in days (default: 7)'),
      author: z.string().optional().describe('GitHub username (default: current user)'),
      repo: repoParam.describe('Target repo, or "all" for all tracked projects (default: all)'),
    },
    wrapHandler(async ({ days, author, repo }) =>
      contributionStats(days as number | undefined, author as string | undefined, repo as string | undefined),
    ),
  )

  // ── Skills (Resource + Tool) ─────────────────────────────

  server.resource(
    'skill',
    new ResourceTemplate('skill://{repo}/{skillName}', {
      list: async () => ({
        resources: listAllSkills().map(s => ({
          uri: `skill://${s.repo}/${s.name}`,
          name: `${s.repo} / ${s.name}`,
          description: s.description,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Skill',
      description: 'Personal reusable skills stored in ~/.contribbot/{owner}/{repo}/skills/',
      mimeType: 'text/markdown',
    },
    async (uri, { repo, skillName }) => {
      try {
        const content = readSkill(repo as string, skillName as string)
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/markdown',
            text: content ?? `Skill "${skillName}" not found in ${repo}.`,
          }],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/plain',
            text: `Error reading skill: ${msg}`,
          }],
        }
      }
    },
  )

  server.tool(
    'skill_write',
    'Create or update a personal skill in ~/.contribbot/{owner}/{repo}/skills/{name}/SKILL.md',
    {
      name: z.string().describe('Skill directory name, e.g. "upstream-sync"'),
      content: z.string().describe('Full SKILL.md content including frontmatter'),
      repo: repoParam,
    },
    wrapHandler(({ name, content, repo }) => skillWrite(name as string, content as string, repo as string | undefined)),
  )

  return server
}
