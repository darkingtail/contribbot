import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface IssueRecordInfo {
  title: string
  link: string
  labels: string
  author: string
  createdAt: string
  commentsSummary: string
  body: string
}

interface UpstreamRecordInfo {
  link: string
  publishedAt: string
  items: string[]
}

interface PRReview {
  user: string
  body: string
}

const PR_FEEDBACK_MARKER = '<!-- 自动追加 -->'

export class RecordFiles {
  constructor(private baseDir: string) {}

  createIssueRecord(issueNumber: number, info: IssueRecordInfo): string {
    const dir = join(this.baseDir, 'todos')
    this.ensureDir(dir)

    const content = [
      `# #${issueNumber} ${info.title}`,
      '',
      '## Issue 信息',
      '',
      `| 字段 | 值 |`,
      `|------|------|`,
      `| 链接 | ${info.link} |`,
      `| 标签 | ${info.labels} |`,
      `| 作者 | ${info.author} |`,
      `| 创建时间 | ${info.createdAt} |`,
      '',
      info.body ? `> ${info.body}` : '',
      '',
      '## 评论总结',
      '',
      info.commentsSummary || '_暂无评论_',
      '',
      '## 分析',
      '',
      '_待分析_',
      '',
      '## 实现计划',
      '',
      '_待规划_',
      '',
      '## PR 反馈',
      '',
      PR_FEEDBACK_MARKER,
      '',
    ].join('\n')

    const filePath = join(dir, `${issueNumber}.md`)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  createUpstreamRecord(repo: string, version: string, info: UpstreamRecordInfo): string {
    const [owner, name] = repo.split('/')
    const dir = join(this.baseDir, 'upstream', owner, name)
    this.ensureDir(dir)

    const itemsList = info.items.map(item => `- ${item}`).join('\n')

    const content = [
      `# ${repo}@${version}`,
      '',
      '## Release 信息',
      '',
      `| 字段 | 值 |`,
      `|------|------|`,
      `| 链接 | ${info.link} |`,
      `| 发布时间 | ${info.publishedAt} |`,
      '',
      '## 同步项',
      '',
      itemsList,
      '',
      '## 实现计划',
      '',
      '_待规划_',
      '',
      '## PR 反馈',
      '',
      PR_FEEDBACK_MARKER,
      '',
    ].join('\n')

    const filePath = join(dir, `${version}.md`)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  createIdeaRecord(title: string): string {
    const dir = join(this.baseDir, 'todos')
    this.ensureDir(dir)

    const nextId = this.getNextIdeaId(dir)

    const content = [
      `# ${title}`,
      '',
      '## 分析',
      '',
      '_待分析_',
      '',
      '## 实现计划',
      '',
      '_待规划_',
      '',
      '## PR 反馈',
      '',
      PR_FEEDBACK_MARKER,
      '',
    ].join('\n')

    const filePath = join(dir, `idea-${nextId}.md`)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  readRecord(ref: string): string | null {
    const filePath = this.resolveRefPath(ref)
    if (!filePath || !existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
  }

  appendPRFeedback(ref: string, prNumber: number, date: string, reviews: PRReview[]): void {
    const filePath = this.resolveRefPath(ref)
    if (!filePath || !existsSync(filePath)) return

    let content = readFileSync(filePath, 'utf-8')

    const feedbackLines = [
      `### PR #${prNumber} (${date})`,
      '',
      ...reviews.map(r => `- **@${r.user}**: ${r.body}`),
      '',
      PR_FEEDBACK_MARKER,
    ].join('\n')

    content = content.replace(PR_FEEDBACK_MARKER, feedbackLines)
    writeFileSync(filePath, content, 'utf-8')
  }

  private resolveRefPath(ref: string): string | null {
    // Issue ref: #281
    if (ref.startsWith('#')) {
      const num = ref.slice(1)
      return join(this.baseDir, 'todos', `${num}.md`)
    }

    // Upstream ref: owner/repo@version
    const atIndex = ref.indexOf('@')
    if (atIndex !== -1) {
      const repo = ref.slice(0, atIndex)
      const version = ref.slice(atIndex + 1)
      const [owner, name] = repo.split('/')
      return join(this.baseDir, 'upstream', owner, name, `${version}.md`)
    }

    return null
  }

  private getNextIdeaId(dir: string): number {
    if (!existsSync(dir)) return 1

    const files = readdirSync(dir)
    let maxId = 0

    for (const file of files) {
      const match = file.match(/^idea-(\d+)\.md$/)
      if (match) {
        const id = Number.parseInt(match[1], 10)
        if (id > maxId) maxId = id
      }
    }

    return maxId + 1
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
