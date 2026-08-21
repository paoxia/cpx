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
  branchRequestId: 0,
  branchRepository: null,
  branchDefault: '',
  integrations: null,
  codexConfig: null,
  codexAuth: null,
  codexModels: [],
  codexTestRunning: false,
};

const elements = {
  taskForm: document.querySelector('#task-form'),
  repositoryPicker: document.querySelector('#repository-picker'),
  repository: document.querySelector('#repository'),
  repositoryHint: document.querySelector('#repository-hint'),
  branchPicker: document.querySelector('#branch-picker'),
  baseBranch: document.querySelector('#base-branch'),
  taskBranch: document.querySelector('#task-branch'),
  branchHint: document.querySelector('#branch-hint'),
  prompt: document.querySelector('#prompt'),
  promptCount: document.querySelector('#prompt-count'),
  createPr: document.querySelector('#create-pr'),
  launchButton: document.querySelector('#launch-button'),
  taskList: document.querySelector('#task-list'),
  taskCount: document.querySelector('#task-count'),
  taskDetail: document.querySelector('#task-detail'),
  tasksView: document.querySelector('#tasks-view'),
  githubView: document.querySelector('#github-view'),
  integrationsView: document.querySelector('#integrations-view'),
  codexView: document.querySelector('#codex-view'),
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
  executionOrderPreview: document.querySelector('#execution-order-preview'),
  feishuForm: document.querySelector('#feishu-form'),
  feishuEnabled: document.querySelector('#feishu-enabled'),
  feishuAppId: document.querySelector('#feishu-app-id'),
  feishuAppSecret: document.querySelector('#feishu-app-secret'),
  feishuStatus: document.querySelector('#feishu-status'),
  feishuStatusMessage: document.querySelector('#feishu-status-message'),
  dingtalkForm: document.querySelector('#dingtalk-form'),
  dingtalkEnabled: document.querySelector('#dingtalk-enabled'),
  dingtalkClientId: document.querySelector('#dingtalk-client-id'),
  dingtalkClientSecret: document.querySelector('#dingtalk-client-secret'),
  dingtalkStatus: document.querySelector('#dingtalk-status'),
  dingtalkStatusMessage: document.querySelector('#dingtalk-status-message'),
  codexAuthStatus: document.querySelector('#codex-auth-status'),
  codexCliStatus: document.querySelector('#codex-cli-status'),
  codexAuthMessage: document.querySelector('#codex-auth-message'),
  codexAuthMethod: document.querySelector('#codex-auth-method'),
  codexDeviceLogin: document.querySelector('#codex-device-login'),
  codexCancelLogin: document.querySelector('#codex-cancel-login'),
  codexDeviceDetails: document.querySelector('#codex-device-details'),
  codexVerificationUrl: document.querySelector('#codex-verification-url'),
  codexUserCode: document.querySelector('#codex-user-code'),
  codexCopyCode: document.querySelector('#codex-copy-code'),
  codexAuthOutput: document.querySelector('#codex-auth-output'),
  codexApiKeyForm: document.querySelector('#codex-api-key-form'),
  codexApiKey: document.querySelector('#codex-api-key'),
  profileList: document.querySelector('#profile-list'),
  profileForm: document.querySelector('#profile-form'),
  profileId: document.querySelector('#profile-id'),
  profileName: document.querySelector('#profile-name'),
  profileModel: document.querySelector('#profile-model'),
  profileReasoning: document.querySelector('#profile-reasoning'),
  profileNew: document.querySelector('#profile-new'),
  profileDelete: document.querySelector('#profile-delete'),
  modelsRefresh: document.querySelector('#models-refresh'),
  modelCatalogMessage: document.querySelector('#model-catalog-message'),
  codexConfigForm: document.querySelector('#codex-config-form'),
  codexApproval: document.querySelector('#codex-approval'),
  codexSandbox: document.querySelector('#codex-sandbox'),
  codexWebSearch: document.querySelector('#codex-web-search'),
  codexTestPrompt: document.querySelector('#codex-test-prompt'),
  codexTestSubmit: document.querySelector('#codex-test-submit'),
  codexTestTerminal: document.querySelector('#codex-test-terminal'),
  activeProfileLabel: document.querySelector('#active-profile-label'),
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
elements.branchPicker.addEventListener('change', handleTaskBranchSelection);
elements.taskForm.addEventListener('submit', createTask);
elements.feishuForm.addEventListener('submit', (event) => saveIntegration(event, 'feishu'));
elements.dingtalkForm.addEventListener('submit', (event) => saveIntegration(event, 'dingtalk'));
elements.codexDeviceLogin.addEventListener('click', startCodexDeviceLogin);
elements.codexCancelLogin.addEventListener('click', cancelCodexLogin);
elements.codexCopyCode.addEventListener('click', copyCodexDeviceCode);
elements.codexApiKeyForm.addEventListener('submit', loginCodexWithApiKey);
elements.profileForm.addEventListener('submit', saveAgentProfile);
elements.profileNew.addEventListener('click', () => editAgentProfile());
elements.profileDelete.addEventListener('click', deleteAgentProfile);
elements.modelsRefresh.addEventListener('click', () => loadCodexModels(true));
elements.profileModel.addEventListener('change', updateProfileEffortOptions);
elements.codexConfigForm.addEventListener('submit', saveCodexConfig);
elements.codexTestSubmit.addEventListener('click', testCodex);
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
    if (['github', 'integrations', 'codex'].includes(initialView)) {
      await switchView(initialView);
    }
    window.setInterval(refreshTasks, 1200);
    window.setInterval(() => {
      if (state.activeView === 'codex' && state.codexAuth?.state === 'waiting') {
        void refreshCodexAuth();
      }
    }, 1500);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadSettings() {
  state.settings = await api('/api/console/settings');
  renderExecutionOrderPreview();
  renderAgentProfiles();
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
    showManualBranchField();
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
    if (state.branchRepository !== selectedRepository.fullName) {
      void loadTaskBranches(selectedRepository.fullName, selectedRepository.defaultBranch);
    }
  } else if (currentValue) {
    elements.repositoryPicker.value = '__manual__';
    elements.repository.hidden = false;
    elements.repository.required = true;
    showManualBranchField();
  } else {
    elements.repositoryPicker.value = '';
    elements.repository.hidden = true;
    elements.repository.required = false;
    resetTaskBranchPicker();
  }
  elements.repositoryHint.textContent = `可选择当前 Token 授权的 ${repositories.length} 个项目，或手动输入仓库地址`;
}

