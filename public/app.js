const state = {
  settings: null,
  tasks: [],
  selectedTaskId: null,
  polling: false,
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
  launchButton: document.querySelector('#launch-button'),
  taskList: document.querySelector('#task-list'),
  taskCount: document.querySelector('#task-count'),
  taskDetail: document.querySelector('#task-detail'),
  settingsModal: document.querySelector('#settings-modal'),
  defaultProvider: document.querySelector('#default-provider'),
  codexModel: document.querySelector('#codex-model'),
  claudeModel: document.querySelector('#claude-model'),
  openaiKey: document.querySelector('#openai-key'),
  anthropicKey: document.querySelector('#anthropic-key'),
  openaiKeyStatus: document.querySelector('#openai-key-status'),
  anthropicKeyStatus: document.querySelector('#anthropic-key-status'),
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
  elements.openaiKeyStatus.textContent = state.settings.hasOpenaiApiKey ? '已配置' : '未配置';
  elements.anthropicKeyStatus.textContent = state.settings.hasAnthropicApiKey ? '已配置' : '未配置';
  selectProvider(state.settings.defaultProvider);
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
        provider: elements.provider.value,
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
        openaiApiKey: elements.openaiKey.value || undefined,
        anthropicApiKey: elements.anthropicKey.value || undefined,
      }),
    });
    elements.openaiKey.value = '';
    elements.anthropicKey.value = '';
    elements.openaiKeyStatus.textContent = state.settings.hasOpenaiApiKey ? '已配置' : '未配置';
    elements.anthropicKeyStatus.textContent = state.settings.hasAnthropicApiKey ? '已配置' : '未配置';
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
    <pre class="task-output" aria-label="任务输出"></pre>
    ${task.pullRequestUrl ? `<a class="pr-link" href="${escapeHtml(task.pullRequestUrl)}" target="_blank" rel="noreferrer"><span>打开 Pull Request</span><b>↗</b></a>` : ''}
    ${task.workspace ? `<div class="workspace-path">WORKSPACE · ${escapeHtml(task.workspace)}</div>` : ''}`;

  const output = elements.taskDetail.querySelector('.task-output');
  output.textContent = task.logs
    .map((log) => `${new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}  ${log.stream === 'stderr' ? '!' : log.stream === 'system' ? '›' : ' '} ${log.message}`)
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
  const normalized = provider === 'claude' ? 'claude' : 'codex';
  elements.provider.value = normalized;
  document.querySelectorAll('[data-provider]').forEach((button) => {
    button.classList.toggle('active', button.dataset.provider === normalized);
  });
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
  return {
    queued: '排队中',
    preparing: '准备工作区',
    running: 'Agent 执行中',
    publishing: '创建 PR',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status] || status;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

init();
