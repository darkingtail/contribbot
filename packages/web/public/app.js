const state = { projects: [], problems: [], view: 'overview', selected: null, status: 'active' }
const app = document.querySelector('#app')
const title = document.querySelector('#page-title')

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const badge = value => `<span class="badge ${escapeHtml(value)}">${escapeHtml(String(value).replace('_', ' '))}</span>`
const todoStatus = todo => `${todo.status}${['done', 'cancelled'].includes(todo.status) ? ' · not archived' : ''}`
const countLabel = value => value === null ? 'unknown' : value
const repositoryLabel = repository => `${repository.platform} · ${repository.instance} · ${repository.path}`
const parentLabel = project => project.config.parent.status === 'confirmed'
  ? repositoryLabel(project.config.parent.repository) : project.config.parent.status
const trackingLabel = project => project.config.tracking.status === 'configured'
  ? project.config.tracking.sources.map(repositoryLabel).join('; ') : project.config.tracking.status
const diagnostics = (problems = state.problems) => problems.length
  ? `<section class="diagnostics" role="status"><h2>Data diagnostics</h2>${problems.map(problem => `<p><strong>${escapeHtml(problem.code)}</strong> · ${escapeHtml(problem.repository ? repositoryLabel(problem.repository) : problem.directory)}<br>${escapeHtml(problem.message)}</p>`).join('')}</section>` : ''