function handleTaskRepositorySelection() {
  const selectedValue = elements.repositoryPicker.value;
  if (selectedValue === '__manual__') {
    elements.repository.value = '';
    elements.repository.hidden = false;
    elements.repository.required = true;
    showManualBranchField();
    elements.repository.focus();
    return;
  }

  elements.repository.hidden = true;
  elements.repository.required = false;
  elements.repository.value = selectedValue;
  const repository = state.repositories.find((item) => item.fullName === selectedValue);
  if (repository) {
    void loadTaskBranches(repository.fullName, repository.defaultBranch);
  } else {
    resetTaskBranchPicker();
  }
}

function selectTaskRepository(fullName, defaultBranch = '') {
  elements.repository.value = fullName;
  state.branchDefault = defaultBranch;
  renderTaskRepositoryPicker();
}

function resetTaskBranchPicker() {
  state.branchRequestId += 1;
  state.branchRepository = null;
  state.branchDefault = '';
  elements.branchPicker.hidden = false;
  elements.branchPicker.disabled = true;
  elements.branchPicker.required = false;
  elements.branchPicker.innerHTML = '<option value="">先选择项目</option>';
  elements.baseBranch.hidden = true;
  elements.baseBranch.required = false;
  elements.baseBranch.value = '';
  elements.taskBranch.hidden = true;
  elements.taskBranch.required = false;
  elements.taskBranch.value = '';
  elements.branchHint.textContent = '选择项目后可读取现有分支或新建任务分支';
}

function showManualBranchField() {
  state.branchRequestId += 1;
  state.branchRepository = null;
  state.branchDefault = '';
  elements.branchPicker.hidden = true;
  elements.branchPicker.disabled = true;
  elements.branchPicker.required = false;
  elements.baseBranch.hidden = false;
  elements.baseBranch.required = false;
  elements.baseBranch.value = '';
  elements.taskBranch.hidden = true;
  elements.taskBranch.required = false;
  elements.taskBranch.value = '';
  elements.branchHint.textContent = '手动输入仓库时可指定基础分支';
}

