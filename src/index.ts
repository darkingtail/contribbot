// Core tools - can be used programmatically without MCP
export { componentTestCoverage } from './core/tools/component-test-coverage.js'
export { vcDependencyStatus } from './core/tools/vc-dependency-status.js'
export { issueDetail } from './core/tools/issue-detail.js'
export { prSummary } from './core/tools/pr-summary.js'
export { projectDashboard } from './core/tools/project-dashboard.js'
export { upstreamSyncCheck } from './core/tools/upstream-sync-check.js'
export { todoActivate } from './core/tools/todo-activate.js'
export { todoDetail } from './core/tools/todo-detail.js'
export { todoUpdate } from './core/tools/todo-update.js'
export { upstreamList, upstreamDetail, upstreamUpdate } from './core/tools/upstream-manage.js'
export { upstreamDaily, upstreamDailyAct } from './core/tools/upstream-daily.js'

// MCP server factory
export { createServer } from './mcp/server.js'
