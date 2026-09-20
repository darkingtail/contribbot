const state = { projects: [], view: 'overview', selected: null, status: 'active' }
const app = document.querySelector('#app')
const title = document.querySelector('#page-title')

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const badge = value => `<span class="badge ${escapeHtml(value)}">${escapeHtml(String(value).replace('_', ' '))}</span>`
const todoStatus = todo => `${todo.status}${['done', 'cancelled'].includes(todo.status) ? ' · not archived' : ''}`

async function load() {
  app.innerHTML = '<div class="loading">Loading tracked projects...</div>'
  const response = await fetch(`/api/projects?status=${encodeURIComponent(state.status)}`)
  const data = await response.json()
  state.projects = data.projects
  if (state.selected) state.selected = state.projects.find(project => project.repo === state.selected.repo) ?? null
  document.querySelector('#last-updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`
  render()
}

function render() {
  if (state.view === 'overview') renderOverview()
  else if (state.view === 'patrol') renderPatrol()
  else if (state.view === 'todos') renderTodos()
  else renderDetail()
}

function renderOverview() {
  title.textContent = 'Project overview'
  const active = state.projects.reduce((sum, project) => sum + project.todos.active, 0)
  const attention = state.projects.filter(project => ['partial', 'failed'].includes(project.patrol.status)).length
  app.innerHTML = `
    <div class="summary-grid">
      <div class="metric"><div class="metric-label">Tracked projects</div><div class="metric-value">${state.projects.length}</div></div>
      <div class="metric"><div class="metric-label">Active todos</div><div class="metric-value">${active}</div></div>
      <div class="metric"><div class="metric-label">Needs attention</div><div class="metric-value">${attention}</div></div>
      <div class="metric"><div class="metric-label">Latest patrols</div><div class="metric-value">${state.projects.filter(p => p.patrol.runId).length}</div></div>
    </div>
    <div class="section-head"><h2>Tracked repositories</h2><label>Project status <select id="project-status">${['active', 'archived', 'all'].map(status => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><span>${state.projects.length} repositories</span></div>
    <div class="project-grid">${state.projects.map(projectCard).join('') || '<div class="empty">No tracked repositories found.</div>'}</div>`
  document.querySelectorAll('[data-repo]').forEach(button => button.addEventListener('click', () => openProject(button.dataset.repo)))
  document.querySelector('#project-status').addEventListener('change', event => {
    state.status = event.target.value
    load().catch(error => { app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>` })
  })
}

function projectCard(project) {
  const relation = project.config.upstream ? `upstream: ${project.config.upstream}` : project.config.fork ? `fork: ${project.config.fork}` : 'standalone project'
  return `<article class="project-card" data-repo="${escapeHtml(project.repo)}">
    <div class="project-title"><h3>${escapeHtml(project.repo)}</h3>${badge(project.config.status)}${badge(project.patrol.status)}</div>
    <p>${escapeHtml(relation)}</p>
    <div class="card-stats"><div class="card-stat"><strong>${project.todos.active}</strong><span>active todos</span></div><div class="card-stat"><strong>${project.todos.backlog}</strong><span>backlog</span></div><div class="card-stat"><strong>${project.todos.total}</strong><span>total todos</span></div></div>
  </article>`
}

function renderPatrol() {
  title.textContent = 'Patrol runs'
  app.innerHTML = `<div class="section-head"><h2>Latest repository patrol</h2><span>Click a project to inspect the report</span></div><div class="project-grid">${state.projects.map(projectCard).join('')}</div>`
  document.querySelectorAll('[data-repo]').forEach(button => button.addEventListener('click', () => openProject(button.dataset.repo)))
}

function renderTodos() {
  title.textContent = 'Todo queue'
  const rows = state.projects.flatMap(project => project.todos.items.map(todo => ({ ...todo, repo: project.repo })))
  app.innerHTML = `<div class="section-head"><h2>Todos across repositories</h2><span>${rows.length} visible items</span></div><div class="panel"><div class="todo-list">${rows.map(todo => `<div class="todo ${escapeHtml(todo.status)}"><div class="todo-title">${escapeHtml(todo.title)}</div><div class="todo-meta">${escapeHtml(todo.repo)} · ${escapeHtml(todoStatus(todo))} · ${escapeHtml(todo.branch || 'no branch')}</div></div>`).join('') || '<div class="empty">No todos found.</div>'}</div></div>`
}

function openProject(repo) { state.selected = state.projects.find(project => project.repo === repo); state.view = 'detail'; render() }

function renderDetail() {
  const project = state.selected
  if (!project) { state.view = 'overview'; return render() }
  title.textContent = 'Project detail'
  app.innerHTML = `<button class="back" id="back">← All projects</button>
    <div class="detail-head"><div><h2>${escapeHtml(project.repo)}</h2><div class="detail-meta">${escapeHtml(project.config.upstream ? `Tracking ${project.config.upstream}` : 'Standalone project')} · role ${escapeHtml(project.config.role || 'unknown')} · ${escapeHtml(project.config.status)}${project.config.archived_at ? ` · archived ${escapeHtml(project.config.archived_at)}` : ''}</div></div>${badge(project.patrol.status)}</div>
    <div class="detail-grid"><div class="panel"><h3>Latest patrol report</h3><div class="report">${escapeHtml(project.patrol.report || 'No patrol report yet.')}</div></div>
      <div class="panel"><h3>Repository context</h3><div class="facts"><div class="fact"><span>Upstream</span><span>${escapeHtml(project.config.upstream || '—')}</span></div><div class="fact"><span>Fork</span><span>${escapeHtml(project.config.fork || '—')}</span></div><div class="fact"><span>Last run</span><span>${escapeHtml(project.patrol.runId || 'Not run')}</span></div><div class="fact"><span>Active todos</span><span>${project.todos.active}</span></div></div><h3 style="margin-top:24px">Todo queue</h3><div class="todo-list">${project.todos.items.map(todo => `<div class="todo ${escapeHtml(todo.status)}"><div class="todo-title">${escapeHtml(todo.title)}</div><div class="todo-meta">${escapeHtml(todoStatus(todo))} · ${escapeHtml(todo.branch || 'no branch')}</div></div>`).join('') || '<div class="empty">No todos.</div>'}</div></div>
    </div></div>`
  document.querySelector('#back').addEventListener('click', () => { state.view = 'overview'; render() })
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'))
  button.classList.add('active')
  state.view = button.dataset.view
  render()
}))
document.querySelector('#refresh').addEventListener('click', load)
load().catch(error => { app.innerHTML = `<div class="empty">Unable to load local contribbot data: ${escapeHtml(error.message)}</div>` })
