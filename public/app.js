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
  githubTokenEntryOpen: false,
  modelConfigs: [],
  modelTestRunning: false,
  modelTestConfigId: null,
  modelTestPrompt: '',
};

const elements = {
  taskForm: document.querySelector('#task-form'),
  repositoryPicker: document.querySelector('#repository-picker'),
  repository: document.querySelector('#repository'),
  repositoryHint: document.querySelector('#repository-hint'),
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
  githubTokenSetup: document.querySelector('#github-token-setup'),
  githubCreateToken: document.querySelector('#github-create-token'),
  githubExistingToken: document.querySelector('#github-existing-token'),
  githubTokenSteps: document.querySelector('#github-token-steps'),
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
elements.repositoryPicker.addEventListener('change', handleTaskRepositorySelection);
elements.taskForm.addEventListener('submit', createTask);
elements.modelSettingsForm.addEventListener('submit', saveModelSettings);
elements.addModelConfig.addEventListener('click', addModelConfiguration);
elements.addModelConfigBottom.addEventListener('click', addModelConfiguration);
elements.resetModelConfigs.addEventListener('click', resetModelConfigurations);
elements.githubForm.addEventListener('submit', connectGitHub);
elements.githubCreateToken.addEventListener('click', () => openGitHubTokenEntry(true));
elements.githubExistingToken.addEventListener('click', () => openGitHubTokenEntry(false));
elements.githubRefresh.addEventListener('click', refreshGitHubRepositories);
elements.repositorySearch.addEventListener('input', renderRepositories);

async function init() {
  try {
    await loadSettings();
    await refreshTasks();
    try {
      await loadGitHubStatus();
    } catch (error) {
      console.error(error);
      renderTaskRepositoryPicker();
    }
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
  state.modelConfigs = editableModelConfigurations(state.settings.modelConfigs);
  renderModelConfigurations();
  renderExecutionOrderPreview();
}

async function loadGitHubStatus() {
  state.githubStatus = await api('/api/console/github');
  renderGitHubConnection();
  if (state.githubStatus.hasToken && !state.githubLoaded) {
    await refreshGitHubRepositories(false);
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
    state.githubTokenEntryOpen = false;
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

async function refreshGitHubRepositories(notify = true) {
  if (elements.githubRefresh.disabled) return;
  elements.githubRefresh.disabled = true;
  elements.githubRefresh.classList.add('spinning');
  try {
    const connection = await api('/api/console/github/repositories');
    applyGitHubConnection(connection);
    if (notify) showToast(`已刷新 ${state.repositories.length} 个 GitHub 仓库。`);
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
    ...state.githubStatus,
    hasToken: true,
    connected: true,
    tokenSource: connection.tokenSource || state.githubStatus?.tokenSource || 'file',
    user: connection.user,
    repositoryCount: state.repositories.length,
  };
  renderGitHubConnection();
  renderRepositories();
  renderTaskRepositoryPicker();
}

function renderTaskRepositoryPicker() {
  const repositories = state.repositories.filter((repository) => !repository.archived);
  if (!state.githubLoaded || !repositories.length) {
    elements.repositoryPicker.hidden = true;
    elements.repositoryPicker.required = false;
    elements.repository.hidden = false;
    elements.repository.required = true;
    elements.repositoryHint.textContent = state.githubLoaded
      ? '当前 Token 没有可选项目；可手动输入 owner/repo、HTTPS 或 SSH 地址'
      : '支持 owner/repo、HTTPS 或 SSH 地址';
    return;
  }

  const currentValue = elements.repository.value.trim();
  const selectedRepository = repositories.find(
    (repository) => repository.fullName === currentValue,
  );
  elements.repositoryPicker.innerHTML = [
    '<option value="">选择已有 Token 授权的项目</option>',
    ...repositories.map(
      (repository) =>
        `<option value="${escapeHtml(repository.fullName)}">${escapeHtml(repository.fullName)}${repository.private ? ' · 私有' : ''}</option>`,
    ),
    '<option value="__manual__">手动输入仓库地址…</option>',
  ].join('');
  elements.repositoryPicker.hidden = false;
  elements.repositoryPicker.required = true;

  if (selectedRepository) {
    elements.repositoryPicker.value = selectedRepository.fullName;
    elements.repository.hidden = true;
    elements.repository.required = false;
  } else if (currentValue) {
    elements.repositoryPicker.value = '__manual__';
    elements.repository.hidden = false;
    elements.repository.required = true;
  } else {
    elements.repositoryPicker.value = '';
    elements.repository.hidden = true;
    elements.repository.required = false;
  }
  elements.repositoryHint.textContent = `可选择当前 Token 授权的 ${repositories.length} 个项目，或手动输入仓库地址`;
}

function handleTaskRepositorySelection() {
  const selectedValue = elements.repositoryPicker.value;
  if (selectedValue === '__manual__') {
    elements.repository.value = '';
    elements.repository.hidden = false;
    elements.repository.required = true;
    elements.repository.focus();
    return;
  }

  elements.repository.hidden = true;
  elements.repository.required = false;
  elements.repository.value = selectedValue;
  const repository = state.repositories.find((item) => item.fullName === selectedValue);
  elements.baseBranch.value = repository?.defaultBranch || '';
}

function selectTaskRepository(fullName, defaultBranch = '') {
  elements.repository.value = fullName;
  elements.baseBranch.value = defaultBranch;
  renderTaskRepositoryPicker();
}

function renderGitHubConnection() {
  const connected = Boolean(state.githubStatus?.connected && state.githubUser);
  const configured = Boolean(state.githubStatus?.hasToken);
  const tokenSource = state.githubStatus?.tokenSource || 'none';
  if (state.githubStatus?.createTokenUrl) {
    elements.githubCreateToken.href = state.githubStatus.createTokenUrl;
  }
  elements.githubTokenSetup.hidden = configured;
  elements.githubForm.hidden = !configured && !state.githubTokenEntryOpen;
  elements.githubToken.disabled = tokenSource === 'environment';
  if (configured) elements.githubTokenSteps.hidden = true;
  elements.githubConnectionBadge.textContent = connected
    ? '已连接'
    : configured
      ? '待验证'
      : '未连接';
  elements.githubConnectionBadge.className = `connection-badge${connected ? ' connected' : ''}`;
  elements.githubTokenHint.textContent =
    tokenSource === 'environment'
      ? 'Token 由 AGENT_GITHUB_TOKEN 环境变量管理；留空可直接验证，更换后需重启服务。'
      : configured
        ? '已有本地 Token；留空可直接验证，输入新 Token 会在验证成功后替换。'
        : '粘贴 Token 并验证成功后，将保存到 config/config.yaml。';
  if (!connected) {
    elements.githubAccount.innerHTML = `
      <div class="github-avatar" aria-hidden="true">GH</div>
      <div>
        <strong>${configured ? '等待验证已配置 Token' : '尚未连接 GitHub'}</strong>
        <small>${configured ? '正在等待读取 GitHub 身份' : '创建或填写 Token 后显示 GitHub 身份'}</small>
      </div>`;
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

function openGitHubTokenEntry(showSteps) {
  state.githubTokenEntryOpen = true;
  elements.githubTokenSteps.hidden = !showSteps;
  renderGitHubConnection();
  window.setTimeout(() => elements.githubToken.focus(), 0);
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
      selectTaskRepository(
        button.dataset.useRepository,
        button.dataset.defaultBranch || '',
      );
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
      const providerChanged = configuration.provider !== event.target.value;
      configuration.provider = event.target.value;
      if (providerChanged) {
        configuration.baseUrl = '';
        configuration.apiKey = '';
        configuration.clearApiKey = configuration.apiKeySource === 'file';
        configuration.hasApiKey = false;
        configuration.apiKeySource = 'none';
        renderModelConfigurations();
      }
    });
    row.querySelector('[data-field="baseUrl"]').addEventListener('input', (event) => {
      configuration.baseUrl = event.target.value;
    });
    row.querySelector('[data-field="apiKey"]').addEventListener('input', (event) => {
      configuration.apiKey = event.target.value;
      if (configuration.apiKey) configuration.clearApiKey = false;
    });
    row.querySelectorAll('[data-config-action]').forEach((button) => {
      button.addEventListener('click', () =>
        handleModelConfigurationAction(button.dataset.configAction, configuration.id),
      );
    });
    row.querySelector('[data-model-test-prompt]')?.addEventListener('input', (event) => {
      state.modelTestPrompt = event.target.value;
    });
    row.querySelector('[data-model-test-submit]')?.addEventListener('click', () =>
      startInlineModelTest(configuration.id),
    );
  });
}

function renderModelConfiguration(configuration, index) {
  const providerOptions = [
    ['codex', 'Codex'],
    ['claude', 'Claude Code'],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${configuration.provider === value ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const apiKeyPlaceholder =
    configuration.apiKeySource === 'file'
      ? '已保存，留空保持不变'
      : configuration.apiKeySource === 'environment'
        ? '已由环境变量提供，可填写覆盖'
        : '填写 API Key（可选）';
  const canClearApiKey = configuration.apiKeySource === 'file' || configuration.apiKey;
  return `
    <article class="model-config-item" data-config-id="${escapeHtml(configuration.id)}">
      <div class="model-config-rank"><strong>${index + 1}</strong><span>PRIORITY</span></div>
      <div class="model-config-fields">
        <label class="field">
          <span>Agent</span>
          <select data-field="provider">${providerOptions}</select>
        </label>
        <label class="field model-base-url-field">
          <span>Base URL</span>
          <input data-field="baseUrl" type="url" value="${escapeHtml(configuration.baseUrl || '')}" placeholder="${configuration.provider === 'codex' ? 'https://gateway.example.com/v1' : 'https://gateway.example.com'}" autocomplete="off" />
          <small>留空使用官方服务或 CLI 已有配置</small>
        </label>
        <label class="field model-api-key-field">
          <span>API Key</span>
          <div class="model-api-key-input">
            <input data-field="apiKey" type="password" value="${escapeHtml(configuration.apiKey || '')}" placeholder="${escapeHtml(apiKeyPlaceholder)}" autocomplete="new-password" />
            ${canClearApiKey ? '<button type="button" data-config-action="clear-key">清除</button>' : ''}
          </div>
          <small>${escapeHtml(apiKeyStatus(configuration))}</small>
        </label>
      </div>
      <div class="model-config-controls">
        <button class="test" type="button" data-config-action="test">测试</button>
        <button type="button" data-config-action="up" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-config-action="down" aria-label="下移" ${index === state.modelConfigs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="danger" type="button" data-config-action="delete">删除</button>
      </div>
      ${state.modelTestConfigId === configuration.id ? renderInlineModelTest(configuration) : ''}
    </article>`;
}

function handleModelConfigurationAction(action, id) {
  if (state.modelTestRunning) {
    showToast('模型正在测试，请等待本次调用结束。', true);
    return;
  }
  const index = state.modelConfigs.findIndex((configuration) => configuration.id === id);
  if (index === -1) return;
  if (action === 'test') {
    state.modelTestConfigId = id;
    state.modelTestPrompt = '';
  } else if (action === 'close-test') {
    state.modelTestConfigId = null;
    state.modelTestPrompt = '';
  } else if (action === 'up' && index > 0) {
    [state.modelConfigs[index - 1], state.modelConfigs[index]] = [
      state.modelConfigs[index],
      state.modelConfigs[index - 1],
    ];
  } else if (action === 'down' && index < state.modelConfigs.length - 1) {
    [state.modelConfigs[index + 1], state.modelConfigs[index]] = [
      state.modelConfigs[index],
      state.modelConfigs[index + 1],
    ];
  } else if (action === 'delete') {
    if (state.modelConfigs.length === 1) {
      showToast('至少需要保留一条模型配置。', true);
      return;
    }
    state.modelConfigs.splice(index, 1);
  } else if (action === 'clear-key') {
    state.modelConfigs[index].apiKey = '';
    state.modelConfigs[index].clearApiKey = true;
    state.modelConfigs[index].hasApiKey = false;
    state.modelConfigs[index].apiKeySource = 'none';
  }
  renderModelConfigurations();
}

function renderInlineModelTest(configuration) {
  return `
    <section class="model-config-test">
      <div class="model-config-test-header">
        <div>
          <strong>测试当前关联项 · ${escapeHtml(providerLabel(configuration.provider))}</strong>
          <small>直接使用 CLI/环境已配置的模型，不覆盖模型名。</small>
        </div>
        <button class="text-button" type="button" data-config-action="close-test">收起</button>
      </div>
      <div class="model-config-test-input">
        <textarea data-model-test-prompt rows="3" maxlength="4000" placeholder="例如：请用一句话介绍你自己">${escapeHtml(state.modelTestPrompt)}</textarea>
        <button class="save-button" type="button" data-model-test-submit>发送并测试</button>
      </div>
      <div class="model-test-terminal" data-model-test-terminal aria-live="polite">
        <p class="muted">输入内容后测试这条关联配置。</p>
      </div>
      <p class="model-test-cost-note">最多 4000 字；每次测试都会发起一次真实模型调用，且禁止使用工具和修改文件。</p>
    </section>`;
}

function appendModelTestLine(terminal, message, tone = '') {
  const line = document.createElement('p');
  if (tone) line.className = tone;
  line.textContent = message;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

async function startInlineModelTest(configurationId) {
  const configuration = state.modelConfigs.find((item) => item.id === configurationId);
  if (!configuration || state.modelTestRunning) return;
  const row = Array.from(
    elements.modelConfigList.querySelectorAll('[data-config-id]'),
  ).find((item) => item.dataset.configId === configurationId);
  const promptInput = row?.querySelector('[data-model-test-prompt]');
  const terminal = row?.querySelector('[data-model-test-terminal]');
  const submit = row?.querySelector('[data-model-test-submit]');
  if (!promptInput || !terminal || !submit) return;
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showToast('请输入要发送给 Agent 的内容。', true);
    promptInput.focus();
    return;
  }

  state.modelTestRunning = true;
  const interactive = Array.from(
    elements.modelSettingsForm.querySelectorAll('button, input, select, textarea'),
  );
  const disabledStates = interactive.map((element) => element.disabled);
  interactive.forEach((element) => {
    element.disabled = true;
  });
  submit.textContent = '测试中…';
  terminal.className = 'model-test-terminal running';
  terminal.innerHTML = '';
  appendModelTestLine(
    terminal,
    `> ${providerLabel(configuration.provider)} / CLI 已配置模型`,
    'command',
  );
  appendModelTestLine(terminal, `你：${prompt}`, 'command');
  appendModelTestLine(terminal, '正在启动对应 CLI…', 'pending');
  appendModelTestLine(terminal, '正在等待 Agent 回复…', 'muted');

  try {
    const result = await api('/api/console/model-test', {
      method: 'POST',
      body: JSON.stringify({
        id: configuration.id,
        provider: configuration.provider,
        baseUrl: configuration.baseUrl,
        apiKey: configuration.apiKey || undefined,
        clearApiKey: configuration.clearApiKey,
        prompt,
      }),
    });
    terminal.className = `model-test-terminal ${result.success ? 'success' : 'error'}`;
    appendModelTestLine(terminal, '', 'spacer');
    appendModelTestLine(terminal, result.message, result.success ? 'success' : 'error');
    if (result.response) {
      appendModelTestLine(terminal, `Agent 回复：\n${result.response}`, 'response');
    }
    appendModelTestLine(terminal, `耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`, 'muted');
    submit.textContent = '再次发送';
    showToast(result.message, !result.success);
  } catch (error) {
    terminal.className = 'model-test-terminal error';
    appendModelTestLine(terminal, '', 'spacer');
    appendModelTestLine(terminal, error.message, 'error');
    submit.textContent = '再次发送';
    showToast(error.message, true);
  } finally {
    state.modelTestRunning = false;
    interactive.forEach((element, index) => {
      element.disabled = disabledStates[index];
    });
  }
}

function addModelConfiguration() {
  if (state.modelConfigs.length >= 20) {
    showToast('模型配置不能超过 20 条。', true);
    return;
  }
  state.modelConfigs.push({
    id: createClientId(),
    provider: 'codex',
    baseUrl: '',
    apiKey: '',
    hasApiKey: false,
    apiKeySource: 'none',
    clearApiKey: false,
  });
  renderModelConfigurations();
  elements.modelConfigList.lastElementChild?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}

function resetModelConfigurations() {
  state.modelConfigs = [
    {
      id: createClientId(),
      provider: 'codex',
      baseUrl: '',
      apiKey: '',
      hasApiKey: false,
      apiKeySource: 'none',
      clearApiKey: false,
    },
    {
      id: createClientId(),
      provider: 'claude',
      baseUrl: '',
      apiKey: '',
      hasApiKey: false,
      apiKeySource: 'none',
      clearApiKey: false,
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
        `<span><b>${index + 1}</b>${escapeHtml(providerLabel(configuration.provider))}</span>`,
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
          baseUrl: configuration.baseUrl,
          apiKey: configuration.apiKey || undefined,
          clearApiKey: configuration.clearApiKey,
        })),
      }),
    });
    state.modelConfigs = editableModelConfigurations(state.settings.modelConfigs);
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
      const label = { codex: 'Codex', claude: 'Claude Code' }[a.provider] || a.provider;
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
  return { codex: 'Codex', claude: 'Claude Code' }[provider] || provider;
}

function editableModelConfigurations(configurations) {
  return configurations.map((configuration) => ({
    ...configuration,
    apiKey: '',
    clearApiKey: false,
  }));
}

function apiKeyStatus(configuration) {
  if (configuration.apiKey) return '将使用新填写的密钥';
  if (configuration.clearApiKey) return '保存后清除已存密钥';
  if (configuration.apiKeySource === 'file') return '页面不回显；密钥保存在本地设置文件';
  if (configuration.apiKeySource === 'environment') return '当前由服务环境变量提供';
  return '未配置时将尝试使用对应 CLI 的登录状态';
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
