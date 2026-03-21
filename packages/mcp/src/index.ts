// Enums
export {
  TodoStatus, TodoType, TodoDifficulty,
  UpstreamItemStatus, UpstreamVersionStatus,
  DailyCommitAction, RepoRole, PRType,
  TODO_STATUSES, TODO_TYPES, TODO_DIFFICULTIES,
  UPSTREAM_ITEM_STATUSES, DAILY_COMMIT_ACTIONS,
} from './core/enums.js'

// Core layer — contribbot 独有能力
export { todoList, todoAdd, todoDone, todoDelete, todoArchive } from './core/tools/core/todos.js'
export { todoActivate } from './core/tools/core/todo-activate.js'
export { todoDetail } from './core/tools/core/todo-detail.js'
export { todoUpdate } from './core/tools/core/todo-update.js'
export { upstreamSyncCheck, syncHistory } from './core/tools/core/upstream-sync-check.js'
export { upstreamList, upstreamDetail, upstreamUpdate } from './core/tools/core/upstream-manage.js'
export { upstreamDaily, upstreamDailyAct, upstreamDailySkipNoise } from './core/tools/core/upstream-daily.js'
export { repoConfig } from './core/tools/core/repo-config-tool.js'
export { projectList } from './core/tools/core/project-list.js'
export { contributionStats } from './core/tools/core/contribution-stats.js'
export { todoClaim } from './core/tools/core/todo-claim.js'
export { todoCompact } from './core/tools/core/todo-compact.js'
export { upstreamCompact } from './core/tools/core/upstream-compact.js'
export { knowledgeList, knowledgeRead, knowledgeWrite } from './core/tools/core/knowledge.js'
export { listAllKnowledge, readKnowledge } from './core/tools/core/knowledge-resources.js'

// Linkage layer — GitHub 操作 + 本地数据联动
export { issueCreate } from './core/tools/linkage/issue-create.js'
export { issueClose } from './core/tools/linkage/issue-close.js'
export { prCreate } from './core/tools/linkage/pr-create.js'
export { syncFork } from './core/tools/linkage/sync-fork.js'

// Compat layer — 纯 GitHub 封装
export { issueList, prList } from './core/tools/compat/issue-list.js'
export { issueDetail } from './core/tools/compat/issue-detail.js'
export { prSummary } from './core/tools/compat/pr-summary.js'
export { prUpdate } from './core/tools/compat/pr-update.js'
export { prReviewComments } from './core/tools/compat/pr-review-comments.js'
export { prReviewReply } from './core/tools/compat/pr-review-reply.js'
export { commentCreate } from './core/tools/compat/comment-create.js'
export { discussionList, discussionDetail } from './core/tools/compat/discussion-list.js'
export { actionsStatus } from './core/tools/compat/actions-status.js'
export { securityOverview } from './core/tools/compat/security-overview.js'
export { repoInfo } from './core/tools/compat/repo-info.js'
export { projectDashboard } from './core/tools/compat/project-dashboard.js'

// Storage utilities
export { inferMode } from './core/storage/repo-config.js'
export type { ProjectMode } from './core/storage/repo-config.js'

// Utilities
export { safeWriteFileSync } from './core/utils/fs.js'
export { resolveRepo, resolveToParent } from './core/utils/resolve-repo.js'

// MCP server factory
export { createServer } from './mcp/server.js'
