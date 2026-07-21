const state = {
  settings: null,
  tasks: [],
  selectedTaskId: null,
  polling: false,
  activeView: 'tasks',
  githubStatus: null,
  githubUser: null,
  repositories: [],
  githubLoaded: false,
};

const elements = {
  taskForm: document.querySelector('#task-form'),
  settingsForm: document.querySelector('#settings-form'),
  provider: document.querySelector('#provider'),
  repository: document.querySelector('#repository'),
  baseBranch: document.querySelector('#base-branch'),
  prompt: document.querySelector('#prompt'),
  promptCount: document.querySelector('#prompt-count'),
  createPr: document.querySelector('#create-pr'),
  autoFallback: document.querySelector('#auto-fallback'),
  launchButton: document.querySelector('#launch-button'),
  taskList: document.querySelector('#task-list'),
  taskCount: document.querySelector('#task-count'),
  taskDetail: document.querySelector('#task-detail'),
  settingsModal: document.querySelector('#settings-modal'),
  defaultProvider: document.querySelector('#default-provider'),
  codexModel: document.querySelector('#codex-model'),
  claudeModel: document.querySelector('#claude-model'),
  codebuddyModel: document.querySelector('#codebuddy-model'),
  openaiKey: document.querySelector('#openai-key'),
  anthropicKey: document.querySelector('#anthropic-key'),
  codebuddyKey: document.querySelector('#codebuddy-key'),
  openaiKeyStatus: document.querySelector('#openai-key-status'),
  anthropicKeyStatus: document.querySelector('#anthropic-key-status'),
  codebuddyKeyStatus: document.querySelector('#codebuddy-key-status'),
  tasksView: document.querySelector('#tasks-view'),
  githubView: document.querySelector('#github-view'),
  githubForm: document.querySelector('#github-form'),
  githubToken: document.querySelector('#github-token'),
  githubTokenHint: document.querySelector('#github-token-hint'),
  githubConnectButton: document.querySelector('#github-connect-button'),
  githubRefresh: document.querySelector('#github-refresh'),
  githubConnectionBadge: document.querySelector('#github-connection-badge'),
  githubAccount: document.querySelector('#github-account'),
  repositoryCount: document.querySelector('#repository-count'),
  repositorySearch: document.querySelector('#repository-search'),
  repositoryList: document.querySelector('#repository-list'),
  fallbackPriority1: document.querySelector('#fallback-priority-1'),
  fallbackPriority2: document.querySelector('#fallback-priority-2'),
  fallbackPriority3: document.querySelector('#fallback-priority-3'),
  toast: document.querySelector('#toast'),
};

document.querySelectorAll('[data-provider]').forEach((button) => {
  button.addEventListener('click', () => selectProvider(button.dataset.provider));
});

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    elements.prompt.value = button.dataset.prompt;
    updatePromptCount();
    elements.prompt.focus();
  });
});

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

document.querySelectorAll('#open-settings, #top-settings').forEach((button) => {
  button.addEventListener('click', openSettings);
});
document.querySelector('#close-settings').addEventListener('click', closeSettings);
elements.settingsModal.addEventListener('click', (event) => {
  if (event.target === elements.settingsModal) closeSettings();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.settingsModal.hidden) closeSettings();
});

elements.prompt.addEventListener('input', updatePromptCount);
elements.taskForm.addEventListener('submit', createTask);
elements.settingsForm.addEventListener('submit', saveSettings);
elements.githubForm.addEventListener('submit', connectGitHub);
elements.githubRefresh.addEventListener('click', refreshGitHubRepositories);
elements.repositorySearch.addEventListener('input', renderRepositories);

