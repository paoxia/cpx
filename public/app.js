const state = {
  settings: null,
  tasks: [],
  selectedTaskId: null,
  creatingTask: false,
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
  launchButton: document.querySelector('#launch-button'),
  newTaskButton: document.querySelector('#new-task-button'),
  newTaskToolbar: document.querySelector('#new-task-toolbar'),
  newTaskContext: document.querySelector('#new-task-context'),
  taskSuggestions: document.querySelector('#task-suggestions'),
  threadHeading: document.querySelector('#thread-heading'),
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
elements.taskForm.addEventListener('submit', submitTask);
elements.newTaskButton.addEventListener('click', startNewTask);
elements.newTaskToolbar.addEventListener('click', startNewTask);
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
  state.creatingTask = true;
  state.selectedTaskId = null;
  elements.repository.value = fullName;
  state.branchDefault = defaultBranch;
  elements.prompt.value = '';
  elements.taskBranch.value = '';
  enableNewTaskFields();
  updatePromptCount();
  renderTaskList();
  renderTaskDetail();
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

function selectedTaskBaseBranch() {
  const selectedBranch = elements.branchPicker.value;
  if (!elements.branchPicker.hidden && !elements.branchPicker.disabled && selectedBranch) {
    return selectedBranch === '__new__' ? state.branchDefault || undefined : selectedBranch;
  }
  return elements.baseBranch.value || undefined;
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
    if (!state.selectedTaskId && !state.creatingTask && state.tasks.length) {
      state.selectedTaskId = state.tasks[0].id;
      state.creatingTask = false;
    }
    renderTaskList();
    renderTaskDetail();
  } catch (error) {
    console.error(error);
  } finally {
    state.polling = false;
  }
}

async function submitTask(event) {
  event.preventDefault();
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!state.creatingTask && task) {
    await continueSelectedTask(task);
    return;
  }
  await createTask();
}

async function createTask() {
  elements.launchButton.disabled = true;
  elements.launchButton.querySelector('span').textContent = '正在启动…';
  try {
    const task = await api('/api/console/tasks', {
      method: 'POST',
      body: JSON.stringify({
        useFallback: false,
        repository: elements.repository.value,
        baseBranch: selectedTaskBaseBranch(),
        taskBranch: elements.taskBranch.value || undefined,
        prompt: elements.prompt.value,
      }),
    });
    state.selectedTaskId = task.id;
    state.creatingTask = false;
    state.tasks.unshift(task);
    elements.prompt.value = '';
    updatePromptCount();
    renderTaskList();
    renderTaskDetail();
    showToast('任务已启动，Agent 正在准备工作区。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (state.creatingTask) {
      elements.launchButton.disabled = false;
      elements.launchButton.querySelector('span').textContent = '创建任务';
    }
  }
}

async function continueSelectedTask(task) {
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  elements.launchButton.disabled = true;
  elements.launchButton.querySelector('span').textContent = '发送中…';
  try {
    const continued = await api('/api/console/task/continue', {
      method: 'POST',
      body: JSON.stringify({ id: task.id, prompt, useFallback: false }),
    });
    const index = state.tasks.findIndex((item) => item.id === continued.id);
    if (index >= 0) state.tasks[index] = continued;
    elements.prompt.value = '';
    updatePromptCount();
    renderTaskList();
    renderTaskDetail();
    showToast('已发送，Agent 将继续使用当前工作区。');
  } catch (error) {
    elements.launchButton.disabled = false;
    elements.launchButton.querySelector('span').textContent = '发送';
    showToast(error.message, true);
  }
}

