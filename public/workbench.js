/* Task operations and instance administration. All authorization is enforced by the server. */
window.Cpx = (() => {
  let csrf;
  let principal;
  let projects = [];
  const results = new Map();
  const panels = new Map();
  let serverPlatform;
  const keys = new Map();
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const headers = () => ({
    ...(csrf ? { 'X-Cpx-Csrf': csrf } : {}),
    ...(sessionStorage.getItem('cpx-access-token')
      ? { Authorization: `Bearer ${sessionStorage.getItem('cpx-access-token')}` }
      : {}),
  });
  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    return data;
  }
  function download(name, content, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function dialog(title, content) {
    document.querySelector('#cpx-dialog')?.remove();
    const el = document.createElement('dialog');
    el.id = 'cpx-dialog';
    el.className = 'cpx-dialog';
    el.innerHTML = `<header><h2>${escape(title)}</h2><button type="button" data-close aria-label="关闭">关闭</button></header><div class="cpx-dialog-body">${content}</div><p class="cpx-message" role="status"></p>`;
    document.body.append(el);
    el.querySelector('[data-close]').onclick = () => el.close();
    el.showModal();
    el.addEventListener('close', () => el.remove());
    return el;
  }
  const message = (el, text) => {
    el.querySelector('.cpx-message').textContent = text;
  };
  const field = (name, label, value = '', type = 'text') =>
    `<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" ${type === 'number' ? 'min="0"' : ''}></label>`;
  const area = (name, label, value = '') =>
    `<label>${escape(label)}<textarea name="${name}" rows="4">${escape(value)}</textarea></label>`;
  const select = (name, label, options, value) =>
    `<label>${escape(label)}<select name="${name}">${options.map(([id, text]) => `<option value="${escape(id)}" ${id === value ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
  function form(el, fn) {
    el.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        await fn(Object.fromEntries(new FormData(event.target)));
        message(el, '已保存');
      } catch (error) {
        message(el, error.message);
      } finally {
        button.disabled = false;
      }
    };
  }
  async function ready() {
    let status = await api('/api/auth/status');
    if (!status.principal) {
      await new Promise((resolve) => {
        const el = dialog(
          status.initialized ? '登录 cpx' : '认领 cpx 实例',
          `<p>${status.initialized ? '输入管理员密码，或使用管理员签发的个人访问令牌。' : '从持久化 data/bootstrap-token.txt 文件读取初始化令牌，或使用部署时预设的 CPX_BOOTSTRAP_TOKEN。设置至少 12 位管理员密码。'}</p><form>${!status.initialized ? field('token', '初始化令牌', '', 'password') : ''}${field('password', '管理员密码', '', 'password')}${status.initialized ? field('accessToken', '个人访问令牌（使用时可不填管理员密码）', '', 'password') : ''}<button>进入工作台</button></form>`,
        );
        el.querySelector('[data-close]').hidden = true;
        el.addEventListener('cancel', (event) => event.preventDefault());
        form(el, async (values) => {
          if (values.accessToken) sessionStorage.setItem('cpx-access-token', values.accessToken);
          else {
            sessionStorage.removeItem('cpx-access-token');
            await api('/api/auth/login', values);
          }
          status = await api('/api/auth/status');
          if (!status.principal) {
            sessionStorage.removeItem('cpx-access-token');
            throw new Error('登录失败');
          }
          el.close();
          resolve();
        });
      });
    }
    csrf = status.csrf;
    principal = status.principal;
    serverPlatform = status.platform;
    projects = await api('/api/workbench/projects');
    const migration = await api('/api/workbench/migration');
    if (migration?.required && principal.role === 'admin')
      await new Promise((resolve) => {
        const el = dialog(
          '选择升级后的发布方式',
          '<p>检测到旧版控制台配置。旧版聊天任务默认自动创建 PR；本版本支持先审查再发布。请选择后续临时任务的默认方式，项目策略仍单独配置。</p><form>' +
            select(
              'policy',
              '默认发布方式',
              [
                ['review', '审查后发布（推荐）'],
                ['auto', '保持自动发布 PR'],
                ['local', '仅保留本地成果'],
              ],
              'review',
            ) +
            '<button>保存迁移选择</button></form>',
        );
        el.querySelector('[data-close]').hidden = true;
        el.addEventListener('cancel', (event) => event.preventDefault());
        form(el, async (values) => {
          await api('/api/workbench/migration', values);
          el.close();
          resolve();
        });
      });
    const nav = document.querySelector('.primary-nav');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.setAttribute('aria-label', '项目与运行管理');
    button.innerHTML =
      '<span class="nav-icon" aria-hidden="true">▦</span><span>项目与运行管理</span>';
    button.onclick = () => openManagement().catch((error) => alert(error.message));
    nav.append(button);
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'nav-item';
    logout.setAttribute('aria-label', `退出 · ${principal.name}`);
    logout.innerHTML = `<span class="nav-icon" aria-hidden="true">⇥</span><span>退出 · ${escape(principal.name)}</span>`;
    logout.onclick = async () => {
      await api('/api/auth/logout', {});
      sessionStorage.removeItem('cpx-access-token');
      location.reload();
    };
    nav.append(logout);
    if (principal.role !== 'admin')
      document
        .querySelectorAll('[data-view="github"], [data-view="integrations"], [data-view="codex"]')
        .forEach((el) => {
          el.hidden = true;
        });
    if (principal.role === 'reviewer')
      document.querySelectorAll('#task-form, #new-task-button, #new-task-toolbar').forEach((el) => {
        el.hidden = true;
      });
    const holder = document.querySelector('#new-task-context');
    const label = document.createElement('label');
    label.className = 'cpx-project-picker';
    label.innerHTML = `项目<select id="cpx-project"><option value="">${principal.role === 'admin' ? '临时仓库任务' : '选择授权项目'}</option>${projects.map((p) => `<option value="${escape(p.id)}">${escape(p.name)} · v${p.version}</option>`).join('')}</select>`;
    holder.prepend(label);
    label.querySelector('select').onchange = (event) => {
      const project = projects.find((p) => p.id === event.target.value);
      if (project) {
        const repository = document.querySelector('#repository');
        repository.value = project.repository;
        repository.required = false;
      }
    };
  }
  async function openManagement() {
    const el = dialog(
      '项目与运行管理',
      '<div class="cpx-actions" id="cpx-admin-tabs"></div><div id="cpx-admin-content"></div>',
    );
    const pages = [
      ['项目', projectPage],
      ['模板与定时任务', schedulesPage],
      ['身份绑定', bindingPage],
    ];
    if (principal.role === 'admin')
      pages.push(
        ['运行与备份', runtimePage],
        ['用户与令牌', accountsPage],
        ['扩展', extensionsPage],
        ['远程执行器', workersPage],
      );
    for (const [name, page] of pages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.onclick = () => page(el).catch((error) => message(el, error.message));
      el.querySelector('#cpx-admin-tabs').append(button);
    }
    await projectPage(el);
  }
  async function projectPage(el, chosen) {
    projects = await api('/api/workbench/projects');
    const p = chosen ||
      (principal.role !== 'admin' ? projects[0] : undefined) || {
        version: 0,
        baseBranch: 'main',
        policy: 'review',
        timeoutMs: 1800000,
      };
    el.querySelector('#cpx-admin-content').innerHTML =
      `<div class="cpx-actions">${projects.map((v) => `<button data-project="${escape(v.id)}">${escape(v.name)} · v${v.version}</button>`).join('')}<button data-new>新建项目</button></div><form>${field('id', '项目标识', p.id)}${field('name', '项目名称', p.name)}${field('repository', 'GitHub 仓库', p.repository)}${field('baseBranch', '基础分支', p.baseBranch)}${select(
        'policy',
        '发布策略',
        [
          ['review', '审查后发布'],
          ['local', '仅保留成果'],
          ['auto', '预授权自动发布 PR'],
        ],
        p.policy,
      )}${select(
        'allowScheduledMerge',
        '允许定时任务通过 GitHub 自动合并（需自动发布策略）',
        [
          ['false', '关闭'],
          ['true', '允许（遵循 GitHub 仓库规则）'],
        ],
        String(Boolean(p.allowScheduledMerge)),
      )}${area('context', '长期项目规则与背景', p.context)}${area('checks', '验证命令（每行一条，仅配置可信命令）', p.verificationCommands?.map((c) => (c.command === 'sh' && c.args[0] === '-lc' ? c.args[1] : c.command === 'cmd' && c.args[2] === '/c' ? c.args[3] : [c.command, ...c.args].join(' '))).join('\n'))}${field('timeoutMinutes', '单轮上限（分钟）', p.timeoutMs / 60000, 'number')}${select(
        'independentReview',
        '额外独立只读审查（产生模型调用）',
        [
          ['false', '关闭'],
          ['true', '启用独立审查会话'],
        ],
        String(Boolean(p.independentReview)),
      )}${field('executorId', '远程执行器标识（留空为本机）', p.executorId)}${field('extensions', '允许的扩展名称（逗号分隔）', p.extensions?.join(','))}<button>保存新版本</button></form><p>任务记录生效规则版本；后续轮次读取最新项目规则。自动发布使用实例的 GitHub 身份。</p>`;
    el.querySelectorAll('[data-project]').forEach((b) => {
      b.onclick = () =>
        projectPage(
          el,
          projects.find((v) => v.id === b.dataset.project),
        );
    });
    el.querySelector('[data-new]').onclick = () => projectPage(el);
    if (principal.role !== 'admin') el.querySelector('[data-new]').hidden = true;
    if (!['admin', 'maintainer'].includes(principal.role))
      el.querySelectorAll('form input, form textarea, form select, form button').forEach(
        (input) => {
          input.disabled = true;
        },
      );
    form(el, async (values) => {
      const verificationCommands = values.checks
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((command) => ({
          command: processShell(),
          args: processShell() === 'cmd' ? ['/d', '/s', '/c', command] : ['-lc', command],
          timeoutMs: 300000,
        }));
      await api('/api/workbench/projects', {
        ...values,
        version: p.version,
        timeoutMs: Number(values.timeoutMinutes) * 60000,
        verificationCommands,
        independentReview: values.independentReview === 'true',
        allowScheduledMerge: values.allowScheduledMerge === 'true',
        executorId: values.executorId || undefined,
        extensions: values.extensions
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      });
      await projectPage(el);
    });
  }
  function processShell() {
    return serverPlatform === 'win32' ? 'cmd' : 'sh';
  } // Container/Linux verification; Windows can configure argv through API.
  async function runtimePage(el) {
    const r = await api('/api/workbench/runtime');
    const s = r.settings;
    el.querySelector('#cpx-admin-content').innerHTML =
      `<p>执行 ${r.active} · 排队 ${r.queued} · 可用磁盘 ${(r.freeBytes / 1073741824).toFixed(1)} GiB</p><form>${field('concurrency', '同时执行上限', s.concurrency, 'number')}${field('maxQueue', '队列上限', s.maxQueue, 'number')}${field('minFreeMiB', '最小可用磁盘（MiB）', s.minFreeBytes / 1048576, 'number')}${field('timeoutMinutes', '默认单轮上限（分钟）', s.timeoutMs / 60000, 'number')}${select(
        'defaultPolicy',
        '临时任务默认发布方式',
        [
          ['review', '审查后发布'],
          ['local', '仅保留成果'],
          ['auto', '预授权自动发布'],
        ],
        s.defaultPolicy,
      )}${field('logLimit', '每任务日志保留条数', s.logLimit, 'number')}${field('retentionDays', '归档工作区保留天数', s.retentionDays, 'number')}${select(
        'autoCleanup',
        '清理已归档且成果安全的工作区',
        [
          ['false', '手动清理'],
          ['true', '按保留天数自动清理'],
        ],
        String(s.autoCleanup),
      )}${select(
        'schedulesEnabled',
        '定时任务',
        [
          ['false', '停用'],
          ['true', '启用'],
        ],
        String(s.schedulesEnabled),
      )}${select(
        'remoteEnabled',
        '远程执行',
        [
          ['false', '停用'],
          ['true', '启用'],
        ],
        String(s.remoteEnabled),
      )}<button>保存运行策略</button></form><div class="cpx-actions"><button data-backup>创建数据库快照</button><button data-diagnostics>预览诊断摘要</button><button data-legacy>检查遗留工作区</button></div><pre data-output></pre><h3>未送达通知</h3>${r.notices.map((n) => `<p>${escape(n.taskId)} · ${escape(n.error || '等待发送')} <button data-notice="${escape(n.id)}">重试</button></p>`).join('')}`;
    form(el, (values) =>
      api('/api/workbench/runtime', {
        concurrency: Number(values.concurrency),
        maxQueue: Number(values.maxQueue),
        minFreeBytes: Number(values.minFreeMiB) * 1048576,
        timeoutMs: Number(values.timeoutMinutes) * 60000,
        schedulesEnabled: values.schedulesEnabled === 'true',
        remoteEnabled: values.remoteEnabled === 'true',
        defaultPolicy: values.defaultPolicy,
        logLimit: Number(values.logLimit),
        retentionDays: Number(values.retentionDays),
        autoCleanup: values.autoCleanup === 'true',
      }),
    );
    el.querySelector('[data-backup]').onclick = async () => {
      try {
        const b = await api('/api/workbench/backup', {});
        el.querySelector('[data-output]').textContent = `${b.file}\n${b.note}`;
      } catch (error) {
        message(el, error.message);
      }
    };
    el.querySelector('[data-diagnostics]').onclick = async () => {
      const d = await api('/api/workbench/diagnostics');
      el.querySelector('[data-output]').textContent = JSON.stringify(d, null, 2);
      const button = document.createElement('button');
      button.textContent = '导出此诊断摘要';
      button.onclick = () =>
        download('cpx-diagnostics.json', JSON.stringify(d, null, 2), 'application/json');
      el.querySelector('[data-output]').after(button);
    };
    el.querySelector('[data-legacy]').onclick = async () => {
      el.querySelector('[data-output]').textContent = JSON.stringify(
        await api('/api/workbench/legacy-workspaces'),
        null,
        2,
      );
    };
    el.querySelectorAll('[data-notice]').forEach((button) => {
      button.onclick = async () => {
        await api('/api/workbench/notice-retry', { id: button.dataset.notice });
        await runtimePage(el);
      };
    });
  }
  async function accountsPage(el) {
    const accounts = await api('/api/workbench/accounts');
    const tokens = await api('/api/workbench/tokens');
    el.querySelector('#cpx-admin-content').innerHTML =
      `<p>团队成员共享执行环境和实例 GitHub 凭据，只应添加可信用户。聊天用户标识使用 feishu:用户ID 或 dingtalk:用户ID。</p><div class="cpx-actions">${accounts
        .filter((a) => a.id !== 'admin')
        .map(
          (a) =>
            `<button data-account="${escape(a.id)}">${escape(a.name)} · ${escape(a.role)}${a.disabled ? '（已禁用）' : ''}</button>`,
        )
        .join('')}</div><form>${field('id', '用户标识')}${field('name', '显示名称')}${select(
        'role',
        '角色',
        [
          ['requester', '发起者：自己的任务'],
          ['reviewer', '审查者：审查与发布'],
          ['maintainer', '维护者：项目规则与任务管理'],
        ],
        'requester',
      )}${field('projects', '授权项目标识（逗号分隔）')}${select(
        'allowGroups',
        '允许群聊发起任务',
        [
          ['false', '仅私聊'],
          ['true', '允许群聊'],
        ],
        'false',
      )}${field('conversations', '限制会话路由（逗号分隔，留空不限）')}${select(
        'disabled',
        '账号状态',
        [
          ['false', '启用'],
          ['true', '禁用'],
        ],
        'false',
      )}<button>保存用户</button></form><h3>个人访问令牌</h3><div class="cpx-actions">${accounts.map((a) => `<button data-token-user="${escape(a.id)}">为 ${escape(a.name)} 签发令牌</button>`).join('')}</div><pre data-secret></pre>${tokens.map((t) => `<p>${escape(t.name)} · ${escape(t.userId)} · ${new Date(t.expiresAt).toLocaleString()} <button data-revoke="${escape(t.id)}">撤销</button></p>`).join('')}`;
    form(el, (v) =>
      api('/api/workbench/accounts', {
        ...v,
        projects: v.projects
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        disabled: v.disabled === 'true',
        allowGroups: v.allowGroups === 'true',
        conversations: v.conversations
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      }),
    );
    el.querySelectorAll('[data-account]').forEach((button) => {
      button.onclick = () => {
        const account = accounts.find((a) => a.id === button.dataset.account);
        for (const name of ['id', 'name', 'role'])
          el.querySelector(`[name="${name}"]`).value = account[name];
        el.querySelector('[name="projects"]').value = account.projects.join(',');
        el.querySelector('[name="disabled"]').value = String(Boolean(account.disabled));
        el.querySelector('[name="allowGroups"]').value = String(Boolean(account.allowGroups));
        el.querySelector('[name="conversations"]').value = (account.conversations || []).join(',');
      };
    });
    el.querySelectorAll('[data-token-user]').forEach((button) => {
      button.onclick = async () => {
        const token = await api('/api/workbench/tokens', {
          userId: button.dataset.tokenUser,
          name: '个人访问',
        });
        el.querySelector('[data-secret]').textContent = `令牌仅显示一次，请保管：\n${token.token}`;
      };
    });
    el.querySelectorAll('[data-revoke]').forEach((button) => {
      button.onclick = async () => {
        await api('/api/workbench/token-revoke', { id: button.dataset.revoke });
        await accountsPage(el);
      };
    });
  }
  async function bindingPage(el) {
    el.querySelector('#cpx-admin-content').innerHTML =
      '<p>生成一次性绑定码后，在需要绑定的聊天账号中向机器人发送命令。有效期 5 分钟；不会按同名自动关联身份。</p><button data-code>生成绑定码</button><pre data-command></pre>';
    el.querySelector('[data-code]').onclick = async () => {
      const code = await api('/api/workbench/binding-code', {});
      el.querySelector('[data-command]').textContent = code.command;
    };
    if (principal.role === 'admin') {
      const identities = await api('/api/workbench/identities');
      for (const identity of identities) {
        const row = document.createElement('p');
        row.textContent = `${identity.id} → ${identity.userId} `;
        const button = document.createElement('button');
        button.textContent = '解绑';
        button.onclick = async () => {
          await api('/api/workbench/identity-unbind', { id: identity.id });
          await bindingPage(el);
        };
        row.append(button);
        el.querySelector('#cpx-admin-content').append(row);
      }
    }
  }
  function newRunId() {
    // getRandomValues also works on the NAS HTTP origin, where randomUUID may be unavailable.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function schedulesPage(el) {
    const [templates, schedules] = await Promise.all([
      api('/api/workbench/templates'),
      api('/api/workbench/schedules'),
    ]);
    projects = await api('/api/workbench/projects');
    const editable = ['admin', 'maintainer'].includes(principal.role);
    el.querySelector('#cpx-admin-content').innerHTML =
      `<p>支持每天定点或固定间隔。定时功能和任务都启用后才会自动运行；停机后处理一次到期任务，同项目忙碌时跳过。</p>
      <p>新闻日报使用实时搜索，校验来源、时间与重复条目后生成 Markdown。先保存并试运行，检查结果后再启用自动发布。</p>
      <form>${field('id', '定时任务标识')}${select(
        'projectId',
        '项目',
        projects.map((p) => [p.id, p.name]),
      )}
      ${select(
        'templateId',
        '任务模板',
        templates.map((t) => [t.id, t.name]),
        'news',
      )}
      ${area('prompt', '新闻主题、优先来源与筛选要求，或自定义任务指令')}
      ${select(
        'cadence',
        '执行频率',
        [
          ['daily', '每天指定时间'],
          ['interval', '固定间隔'],
        ],
        'daily',
      )}
      ${field('dailyTime', '每天执行时间', '09:00', 'time')}
      ${field('intervalMinutes', '执行间隔（分钟，至少 5）', 1440, 'number')}
      ${field('timeZone', '执行时区', 'Asia/Shanghai')}
      ${field('newsDirectory', '新闻保存目录', 'news')}
      ${field('newsMaxItems', '每次最多新闻条数（1–50）', 10, 'number')}
      ${select(
        'publication',
        '交付方式',
        [
          ['review', '生成待审查成果'],
          ['pull_request', '自动创建 PR（项目需预授权）'],
          ['merge', '自动创建并请求合并 PR（项目需单独授权）'],
        ],
        'review',
      )}
      ${select(
        'enabled',
        '定时任务开关',
        [
          ['false', '暂停'],
          ['true', '启用'],
        ],
        'false',
      )}
      <button>保存定时任务</button></form>
      <div class="cpx-actions"><button data-new-schedule>新建任务</button><button data-refresh-schedules>刷新执行结果</button></div>
      ${schedules
        .map(
          (
            s,
          ) => `<div class="cpx-result"><p><strong>${escape(s.id)}</strong> · ${s.enabled ? '已启用' : '已暂停'} · ${s.cadence === 'daily' ? `每天 ${escape(s.dailyTime)}` : `间隔 ${s.intervalMinutes} 分钟`} · ${escape(s.timeZone)}<br>下次：${new Date(s.nextAt).toLocaleString('zh-CN', { timeZone: s.timeZone })}${s.lastAt ? `<br>上次触发：${new Date(s.lastAt).toLocaleString('zh-CN', { timeZone: s.timeZone })}` : ''}</p>
      ${s.error ? `<p role="alert">${escape(s.error)}</p>` : ''}
      ${s.lastTask ? `<p>最近任务：<a href="?task=${encodeURIComponent(s.lastTask.id)}">${escape(s.lastTask.id.slice(0, 8))}</a> · ${escape(s.lastTask.status)}${s.lastTask.publication ? ` · 发布 ${escape(s.lastTask.publication.status)}` : ''}${s.lastTask.merge ? ` · 合并 ${escape(s.lastTask.merge.status)}` : ''}</p><p>${escape(s.lastTask.error || s.lastTask.publication?.error || '')}</p>` : ''}
      ${editable ? `<div class="cpx-actions"><button data-schedule="${escape(s.id)}">编辑</button><button data-test-schedule="${escape(s.id)}">试运行（待审查）</button></div>` : ''}</div>`,
        )
        .join('')}
      <h3>模板内容</h3>${templates.map((t) => `<details><summary>${escape(t.name)}</summary><pre>${escape(t.prompt)}</pre></details>`).join('')}`;
    const formEl = el.querySelector('form');
    const toggle = () => {
      const daily = formEl.elements.cadence.value === 'daily';
      formEl.elements.dailyTime.closest('label').hidden = !daily;
      formEl.elements.intervalMinutes.closest('label').hidden = daily;
      const news = formEl.elements.templateId.value === 'news';
      for (const name of ['newsDirectory', 'newsMaxItems'])
        formEl.elements[name].closest('label').hidden = !news;
    };
    formEl.elements.cadence.onchange = toggle;
    formEl.elements.templateId.onchange = toggle;
    formEl.elements.id.required = true;
    formEl.elements.prompt.required = true;
    formEl.elements.intervalMinutes.min = '5';
    formEl.elements.newsMaxItems.min = '1';
    formEl.elements.newsMaxItems.max = '50';
    if (!editable)
      formEl.querySelectorAll('input, textarea, select, button').forEach((input) => {
        input.disabled = true;
      });
    form(el, async (v) => {
      await api('/api/workbench/schedules', {
        ...v,
        intervalMinutes: Number(v.intervalMinutes),
        newsMaxItems: Number(v.newsMaxItems),
        enabled: v.enabled === 'true',
      });
      await schedulesPage(el);
    });
    el.querySelector('[data-new-schedule]').onclick = () =>
      schedulesPage(el).catch((error) => message(el, error.message));
    el.querySelector('[data-refresh-schedules]').onclick = () =>
      schedulesPage(el).catch((error) => message(el, error.message));
    el.querySelectorAll('[data-schedule]').forEach((button) => {
      button.onclick = () => {
        const s = schedules.find((v) => v.id === button.dataset.schedule);
        formEl.reset();
        for (const [key, value] of Object.entries(s)) {
          const input = formEl.elements.namedItem(key);
          if (input) input.value = String(value);
        }
        toggle();
        formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    el.querySelectorAll('[data-test-schedule]').forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          // Retain the same key if a network failure prompts a retry.
          const runId = button.dataset.runId || (button.dataset.runId = newRunId());
          const task = await api('/api/workbench/schedule-run', {
            id: button.dataset.testSchedule,
            runId,
          });
          await schedulesPage(el);
          message(el, `试运行已创建：${task.id}。本次仅生成待审查成果。`);
        } catch (error) {
          message(el, error.message);
        } finally {
          button.disabled = false;
        }
      };
    });
    toggle();
  }
  async function extensionsPage(el) {
    const data = await api('/api/workbench/extensions');
    el.querySelector('#cpx-admin-content').innerHTML =
      `<p>仅安装可信扩展。Skill 以受管理子进程执行，不构成操作系统安全沙箱；MCP 可访问其配置授权的资源。</p><form>${select(
        'action',
        '操作',
        [
          ['skill-install', '安装 Skill'],
          ['mcp-connect', '连接 MCP'],
          ['mcp-disconnect', '断开 MCP'],
        ],
        'skill-install',
      )}${select(
        'source',
        'Skill 来源',
        [
          ['npm', 'npm'],
          ['git', 'Git'],
          ['local', '本地目录'],
        ],
        'npm',
      )}${field('identifier', 'Skill 包或来源路径')}${field('name', 'MCP 名称')}${select(
        'transport',
        'MCP 传输',
        [
          ['stdio', 'stdio'],
          ['http', 'HTTP'],
          ['websocket', 'WebSocket'],
        ],
        'stdio',
      )}${field('command', 'stdio 程序')}${field('args', 'stdio 参数（JSON 字符串数组）', '[]')}${field('url', 'MCP 服务地址')}<button>执行操作</button></form><h3>已安装 Skill</h3>${(data.skills || []).map((s) => `<p>${escape(s.manifest.name)} @ ${escape(s.manifest.version)} · ${escape(s.source)}<button data-uninstall="${escape(s.manifest.name)}">卸载</button></p>`).join('')}<h3>MCP</h3>${(data.mcp || []).map((c) => `<p>${escape(c.name)} · ${escape(c.status)}</p>`).join('')}`;
    form(el, (v) =>
      api('/api/workbench/extensions', {
        ...v,
        config: {
          name: v.name,
          transport: v.transport,
          command: v.command || undefined,
          args: JSON.parse(v.args || '[]'),
          url: v.url || undefined,
        },
      }),
    );
    el.querySelectorAll('[data-uninstall]').forEach((button) => {
      button.onclick = async () => {
        try {
          await api('/api/workbench/extensions', {
            action: 'skill-uninstall',
            name: button.dataset.uninstall,
          });
          await extensionsPage(el);
        } catch (error) {
          message(el, error.message);
        }
      };
    });
  }
  async function workersPage(el) {
    const workers = await api('/api/workbench/workers');
    el.querySelector('#cpx-admin-content').innerHTML =
      `<p>远程执行为可选功能。执行器主动连接本实例，使用执行器自身的模型和仓库凭据；实例不会下发 GitHub 或 Codex 密钥。运行策略中启用后才能分配。</p><form>${field('name', '执行器名称')}<button>创建配对令牌</button></form><pre data-worker-secret></pre>${workers.map((w) => `<p>${escape(w.name)} · ${escape(w.id)} · ${w.revoked ? '已撤销' : '可用'} · ${w.lastSeen ? new Date(w.lastSeen).toLocaleString() : '尚未连接'}<button data-worker-revoke="${escape(w.id)}">撤销</button><button data-worker-release="${escape(w.id)}">核对后解除占用</button></p>`).join('')}`;
    form(el, async (v) => {
      const w = await api('/api/workbench/workers', v);
      el.querySelector('[data-worker-secret]').textContent =
        `标识：${w.id}\n一次性显示令牌：${w.token}\n在开发机配置 CPX_WORKER_TOKEN 后运行：cpx worker --server <实例地址> --dir <独立执行目录>`;
    });
    el.querySelectorAll('[data-worker-release]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('请先在开发机确认旧执行已停止，再解除该执行器的未知任务占用。')) return;
        await api('/api/workbench/worker-release', {
          id: button.dataset.workerRelease,
          oldExecutionStopped: true,
        });
        message(el, '已解除旧租约占用；可恢复中断任务');
      };
    });
    el.querySelectorAll('[data-worker-revoke]').forEach((button) => {
      button.onclick = async () => {
        await api('/api/workbench/worker-revoke', { id: button.dataset.workerRevoke });
        await workersPage(el);
      };
    });
  }
  function renderTask(task, holder) {
    const canWrite = principal?.role !== 'reviewer';
    const active = ['queued', 'preparing', 'running', 'verifying', 'publishing'].includes(
      task.status,
    );
    const signature = [
      task.updatedAt,
      task.status,
      task.archivedAt,
      task.acceptedAt,
      task.result?.version,
      task.publication?.status,
      task.merge?.status,
      (task.pendingInputs || []).map((i) => i.id).join(','),
    ].join(':');
    const cached = results.get(task.id);
    if (
      (cached && task.result && cached.version !== task.result.version) ||
      (active && !task.result)
    )
      results.delete(task.id);
    const previous = panels.get(task.id);
    if (previous?.signature === signature) {
      holder.append(previous.panel);
      return;
    }
    const draft = previous?.panel.querySelector('.cpx-input textarea')?.value || '';
    const open = previous
      ? [...previous.panel.querySelectorAll('details')].map((el) => el.open)
      : [];
    const panel = document.createElement('section');
    panel.className = 'cpx-result';
    panels.set(task.id, { signature, panel });
    const result = results.get(task.id) || task.result;
    panel.innerHTML = `<h3>成果与交付</h3>${task.merge ? `<p>自动合并：${escape({ requested: '已提交 GitHub 自动合并请求；最终状态以 GitHub 为准', merged: 'GitHub 已合并', failed: '失败' }[task.merge.status])} ${escape(task.merge.error || '')}</p>` : ''}<p>${escape({ review: '审查后发布', local: '仅保留成果', auto: '预授权自动发布' }[task.policy] || '兼容策略')} · ${escape({ not_requested: '未请求发布', pending: '待批准', publishing: '发布中', published: '已发布', failed: '发布失败', unknown: '待核对' }[task.publication?.status] || '尚未发布')}${task.publication?.error ? ` · ${escape(task.publication.error)}` : ''}${task.archivedAt ? ' · 已归档' : ''}</p><div class="cpx-actions"><button data-action="link">复制任务链接</button>${!active && task.workspace ? '<button data-action="result">审查改动</button><button data-action="export">导出补丁</button>' : ''}${canWrite && task.status === 'interrupted' ? '<button data-action="resume">检查后继续原会话</button><button data-action="new-session">重建会话后继续</button>' : ''}${canWrite && !active && !task.archivedAt ? '<button data-action="accept">标记采用</button><button data-action="archive">归档</button>' : ''}${result && task.policy !== 'local' && !active && !task.archivedAt ? '<button data-action="publish">发布或更新 PR</button>' : ''}${canWrite && task.archivedAt && task.workspace ? '<button data-action="cleanup">预览工作区清理</button>' : ''}</div>${task.pullRequestUrl ? `<p><a href="${escape(task.pullRequestUrl)}" target="_blank" rel="noreferrer">查看 Pull Request</a></p>` : ''}${result ? `<details><summary>文件改动 · ${escape(result.version.slice(0, 12))}</summary><pre>${escape(result.files)}\n${escape(result.diff)}</pre></details>` : ''}<details><summary>验证证据 · ${task.verification?.length || 0} 项</summary>${task.verification?.length ? task.verification.map((v) => `<p>${escape(v.command)} ${escape(v.args.join(' '))} · 退出码 ${escape(v.exitCode)} · ${v.endedAt - v.startedAt}ms</p><pre>${escape(v.output)}</pre>`).join('') : '<p>没有运行平台配置的验证命令，Agent 回复不能替代验证证据。</p>'}</details>${task.reviewReport ? `<details><summary>独立审查 · ${task.reviewReport.status === 'completed' ? '已返回意见' : '执行失败'}</summary><p>独立会话生成的意见，不替代实际验证与用户批准。</p><pre>${escape(task.reviewReport.response || task.reviewReport.error)}</pre></details>` : ''}${canWrite && active ? `<form class="cpx-input"><label>追加待处理要求<textarea name="prompt" required maxlength="20000"></textarea></label><button>保存待处理消息</button></form>` : ''}${(task.pendingInputs || []).map((i) => `<p>${escape(i.prompt)} <button data-action="input-remove" data-input="${escape(i.id)}">撤回</button>${!active ? `<button data-action="input-run" data-input="${escape(i.id)}">执行此要求</button>` : ''}</p>`).join('')}<p role="status" class="cpx-task-message"></p>`;
    holder.append(panel);
    panel.querySelectorAll('details').forEach((el, i) => {
      el.open = Boolean(open[i]);
    });
    const draftInput = panel.querySelector('.cpx-input textarea');
    if (draftInput) draftInput.value = draft;
    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.onclick = async () => {
        const output = panel.querySelector('.cpx-task-message');
        button.disabled = true;
        try {
          const action = button.dataset.action;
          if (action === 'link') {
            const url = new URL(location.href);
            url.searchParams.set('task', task.id);
            url.hash = '';
            await navigator.clipboard.writeText(url.toString());
            output.textContent = '已复制；访问者仍需登录并获得任务授权';
          } else if (action === 'result') {
            const data = await api(`/api/console/task/result?id=${task.id}`);
            results.set(task.id, data);
            panels.delete(task.id);
            panel.remove();
            renderTask(task, holder);
          } else if (action === 'export') {
            const data = await api(`/api/console/task/export?id=${task.id}`);
            download(`cpx-${task.id}.patch`, data.diff);
            download(
              `cpx-${task.id}-result.json`,
              JSON.stringify({ ...data, diff: undefined }, null, 2),
              'application/json',
            );
            output.textContent = '已导出补丁和结果摘要；忽略文件与外部产物不包含在内';
          } else if (action === 'cleanup') {
            const preview = await api(`/api/console/task/cleanup-preview?id=${task.id}`);
            output.textContent = preview.reason;
            if (preview.safe) {
              const remove = document.createElement('button');
              remove.textContent = '删除此已归档工作区';
              remove.onclick = async () => {
                await api('/api/console/task/cleanup', { id: task.id, version: preview.version });
                output.textContent = '工作区已清理，任务记录保留';
              };
              output.append(remove);
            }
          } else {
            const body = {
              id: task.id,
              version: result?.version,
              inputId: button.dataset.input,
              newSession: action === 'new-session',
              oldExecutionStopped: task.executorId
                ? confirm('请先在远程执行机确认旧执行已停止。确认后才恢复，避免重复执行。')
                : undefined,
            };
            if (
              task.executorId &&
              ['resume', 'new-session'].includes(action) &&
              !body.oldExecutionStopped
            )
              return;
            await api(`/api/console/task/${action === 'new-session' ? 'resume' : action}`, body);
            results.delete(task.id);
            output.textContent = '操作已受理';
          }
        } catch (error) {
          output.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
    });
    const input = panel.querySelector('.cpx-input');
    if (input)
      input.onsubmit = async (event) => {
        event.preventDefault();
        try {
          await api('/api/console/task/input', {
            id: task.id,
            prompt: new FormData(input).get('prompt'),
          });
          input.reset();
        } catch (error) {
          panel.querySelector('.cpx-task-message').textContent = error.message;
        }
      };
  }
  return {
    ready,
    headers,
    renderTask,
    get principal() {
      return principal;
    },
    taskOptions: () => ({ projectId: document.querySelector('#cpx-project')?.value || undefined }),
    requestKey: (type) => {
      if (!keys.has(type)) keys.set(type, crypto.randomUUID());
      return keys.get(type);
    },
    clearRequestKey: (type) => keys.delete(type),
  };
})();
