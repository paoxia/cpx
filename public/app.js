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
  modelConfigs: [],
  agentAuth: { codex: null, claude: null },
  agentAuthTimers: { codex: null, claude: null },
};

const elements = {
  taskForm: document.querySelector('#task-form'),
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
  tasksView: document.querySelector('#tasks-view'),
  githubView: document.querySelector('#github-view'),
  modelsView: document.querySelector('#models-view'),
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
  modelSettingsForm: document.querySelector('#model-settings-form'),
  modelConfigList: document.querySelector('#model-config-list'),
  modelConfigCount: document.querySelector('#model-config-count'),
  addModelConfig: document.querySelector('#add-model-config'),
  addModelConfigBottom: document.querySelector('#add-model-config-bottom'),
  resetModelConfigs: document.querySelector('#reset-model-configs'),
  executionOrderPreview: document.querySelector('#execution-order-preview'),
  agentAuth: {
    codex: {
      badge: document.querySelector('#codex-auth-badge'),
      message: document.querySelector('#codex-auth-message'),
      method: document.querySelector('#codex-auth-method'),
      login: document.querySelector('#codex-device-login'),
      refresh: document.querySelector('#codex-auth-refresh'),
      cancel: document.querySelector('#codex-auth-cancel'),
      details: document.querySelector('#codex-device-details'),
      verificationLink: document.querySelector('#codex-verification-link'),
      userCode: document.querySelector('#codex-user-code'),
      copyCode: document.querySelector('#copy-codex-code'),
      output: document.querySelector('#codex-auth-output'),
    },
    claude: {
      badge: document.querySelector('#claude-auth-badge'),
      message: document.querySelector('#claude-auth-message'),
      method: document.querySelector('#claude-auth-method'),
      login: document.querySelector('#claude-login'),
      refresh: document.querySelector('#claude-auth-refresh'),
      cancel: document.querySelector('#claude-auth-cancel'),
      details: document.querySelector('#claude-auth-details'),
      verificationLink: document.querySelector('#claude-verification-link'),
      input: document.querySelector('#claude-auth-input'),
      submitInput: document.querySelector('#submit-claude-auth-input'),
      output: document.querySelector('#claude-auth-output'),
    },
  },
  toast: document.querySelector('#toast'),
};

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

elements.prompt.addEventListener('input', updatePromptCount);
elements.taskForm.addEventListener('submit', createTask);
elements.modelSettingsForm.addEventListener('submit', saveModelSettings);
elements.addModelConfig.addEventListener('click', addModelConfiguration);
elements.addModelConfigBottom.addEventListener('click', addModelConfiguration);
elements.resetModelConfigs.addEventListener('click', resetModelConfigurations);
elements.githubForm.addEventListener('submit', connectGitHub);
elements.githubRefresh.addEventListener('click', refreshGitHubRepositories);
elements.repositorySearch.addEventListener('input', renderRepositories);
for (const provider of ['codex', 'claude']) {
  const controls = elements.agentAuth[provider];
  controls.login.addEventListener('click', () => startAgentLogin(provider));
  controls.refresh.addEventListener('click', () => loadAgentAuthStatus(provider, true));
  controls.cancel.addEventListener('click', () => cancelAgentLogin(provider));
}
elements.agentAuth.codex.copyCode.addEventListener('click', copyCodexDeviceCode);
elements.agentAuth.claude.submitInput.addEventListener('click', submitClaudeAuthInput);

