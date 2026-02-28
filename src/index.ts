// Core tools - can be used programmatically without MCP
export { componentTestCoverage } from './core/tools/component-test-coverage.js'
export { vcDependencyStatus } from './core/tools/vc-dependency-status.js'
export { issueDetail } from './core/tools/issue-detail.js'
export { prSummary } from './core/tools/pr-summary.js'
export { projectDashboard } from './core/tools/project-dashboard.js'
export { upstreamSyncCheck } from './core/tools/upstream-sync-check.js'

// MCP server factory
export { createServer } from './mcp/server.js'