async function loadTaskBranches(repository, defaultBranch) {
  const requestId = ++state.branchRequestId;
  state.branchRepository = repository;
  state.branchDefault = defaultBranch || '';
  elements.branchPicker.hidden = false;
  elements.branchPicker.disabled = true;
  elements.branchPicker.required = false;
  elements.branchPicker.innerHTML = '<option value="">正在读取分支…</option>';
  elements.baseBranch.hidden = true;
  elements.baseBranch.required = false;
  elements.baseBranch.value = defaultBranch || '';
  elements.taskBranch.hidden = true;
  elements.taskBranch.required = false;
  elements.taskBranch.value = '';
  elements.branchHint.textContent = '正在读取仓库分支…';

  try {
    const result = await api(
      `/api/console/github/branches?repository=${encodeURIComponent(repository)}`,
    );
    if (requestId !== state.branchRequestId || state.branchRepository !== repository) return;
    const branches = [...(result.branches || [])].sort((left, right) => {
      if (left.name === defaultBranch) return -1;
      if (right.name === defaultBranch) return 1;
      return left.name.localeCompare(right.name);
    });
    elements.branchPicker.innerHTML = [
      ...branches.map(
        (branch) =>
          `<option value="${escapeHtml(branch.name)}">${escapeHtml(branch.name)}${branch.protected ? ' · 受保护' : ''}</option>`,
      ),
      '<option value="__new__">＋ 新建任务分支…</option>',
    ].join('');
    elements.branchPicker.disabled = false;
    elements.branchPicker.required = true;
    const selectedBranch =
      branches.find((branch) => branch.name === defaultBranch)?.name ||
      branches[0]?.name ||
      '__new__';
    elements.branchPicker.value = selectedBranch;
    elements.branchHint.textContent = branches.length
      ? `已读取 ${branches.length} 个分支；选择现有分支作为基线，或新建任务分支`
      : '仓库暂无可选分支，请新建任务分支';
    handleTaskBranchSelection();
  } catch (error) {
    if (requestId !== state.branchRequestId) return;
    elements.branchPicker.hidden = true;
    elements.branchPicker.disabled = true;
    elements.branchPicker.required = false;
    elements.baseBranch.hidden = false;
    elements.baseBranch.value = defaultBranch || '';
    elements.branchHint.textContent = '分支读取失败，可手动填写基础分支';
    showToast(error.message, true);
  }
}

