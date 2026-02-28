import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { componentTestCoverage } from '../core/tools/component-test-coverage.js'
import { vcDependencyStatus } from '../core/tools/vc-dependency-status.js'
import { issueDetail } from '../core/tools/issue-detail.js'
import { prSummary } from '../core/tools/pr-summary.js'
import { projectDashboard } from '../core/tools/project-dashboard.js'
import { upstreamSyncCheck, syncHistory } from '../core/tools/upstream-sync-check.js'
import { myMissions } from '../core/tools/my-missions.js'
import { todoList, todoAdd, todoDone } from '../core/tools/todos.js'
import { discussionList, discussionDetail } from '../core/tools/discussion-list.js'
import { actionsStatus } from '../core/tools/actions-status.js'
import { securityOverview } from '../core/tools/security-overview.js'
import { repoInfo } from '../core/tools/repo-info.js'
import { skillList, skillRead, skillWrite } from '../core/tools/skills.js'

const repoParam = z.string().optional().describe('GitHub repo "owner/name". Default: antdv-next/antdv-next')

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'contrib',
    version: '0.1.0',
  })

  // ── Project ──────────────────────────────────────────────

  server.tool(
    'project_dashboard',
    'Project overview: open issues/PRs stats, labels distribution, recent commits, latest release',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: await projectDashboard(repo) }] }),
  )

  server.tool(
    'repo_info',
    'Repository metadata: stars, forks, topics, license, contributors',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: await repoInfo(repo) }] }),
  )

  // ── My Work ──────────────────────────────────────────────

  server.tool(
    'my_missions',
    'My active work: open PRs I authored, issues assigned to me, issues I commented on, issues that mention me',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: await myMissions(repo) }] }),
  )

  server.tool(
    'todo_list',
    'List personal todos stored locally in ~/.contrib/{owner}/{repo}/todos.md',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: todoList(repo) }] }),
  )

  server.tool(
    'todo_add',
    'Add a personal todo. Can reference an issue number, e.g. "#259 研究 Cascader 方案"',
    {
      text: z.string().describe('Todo text, e.g. "#259 研究 Cascader showSearch + loadData 共存方案"'),
      repo: repoParam,
    },
    async ({ text, repo }) => ({ content: [{ type: 'text', text: todoAdd(text, repo) }] }),
  )

  server.tool(
    'todo_done',
    'Mark a todo as done. Pass the 1-based index number or a text substring to match.',
    {
      item: z.string().describe('Todo index (1, 2, 3…) or text substring to match'),
      repo: repoParam,
    },
    async ({ item, repo }) => ({ content: [{ type: 'text', text: todoDone(item, repo) }] }),
  )

  // ── Issues & PRs ─────────────────────────────────────────

  server.tool(
    'issue_detail',
    'Issue details: title, labels, linked PRs, antd references, comments summary',
    {
      issue_number: z.number().describe('GitHub issue number'),
      repo: repoParam,
    },
    async ({ issue_number, repo }) => ({ content: [{ type: 'text', text: await issueDetail(issue_number, repo) }] }),
  )

  server.tool(
    'pr_summary',
    'PR summary: author, status, changed files grouped by component, CI checks, reviews',
    {
      pr_number: z.number().describe('GitHub PR number'),
      repo: repoParam,
    },
    async ({ pr_number, repo }) => ({ content: [{ type: 'text', text: await prSummary(pr_number, repo) }] }),
  )

  // ── Discussions ───────────────────────────────────────────

  server.tool(
    'discussion_list',
    'List GitHub Discussions, optionally filtered by category',
    {
      repo: repoParam,
      category: z.string().optional().describe('Filter by category name, e.g. "Q&A"'),
    },
    async ({ repo, category }) => ({ content: [{ type: 'text', text: await discussionList(repo, category) }] }),
  )

  server.tool(
    'discussion_detail',
    'Discussion details with all comments',
    {
      discussion_number: z.number().describe('Discussion number'),
      repo: repoParam,
    },
    async ({ discussion_number, repo }) => ({ content: [{ type: 'text', text: await discussionDetail(discussion_number, repo) }] }),
  )

  // ── Actions ───────────────────────────────────────────────

  server.tool(
    'actions_status',
    'GitHub Actions workflow runs: recent CI status, failures highlight',
    {
      repo: repoParam,
      branch: z.string().optional().describe('Filter by branch name'),
    },
    async ({ repo, branch }) => ({ content: [{ type: 'text', text: await actionsStatus(repo, branch) }] }),
  )

  // ── Security ──────────────────────────────────────────────

  server.tool(
    'security_overview',
    'Security alerts: Dependabot vulnerabilities, code scanning alerts',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: await securityOverview(repo) }] }),
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
      save: z.boolean().optional().describe('Save the result to ~/.contrib/{target}/sync/{version}.md for historical tracking'),
    },
    async ({ version, upstream_repo, target_repo, target_branch, save }) => ({
      content: [{ type: 'text', text: await upstreamSyncCheck(version, upstream_repo, target_repo, save ?? false, target_branch) }],
    }),
  )

  server.tool(
    'sync_history',
    'List all saved upstream sync records for a repo',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: syncHistory(repo) }] }),
  )

  server.tool(
    'vc_dependency_status',
    'Check @v-c/* dependency updates vs npm latest',
    {
      component: z.string().optional().describe('Filter by name, e.g. "select"'),
      project_root: z.string().optional().describe('Absolute path to project root. Required when running as global MCP server.'),
    },
    async ({ component, project_root }) => ({ content: [{ type: 'text', text: await vcDependencyStatus(component, project_root) }] }),
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
    async ({ component, project_root, components_dir, tests_subdir }) => ({
      content: [{ type: 'text', text: await componentTestCoverage(component, project_root, components_dir, tests_subdir) }],
    }),
  )

  // ── Skills ────────────────────────────────────────────────

  server.tool(
    'skill_list',
    'List all personal skills stored in ~/.contrib/{owner}/{repo}/skills/',
    { repo: repoParam },
    async ({ repo }) => ({ content: [{ type: 'text', text: skillList(repo) }] }),
  )

  server.tool(
    'skill_read',
    'Read the content of a personal skill',
    {
      name: z.string().describe('Skill directory name, e.g. "component-test"'),
      repo: repoParam,
    },
    async ({ name, repo }) => ({ content: [{ type: 'text', text: skillRead(name, repo) }] }),
  )

  server.tool(
    'skill_write',
    'Create or update a personal skill in ~/.contrib/{owner}/{repo}/skills/{name}/SKILL.md',
    {
      name: z.string().describe('Skill directory name, e.g. "upstream-sync"'),
      content: z.string().describe('Full SKILL.md content including frontmatter'),
      repo: repoParam,
    },
    async ({ name, content, repo }) => ({ content: [{ type: 'text', text: skillWrite(name, content, repo) }] }),
  )

  return server
}
