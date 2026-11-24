const state = {
  settings: null,
  activeView: 'stories',
  workspaceMode: null,
  workspace: null,
  workspacePaths: new Set(),
  workspaceBusy: false,
  recentWorkspaces: [],
  directoryBrowser: null,
  directoryBrowserRequest: 0,
  workspaceFile: null,
  story: null,
  storyRun: null,
  storyRunPolling: false,
  sessionsPolling: false,
  sessionIndex: [],
  sessionTab: 'sessions',
  sessionSelection: 0,
  githubStatus: null,
  githubUser: null,
  repositories: [],
  githubLoaded: false,
  githubTokenEntryOpen: false,
  integrations: null,
  codexConfig: null,
  codexAuth: null,
  codexModels: [],
  codexTestRunning: false,
};

const elements = {
  workspaceView: document.querySelector('#workspace-view'),
  workspaceForm: document.querySelector('#workspace-form'),
  workspaceAccessField: document.querySelector('#workspace-access-field'),
  workspaceAccess: document.querySelector('#workspace-access'),
  workspaceOperation: document.querySelector('#workspace-operation'),
  workspaceGitHubField: document.querySelector('#workspace-github-field'),
  workspaceGitHubRepository: document.querySelector('#workspace-github-repository'),
  workspaceGitHubRepositories: document.querySelector('#workspace-github-repositories'),
  workspaceGitHubConnect: document.querySelector('#workspace-github-connect'),
  workspacePathField: document.querySelector('#workspace-path-field'),
  workspacePath: document.querySelector('#workspace-path'),
  workspacePathHint: document.querySelector('#workspace-path-hint'),
  workspacePaths: document.querySelector('#workspace-recent-paths'),
  workspaceRecentField: document.querySelector('#workspace-recent-field'),
  workspaceRecent: document.querySelector('#workspace-recent'),
  workspaceBrowse: document.querySelector('#workspace-browse'),
  directoryPicker: document.querySelector('#directory-picker'),
  directoryPickerClose: document.querySelector('#directory-picker-close'),
  directoryPickerCancel: document.querySelector('#directory-picker-cancel'),
  directoryPickerHome: document.querySelector('#directory-picker-home'),
  directoryPickerRoot: document.querySelector('#directory-picker-root'),
  directoryPickerUp: document.querySelector('#directory-picker-up'),
  directoryPickerPath: document.querySelector('#directory-picker-path'),
  directoryPickerList: document.querySelector('#directory-picker-list'),
  directoryPickerStatus: document.querySelector('#directory-picker-status'),
  directoryPickerSelect: document.querySelector('#directory-picker-select'),
  workspaceSubmit: document.querySelector('#workspace-submit'),
  workspaceFeedback: document.querySelector('#workspace-feedback'),
  workspaceSummary: document.querySelector('#workspace-summary'),
  workspaceGitHubLink: document.querySelector('#workspace-github-link'),
  workspaceProjects: document.querySelector('#workspace-projects'),
  workspaceProjectForm: document.querySelector('#workspace-project-form'),
  workspaceProjectName: document.querySelector('#workspace-project-name'),
  workspaceProjectNames: document.querySelector('#workspace-project-names'),
  workspaceProjectPurpose: document.querySelector('#workspace-project-purpose'),
  workspaceProjectRemote: document.querySelector('#workspace-project-remote'),
  workspaceProjectSubmit: document.querySelector('#workspace-project-submit'),
  workspaceProjectFeedback: document.querySelector('#workspace-project-feedback'),
  workspaceStories: document.querySelector('#workspace-stories'),
  workspaceTree: document.querySelector('#workspace-tree'),
  storiesView: document.querySelector('#stories-view'),
  sessionLayout: document.querySelector('#session-layout'),
  sessionRailToggle: document.querySelector('#session-rail-toggle'),
  sessionTabs: document.querySelector('#session-tabs'),
  sessionConversation: document.querySelector('#session-conversation'),
  sessionBody: document.querySelector('.session-body'),
  sessionWelcome: document.querySelector('#session-welcome'),
  sessionWelcomeHint: document.querySelector('#session-welcome-hint'),
  sessionSearch: document.querySelector('#session-search'),
  sessionHistory: document.querySelector('#session-history'),
  sessionListEmpty: document.querySelector('#session-list-empty'),
  sessionTreePanel: document.querySelector('#session-tree-panel'),
  sessionTree: document.querySelector('#session-tree'),
  sessionMessages: document.querySelector('#session-messages'),
  sessionRecord: document.querySelector('#session-record'),
  filePreview: document.querySelector('#file-preview'),
  filePreviewMeta: document.querySelector('#file-preview-meta'),
  filePreviewPath: document.querySelector('#file-preview-path'),
  filePreviewLink: document.querySelector('#file-preview-link'),
  filePreviewStatus: document.querySelector('#file-preview-status'),
  filePreviewText: document.querySelector('#file-preview-text'),
  filePreviewImage: document.querySelector('#file-preview-image'),
  storySource: document.querySelector('#story-source'),
  storyWorkspace: document.querySelector('#story-workspace'),
  storyList: document.querySelector('#story-list'),
  storyNew: document.querySelector('#story-new'),
  storyLocation: document.querySelector('#story-location'),
  storyTitle: document.querySelector('#story-title'),
  storyGitHubLink: document.querySelector('#story-github-link'),
  storyContent: document.querySelector('#story-content'),
  storyForm: document.querySelector('#story-form'),
  storyDescription: document.querySelector('#story-description'),
  storyDescriptionLabel: document.querySelector('#story-description-label'),
  storySubmit: document.querySelector('#story-submit'),
  storyFeedback: document.querySelector('#story-feedback'),
  storyRun: document.querySelector('#story-run'),
  storyRunStatus: document.querySelector('#story-run-status'),
  sessionLog: document.querySelector('#session-log'),
  storyRunOutput: document.querySelector('#story-run-output'),
  storyRunResult: document.querySelector('#story-run-result'),
  storyRunStop: document.querySelector('#story-run-stop'),
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
  profileSpeed: document.querySelector('#profile-speed'),
  profileSpeedHint: document.querySelector('#profile-speed-hint'),
  codexSandboxCheck: document.querySelector('#codex-sandbox-check'),
  codexSandboxStatus: document.querySelector('#codex-sandbox-status'),
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

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

elements.workspaceOperation.addEventListener('change', updateWorkspaceForm);
elements.workspaceAccess.addEventListener('change', () => void loadRecentWorkspaces());
elements.workspaceRecent.addEventListener('change', () => {
  if (elements.workspaceRecent.value) elements.workspacePath.value = elements.workspaceRecent.value;
});
elements.workspacePath.addEventListener('input', () => { elements.workspaceRecent.value = ''; });
elements.workspaceBrowse.addEventListener('click', () => void openDirectoryPicker());
elements.directoryPickerClose.addEventListener('click', () => elements.directoryPicker.close());
elements.directoryPickerCancel.addEventListener('click', () => elements.directoryPicker.close());
elements.directoryPicker.addEventListener('close', () => { state.directoryBrowserRequest += 1; });
elements.directoryPickerHome.addEventListener('click', () => void browseServerDirectory());
elements.directoryPickerRoot.addEventListener('click', () => void browseServerDirectory(state.directoryBrowser?.root));
elements.directoryPickerUp.addEventListener('click', () => void browseServerDirectory(state.directoryBrowser?.parent));
elements.directoryPickerSelect.addEventListener('click', () => {
  if (!state.directoryBrowser) return;
  elements.workspacePath.value = state.directoryBrowser.path;
  elements.workspaceRecent.value = state.directoryBrowser.path;
  elements.directoryPicker.close();
});
elements.workspaceForm.addEventListener('submit', submitWorkspace);
elements.workspaceProjectForm.addEventListener('submit', submitWorkspaceProject);
elements.sessionSearch.addEventListener('input', renderSessionList);
elements.sessionTabs.addEventListener('click', ({ target }) => {
  const tab = target.closest('[role="tab"]');
  if (tab) selectSessionTab(tab.dataset.tab);
});
elements.sessionTabs.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...elements.sessionTabs.querySelectorAll('[role="tab"]:not([hidden])')];
  const current = tabs.indexOf(event.target);
  if (current === -1) return;
  event.preventDefault();
  const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
    : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  selectSessionTab(next.dataset.tab);
  next.focus();
});
elements.sessionRailToggle.addEventListener('click', () => {
  setSessionRail(!elements.sessionLayout.classList.contains('rail-open'));
});
elements.storyNew.addEventListener('click', () => {
  if (storyRunActive(state.storyRun)) return;
  state.sessionSelection += 1;
  renderStoryRun(null);
  renderStory(null);
  workspaceFeedback(elements.storyFeedback, '');
  setSessionRail(false);
  elements.storyDescription.focus();
});
elements.storyForm.addEventListener('submit', submitStory);
elements.storyDescription.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!elements.storySubmit.disabled && elements.storyDescription.value.trim()) {
    elements.storyForm.requestSubmit();
  }
});
elements.storyRunStop.addEventListener('click', stopStoryRun);
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
elements.codexSandboxCheck.addEventListener('click', async () => {
  elements.codexSandboxCheck.disabled = true;
  workspaceFeedback(elements.codexSandboxStatus, '正在按已保存的模式检查执行权限…');
  try {
    const result = await api('/api/console/codex-sandbox', { method: 'POST', body: '{}' });
    workspaceFeedback(elements.codexSandboxStatus, result.message, !result.success);
  } catch (error) {
    workspaceFeedback(elements.codexSandboxStatus, error.message, true);
  } finally {
    elements.codexSandboxCheck.disabled = false;
  }
});
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
    await switchView(window.location.hash.slice(1));
    try {
      if (!state.githubStatus) await loadGitHubStatus();
    } catch (error) {
      console.error(error);
    }
    window.setInterval(refreshStoryRun, 900);
    window.setInterval(refreshWorkspaceSessions, 4000);
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
  updateWorkspaceOptions(elements.workspaceGitHubRepositories, state.repositories.map((repository) => repository.fullName));
  updateWorkspaceForm();
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
        </article>`,
    )
    .join('');

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
      return `<button class="agent-profile-item ${active ? 'active' : ''}" data-profile-id="${escapeHtml(profile.id)}" type="button"><span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(providerLabel(profile.provider))} · ${escapeHtml(profile.model || 'CLI 默认模型')} · ${escapeHtml(profile.reasoningEffort)} · ${profileSpeedLabel(profile.serviceTier)}</small></span><em>${active ? '当前' : '切换'}</em></button>`;
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
    ? `${active.name} · ${providerLabel(active.provider)} · ${active.model || 'CLI 默认模型'} · ${active.reasoningEffort} · ${profileSpeedLabel(active.serviceTier)}`
    : '请选择配置';
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
  elements.profileSpeed.dataset.savedValue = profile?.serviceTier || '';
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
  updateProfileSpeedOptions();
}

function profileSpeedLabel(tier) {
  return tier === 'fast' ? 'Fast' : tier === 'default' ? '标准' : 'CLI 速度';
}

function updateProfileSpeedOptions() {
  const model = state.codexModels.find((item) => item.id === elements.profileModel.value);
  const saved = elements.profileSpeed.dataset.savedValue ?? elements.profileSpeed.value;
  const supportsFast = model?.supportedServiceTiers?.includes('fast');
  const options = [new Option('跟随 CLI', ''), new Option('标准', 'default')];
  if (supportsFast || (!model && saved === 'fast')) options.push(new Option('Fast', 'fast'));
  elements.profileSpeed.replaceChildren(...options);
  elements.profileSpeed.value = saved === 'fast' && model && !supportsFast ? '' : saved;
  delete elements.profileSpeed.dataset.savedValue;
  elements.profileSpeedHint.textContent = supportsFast
    ? 'Fast 使用更高额度，推理强度保持独立设置。'
    : model ? '当前账号的此模型未提供 Fast 速度档位。' : '登录并刷新模型目录后显示支持的速度；跟随 CLI 会保留原有配置。';
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
    ...(elements.profileSpeed.value ? { serviceTier: elements.profileSpeed.value } : {}),
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

function connectionStateLabel(stateValue) {
  return (
    { disabled: '未启用', connecting: '连接中', connected: '已连接', error: '连接失败' }[
      stateValue
    ] || stateValue
  );
}

function workspaceFeedback(element, message, error = false) {
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', error);
}

async function loadWorkspaceMode() {
  try {
    const { mode, defaultRoot } = await api('/api/console/workspace');
    state.workspaceMode = mode;
    elements.workspaceAccessField.hidden = mode !== 'token';
    elements.workspaceForm.hidden = mode === 'disabled';
    workspaceFeedback(
      elements.workspaceFeedback,
      mode === 'disabled'
        ? '当前连接无法访问工作区。NAS 部署请更新镜像并重新创建容器，或在 Compose 环境变量中设置至少 32 字符的 AGENT_WORKSPACE_WEB_TOKEN；本机调试请直接访问仅监听 127.0.0.1 的实例。'
        : '',
    );
    updateWorkspaceForm();
    await loadRecentWorkspaces();
    if (defaultRoot && !state.workspace) {
      const workspace = await callWorkspace({ operation: 'show', path: defaultRoot });
      if (!state.workspace) {
        renderWorkspace(workspace);
        elements.workspacePath.value = workspace.root;
      }
    }
  } catch (error) {
    workspaceFeedback(elements.workspaceFeedback, error.message, true);
    if (state.activeView === 'stories') workspaceFeedback(elements.storyFeedback, error.message, true);
  }
}

function updateWorkspaceForm() {
  const operation = elements.workspaceOperation.value;
  const fromGitHub = operation === 'clone-github';
  elements.workspaceGitHubField.hidden = !fromGitHub;
  elements.workspaceGitHubRepository.required = fromGitHub;
  elements.workspaceGitHubConnect.hidden = !fromGitHub || Boolean(state.githubStatus?.connected);
  elements.workspacePathField.hidden = fromGitHub;
  elements.workspacePath.required = !fromGitHub;
  elements.workspaceRecentField.hidden = operation !== 'show';
  elements.workspaceSubmit.textContent = {
    show: '打开工作区',
    'clone-github': '克隆并打开工作区',
    init: '创建工作区',
  }[operation];
  elements.workspacePathHint.textContent = operation === 'show'
    ? '选择已保存的工作区或服务器目录，也可以填写绝对路径。'
    : '选择空目录，或选择父目录后填写新的文件夹名称。';
}

function renderRecentWorkspaces(workspaces) {
  state.recentWorkspaces = workspaces;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = workspaces.length ? '选择已保存的本地工作区' : '暂无已保存的工作区';
  elements.workspaceRecent.replaceChildren(placeholder, ...workspaces.map((workspace) => {
    const option = document.createElement('option');
    option.value = workspace.path;
    option.textContent = `${workspace.name} · ${workspace.path}${workspace.available ? '' : '（目录暂不可用）'}`;
    option.disabled = !workspace.available;
    return option;
  }));
  elements.workspaceRecent.disabled = workspaces.length === 0;
  elements.workspaceRecent.value = elements.workspacePath.value;
  for (const workspace of workspaces) state.workspacePaths.add(workspace.path);
  updateWorkspaceOptions(elements.workspacePaths, state.workspacePaths);
}

async function loadRecentWorkspaces() {
  if (state.workspaceMode === 'disabled') return;
  if (state.workspaceMode === 'token' && !elements.workspaceAccess.value.trim()) {
    elements.workspaceRecent.replaceChildren(new Option('填写访问密码后加载已保存的工作区', ''));
    elements.workspaceRecent.disabled = true;
    return;
  }
  try {
    const { workspaces } = await callWorkspace({ operation: 'recent-workspaces' });
    renderRecentWorkspaces(workspaces);
    if (!state.workspaceBusy) workspaceFeedback(elements.workspaceFeedback, '');
  } catch (error) {
    workspaceFeedback(elements.workspaceFeedback, error.message, true);
  }
}

async function openDirectoryPicker() {
  if (state.workspaceMode === 'token' && !elements.workspaceAccess.value.trim()) {
    workspaceFeedback(elements.workspaceFeedback, '请先填写工作区访问密码。', true);
    elements.workspaceAccess.focus();
    return;
  }
  state.directoryBrowser = null;
  elements.directoryPickerPath.textContent = '';
  elements.directoryPickerRoot.disabled = true;
  elements.directoryPickerUp.disabled = true;
  elements.directoryPicker.showModal();
  await browseServerDirectory(elements.workspacePath.value.trim() || undefined);
}

async function browseServerDirectory(path) {
  const request = ++state.directoryBrowserRequest;
  elements.directoryPickerSelect.disabled = true;
  elements.directoryPickerList.replaceChildren();
  workspaceFeedback(elements.directoryPickerStatus, '正在读取服务器目录…');
  try {
    const result = await callWorkspace({ operation: 'server-directories', ...(path ? { path } : {}) });
    if (request !== state.directoryBrowserRequest || !elements.directoryPicker.open) return;
    state.directoryBrowser = result;
    elements.directoryPickerPath.textContent = result.path;
    elements.directoryPickerList.replaceChildren(...result.directories.map((directory) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `▸ ${directory.name}`;
      button.addEventListener('click', () => void browseServerDirectory(directory.path));
      row.append(button);
      return row;
    }));
    workspaceFeedback(elements.directoryPickerStatus, result.directories.length ? '' : '此目录没有子文件夹，可以直接选择。');
  } catch (error) {
    if (request !== state.directoryBrowserRequest || !elements.directoryPicker.open) return;
    workspaceFeedback(elements.directoryPickerStatus, error.message, true);
  } finally {
    if (request === state.directoryBrowserRequest && elements.directoryPicker.open) {
      elements.directoryPickerSelect.disabled = !state.directoryBrowser;
      elements.directoryPickerRoot.disabled = !state.directoryBrowser;
      elements.directoryPickerUp.disabled = !state.directoryBrowser?.parent;
    }
  }
}

function updateWorkspaceOptions(datalist, values) {
  datalist.replaceChildren(...Array.from(values, (value) => {
    const option = document.createElement('option');
    option.value = value;
    return option;
  }));
}

function renderWorkspace(workspace) {
  if (Array.isArray(workspace.recentWorkspaces)) renderRecentWorkspaces(workspace.recentWorkspaces);
  if (workspace.historyWarning) showToast(workspace.historyWarning, true);
  const isGitHub = workspace.source === 'github';
  const previous = state.workspace;
  const changed = previous?.root !== workspace.root || previous?.repository !== workspace.repository;
  if (changed) {
    state.sessionSelection += 1;
    renderStoryRun(null);
    renderStory(null);
    state.workspaceFile = null;
    state.sessionIndex = [];
    elements.sessionSearch.value = '';
    workspaceFeedback(elements.storyFeedback, '');
  }
  state.workspace = workspace;
  if (changed) renderSessionList();
  if (workspace.root && !previous?.root) state.sessionTab = 'sessions';
  selectSessionTab(state.sessionTab);
  renderFilePreview();
  if (workspace.root) state.workspacePaths.add(workspace.root);
  updateWorkspaceOptions(elements.workspacePaths, state.workspacePaths);
  updateWorkspaceOptions(elements.workspaceProjectNames, workspace.projects.map((project) => project.name));

  const workspaceLabel = isGitHub ? `GitHub · ${workspace.repository}` : workspace.root;
  elements.workspaceSummary.textContent = `${workspaceLabel} · ${workspace.branch} · ${workspace.projects.length} 个项目`;
  elements.workspaceGitHubLink.hidden = !isGitHub;
  elements.workspaceGitHubLink.href = isGitHub ? `${workspace.url}/tree/${workspace.revision}` : '#workspace';
  const rows = workspace.projects.map((project) => {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    const status = document.createElement('span');
    name.textContent = project.name;
    status.textContent = isGitHub ? '远端登记' : project.present ? '本机可用' : '待克隆';
    status.className = project.present ? 'workspace-project-local' : 'workspace-project-pending';
    row.append(name, status);
    if (project.remote) {
      const remote = document.createElement('code');
      remote.textContent = project.remote;
      row.append(remote);
    }
    return row;
  });
  elements.workspaceProjects.hidden = rows.length === 0;
  elements.workspaceProjects.replaceChildren(...rows);
  elements.workspaceStories.hidden = false;
  elements.workspaceProjectForm.hidden = isGitHub;
  void loadWorkspaceTree(workspace);
}

async function readWorkspaceDirectory(workspace, directory) {
  const request = workspace.root
    ? { operation: 'workspace-tree', path: workspace.root }
    : { operation: 'github-tree', repository: workspace.repository };
  return (await callWorkspace({ ...request, directory })).entries;
}

function directoryTree(workspace, entries, parent = '') {
  const list = document.createElement('ul');
  list.className = 'directory-tree';
  for (const entry of entries) {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    const row = document.createElement('li');
    row.dataset.kind = entry.repository ? 'repository' : entry.type;
    if (entry.type === 'directory') {
      const folder = document.createElement('details');
      const summary = document.createElement('summary');
      styleTreeEntry(summary, entry.name);
      folder.append(summary);
      folder.addEventListener('toggle', async () => {
        if (folder.open && folder.lastElementChild?.dataset.failed) folder.lastElementChild.remove();
        if (!folder.open || folder.childElementCount > 1) return;
        const status = document.createElement('small');
        status.className = 'tree-status';
        status.setAttribute('role', 'status');
        status.textContent = '读取中…';
        folder.append(status);
        try {
          const children = await readWorkspaceDirectory(workspace, path);
          if (children.length) status.replaceWith(directoryTree(workspace, children, path));
          else status.textContent = '空目录';
        } catch (error) {
          status.textContent = error.message;
          status.dataset.failed = 'true';
        }
      });
      row.append(folder);
    } else if (entry.type === 'file') {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.filePath = path;
      button.setAttribute('aria-current', String(state.workspaceFile?.path === path));
      styleTreeEntry(button, entry.name);
      button.addEventListener('click', () => void openWorkspaceFile(workspace, path));
      row.append(button);
    } else {
      const label = document.createElement(entry.url ? 'a' : 'span');
      styleTreeEntry(label, entry.name);
      if (entry.url) {
        label.href = entry.url;
        label.target = '_blank';
        label.rel = 'noreferrer';
      }
      row.append(label);
    }
    list.append(row);
  }
  return list;
}

function styleTreeEntry(element, name) {
  element.className = 'tree-entry';
  element.title = name;
  const icon = document.createElement('span');
  icon.className = 'tree-entry-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'tree-entry-name';
  label.textContent = name;
  element.append(icon, label);
}

async function loadWorkspaceTree(workspace) {
  elements.workspaceTree.hidden = true;
  const status = document.createElement('p');
  status.className = 'tree-status';
  status.setAttribute('role', 'status');
  status.textContent = '正在读取目录…';
  elements.sessionTree.replaceChildren(status);
  try {
    const entries = await readWorkspaceDirectory(workspace, '');
    if (state.workspace !== workspace) return;
    elements.workspaceTree.replaceChildren(directoryTree(workspace, entries));
    elements.sessionTree.replaceChildren(directoryTree(workspace, entries));
    elements.workspaceTree.hidden = false;
    elements.workspaceProjects.hidden = true;
  } catch (error) {
    if (state.workspace !== workspace) return;
    status.textContent = error.message;
  }
}

async function openWorkspaceFile(workspace, path) {
  if (state.workspace !== workspace) return;
  const selection = { path };
  state.workspaceFile = selection;
  selectSessionTab('directory');
  renderFilePreview();
  elements.filePreview.scrollTop = 0;
  if (state.activeView !== 'stories') void switchView('stories');
  if (elements.sessionRailToggle.getAttribute('aria-expanded') === 'true') {
    setSessionRail(false);
    elements.storyTitle.focus();
  }

  try {
    selection.result = await callWorkspace(workspace.root
      ? { operation: 'workspace-file', path: workspace.root, file: path }
      : { operation: 'github-file', repository: workspace.repository, file: path });
  } catch (error) {
    selection.error = error.message;
  }
  if (state.workspaceFile === selection) renderFilePreview();
}

function renderFilePreview() {
  const { path, result, error } = state.workspaceFile || {};
  const url = result?.url;
  const image = result?.kind === 'image';
  const text = result?.kind === 'text' ? result.content : '';
  const nested = path?.includes('/');
  elements.filePreviewMeta.hidden = !nested && !url;
  elements.filePreviewPath.hidden = !nested;
  elements.filePreviewPath.textContent = nested ? path : '';
  elements.filePreviewLink.hidden = !url;
  elements.filePreviewLink.href = url || '#';
  elements.filePreviewText.hidden = !text;
  elements.filePreviewText.textContent = text;
  elements.filePreviewImage.hidden = !image;
  if (image) {
    elements.filePreviewImage.alt = path.split('/').at(-1);
    elements.filePreviewImage.src = `data:${result.imageType};base64,${result.content}`;
  } else {
    elements.filePreviewImage.removeAttribute('src');
  }
  elements.filePreviewStatus.hidden = Boolean(image || text);
  elements.filePreviewStatus.dataset.error = String(Boolean(error));
  elements.filePreviewStatus.textContent = error || (!path ? '在目录中选择一个文件' : !result ? '正在读取文件…' : {
    text: '空文件',
    'too-large': '文件超过 1 MiB，无法预览',
    unsupported: '此文件格式暂不支持预览',
  }[result.kind] || '');
  for (const button of document.querySelectorAll('button[data-file-path]')) {
    button.setAttribute('aria-current', String(button.dataset.filePath === path));
  }
}

async function callWorkspace(payload) {
  const token = elements.workspaceAccess.value.trim();
  if (state.workspaceMode === 'token' && !token) {
    elements.workspaceAccess.focus();
    throw new Error('请输入工作区访问令牌。');
  }
  return api('/api/console/workspace', {
    method: 'POST',
    headers: state.workspaceMode === 'token' ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(payload),
  });
}

async function requestWorkspace(payload, feedback, successMessage) {
  if (state.workspaceBusy) return false;
  state.workspaceBusy = true;
  elements.workspaceSubmit.disabled = true;
  elements.workspaceProjectSubmit.disabled = true;
  workspaceFeedback(feedback, payload.operation === 'clone-github' ? '正在克隆 GitHub 仓库到本地工作区…' : '正在处理…');
  try {
    const workspace = await callWorkspace(payload);
    renderWorkspace(workspace);
    workspaceFeedback(feedback, successMessage);
    return true;
  } catch (error) {
    workspaceFeedback(feedback, error.message, true);
    return false;
  } finally {
    state.workspaceBusy = false;
    elements.workspaceSubmit.disabled = false;
    elements.workspaceProjectSubmit.disabled = false;
  }
}

async function submitWorkspace(event) {
  event.preventDefault();
  const operation = elements.workspaceOperation.value;
  const opened = await requestWorkspace(
    operation === 'clone-github' ? { operation, repository: elements.workspaceGitHubRepository.value.trim() } : {
      operation,
      path: elements.workspacePath.value.trim(),
    },
    elements.workspaceFeedback,
    { show: '已打开工作区。', 'clone-github': 'GitHub 仓库已准备完成，已打开本地工作区。', init: '已创建工作区。' }[operation],
  );
  if (opened) {
    if (state.workspace.root) elements.workspacePath.value = state.workspace.root;
    elements.workspaceProjectForm.reset();
    workspaceFeedback(elements.workspaceProjectFeedback, '');
    if (operation === 'clone-github') await switchView('stories');
  }
}

async function submitWorkspaceProject(event) {
  event.preventDefault();
  if (!state.workspace?.root) return;
  const remote = elements.workspaceProjectRemote.value.trim();
  const added = await requestWorkspace(
    {
      operation: 'add',
      path: state.workspace.root,
      name: elements.workspaceProjectName.value.trim(),
      purpose: elements.workspaceProjectPurpose.value.trim(),
      ...(remote ? { remote } : {}),
    },
    elements.workspaceProjectFeedback,
    '已登记项目。',
  );
  if (added) elements.workspaceProjectForm.reset();
}

async function loadStories() {
  const workspace = state.workspace;
  if (!workspace) return;
  const location = workspace.root || workspace.repository;
  elements.storySource.textContent = workspace.root ? location.split(/[\\/]/).filter(Boolean).at(-1) || location : location;
  elements.storySource.title = location;
  elements.storyWorkspace.textContent = '切换';
  elements.storyWorkspace.setAttribute('aria-label', '切换工作区');
  elements.sessionWelcomeHint.textContent = workspace.root
    ? '直接说出你的想法，Codex 会在当前工作区开始处理。'
    : '已连接 GitHub。打开本地工作区即可发起会话。';
  elements.storyForm.hidden = !workspace.root;
  if (!workspace.root) return;
  try {
    await updateSessionIndex(workspace);
    if (state.workspace !== workspace) return;
    if (!state.storyRun) {
      const run = await callWorkspace({ operation: 'latest-story-run', path: workspace.root });
      if (state.workspace === workspace && !state.storyRun && run) renderStoryRun(run);
    }
  } catch (error) {
    workspaceFeedback(elements.storyFeedback, error.message, true);
  }
}

async function updateSessionIndex(workspace) {
  const { sessions } = await callWorkspace({ operation: 'sessions', path: workspace.root });
  if (state.workspace !== workspace) return;
  const index = sessions.map(({ id, title }) => ({ id, title: title || id.slice(11).replace(/[-_]+/g, ' ') }));
  const unchanged = index.length === state.sessionIndex.length && index.every(({ id, title }, position) =>
    state.sessionIndex[position].id === id && state.sessionIndex[position].title === title);
  if (unchanged) return;
  state.sessionIndex = index;
  renderSessionList();
}

async function refreshWorkspaceSessions() {
  const { workspace, story, storyRun, sessionSelection } = state;
  if (!workspace?.root || state.activeView !== 'stories' || state.sessionTab !== 'sessions' ||
      document.hidden || state.sessionsPolling) return;
  state.sessionsPolling = true;
  try {
    await updateSessionIndex(workspace);
    if (state.workspace !== workspace || state.sessionSelection !== sessionSelection ||
        !story || storyRunActive(storyRun) || state.storyRun !== storyRun) return;
    const run = await callWorkspace({
      operation: 'latest-story-run', path: workspace.root, id: story.id, knownRunId: storyRun?.id,
    });
    if (run && state.workspace === workspace && state.sessionSelection === sessionSelection &&
        state.storyRun === storyRun) renderStoryRun(run);
  } catch {
    // The next refresh will retry transient failures.
  } finally {
    state.sessionsPolling = false;
  }
}

function selectSessionTab(tab) {
  const workspace = state.workspace;
  state.sessionTab = workspace && !workspace.root ? 'directory' : tab;
  const directory = Boolean(workspace && state.sessionTab === 'directory');
  elements.sessionTabs.hidden = !workspace;
  for (const button of elements.sessionTabs.querySelectorAll('[role="tab"]')) {
    const selected = button.dataset.tab === state.sessionTab;
    button.hidden = button.dataset.tab === 'sessions' && !workspace?.root;
    button.tabIndex = selected ? 0 : -1;
    button.setAttribute('aria-selected', String(selected));
  }
  elements.sessionTreePanel.hidden = !directory;
  elements.sessionHistory.hidden = directory || !workspace?.root;
  elements.sessionConversation.hidden = directory;
  elements.filePreview.hidden = !directory;
  renderSessionTitle();
}

function renderSessionTitle() {
  elements.storyTitle.textContent = state.sessionTab === 'directory'
    ? state.workspaceFile?.path.split('/').at(-1) || '目录结构'
    : state.story?.title || state.story?.content?.match(/^#\s+(.+)$/m)?.[1] || state.story?.id || '新会话';
}

function setSessionRail(open) {
  elements.sessionLayout.classList.toggle('rail-open', open);
  elements.sessionRailToggle.setAttribute('aria-expanded', String(open));
}

function renderSessionList() {
  const query = elements.sessionSearch.value.trim().toLocaleLowerCase();
  const sessions = state.sessionIndex.filter(({ id, title }) => `${title} ${id}`.toLocaleLowerCase().includes(query));
  elements.sessionSearch.hidden = state.sessionIndex.length === 0;
  elements.sessionListEmpty.hidden = sessions.length > 0 || !state.workspace;
  elements.sessionListEmpty.textContent = query ? '没有匹配的会话' : '暂无会话';
  const rows = sessions.map(({ id, title }) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.title = `${title} · ${id.slice(0, 10)}`;
    button.setAttribute('aria-current', String(state.story?.id === id));
    button.disabled = storyRunActive(state.storyRun);
    button.addEventListener('click', () => void openStory(id));
    row.append(button);
    return row;
  });
  elements.storyList.replaceChildren(...rows);
}

function renderStory(story) {
  const changed = state.story?.id !== story?.id;
  state.story = story;
  renderSessionTitle();
  elements.sessionWelcome.hidden = Boolean(story || state.storyRun);
  elements.sessionRecord.hidden = !story?.content;
  elements.storyLocation.hidden = !story?.directory;
  elements.storyLocation.textContent = story?.directory ? `story/${story.id}/${story.file}` : '';
  elements.storyLocation.title = story?.directory ? `${story.directory}/${story.file}` : '';
  elements.storyContent.hidden = !story;
  elements.storyContent.textContent = story?.content || '';
  elements.storyGitHubLink.hidden = !story?.url;
  elements.storyGitHubLink.href = story?.url || '#stories';
  if (changed) elements.storyDescription.value = '';
  elements.storyDescription.placeholder = story ? '补充需求或继续讨论…' : '告诉 Codex 你想做什么…';
  elements.storyDescriptionLabel.textContent = story ? '继续会话' : '描述需求';
  if (changed) renderSessionList();
}

async function openStory(id) {
  const workspace = state.workspace;
  if (!workspace || storyRunActive(state.storyRun)) return;
  const selection = ++state.sessionSelection;
  const payload = workspace.root
    ? { operation: 'session', path: workspace.root, id }
    : { operation: 'github-story', repository: workspace.repository, id };
  try {
    const story = await callWorkspace(payload);
    if (state.workspace !== workspace || state.sessionSelection !== selection) return;
    renderStory(story);
    renderStoryRun(null);
    elements.sessionRecord.open = true;
    elements.sessionBody.scrollTop = 0;
    setSessionRail(false);
    workspaceFeedback(elements.storyFeedback, '');
    if (workspace.root) {
      const run = await callWorkspace({ operation: 'latest-story-run', path: workspace.root, id });
      if (state.workspace === workspace && state.sessionSelection === selection && run) {
        elements.sessionRecord.open = false;
        renderStoryRun(run);
      }
    }
  } catch (error) {
    if (state.sessionSelection === selection) workspaceFeedback(elements.storyFeedback, error.message, true);
  }
}

async function submitStory(event) {
  event.preventDefault();
  const workspace = state.workspace;
  if (!workspace?.root || storyRunActive(state.storyRun)) return;
  const current = state.story;
  elements.storySubmit.disabled = true;
  workspaceFeedback(elements.storyFeedback, '正在提交给 Codex…');
  try {
    const run = await callWorkspace({
      operation: 'run-story',
      path: workspace.root,
      ...(current ? { id: current.id } : {}),
      description: elements.storyDescription.value.trim(),
    });
    if (state.workspace !== workspace) return;
    renderStoryRun(run);
    elements.storyDescription.value = '';
    workspaceFeedback(elements.storyFeedback, '');
  } catch (error) {
    workspaceFeedback(elements.storyFeedback, error.message, true);
  } finally {
    elements.storySubmit.disabled = storyRunActive(state.storyRun);
  }
}

function storyRunActive(run) {
  return Boolean(run && !['completed', 'failed', 'cancelled'].includes(run.status));
}

function renderStoryRun(run) {
  const previous = state.storyRun;
  state.storyRun = run;
  const active = storyRunActive(run);
  elements.sessionWelcome.hidden = Boolean(state.story || run);
  elements.storyRun.hidden = !run;
  elements.storyRun.dataset.active = String(active);
  elements.storyRun.dataset.failed = String(run?.status === 'failed');
  elements.storySubmit.disabled = active;
  elements.storyNew.disabled = active;
  elements.storyRunStop.hidden = !active;
  for (const button of elements.storyList.querySelectorAll('button')) button.disabled = active;
  if (!run) {
    elements.sessionMessages.hidden = true;
    elements.sessionMessages.replaceChildren();
    return;
  }
  const session = run.story || run.session;
  if (session && (state.story?.id !== session.id || previous?.story?.content !== run.story?.content || state.story?.title !== session.title)) {
    renderStory(session);
  }
  if (previous?.id !== run.id) elements.sessionLog.open = false;
  elements.storyRunStatus.textContent = {
    queued: '等待 Codex',
    naming: 'Codex 正在命名会话',
    creating: '正在建立会话',
    running: 'Codex 正在执行需求',
    completed: 'Codex 已完成',
    failed: '执行失败',
    cancelled: '已停止',
  }[run.status];
  const logs = run.logs.join('\n');
  const output = elements.storyRunOutput;
  output.hidden = !logs;
  elements.sessionLog.hidden = !logs;
  if (output.textContent !== logs) {
    const atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 32;
    output.textContent = logs;
    if (atEnd) output.scrollTop = output.scrollHeight;
  }
  const result = run.error || '';
  elements.storyRunResult.hidden = !result;
  elements.storyRunResult.textContent = result;
  const turnSignature = JSON.stringify(run.turns);
  if (elements.sessionMessages.dataset.turns !== turnSignature || elements.sessionMessages.hidden) {
    const body = elements.sessionBody;
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 48 || previous?.id !== run.id;
    elements.sessionMessages.dataset.turns = turnSignature;
    const messages = run.turns.flatMap((turn) => {
      const message = (author, content) => {
        const article = document.createElement('article');
        article.dataset.author = author === '你' ? 'user' : 'agent';
        const label = document.createElement('strong');
        const text = document.createElement('p');
        label.textContent = author;
        text.textContent = content;
        article.append(label, text);
        return article;
      };
      return [message('你', turn.description), ...(turn.response ? [message('Codex', turn.response)] : [])];
    });
    elements.sessionMessages.replaceChildren(...messages);
    elements.sessionMessages.hidden = false;
    if (follow) body.scrollTop = body.scrollHeight;
  }
}

async function refreshStoryRun() {
  if (state.storyRunPolling || !storyRunActive(state.storyRun)) return;
  const { id, storyId } = state.storyRun;
  state.storyRunPolling = true;
  try {
    const run = await callWorkspace({ operation: 'story-run', path: state.workspace.root, id });
    if (state.storyRun?.id !== id || !storyRunActive(state.storyRun)) return;
    renderStoryRun(run);
    if (run.storyId && (run.storyId !== storyId || !storyRunActive(run))) await loadStories();
  } catch (error) {
    workspaceFeedback(elements.storyFeedback, error.message, true);
  } finally {
    state.storyRunPolling = false;
  }
}

async function stopStoryRun() {
  if (!storyRunActive(state.storyRun)) return;
  const { id } = state.storyRun;
  elements.storyRunStop.disabled = true;
  try {
    const run = await callWorkspace({ operation: 'stop-story-run', id });
    if (state.storyRun?.id === id) {
      renderStoryRun(run);
      if (run.storyId) await loadStories();
    }
  } catch (error) {
    workspaceFeedback(elements.storyFeedback, error.message, true);
  } finally {
    elements.storyRunStop.disabled = false;
  }
}

async function switchView(view) {
  const normalized = ['workspace', 'github', 'integrations', 'codex'].includes(view) ? view : 'stories';
  state.activeView = normalized;
  if (window.location.hash.slice(1) !== normalized) {
    window.history.replaceState(null, '', normalized === 'stories' ? '#' : `#${normalized}`);
  }
  elements.storiesView.hidden = normalized !== 'stories';
  elements.workspaceView.hidden = normalized !== 'workspace';
  elements.githubView.hidden = normalized !== 'github';
  elements.integrationsView.hidden = normalized !== 'integrations';
  elements.codexView.hidden = normalized !== 'codex';
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === normalized);
  });
  if ((normalized === 'workspace' || normalized === 'stories') && !state.workspaceMode) await loadWorkspaceMode();
  if (normalized === 'stories') await loadStories();
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

async function api(url, options = {}) {
  const { headers, ...request } = options;
  const response = await fetch(url, {
    ...request,
    headers: { 'Content-Type': 'application/json', ...headers },
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