async function load() {
  app.innerHTML = '<div class="loading">Loading tracked projects...</div>'
  const response = await fetch(`/api/projects?status=${encodeURIComponent(state.status)}`)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Project data could not be read.')
  state.projects = data.projects
  state.problems = data.problems
  if (state.selected) state.selected = state.projects.find(project => project.digest === state.selected.digest) ?? null
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
  const active = state.projects.some(project => project.todos.active === null)
    ? 'unknown' : state.projects.reduce((sum, project) => sum + project.todos.active, 0)
  const attention = state.projects.filter(project => project.problems.length || ['partial', 'failed', 'unknown'].includes(project.patrol.status)).length
  app.innerHTML = `
    ${diagnostics()}
    <div class="summary-grid">
      <div class="metric"><div class="metric-label">Tracked projects</div><div class="metric-value">${state.projects.length}</div></div>
      <div class="metric"><div class="metric-label">Active todos</div><div class="metric-value">${active}</div></div>
      <div class="metric"><div class="metric-label">Needs attention</div><div class="metric-value">${attention}</div></div>
      <div class="metric"><div class="metric-label">Latest patrols</div><div class="metric-value">${state.projects.filter(p => p.patrol.runId).length}</div></div>
    </div>
    <div class="section-head"><h2>Tracked repositories</h2><label>Project status <select id="project-status">${['active', 'archived', 'all'].map(status => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label><span>${state.projects.length} repositories</span></div>
    <div class="project-grid">${state.projects.map(projectCard).join('') || '<div class="empty">No tracked repositories found.</div>'}</div>`
  document.querySelectorAll('[data-project]').forEach(button => button.addEventListener('click', () => openProject(button.dataset.project)))
  document.querySelector('#project-status').addEventListener('change', event => {
    state.status = event.target.value
    load().catch(error => { app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>` })
  })
}

function projectCard(project) {
  const relation = `Parent: ${parentLabel(project)}; Tracking: ${trackingLabel(project)}`
  return `<article class="project-card" data-project="${escapeHtml(project.digest)}" tabindex="0" role="button" aria-label="${escapeHtml(repositoryLabel(project.repository))}">
    <div class="project-title"><h3>${escapeHtml(project.repository.path)}</h3>${badge(project.config.lifecycle.status)}${badge(project.patrol.status)}</div>
    <p>${escapeHtml(project.repository.platform)} · ${escapeHtml(project.repository.instance)}<br>${escapeHtml(relation)}</p>
    <div class="card-stats"><div class="card-stat"><strong>${countLabel(project.todos.active)}</strong><span>active todos</span></div><div class="card-stat"><strong>${countLabel(project.todos.backlog)}</strong><span>backlog</span></div><div class="card-stat"><strong>${countLabel(project.todos.total)}</strong><span>total todos</span></div></div>
  </article>`
}

function renderPatrol() {
  title.textContent = 'Patrol runs'
  app.innerHTML = `${diagnostics()}<div class="section-head"><h2>Latest repository patrol</h2></div><div class="project-grid">${state.projects.map(projectCard).join('')}</div>`
  document.querySelectorAll('[data-project]').forEach(button => button.addEventListener('click', () => openProject(button.dataset.project)))
}

function renderTodos() {
  title.textContent = 'Todo queue'
  const rows = state.projects.flatMap(project => (project.todos.items ?? []).map(todo => ({ ...todo, repo: repositoryLabel(project.repository) })))
  const incomplete = state.projects.some(project => project.todos.items === null) || state.problems.some(problem => problem.code.startsWith('config_'))
  app.innerHTML = `${diagnostics()}<div class="section-head"><h2>Todos across repositories</h2><span>${rows.length} visible items${incomplete ? ' · incomplete data' : ''}</span></div><div class="panel"><div class="todo-list">${rows.map(todo => `<div class="todo ${escapeHtml(todo.status)}"><div class="todo-title">${escapeHtml(todo.title)}</div><div class="todo-meta">${escapeHtml(todo.repo)} · ${escapeHtml(todoStatus(todo))} · ${escapeHtml(todo.branch || 'no branch')}</div></div>`).join('') || `<div class="empty">${incomplete ? 'Todo data unavailable.' : 'No todos found.'}</div>`}</div></div>`
}

function openProject(digest) { state.selected = state.projects.find(project => project.digest === digest); state.view = 'detail'; render() }

function renderDetail() {
  const project = state.selected
  if (!project) { state.view = 'overview'; return render() }
  title.textContent = 'Project detail'
  app.innerHTML = `<button class="back" id="back">← All projects</button>
    ${diagnostics(project.problems)}
    <div class="detail-head"><div><h2>${escapeHtml(project.repository.path)}</h2><div class="detail-meta">${escapeHtml(repositoryLabel(project.repository))} · ${escapeHtml(project.config.lifecycle.status)}${project.config.lifecycle.archived_at ? ` · archived ${escapeHtml(project.config.lifecycle.archived_at)}` : ''}</div></div>${badge(project.patrol.status)}</div>
    <div class="detail-grid"><div class="panel"><h3>Latest patrol report</h3><div class="report">${escapeHtml(project.patrol.report || (project.patrol.status === 'not_run' ? 'No patrol report yet.' : 'Patrol report unavailable.'))}</div></div>
      <div class="panel"><h3>Repository context</h3><div class="facts"><div class="fact"><span>Platform</span><span>${escapeHtml(project.repository.platform)}</span></div><div class="fact"><span>Instance</span><span>${escapeHtml(project.repository.instance)}</span></div><div class="fact"><span>Path</span><span>${escapeHtml(project.repository.path)}</span></div><div class="fact"><span>Parent</span><span>${escapeHtml(parentLabel(project))}</span></div><div class="fact"><span>Tracking</span><span>${escapeHtml(trackingLabel(project))}</span></div><div class="fact"><span>Last run</span><span>${escapeHtml(project.patrol.runId || (project.patrol.status === 'not_run' ? 'Not run' : 'unknown'))}</span></div><div class="fact"><span>Active todos</span><span>${countLabel(project.todos.active)}</span></div></div><h3 style="margin-top:24px">Todo queue</h3><div class="todo-list">${project.todos.items === null ? '<div class="empty">Todo data unavailable.</div>' : project.todos.items.map(todo => `<div class="todo ${escapeHtml(todo.status)}"><div class="todo-title">${escapeHtml(todo.title)}</div><div class="todo-meta">${escapeHtml(todoStatus(todo))} · ${escapeHtml(todo.branch || 'no branch')}</div></div>`).join('') || '<div class="empty">No todos.</div>'}</div></div>
    </div>`
  document.querySelector('#back').addEventListener('click', () => { state.view = 'overview'; render() })
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'))
  button.classList.add('active')
  state.view = button.dataset.view
  render()
}))
app.addEventListener('keydown', event => {
  const card = event.target.closest('[data-project]')
  if (card && ['Enter', ' '].includes(event.key)) {
    event.preventDefault()
    openProject(card.dataset.project)
  }
})
document.querySelector('#refresh').addEventListener('click', () => {
  load().catch(error => { app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>` })
})
load().catch(error => { app.innerHTML = `<div class="empty">Unable to load local contribbot data: ${escapeHtml(error.message)}</div>` })