function startNewTask() {
  state.creatingTask = true;
  state.selectedTaskId = null;
  elements.prompt.value = '';
  elements.taskBranch.value = '';
  enableNewTaskFields();
  updatePromptCount();
  renderTaskList();
  renderTaskDetail();
  window.requestAnimationFrame(() => elements.prompt.focus());
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
          <strong>${escapeHtml(task.prompt)}</strong>
          <span><i class="mini-dot ${task.status}"></i>${escapeHtml(shortRepository(task.repository))} · ${escapeHtml(statusLabel(task.status))}</span>
        </button>`,
    )
    .join('');
  elements.taskList.querySelectorAll('[data-task-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedTaskId = button.dataset.taskId;
      state.creatingTask = false;
      elements.prompt.value = '';
      updatePromptCount();
      renderTaskList();
      renderTaskDetail();
    });
  });
}

function renderTaskDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (state.creatingTask || !task) {
    state.creatingTask = true;
    elements.threadHeading.innerHTML = `
      <p class="eyebrow">NEW AGENT TASK</p>
      <h1>新建任务</h1>
      <p>选择仓库并描述你想完成的工作</p>`;
    elements.taskDetail.className = 'task-detail thread-empty';
    elements.taskDetail.innerHTML = `
      <div class="thread-empty-mark" aria-hidden="true">⌁</div>
      <h2>从一个开发任务开始</h2>
      <p>每个任务拥有独立的 Git worktree。完成第一轮后，可以在这里持续追加要求和调整代码。</p>`;
    elements.taskForm.classList.add('new-task-mode');
    elements.newTaskContext.hidden = false;
    elements.taskSuggestions.hidden = false;
    elements.prompt.disabled = false;
    elements.prompt.placeholder = '描述要完成的工作…';
    elements.launchButton.disabled = false;
    elements.launchButton.querySelector('span').textContent = '创建任务';
    return;
  }

  const active = ['queued', 'preparing', 'running', 'publishing'].includes(task.status);
  const canContinue = !active && task.workspace && task.agentBranch;
  elements.threadHeading.innerHTML = `
    <div class="thread-title-row">
      <span class="status-badge"><i class="mini-dot ${task.status}"></i>${escapeHtml(statusLabel(task.status))}</span>
      ${active ? '<button class="cancel-button" type="button">停止</button>' : ''}
    </div>
    <h1>${escapeHtml(task.prompt)}</h1>
    <p>${escapeHtml(shortRepository(task.repository))} · ${escapeHtml(task.agentBranch || task.baseBranch || '准备分支中')} · ${escapeHtml(providerLabel(task.provider))}${task.model ? ` / ${escapeHtml(task.model)}` : ''}</p>`;
  elements.taskDetail.className = 'task-detail thread-conversation';
  elements.taskDetail.innerHTML = `
    <div class="conversation-stream">
      ${task.turns.map((turn, index) => renderConversationTurn(task, turn, index)).join('')}
    </div>
    <details class="run-details">
      <summary>运行详情 <span>${task.logs.length} 条日志 · ${task.attempts.length} 次执行</span></summary>
      ${renderAttempts(task.attempts)}
      <pre class="task-output" aria-label="任务输出">${escapeHtml(formatTaskLogs(task.logs))}</pre>
    </details>
    <div class="workspace-strip">
      ${task.workspace ? `<span>WORKSPACE · ${escapeHtml(task.workspace)}</span>` : '<span>正在准备工作区…</span>'}
      <time>${escapeHtml(formatTime(task.updatedAt))}</time>
    </div>`;

  elements.taskForm.classList.remove('new-task-mode');
  elements.newTaskContext.hidden = true;
  disableNewTaskFields();
  elements.taskSuggestions.hidden = true;
  elements.prompt.disabled = !canContinue;
  elements.prompt.placeholder = active
    ? 'Agent 正在工作，完成后可继续输入…'
    : canContinue
      ? '继续要求 Agent 调整这个任务…'
      : '工作区未创建，无法继续此任务';
  elements.launchButton.disabled = !canContinue;
  elements.launchButton.querySelector('span').textContent = active ? '执行中' : '发送';

  elements.threadHeading.querySelector('.cancel-button')?.addEventListener('click', async () => {
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

  elements.taskDetail.scrollTop = elements.taskDetail.scrollHeight;
}

function enableNewTaskFields() {
  elements.repositoryPicker.disabled = false;
  elements.repository.disabled = false;
  elements.branchPicker.disabled = false;
  elements.baseBranch.disabled = false;
  elements.taskBranch.disabled = false;
  renderTaskRepositoryPicker();
}

function disableNewTaskFields() {
  elements.repositoryPicker.disabled = true;
  elements.repository.disabled = true;
  elements.branchPicker.disabled = true;
  elements.baseBranch.disabled = true;
  elements.taskBranch.disabled = true;
}

function renderConversationTurn(task, turn, index) {
  const response = turn.response || (index === task.turns.length - 1 ? task.lastAgentResponse : '');
  const isCurrent = index === task.turns.length - 1;
  const waiting = isCurrent && ['queued', 'running'].includes(turn.status) && !response;
  return `
    <section class="conversation-turn">
      <article class="chat-message user-message">
        <div class="message-avatar">你</div>
        <div class="message-content">
          <div class="message-label">你 <time>${escapeHtml(formatTime(turn.createdAt))}</time></div>
          <div class="message-body">${escapeHtml(turn.prompt)}</div>
        </div>
      </article>
      <article class="chat-message agent-message ${waiting ? 'waiting' : ''}">
        <div class="message-avatar">⌁</div>
        <div class="message-content">
          <div class="message-label">Codex <span>${escapeHtml(turnStatusLabel(turn.status))}</span></div>
          <div class="message-body">${
            response
              ? escapeHtml(response)
              : waiting
                ? '<span class="thinking"><i></i><i></i><i></i></span> 正在分析并修改代码…'
                : escapeHtml(turn.error || '这一轮没有返回文本结果。')
          }</div>
        </div>
      </article>
    </section>`;
}

function formatTaskLogs(logs) {
  return logs
    .map(
      (log) =>
        `${new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}  ${log.stream === 'stderr' ? '!' : log.stream === 'system' ? '›' : ' '} ${log.message}`,
    )
    .join('\n');
}

function turnStatusLabel(status) {
  return (
    {
      queued: '等待中',
      running: '工作中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已停止',
    }[status] || status
  );
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
