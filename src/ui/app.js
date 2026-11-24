const list = document.querySelector('#projects')
const empty = document.querySelector('#empty')
const userBadge = document.querySelector('#user')
const form = document.querySelector('#create-form')
const nameInput = document.querySelector('#project-name')
const refresh = document.querySelector('#refresh')
const toast = document.querySelector('#toast')

let toastTimer = 0

function showToast(message, tone = 'info') {
  toast.textContent = message
  toast.dataset.tone = tone
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.hidden = true
  }, 4000)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    ...options,
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch {
    payload = { error: text }
  }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`)
  return payload
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) +
    ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function render(projects) {
  list.replaceChildren()
  empty.hidden = projects.length > 0

  for (const project of projects) {
    const row = document.createElement('div')
    row.className = 'project'

    const link = document.createElement('a')
    link.href = `./p/${encodeURIComponent(project.id)}/`
    link.rel = 'noopener'

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = project.name

    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `创建于 ${formatDate(project.createdAt)}`

    link.append(name, meta)

    const actions = document.createElement('div')
    actions.className = 'actions'

    const open = document.createElement('a')
    open.href = link.href
    open.className = 'open'
    open.textContent = '打开'

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = '删除'
    remove.addEventListener('click', () => void removeProject(project))

    actions.append(open, remove)
    row.append(link, actions)
    list.append(row)
  }
}

async function load() {
  try {
    const payload = await api('api/projects')
    if (payload.user) {
      userBadge.textContent = payload.user.isAdmin
        ? `${payload.user.name} · 管理员`
        : payload.user.name
      userBadge.hidden = false
    }
    render(payload.projects ?? [])
  } catch (error) {
    showToast(error.message, 'error')
  }
}

async function removeProject(project) {
  if (!confirm(`删除项目「${project.name}」？\n\n项目数据会被移出活动列表，不会立即销毁。`)) return
  try {
    await api(`api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' })
    showToast('项目已删除')
    await load()
  } catch (error) {
    showToast(error.message, 'error')
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const name = nameInput.value.trim()
  if (name === '') return
  void (async () => {
    try {
      await api('api/projects', { method: 'POST', body: JSON.stringify({ name }) })
      nameInput.value = ''
      showToast('项目已创建')
      await load()
    } catch (error) {
      showToast(error.message, 'error')
    }
  })()
})

refresh.addEventListener('click', () => void load())

void load()