function handleTaskBranchSelection() {
  const selectedBranch = elements.branchPicker.value;
  if (selectedBranch === '__new__') {
    elements.baseBranch.value = state.branchDefault;
    elements.taskBranch.hidden = false;
    elements.taskBranch.required = true;
    elements.branchHint.textContent = `新分支将基于 ${state.branchDefault || '仓库默认分支'} 创建`;
    elements.taskBranch.focus();
    return;
  }
  elements.baseBranch.value = selectedBranch;
  elements.taskBranch.hidden = true;
  elements.taskBranch.required = false;
  elements.taskBranch.value = '';
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
      selectTaskRepository(button.dataset.useRepository, button.dataset.defaultBranch || '');
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

function appendModelTestLine(terminal, message, tone = '') {
  const line = document.createElement('p');
  if (tone) line.className = tone;
  line.textContent = message;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

async function testCodex() {
  if (state.codexTestRunning) return;
  const prompt = elements.codexTestPrompt.value.trim();
  if (!prompt) {
    showToast('请输入要发送给 Agent 的内容。', true);
    elements.codexTestPrompt.focus();
    return;
  }
  state.codexTestRunning = true;
  elements.codexTestSubmit.disabled = true;
  elements.codexTestSubmit.textContent = '测试中…';
  elements.codexTestTerminal.className = 'model-test-terminal running';
  elements.codexTestTerminal.innerHTML = '';
  const profile = activeAgentProfile();
  if (!profile) return;
  appendModelTestLine(
    elements.codexTestTerminal,
    `> ${profile.name} / ${providerLabel(profile.provider)}`,
    'command',
  );
  appendModelTestLine(elements.codexTestTerminal, `你：${prompt}`, 'command');
  appendModelTestLine(elements.codexTestTerminal, '正在等待 Codex 回复…', 'muted');
  try {
    const result = await api('/api/console/model-test', {
      method: 'POST',
      body: JSON.stringify({ ...profile, prompt }),
    });
    elements.codexTestTerminal.className = `model-test-terminal ${result.success ? 'success' : 'error'}`;
    appendModelTestLine(
      elements.codexTestTerminal,
      result.message,
      result.success ? 'success' : 'error',
    );
    if (result.response) {
      appendModelTestLine(
        elements.codexTestTerminal,
        `${providerLabel(profile.provider)} 回复：\n${result.response}`,
        'response',
      );
    }
    appendModelTestLine(
      elements.codexTestTerminal,
      `耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`,
      'muted',
    );
    showToast(result.message, !result.success);
  } catch (error) {
    elements.codexTestTerminal.className = 'model-test-terminal error';
    appendModelTestLine(elements.codexTestTerminal, error.message, 'error');
    showToast(error.message, true);
  } finally {
    state.codexTestRunning = false;
    elements.codexTestSubmit.disabled = false;
    elements.codexTestSubmit.textContent = '再次发送';
  }
}

async function loadIntegrations() {
  state.integrations = await api('/api/console/integrations');
  renderIntegrations();
}

function renderIntegrations() {
  for (const platform of ['feishu', 'dingtalk']) {
    const status = state.integrations?.[platform];
    if (!status) continue;
    elements[`${platform}Enabled`].checked = status.enabled;
    const idInput = elements[platform === 'feishu' ? 'feishuAppId' : 'dingtalkClientId'];
    idInput.placeholder = status[platform === 'feishu' ? 'hasAppId' : 'hasClientId']
      ? '已配置；留空可保留'
      : platform === 'feishu'
        ? 'cli_…'
        : 'ding…';
    const badge = elements[`${platform}Status`];
    badge.textContent = connectionStateLabel(status.state);
    badge.className = `connection-badge ${status.state === 'connected' ? 'connected' : status.state === 'connecting' ? 'pending' : status.state === 'error' ? 'error' : ''}`;
    elements[`${platform}StatusMessage`].textContent = status.message;
  }
}

async function saveIntegration(event, platform) {
  event.preventDefault();
  const form = platform === 'feishu' ? elements.feishuForm : elements.dingtalkForm;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = '正在验证并连接…';
  try {
    const body =
      platform === 'feishu'
        ? {
            platform,
            enabled: elements.feishuEnabled.checked,
            appId: elements.feishuAppId.value || undefined,
            appSecret: elements.feishuAppSecret.value || undefined,
          }
        : {
            platform,
            enabled: elements.dingtalkEnabled.checked,
            clientId: elements.dingtalkClientId.value || undefined,
            clientSecret: elements.dingtalkClientSecret.value || undefined,
          };
    state.integrations = await api('/api/console/integrations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    elements.feishuAppId.value = '';
    elements.feishuAppSecret.value = '';
    elements.dingtalkClientId.value = '';
    elements.dingtalkClientSecret.value = '';
    renderIntegrations();
    const status = state.integrations[platform];
    showToast(
      status.state === 'connected' || status.state === 'disabled'
        ? status.message
        : `配置已保存：${status.message}`,
      status.state === 'error',
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '保存并连接';
  }
}

async function loadCodexPage() {
  const [config, auth] = await Promise.all([loadCodexConfig(), refreshCodexAuth()]);
  if (auth.authenticated) await loadCodexModels(false);
  else renderModelCatalog();
  renderAgentProfiles();
  return config;
}

async function loadCodexModels(notify = false) {
  elements.modelsRefresh.disabled = true;
  elements.modelsRefresh.textContent = '正在刷新…';
  try {
    const catalog = await api('/api/console/codex-models');
    state.codexModels = catalog.models || [];
    renderModelCatalog();
    if (notify) showToast(`已读取 ${state.codexModels.length} 个 Codex 模型。`);
    return catalog;
  } catch (error) {
    state.codexModels = [];
    renderModelCatalog(error.message);
    if (notify) showToast(error.message, true);
    return null;
  } finally {
    elements.modelsRefresh.disabled = false;
    elements.modelsRefresh.textContent = '刷新模型列表';
  }
}

function renderModelCatalog(errorMessage) {
  const savedModel = elements.profileModel.value || activeAgentProfile()?.model || '';
  const options = state.codexModels.map(
    (model) =>
      `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName)} · ${escapeHtml(model.id)}</option>`,
  );
  if (savedModel && !state.codexModels.some((model) => model.id === savedModel)) {
    options.unshift(
      `<option value="${escapeHtml(savedModel)}">${escapeHtml(savedModel)}（已保存，当前目录不可用）</option>`,
    );
  }
  if (!options.length) {
    options.push(
      `<option value="${escapeHtml(savedModel)}">${escapeHtml(savedModel || '登录 Codex 后刷新模型列表')}</option>`,
    );
  }
  elements.profileModel.innerHTML = options.join('');
  elements.profileModel.value = savedModel || state.codexModels[0]?.id || '';
  elements.profileModel.disabled = state.codexModels.length === 0;
  elements.modelCatalogMessage.textContent = errorMessage
    ? errorMessage
    : state.codexModels.length
      ? `模型目录来自当前登录的 Codex 账号，共 ${state.codexModels.length} 个可选模型。聊天任务失败时会按配置列表顺序回退。`
      : '请先登录 Codex，再刷新模型列表。';
  updateProfileEffortOptions();
}

async function loadCodexConfig() {
  state.codexConfig = await api('/api/console/codex-config');
  elements.codexApproval.value = state.codexConfig.approvalPolicy;
  elements.codexSandbox.value = state.codexConfig.sandboxMode;
  elements.codexWebSearch.value = state.codexConfig.webSearch;
  return state.codexConfig;
}

async function saveCodexConfig(event) {
  event.preventDefault();
  const button = elements.codexConfigForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    state.codexConfig = await api('/api/console/codex-config', {
      method: 'POST',
      body: JSON.stringify({
        model: state.codexConfig?.model,
        modelReasoningEffort: state.codexConfig?.modelReasoningEffort || 'high',
        approvalPolicy: elements.codexApproval.value,
        sandboxMode: elements.codexSandbox.value,
        webSearch: elements.codexWebSearch.value,
      }),
    });
    showToast('Codex 配置已保存，下一次任务开始时生效。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function refreshCodexAuth() {
  const wasAuthenticated = state.codexAuth?.authenticated;
  state.codexAuth = await api('/api/console/agent-auth?provider=codex');
  renderCodexAuth();
  if (!wasAuthenticated && state.codexAuth.authenticated && state.activeView === 'codex') {
    void loadCodexModels(false);
  }
  return state.codexAuth;
}

function renderCodexAuth() {
  const auth = state.codexAuth;
  if (!auth) return;
  const tone = auth.authenticated
    ? 'connected'
    : auth.state === 'waiting'
      ? 'pending'
      : auth.state === 'failed'
        ? 'error'
        : '';
  elements.codexAuthStatus.textContent = auth.authenticated
    ? '已登录'
    : auth.state === 'waiting'
      ? '等待授权'
      : '未登录';
  elements.codexAuthStatus.className = `connection-badge ${tone}`;
  elements.codexCliStatus.textContent = auth.cliAvailable ? 'CLI 可用' : 'CLI 缺失';
  elements.codexCliStatus.className = `connection-badge ${auth.cliAvailable ? 'connected' : 'error'}`;
  elements.codexAuthMessage.textContent = auth.message || '尚未登录。';
  elements.codexAuthMethod.textContent = `认证方式：${auth.authMethod || '未登录'}`;
  elements.codexCancelLogin.hidden = auth.state !== 'waiting';
  elements.codexDeviceLogin.disabled = auth.state === 'waiting';
  elements.codexDeviceDetails.hidden = auth.state !== 'waiting';
  if (auth.verificationUrl) {
    elements.codexVerificationUrl.href = auth.verificationUrl;
    elements.codexVerificationUrl.textContent = auth.verificationUrl;
  }
  elements.codexUserCode.textContent = auth.userCode || '等待设备码…';
  elements.codexAuthOutput.textContent = auth.output || '';
}

async function startCodexDeviceLogin() {
  try {
    state.codexAuth = await api('/api/console/agent-auth/login', {
      method: 'POST',
      body: JSON.stringify({ provider: 'codex' }),
    });
    renderCodexAuth();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loginCodexWithApiKey(event) {
  event.preventDefault();
  const apiKey = elements.codexApiKey.value.trim();
  if (!apiKey) return showToast('请输入 OpenAI API Key。', true);
  const button = elements.codexApiKeyForm.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = '正在验证…';
  try {
    state.codexAuth = await api('/api/console/agent-auth/api-key', {
      method: 'POST',
      body: JSON.stringify({ provider: 'codex', apiKey }),
    });
    elements.codexApiKey.value = '';
    renderCodexAuth();
    if (state.codexAuth.authenticated) await loadCodexModels(false);
    showToast(state.codexAuth.message, !state.codexAuth.authenticated);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '验证并登录';
  }
}

async function cancelCodexLogin() {
  try {
    await api('/api/console/agent-auth/cancel', {
      method: 'POST',
      body: JSON.stringify({ provider: 'codex' }),
    });
    await refreshCodexAuth();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function copyCodexDeviceCode() {
  const code = state.codexAuth?.userCode;
  if (!code) return;
  await navigator.clipboard.writeText(code);
  showToast('设备码已复制。');
}

function activeAgentProfile() {
  return state.settings?.modelConfigs?.find(
    (profile) => profile.id === state.settings.activeConfigurationId,
  );
}

function renderAgentProfiles() {
  if (!elements.profileList || !state.settings) return;
  elements.profileList.innerHTML = state.settings.modelConfigs
    .map((profile) => {
      const active = profile.id === state.settings.activeConfigurationId;
      return `<button class="agent-profile-item ${active ? 'active' : ''}" data-profile-id="${escapeHtml(profile.id)}" type="button"><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(providerLabel(profile.provider))} · ${escapeHtml(profile.model || 'CLI 默认模型')} · ${escapeHtml(profile.reasoningEffort)}</small></span><em>${active ? '当前' : '切换'}</em></button>`;
    })
    .join('');
  elements.profileList.querySelectorAll('[data-profile-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.profileId;
      if (id === state.settings.activeConfigurationId) {
        editAgentProfile(id);
        return;
      }
      await persistAgentProfiles(id);
      editAgentProfile(id);
      showToast('当前 Agent 配置已切换。');
    });
  });
  const active = activeAgentProfile();
  elements.activeProfileLabel.textContent = active
    ? `${active.name} · ${providerLabel(active.provider)} · ${active.model || 'CLI 默认模型'} · ${active.reasoningEffort}`
    : '请选择配置';
  renderExecutionOrderPreview();
  if (!elements.profileId.value && active) editAgentProfile(active.id);
}

function editAgentProfile(id) {
  const profile = state.settings?.modelConfigs?.find((item) => item.id === id);
  elements.profileId.value = profile?.id || '';
  elements.profileName.value = profile?.name || '';
  const modelId = profile?.model || state.codexModels[0]?.id || '';
  if (
    modelId &&
    !Array.from(elements.profileModel.options).some((option) => option.value === modelId)
  ) {
    elements.profileModel.add(
      new Option(`${modelId}（已保存，当前目录不可用）`, modelId, true, true),
      0,
    );
  }
  elements.profileModel.value = modelId;
  elements.profileReasoning.dataset.savedValue = profile?.reasoningEffort || '';
  elements.profileDelete.disabled = !profile || state.settings.modelConfigs.length === 1;
  updateProfileEffortOptions();
}

function updateProfileEffortOptions() {
  const model = state.codexModels.find((item) => item.id === elements.profileModel.value);
  const saved = elements.profileReasoning.dataset.savedValue || elements.profileReasoning.value;
  const efforts = model?.supportedReasoningEfforts || (saved ? [saved] : ['high']);
  elements.profileReasoning.innerHTML = efforts
    .map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`)
    .join('');
  elements.profileReasoning.value = efforts.includes(saved)
    ? saved
    : model?.defaultReasoningEffort || efforts[0];
  elements.profileReasoning.dataset.savedValue = '';
}

async function saveAgentProfile(event) {
  event.preventDefault();
  const id = elements.profileId.value || `profile-${Date.now()}`;
  const next = {
    id,
    name: elements.profileName.value.trim(),
    provider: 'codex',
    model: elements.profileModel.value || undefined,
    reasoningEffort: elements.profileReasoning.value,
  };
  const profiles = state.settings.modelConfigs.some((item) => item.id === id)
    ? state.settings.modelConfigs.map((item) => (item.id === id ? next : item))
    : [...state.settings.modelConfigs, next];
  await persistAgentProfiles(state.settings.activeConfigurationId, profiles);
  editAgentProfile(id);
  showToast('Codex 配置已保存。');
}

async function deleteAgentProfile() {
  const id = elements.profileId.value;
  if (!id || state.settings.modelConfigs.length <= 1) return;
  const profiles = state.settings.modelConfigs.filter((item) => item.id !== id);
  const activeId =
    state.settings.activeConfigurationId === id
      ? profiles[0].id
      : state.settings.activeConfigurationId;
  await persistAgentProfiles(activeId, profiles);
  editAgentProfile(activeId);
  showToast('Agent 配置已删除。');
}

async function persistAgentProfiles(
  activeConfigurationId,
  modelConfigs = state.settings.modelConfigs,
) {
  state.settings = await api('/api/console/settings', {
    method: 'POST',
    body: JSON.stringify({ activeConfigurationId, modelConfigs }),
  });
  renderAgentProfiles();
}

function renderExecutionOrderPreview() {
  const profile = activeAgentProfile();
  elements.executionOrderPreview.innerHTML = profile
    ? `<span><b>1</b>${escapeHtml(providerLabel(profile.provider))} · ${escapeHtml(profile.name)}</span>`
    : '<span><b>1</b>未选择 Codex 配置</span>';
}

function connectionStateLabel(stateValue) {
  return (
    { disabled: '未启用', connecting: '连接中', connected: '已连接', error: '连接失败' }[
      stateValue
    ] || stateValue
  );
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
        useFallback: false,
        repository: elements.repository.value,
        baseBranch: elements.baseBranch.value || undefined,
        taskBranch: elements.taskBranch.value || undefined,
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
  const canContinue = !active && task.workspace && task.agentBranch;
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
    ${
      canContinue
        ? `
      <form class="continue-task-form">
        <label>
          <span>继续修改这个工作区</span>
          <textarea rows="4" name="prompt" required placeholder="输入下一轮要求，Codex 会继续当前会话和代码现场。"></textarea>
        </label>
        <button class="launch-button continue-task-button" type="submit"><span>继续任务</span></button>
      </form>`
        : ''
    }
    ${task.pullRequestUrl ? `<a class="pr-link" href="${escapeHtml(task.pullRequestUrl)}" target="_blank" rel="noreferrer"><span>打开 Pull Request</span><b>↗</b></a>` : ''}
    ${task.repositoryPath ? `<div class="workspace-path">REPOSITORY · ${escapeHtml(task.repositoryPath)}</div>` : ''}
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

  elements.taskDetail
    .querySelector('.continue-task-form')
    ?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      const prompt = form.querySelector('textarea').value;
      button.disabled = true;
      try {
        const continued = await api('/api/console/task/continue', {
          method: 'POST',
          body: JSON.stringify({ id: task.id, prompt, useFallback: false }),
        });
        const index = state.tasks.findIndex((item) => item.id === continued.id);
        if (index >= 0) state.tasks[index] = continued;
        renderTaskList();
        renderTaskDetail();
        showToast('已追加指令，继续使用原工作区。');
      } catch (error) {
        button.disabled = false;
        showToast(error.message, true);
      }
    });
}

async function switchView(view) {
  const normalized = ['tasks', 'github', 'integrations', 'codex'].includes(view) ? view : 'tasks';
  state.activeView = normalized;
  window.history.replaceState(null, '', normalized === 'tasks' ? '#' : `#${normalized}`);
  elements.tasksView.hidden = normalized !== 'tasks';
  elements.githubView.hidden = normalized !== 'github';
  elements.integrationsView.hidden = normalized !== 'integrations';
  elements.codexView.hidden = normalized !== 'codex';
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
  if (normalized === 'integrations') {
    try {
      await loadIntegrations();
    } catch (error) {
      showToast(error.message, true);
    }
  }
  if (normalized === 'codex') {
    try {
      await loadCodexPage();
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
      const label = a.provider === 'codex' ? 'Codex' : a.provider;
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
  return provider === 'codex' ? 'Codex' : provider;
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
