import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TODO_STATUSES, UPSTREAM_ITEM_STATUSES, TODO_DIFFICULTIES, DAILY_COMMIT_ACTIONS } from '../core/enums.js'
// ── Core: contribbot 独有能力 ────────────────────────────
import { todoList, todoAdd, todoDone, todoDelete, todoArchive } from '../core/tools/core/todos.js'
import { todoActivate } from '../core/tools/core/todo-activate.js'
import { todoDetail } from '../core/tools/core/todo-detail.js'
import { todoUpdate } from '../core/tools/core/todo-update.js'
import { upstreamSyncCheck, syncHistory } from '../core/tools/core/upstream-sync-check.js'
import { upstreamList, upstreamDetail, upstreamUpdate } from '../core/tools/core/upstream-manage.js'
import { upstreamDaily, upstreamDailyAct, upstreamDailySkipNoise } from '../core/tools/core/upstream-daily.js'
import { repoConfig } from '../core/tools/core/repo-config-tool.js'
import { projectList } from '../core/tools/core/project-list.js'
import { contributionStats } from '../core/tools/core/contribution-stats.js'
import { todoClaim } from '../core/tools/core/todo-claim.js'
import { todoCompact } from '../core/tools/core/todo-compact.js'
import { knowledgeWrite } from '../core/tools/core/knowledge.js'
import { listAllKnowledge, readKnowledge } from '../core/tools/core/knowledge-resources.js'

// ── Linkage: GitHub 操作 + 本地数据联动 ──────────────────
import { issueCreate } from '../core/tools/linkage/issue-create.js'
import { issueClose } from '../core/tools/linkage/issue-close.js'
import { prCreate } from '../core/tools/linkage/pr-create.js'
import { syncFork } from '../core/tools/linkage/sync-fork.js'

// ── Compat: 纯 GitHub 封装，保证开箱即用 ─────────────────
import { issueList, prList } from '../core/tools/compat/issue-list.js'
import { issueDetail } from '../core/tools/compat/issue-detail.js'
import { prSummary } from '../core/tools/compat/pr-summary.js'
import { prUpdate } from '../core/tools/compat/pr-update.js'
import { prReviewComments } from '../core/tools/compat/pr-review-comments.js'
import { prReviewReply } from '../core/tools/compat/pr-review-reply.js'
import { commentCreate } from '../core/tools/compat/comment-create.js'
import { discussionList, discussionDetail } from '../core/tools/compat/discussion-list.js'
import { actionsStatus } from '../core/tools/compat/actions-status.js'
import { securityOverview } from '../core/tools/compat/security-overview.js'
import { repoInfo } from '../core/tools/compat/repo-info.js'
import { projectDashboard } from '../core/tools/compat/project-dashboard.js'

const repoParam = z.string().optional().describe('GitHub repo "owner/name"')

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

## 项目模式

通过 repo_config 自动推断，决定可用工作流：

- **none**（fork=无, upstream=无）：无上游对齐关系
- **fork**（fork=有, upstream=无）：有 fork 源仓库，同源对齐（cherry-pick）
- **fork+upstream**（fork=有, upstream=有）：fork 同步 + 跨栈复刻追踪
- **upstream**（fork=无, upstream=有）：非 fork 跨栈追踪

首次进入项目时用 repo_config 查看模式。upstream_daily 和 upstream_sync_check 同时支持 fork source 和外部 upstream 追踪。

## 工具组合逻辑

1. **同步 fork**：sync_fork → 开始工作前同步上游（fork/fork+upstream 模式）
2. **建立上下文**：project_dashboard → 项目全貌
3. **任务管理**：todo_add → todo_activate → todo_claim（如有子任务）→ todo_detail → todo_update → todo_done → todo_archive
4. **深入调查**：issue_detail / pr_summary / discussion_detail
5. **上游追踪**：upstream_daily → 抓取上游提交；upstream_daily_act → 标记动作；upstream_daily_skip_noise → 跳过噪音
6. **版本同步**：upstream_sync_check → 对比 release 同步状态；upstream_list → 总览；upstream_detail → 详情
7. **质量保障**：actions_status → CI；security_overview → 安全告警
8. **GitHub 写入**：issue_create / issue_close / comment_create / pr_create / pr_update / pr_review_reply
9. **知识沉淀**：knowledge_write → 项目知识记录（Resource: knowledge://{repo}/{name}）
10. **全局视图**：project_list → 跨项目概况；repo_config → 仓库配置
11. **贡献统计**：contribution_stats → 个人贡献节奏
12. **搜索**：issue_list / pr_list → 按状态/标签/关键词搜索

## Agent 行为规则

- 首次进入项目：repo_config 查看模式，决定可用工作流
- 创建 PR 后：如有 active todo，自动 todo_update 关联
- 创建 issue 后：如来自 upstream daily，自动 upstream_daily_act 关联
- 关闭 issue 时：如有对应 todo，自动标记 done
- 回复 review 前：先用 pr_review_comments 获取评论列表