async function init() {
  try {
    await loadSettings();
    await refreshTasks();
    window.setInterval(refreshTasks, 1200);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadSettings() {
  state.settings = await api('/api/console/settings');
  elements.defaultProvider.value = state.settings.defaultProvider;
  elements.codexModel.value = state.settings.codexModel || '';
  elements.claudeModel.value = state.settings.claudeModel || '';
  elements.codebuddyModel.value = state.settings.codebuddyModel || '';
  elements.openaiKeyStatus.textContent = state.settings.hasOpenaiApiKey ? '已配置' : '未配置';
  elements.anthropicKeyStatus.textContent = state.settings.hasAnthropicApiKey ? '已配置' : '未配置';
  elements.codebuddyKeyStatus.textContent = state.settings.hasCodebuddyApiKey ? '已配置' : '未配置';
  loadFallbackOrder(state.settings.fallbackOrder || ['codex', 'claude', 'codebuddy']);
  selectProvider(state.settings.defaultProvider);
}

async function loadGitHubStatus() {
  state.githubStatus = await api('/api/console/github');
  renderGitHubConnection();
  if (state.githubStatus.hasToken && !state.githubLoaded) {
    await refreshGitHubRepositories();
  }
}

async function connectGitHub(event) {
  event.preventDefault();
  const token = elements.githubToken.value.trim();
  setGitHubBusy(true, '正在验证…');
  try {
    const connection = await api('/api/console/github/connect', {
      method: 'POST',
      body: JSON.stringify({ token: token || undefined }),
    });
    applyGitHubConnection(connection);
    elements.githubToken.value = '';
    showToast(`GitHub 已连接，共读取 ${state.repositories.length} 个仓库。`);
  } catch (error) {
    elements.githubConnectionBadge.textContent = '验证失败';
    elements.githubConnectionBadge.className = 'connection-badge error';
    showToast(error.message, true);
  } finally {
    setGitHubBusy(false, '验证并读取仓库');
  }
}

async function refreshGitHubRepositories() {
  if (elements.githubRefresh.disabled) return;
  elements.githubRefresh.disabled = true;
  elements.githubRefresh.classList.add('spinning');
  try {
    const connection = await api('/api/console/github/repositories');
    applyGitHubConnection(connection);
    showToast(`已刷新 ${state.repositories.length} 个 GitHub 仓库。`);
  } catch (error) {
    state.githubLoaded = false;
    showToast(error.message, true);
  } finally {
    elements.githubRefresh.disabled = false;
    elements.githubRefresh.classList.remove('spinning');
  }
}

function applyGitHubConnection(connection) {
  state.githubUser = connection.user;
  state.repositories = connection.repositories || [];
  state.githubLoaded = true;
  state.githubStatus = {
    hasToken: true,
    connected: true,
    user: connection.user,
    repositoryCount: state.repositories.length,
  };
  renderGitHubConnection();
  renderRepositories();
}

function renderGitHubConnection() {
  const connected = Boolean(state.githubStatus?.connected && state.githubUser);
  const configured = Boolean(state.githubStatus?.hasToken);
  elements.githubConnectionBadge.textContent = connected
    ? '已连接'
    : configured
      ? '待验证'
      : '未连接';
  elements.githubConnectionBadge.className = `connection-badge${connected ? ' connected' : ''}`;
  elements.githubTokenHint.textContent = configured
    ? '已有配置或环境变量 Token；留空可直接验证。输入新 Token 会在验证成功后保存到配置。'
    : '输入 Token 并验证成功后，将保存到 config/config.yaml。';
  if (!connected) {
    elements.githubAccount.innerHTML = `
      <div class="github-avatar" aria-hidden="true">GH</div>
      <div><strong>等待验证 Token</strong><small>连接后显示 GitHub 用户身份</small></div>`;
    return;
  }
  const displayName = state.githubUser.name || state.githubUser.login;
  const initials = state.githubUser.login.slice(0, 2).toUpperCase();
  elements.githubAccount.innerHTML = `
    <div class="github-avatar connected" aria-hidden="true">${escapeHtml(initials)}</div>
    <div>
      <strong>${escapeHtml(displayName)}</strong>
      <a href="${escapeHtml(state.githubUser.htmlUrl)}" target="_blank" rel="noreferrer">@${escapeHtml(state.githubUser.login)} ↗</a>
    </div>`;
}

function renderRepositories() {
  const query = elements.repositorySearch.value.trim().toLocaleLowerCase();
  const filtered = state.repositories.filter((repository) => {
    const searchable = `${repository.fullName} ${repository.description || ''} ${repository.language || ''}`;
    return searchable.toLocaleLowerCase().includes(query);
  });
  elements.repositoryCount.textContent = query
    ? `${filtered.length} / ${state.repositories.length}`
    : String(state.repositories.length);

  if (!state.githubLoaded) {
    elements.repositoryList.className = 'repository-list empty-repositories';
    elements.repositoryList.innerHTML = `
      <div class="repository-empty-state">
        <span>⑂</span><h3>尚未读取仓库</h3>
        <p>输入 GitHub Token 并验证后，这里会列出该 Token 可以访问的全部仓库。</p>
      </div>`;
    return;
  }
  if (!filtered.length) {
    elements.repositoryList.className = 'repository-list empty-repositories';
    elements.repositoryList.innerHTML = `
      <div class="repository-empty-state">
        <span>⌕</span><h3>${query ? '没有匹配的仓库' : '没有可访问仓库'}</h3>
        <p>${query ? '换一个名称、描述或语言关键词试试。' : '请检查 Token 的仓库访问范围。'}</p>
      </div>`;
    return;
  }

  elements.repositoryList.className = 'repository-list';
  elements.repositoryList.innerHTML = filtered
    .map(
      (repository) => `
        <article class="repository-item">
          <div class="repository-main">
            <div class="repository-title">
              <a href="${escapeHtml(repository.htmlUrl)}" target="_blank" rel="noreferrer">${escapeHtml(repository.fullName)}</a>
              <span class="repo-visibility">${repository.private ? 'PRIVATE' : 'PUBLIC'}</span>
              ${repository.archived ? '<span class="repo-archived">ARCHIVED</span>' : ''}
            </div>
            <p>${escapeHtml(repository.description || '暂无描述')}</p>
            <div class="repository-meta">
              ${repository.language ? `<span><i></i>${escapeHtml(repository.language)}</span>` : ''}
              <span>★ ${Number(repository.stars).toLocaleString('zh-CN')}</span>
              <span>${repository.fork ? 'Fork · ' : ''}更新于 ${escapeHtml(formatDate(repository.updatedAt))}</span>
              <span>默认分支 ${escapeHtml(repository.defaultBranch)}</span>
            </div>
          </div>
          <button class="use-repository" data-use-repository="${escapeHtml(repository.fullName)}" data-default-branch="${escapeHtml(repository.defaultBranch)}" type="button">用于新任务</button>
        </article>`,
    )
    .join('');

  elements.repositoryList.querySelectorAll('[data-use-repository]').forEach((button) => {
    button.addEventListener('click', () => {
      elements.repository.value = button.dataset.useRepository;
      elements.baseBranch.value = button.dataset.defaultBranch || '';
      switchView('tasks');
      elements.prompt.focus();
      showToast(`已选择 ${button.dataset.useRepository}`);
    });
  });
}

function setGitHubBusy(busy, label) {
  elements.githubConnectButton.disabled = busy;
  elements.githubConnectButton.textContent = label;
}

function loadFallbackOrder(order) {
  const selects = [
    elements.fallbackPriority1,
    elements.fallbackPriority2,
    elements.fallbackPriority3,
  ];
  const padded = [...order, 'none', 'none'].slice(0, 3);
  selects.forEach((select, index) => {
    select.value = padded[index];
  });
  refreshFallbackOptions();
}

function collectFallbackOrder() {
  return [
    elements.fallbackPriority1.value,
    elements.fallbackPriority2.value,
    elements.fallbackPriority3.value,
  ].filter((value) => value && value !== 'none');
}

/** 在三个 fallback 优先级 select 之间禁用彼此已选的 provider,防止重复。 */
function refreshFallbackOptions() {
  const selects = [
    elements.fallbackPriority1,
    elements.fallbackPriority2,
    elements.fallbackPriority3,
  ];
  const chosen = selects.map((select) => select.value);
  selects.forEach((select, index) => {
    Array.from(select.options).forEach((option) => {
      const taken = chosen.findIndex((value, i) => i !== index && value === option.value);
      option.disabled = option.value !== 'none' && taken !== -1;
    });
  });
}

[elements.fallbackPriority1, elements.fallbackPriority2, elements.fallbackPriority3].forEach(
  (select) => {
    select.addEventListener('change', refreshFallbackOptions);
  },
);

async function refreshTasks() {
  if (state.polling) return;
  state.polling = true;
  try {
    const result = await api('/api/console/tasks');
    state.tasks = result.tasks || [];
    if (!state.selectedTaskId && state.tasks.length) {
      state.selectedTaskId = state.tasks[0].id;
    }
    renderTaskList();
    renderTaskDetail();
  } catch (error) {
    console.error(error);
  } finally {
    state.polling = false;
  }
}

async function createTask(event) {
  event.preventDefault();
  elements.launchButton.disabled = true;
  elements.launchButton.querySelector('span').textContent = '正在启动…';
  try {
    const primary = elements.provider.value;
    const autoFallback = elements.autoFallback.checked;
    let providers = [primary];
    if (autoFallback) {
      const order = collectFallbackOrder().filter((p) => p !== primary);
      providers = [primary, ...order];
    }
    const task = await api('/api/console/tasks', {
      method: 'POST',
      body: JSON.stringify({
        providers,
        repository: elements.repository.value,
        baseBranch: elements.baseBranch.value || undefined,
        prompt: elements.prompt.value,
        createPullRequest: elements.createPr.checked,
      }),
    });
    state.selectedTaskId = task.id;
    state.tasks.unshift(task);
    renderTaskList();
    renderTaskDetail();
    showToast('任务已启动，Agent 正在准备工作区。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.launchButton.disabled = false;
    elements.launchButton.querySelector('span').textContent = '启动任务';
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const submit = elements.settingsForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    state.settings = await api('/api/console/settings', {
      method: 'POST',
      body: JSON.stringify({
        defaultProvider: elements.defaultProvider.value,
        codexModel: elements.codexModel.value,
        claudeModel: elements.claudeModel.value,
        codebuddyModel: elements.codebuddyModel.value,
        fallbackOrder: collectFallbackOrder(),
        openaiApiKey: elements.openaiKey.value || undefined,
        anthropicApiKey: elements.anthropicKey.value || undefined,
        codebuddyApiKey: elements.codebuddyKey.value || undefined,
      }),
    });
    elements.openaiKey.value = '';
    elements.anthropicKey.value = '';
    elements.codebuddyKey.value = '';
    elements.openaiKeyStatus.textContent = state.settings.hasOpenaiApiKey ? '已配置' : '未配置';
    elements.anthropicKeyStatus.textContent = state.settings.hasAnthropicApiKey
      ? '已配置'
      : '未配置';
    elements.codebuddyKeyStatus.textContent = state.settings.hasCodebuddyApiKey
      ? '已配置'
      : '未配置';
    loadFallbackOrder(state.settings.fallbackOrder || ['codex', 'claude', 'codebuddy']);
    selectProvider(state.settings.defaultProvider);
    closeSettings();
    showToast('模型设置已保存。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

function renderTaskList() {
  elements.taskCount.textContent = String(state.tasks.length);
  if (!state.tasks.length) {
    elements.taskList.innerHTML = '<div class="empty-list">尚未运行任务</div>';
    return;
  }
  elements.taskList.innerHTML = state.tasks
    .map(
      (task) => `
        <button class="task-list-item ${task.id === state.selectedTaskId ? 'active' : ''}" data-task-id="${task.id}" type="button">
          <strong>${escapeHtml(shortRepository(task.repository))}</strong>
          <span><i class="mini-dot ${task.status}"></i>${escapeHtml(statusLabel(task.status))} · ${escapeHtml(task.provider)}</span>
        </button>`,
    )
    .join('');
  elements.taskList.querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedTaskId = button.dataset.taskId;
      renderTaskList();
      renderTaskDetail();
    });
  });
}

function renderTaskDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    elements.taskDetail.className = 'task-detail empty-detail';
    elements.taskDetail.innerHTML = `
      <div class="orb" aria-hidden="true"><i></i></div>
      <h3>等待第一个任务</h3>
      <p>提交任务后，这里会实时展示 Agent 的执行阶段、日志和 Pull Request。</p>`;
    return;
  }

  const active = ['queued', 'preparing', 'running', 'publishing'].includes(task.status);
  elements.taskDetail.className = 'task-detail';
  elements.taskDetail.innerHTML = `
    <div class="detail-summary">
      <div class="detail-status">
        <span class="status-badge"><i class="mini-dot ${task.status}"></i>${escapeHtml(statusLabel(task.status))}</span>
        ${active ? '<button class="cancel-button" type="button">取消任务</button>' : ''}
      </div>
      <h3>${escapeHtml(task.prompt)}</h3>
      <div class="detail-meta">${escapeHtml(task.provider.toUpperCase())}${task.model ? ` / ${escapeHtml(task.model)}` : ''}<br />${escapeHtml(shortRepository(task.repository))} · ${escapeHtml(formatTime(task.createdAt))}</div>
    </div>
    ${renderAttempts(task.attempts)}
    <pre class="task-output" aria-label="任务输出"></pre>
    ${task.pullRequestUrl ? `<a class="pr-link" href="${escapeHtml(task.pullRequestUrl)}" target="_blank" rel="noreferrer"><span>打开 Pull Request</span><b>↗</b></a>` : ''}
    ${task.workspace ? `<div class="workspace-path">WORKSPACE · ${escapeHtml(task.workspace)}</div>` : ''}`;

  const output = elements.taskDetail.querySelector('.task-output');
  output.textContent = task.logs
    .map(
      (log) =>
        `${new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}  ${log.stream === 'stderr' ? '!' : log.stream === 'system' ? '›' : ' '} ${log.message}`,
    )
    .join('\n');
  output.scrollTop = output.scrollHeight;

  elements.taskDetail.querySelector('.cancel-button')?.addEventListener('click', async () => {
    try {
      await api('/api/console/cancel', {
        method: 'POST',
        body: JSON.stringify({ id: task.id }),
      });
      showToast('正在取消任务。');
      await refreshTasks();
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function selectProvider(provider) {
  const valid = ['codex', 'claude', 'codebuddy'];
  const normalized = valid.includes(provider) ? provider : 'codex';
  elements.provider.value = normalized;
  document.querySelectorAll('[data-provider]').forEach((button) => {
    button.classList.toggle('active', button.dataset.provider === normalized);
  });
}

async function switchView(view) {
  const normalized = view === 'github' ? 'github' : 'tasks';
  state.activeView = normalized;
  elements.tasksView.hidden = normalized !== 'tasks';
  elements.githubView.hidden = normalized !== 'github';
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === normalized);
  });
  if (normalized === 'github' && !state.githubStatus) {
    try {
      await loadGitHubStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  }
}

function openSettings() {
  elements.settingsModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  elements.settingsModal.hidden = true;
  document.body.style.overflow = '';
}

function updatePromptCount() {
  elements.promptCount.textContent = `${elements.prompt.value.length} / 20000`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove('show'), 3200);
}

function statusLabel(status) {
  return (
    {
      queued: '排队中',
      preparing: '准备工作区',
      running: 'Agent 执行中',
      publishing: '创建 PR',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }[status] || status
  );
}

function renderAttempts(attempts) {
  if (!attempts || !attempts.length) return '';
  const rows = attempts
    .map((a) => {
      const label =
        { codex: 'Codex', claude: 'Claude Code', codebuddy: 'CodeBuddy' }[a.provider] || a.provider;
      return `
        <div class="attempt ${a.status}">
          <strong>${escapeHtml(label)}</strong>
          <span class="attempt-status">${escapeHtml(a.status)}</span>
          ${a.errorKind ? `<em>${escapeHtml(a.errorKind)}</em>` : ''}
          ${a.error ? `<small>${escapeHtml(a.error)}</small>` : ''}
        </div>`;
    })
    .join('');
  return `<div class="attempts-list">${rows}</div>`;
}

function shortRepository(repository) {
  return repository
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

init();