async function init() {
  try {
    await loadSettings();
    await refreshTasks();
    const initialView = window.location.hash.slice(1);
    if (['github', 'models'].includes(initialView)) {
      await switchView(initialView);
    }
    window.setInterval(refreshTasks, 1200);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadSettings() {
  state.settings = await api('/api/console/settings');
  state.modelConfigs = state.settings.modelConfigs.map((configuration) => ({ ...configuration }));
  renderModelConfigurations();
  renderExecutionOrderPreview();
}

async function loadAgentAuthStatus(provider, showSuccess = false) {
  setAgentAuthBusy(provider, true);
  try {
    state.agentAuth[provider] = await api(`/api/console/agent-auth?provider=${provider}`);
    renderAgentAuth(provider);
    scheduleAgentAuthPoll(provider);
    if (showSuccess && state.agentAuth[provider].authenticated) {
      showToast(`${providerLabel(provider)} 登录状态验证成功。`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setAgentAuthBusy(provider, false);
  }
}

async function startAgentLogin(provider) {
  setAgentAuthBusy(provider, true);
  try {
    state.agentAuth[provider] = await api('/api/console/agent-auth/login', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    renderAgentAuth(provider);
    scheduleAgentAuthPoll(provider);
    showToast(`${providerLabel(provider)} 登录已启动，请按页面提示完成授权。`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setAgentAuthBusy(provider, false);
  }
}

async function cancelAgentLogin(provider) {
  setAgentAuthBusy(provider, true);
  try {
    await api('/api/console/agent-auth/cancel', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    window.clearTimeout(state.agentAuthTimers[provider]);
    state.agentAuthTimers[provider] = null;
    await loadAgentAuthStatus(provider);
    showToast(`已取消 ${providerLabel(provider)} 登录。`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setAgentAuthBusy(provider, false);
  }
}

function renderAgentAuth(provider) {
  const auth = state.agentAuth[provider];
  if (!auth) return;
  const controls = elements.agentAuth[provider];
  const waiting = auth.state === 'waiting' || auth.state === 'checking';
  const badge = auth.authenticated
    ? ['已连接', 'connected']
    : auth.state === 'failed'
      ? ['连接失败', 'error']
      : waiting
        ? ['等待授权', 'pending']
        : ['未连接', ''];
  controls.badge.textContent = badge[0];
  controls.badge.className = `connection-badge ${badge[1]}`.trim();
  controls.message.textContent = auth.message || `${providerLabel(provider)} 尚未登录。`;
  controls.method.textContent = auth.authenticated
    ? `登录方式：${auth.authMethod || '官方 CLI'}`
    : auth.cliAvailable === false
      ? `需要先在服务器安装 ${providerLabel(provider)}`
      : '';
  controls.login.textContent = auth.authenticated
    ? '重新授权'
    : provider === 'codex'
      ? '使用设备码连接'
      : '使用浏览器连接';
  controls.login.disabled = waiting || auth.cliAvailable === false;
  controls.cancel.hidden = auth.state !== 'waiting';

  const showDetails = auth.state === 'waiting' && Boolean(auth.output || auth.verificationUrl);
  controls.details.hidden = !showDetails;
  const safeUrl = safeExternalUrl(auth.verificationUrl);
  controls.verificationLink.textContent = safeUrl || `等待 ${providerLabel(provider)} 返回授权地址…`;
  if (safeUrl) {
    controls.verificationLink.href = safeUrl;
  } else {
    controls.verificationLink.removeAttribute('href');
  }
  if (provider === 'codex') {
    controls.userCode.textContent = auth.userCode || '等待生成…';
    controls.copyCode.hidden = !auth.userCode;
  }
  controls.output.textContent = auth.output || '';
}

function scheduleAgentAuthPoll(provider) {
  window.clearTimeout(state.agentAuthTimers[provider]);
  state.agentAuthTimers[provider] = null;
  const auth = state.agentAuth[provider];
  if (!auth || !['waiting', 'checking'].includes(auth.state)) return;
  state.agentAuthTimers[provider] = window.setTimeout(async () => {
    await loadAgentAuthStatus(provider);
  }, 1200);
}

async function copyCodexDeviceCode() {
  const code = state.agentAuth.codex?.userCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast('设备码已复制。');
  } catch {
    showToast(`设备码：${code}`);
  }
}

async function submitClaudeAuthInput() {
  const input = elements.agentAuth.claude.input.value.trim();
  if (!input) {
    showToast('请粘贴完整 callback 地址或授权码。', true);
    return;
  }
  setAgentAuthBusy('claude', true);
  try {
    state.agentAuth.claude = await api('/api/console/agent-auth/input', {
      method: 'POST',
      body: JSON.stringify({ provider: 'claude', input }),
    });
    elements.agentAuth.claude.input.value = '';
    renderAgentAuth('claude');
    scheduleAgentAuthPoll('claude');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setAgentAuthBusy('claude', false);
  }
}

function setAgentAuthBusy(provider, busy) {
  const controls = elements.agentAuth[provider];
  controls.refresh.disabled = busy;
  const auth = state.agentAuth[provider];
  if (!auth || !['waiting', 'checking'].includes(auth.state)) {
    controls.login.disabled = busy || auth?.cliAvailable === false;
  }
  if (controls.submitInput) controls.submitInput.disabled = busy;
}

function safeExternalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
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

function renderModelConfigurations() {
  elements.modelConfigCount.textContent = String(state.modelConfigs.length);
  elements.modelConfigList.innerHTML = state.modelConfigs
    .map((configuration, index) => renderModelConfiguration(configuration, index))
    .join('');

  elements.modelConfigList.querySelectorAll('[data-config-id]').forEach((row) => {
    const configuration = state.modelConfigs.find((item) => item.id === row.dataset.configId);
    if (!configuration) return;
    row.querySelector('[data-field="provider"]').addEventListener('change', (event) => {
      configuration.provider = event.target.value;
    });
    row.querySelector('[data-field="model"]').addEventListener('input', (event) => {
      configuration.model = event.target.value;
    });
    row.querySelector('[data-field="apiKey"]').addEventListener('input', (event) => {
      configuration.apiKey = event.target.value;
      configuration.clearApiKey = false;
    });
    row.querySelectorAll('[data-config-action]').forEach((button) => {
      button.addEventListener('click', () =>
        handleModelConfigurationAction(button.dataset.configAction, configuration.id),
      );
    });
  });
}

function renderModelConfiguration(configuration, index) {
  const providerOptions = [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
    ['codebuddy', 'CodeBuddy'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${configuration.provider === value ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const keyStatus = configuration.clearApiKey
    ? '保存后清除密钥'
    : configuration.apiKeySource === 'file'
      ? '已保存到文件；留空保持不变'
      : configuration.apiKeySource === 'environment'
        ? '当前使用环境变量；输入后改为文件配置'
        : '可留空使用 CLI 登录或环境变量';
  return `
    <article class="model-config-item" data-config-id="${escapeHtml(configuration.id)}">
      <div class="model-config-rank"><strong>${index + 1}</strong><span>PRIORITY</span></div>
      <div class="model-config-fields">
        <label class="field">
          <span>Agent</span>
          <select data-field="provider">${providerOptions}</select>
        </label>
        <label class="field model-name-field">
          <span>模型</span>
          <input data-field="model" type="text" value="${escapeHtml(configuration.model || '')}" placeholder="留空使用 Agent 默认模型" autocomplete="off" />
        </label>
        <label class="field model-key-field">
          <span>API Key</span>
          <input data-field="apiKey" type="password" value="${escapeHtml(configuration.apiKey || '')}" placeholder="输入新密钥" autocomplete="new-password" />
          <small>${escapeHtml(keyStatus)}</small>
        </label>
      </div>
      <div class="model-config-controls">
        <button type="button" data-config-action="up" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-config-action="down" aria-label="下移" ${index === state.modelConfigs.length - 1 ? 'disabled' : ''}>↓</button>
        ${configuration.hasApiKey && !configuration.clearApiKey ? '<button type="button" data-config-action="clear-key">清除密钥</button>' : ''}
        <button class="danger" type="button" data-config-action="delete">删除</button>
      </div>
    </article>`;
}

function handleModelConfigurationAction(action, id) {
  const index = state.modelConfigs.findIndex((configuration) => configuration.id === id);
  if (index === -1) return;
  if (action === 'up' && index > 0) {
    [state.modelConfigs[index - 1], state.modelConfigs[index]] = [
      state.modelConfigs[index],
      state.modelConfigs[index - 1],
    ];
  } else if (action === 'down' && index < state.modelConfigs.length - 1) {
    [state.modelConfigs[index + 1], state.modelConfigs[index]] = [
      state.modelConfigs[index],
      state.modelConfigs[index + 1],
    ];
  } else if (action === 'clear-key') {
    state.modelConfigs[index].apiKey = '';
    state.modelConfigs[index].clearApiKey = true;
  } else if (action === 'delete') {
    if (state.modelConfigs.length === 1) {
      showToast('至少需要保留一条模型配置。', true);
      return;
    }
    state.modelConfigs.splice(index, 1);
  }
  renderModelConfigurations();
}

function addModelConfiguration() {
  if (state.modelConfigs.length >= 20) {
    showToast('模型配置不能超过 20 条。', true);
    return;
  }
  state.modelConfigs.push({
    id: createClientId(),
    provider: 'codex',
    model: '',
    hasApiKey: false,
    apiKeySource: 'none',
  });
  renderModelConfigurations();
  elements.modelConfigList.lastElementChild?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}

function resetModelConfigurations() {
  state.modelConfigs = [
    { id: createClientId(), provider: 'codex', model: '', hasApiKey: false, apiKeySource: 'none' },
    {
      id: createClientId(),
      provider: 'claude',
      model: 'sonnet',
      hasApiKey: false,
      apiKeySource: 'none',
    },
    {
      id: createClientId(),
      provider: 'codebuddy',
      model: '',
      hasApiKey: false,
      apiKeySource: 'none',
    },
  ];
  renderModelConfigurations();
  showToast('已恢复默认顺序，点击“保存全部配置”后生效。');
}

function renderExecutionOrderPreview() {
  const configurations = state.settings?.modelConfigs || [];
  elements.executionOrderPreview.innerHTML = configurations
    .map(
      (configuration, index) =>
        `<span><b>${index + 1}</b>${escapeHtml(providerLabel(configuration.provider))}${configuration.model ? ` / ${escapeHtml(configuration.model)}` : ''}</span>`,
    )
    .join('<i>→</i>');
}

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
    const task = await api('/api/console/tasks', {
      method: 'POST',
      body: JSON.stringify({
        useFallback: elements.autoFallback.checked,
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

async function saveModelSettings(event) {
  event.preventDefault();
  const submit = elements.modelSettingsForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    state.settings = await api('/api/console/settings', {
      method: 'POST',
      body: JSON.stringify({
        modelConfigs: state.modelConfigs.map((configuration) => ({
          id: configuration.id,
          provider: configuration.provider,
          model: configuration.model,
          apiKey: configuration.apiKey || undefined,
          clearApiKey: Boolean(configuration.clearApiKey),
        })),
      }),
    });
    state.modelConfigs = state.settings.modelConfigs.map((configuration) => ({ ...configuration }));
    renderModelConfigurations();
    renderExecutionOrderPreview();
    showToast('模型配置和执行顺序已保存。');
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

async function switchView(view) {
  const normalized = ['tasks', 'github', 'models'].includes(view) ? view : 'tasks';
  state.activeView = normalized;
  window.history.replaceState(null, '', normalized === 'tasks' ? '#' : `#${normalized}`);
  elements.tasksView.hidden = normalized !== 'tasks';
  elements.githubView.hidden = normalized !== 'github';
  elements.modelsView.hidden = normalized !== 'models';
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
  if (normalized === 'models') {
    const unloaded = ['codex', 'claude'].filter((provider) => !state.agentAuth[provider]);
    await Promise.all(unloaded.map((provider) => loadAgentAuthStatus(provider)));
  }
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
          <strong>${escapeHtml(label)}${a.model ? ` / ${escapeHtml(a.model)}` : ''}</strong>
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

function providerLabel(provider) {
  return { codex: 'Codex', claude: 'Claude Code', codebuddy: 'CodeBuddy' }[provider] || provider;
}

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `model-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