## 注意事项

- 所有工具的 repo 参数必须显式传 "owner/repo"，无默认值
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
      upstream: z.string().optional().describe('Set upstream repo, e.g. "upstream-org/upstream-repo"'),
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
    'Archive all done todos: move from todos.yaml to todos.archive.yaml',
    { repo: repoParam },
    wrapHandler(({ repo }) => todoArchive(repo as string | undefined)),
  )

  server.tool(
    'todo_compact',
    'Compact todo archive: remove old entries by date or keep count. Pass no params to see archive stats.',
    {
      before: z.string().optional().describe('Remove entries archived before this date (YYYY-MM-DD). Mutually exclusive with keep.'),
      keep: z.number().optional().describe('Keep only the latest N entries. Mutually exclusive with before.'),
      repo: repoParam,
    },
    wrapHandler(async ({ before, keep, repo }) =>
      todoCompact(before as string | undefined, keep as number | undefined, repo as string | undefined),
    ),
  )

  server.tool(
    'todo_activate',
    'Activate a todo: fetch issue details, assess difficulty, create implementation record. Branch name can be provided by LLM based on repo conventions, otherwise uses default naming.',
    {
      item: z.string().describe('Todo index (1-based) or text substring to match'),
      branch: z.string().optional().describe('Branch name suggested by LLM based on repo conventions. If omitted, uses default: prefix/number-slug'),
      repo: repoParam,
    },
    wrapHandler(async ({ item, branch, repo }) => todoActivate(item as string, branch as string | undefined, repo as string | undefined)),
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

  server.tool(
    'todo_claim',
    'Claim items from an issue: post a comment on GitHub and record locally. Use after todo_activate when LLM identifies claimable work in the issue body (subtasks, table rows, scope areas, or the whole issue).',
    {
      item: z.string().describe('Todo index (1-based) or text substring to match'),
      items: z.array(z.string()).describe('Work items to claim, identified by LLM from issue body'),
      repo: repoParam,
    },
    wrapHandler(async ({ item, items, repo }) =>
      todoClaim(item as string, items as string[], repo as string | undefined),
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
    'Issue details: title, labels, linked PRs, upstream references, comments summary',
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
      upstream_repo: z.string().optional().describe('Upstream repo for the commit, e.g. "upstream-org/upstream-repo"'),
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
    'Compare upstream release changelog (fork source or external upstream) with target repo sync status. Groups by feat/fix.',
    {
      version: z.string().optional().describe('Release version, e.g. "5.24.0". Omit to check the latest release.'),
      upstream_repo: z.string().describe('Upstream repo, e.g. "makeplane/plane"'),
      repo: z.string().describe('Your repo (fork or target), e.g. "darkingtail/plane"'),
      target_branch: z.string().optional().describe('Branch in target repo to check sync status against, e.g. "feature/dev". Omit to search all branches.'),
      save: z.boolean().optional().describe('Save the result to ~/.contribbot/{target}/sync/{version}.md for historical tracking'),
    },
    wrapHandler(async ({ version, upstream_repo, repo, target_branch, save }) =>
      upstreamSyncCheck(
        version as string | undefined, upstream_repo as string | undefined,
        repo as string | undefined, (save as boolean | undefined) ?? false,
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
      upstream_repo: z.string().optional().describe('Filter by upstream repo, e.g. "upstream-org/upstream-repo"'),
    },
    wrapHandler(({ repo, upstream_repo }) => upstreamList(repo as string | undefined, upstream_repo as string | undefined)),
  )

  server.tool(
    'upstream_detail',
    'View upstream version sync details or implementation record',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "upstream-org/upstream-repo"'),
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
    'Fetch commits from upstream repo (fork source or external upstream) since last tracked version. First run: shows releases to pick baseline.',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "upstream-org/upstream-repo"'),
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
    'Batch skip all noise commits (CI, deps, build, etc.)',
    {
      upstream_repo: z.string().describe('Upstream repo, e.g. "upstream-org/upstream-repo"'),
      repo: repoParam,
    },
    wrapHandler(({ upstream_repo, repo }) => upstreamDailySkipNoise(upstream_repo as string, repo as string | undefined)),
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

  // ── Knowledge (Resource + Tool) ─────────────────────────

  server.resource(
    'knowledge',
    new ResourceTemplate('knowledge://{+repo}/{knowledgeName}', {
      list: async () => ({
        resources: listAllKnowledge().map(k => ({
          uri: `knowledge://${k.repo}/${k.name}`,
          name: `${k.repo} / ${k.name}`,
          description: k.description,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Knowledge',
      description: 'Project knowledge stored in ~/.contribbot/{owner}/{repo}/knowledge/',
      mimeType: 'text/markdown',
    },
    async (uri, { repo, knowledgeName }) => {
      try {
        const content = readKnowledge(repo as string, knowledgeName as string)
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/markdown',
            text: content ?? `Knowledge "${knowledgeName}" not found in ${repo}.`,
          }],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'text/plain',
            text: `Error reading knowledge: ${msg}`,
          }],
        }
      }
    },
  )

  server.tool(
    'knowledge_write',
    'Create or update project knowledge in ~/.contribbot/{owner}/{repo}/knowledge/{name}/README.md',
    {
      name: z.string().describe('Knowledge directory name, e.g. "upstream-sync"'),
      content: z.string().describe('Full README.md content including frontmatter'),
      repo: repoParam,
    },
    wrapHandler(({ name, content, repo }) => knowledgeWrite(name as string, content as string, repo as string | undefined)),
  )

  // ── MCP Prompts (enhanced versions of Skills, using MCP tools) ──

  server.registerPrompt('daily-sync', {
    title: 'Daily Upstream Sync',
    description: 'Enhanced workflow: check project mode, sync fork, fetch upstream commits, skip noise, triage remaining',
    argsSchema: { repo: repoParam },
  }, ({ repo }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Execute the daily upstream sync workflow for ${repo ?? 'the project'}:`,
          '',
          '1. `repo_config` — check project mode (none/fork/fork+upstream/upstream)',
          '2. If fork exists: `sync_fork` — sync fork to upstream latest',
          '3. For each tracking source (fork source and/or external upstream):',
          '   - `upstream_daily` — fetch new commits since last tracked version',
          '   - `upstream_daily_skip_noise` — batch skip CI/deps/build noise',
          '   - Review remaining pending commits and suggest actions',
          '   - For relevant commits: create issues or link to existing ones via `upstream_daily_act`',
          '4. If mode is "none": skip upstream tracking, show project_dashboard + issue_list + actions_status + security_overview',
          '',
          'Show a summary when done: mode, how many new, skipped, linked, and still pending per tracking source.',
        ].join('\n'),
      },
    }],
  }))

  server.registerPrompt('start-task', {
    title: 'Start Task',
    description: 'Enhanced workflow: enter project context, pick a todo, activate it, review details',
    argsSchema: {
      repo: repoParam,
      item: z.string().optional().describe('Todo item to activate (index or text match)'),
    },
  }, ({ repo, item }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Start a task in ${repo ?? 'default repo'}:`,
          '',
          '1. `repo_config` — check project mode, if fork suggest sync_fork first',
          '2. `project_dashboard` — understand project state (issues, PRs, recent activity)',
          '3. `todo_list` — review current todos',
          item
            ? `4. \`todo_activate(item="${item}")\` — activate the specified todo`
            : '4. Help me pick a todo to work on based on priority and difficulty',
          '5. `todo_detail` — review implementation record and context',
          '6. Summarize: what the task is, related issues/discussions, suggested approach',
        ].join('\n'),
      },
    }],
  }))

  server.registerPrompt('pre-submit', {
    title: 'Pre-Submit Check',
    description: 'Enhanced workflow: review PR changes, check CI, review comments, security alerts, prepare for merge',
    argsSchema: {
      repo: repoParam,
      pr: z.string().describe('PR number to review'),
    },
  }, ({ repo, pr }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Pre-submit check for PR #${pr} in ${repo ?? 'default repo'}:`,
          '',
          '1. `pr_summary` — review PR changes and description',
          '2. `pr_review_comments` — check all review comments, ensure none unresolved',
          '3. `actions_status` — verify CI is passing',
          '4. `security_overview` — check for security alerts',
          '5. If review comments need replies, use `pr_review_reply`',
          '6. If PR has linked todo, `todo_update` to set status=pr_submitted',
          '7. Report: CI status, unresolved comments, security alerts, merge readiness',
        ].join('\n'),
      },
    }],
  }))

  server.registerPrompt('weekly-review', {
    title: 'Weekly Review',
    description: 'Enhanced workflow: review contribution stats, todo progress, upstream sync status, archive done todos',
    argsSchema: {
      repo: z.string().optional().describe('Specific repo to review, or omit for cross-project overview'),
    },
  }, ({ repo }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          repo
            ? `Weekly review for ${repo}:`
            : 'Cross-project weekly review:',
          '',
          repo
            ? [
                '1. `contribution_stats` — PR/issue/review counts this week',
                '2. `todo_list` — which todos progressed, which are stuck',
                '3. `upstream_list` — upstream sync coverage (skip for none mode)',
                '4. `todo_archive` — clean up completed todos',
                '5. Summary: wins, blockers, focus for next week',
              ].join('\n')
            : [
                '1. `project_list` — overview all tracked projects',
                '2. For each active project:',
                '   - `contribution_stats` — this week\'s activity',
                '   - `todo_list` — stuck items',
                '   - `upstream_list` — sync gaps',
                '3. `todo_archive` — clean up completed todos across projects',
                '4. Cross-project summary: total output, blockers, priorities for next week',
              ].join('\n'),
        ].join('\n'),
      },
    }],
  }))

  return server
}
