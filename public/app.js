const services = ['nginx', 'mysql', 'mariadb', 'apache2'];
const databaseQueryPresets = [
  { key: 'create-database', label: 'Create DB' },
  { key: 'grant-access', label: 'Grant Access' },
  { key: 'create-schema', label: 'Schema' },
  { key: 'seed-baseline', label: 'Seed Data' }
];
const apiEndpointPresets = [
  { key: 'health', label: 'Health' },
  { key: 'auth', label: 'Auth' },
  { key: 'resources', label: 'Resources' },
  { key: 'custom-crud', label: 'CRUD' }
];

let dashboardState = {
  user: null,
  projects: [],
  users: []
};

let endpointRowCount = 0;

function clearSession() {
  dashboardState.user = null;
}

function reportError(error, context) {
  if (window.ekafyReportError) {
    window.ekafyReportError(error, context);
    return;
  }

  console.error(context || 'App error', error);
}

function redirectOnAuthError(error) {
  if (error?.status === 401) {
    window.location.href = '/login.html';
    return true;
  }

  return false;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isAdmin() {
  return dashboardState.user?.role === 'admin';
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include'
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const ErrorClass = window.ApiError || Error;
    const error = new ErrorClass(
      data.message || 'Request failed',
      response.status,
      data.code || 'REQUEST_FAILED',
      data.details || null
    );
    throw error;
  }

  return data;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function setMeter(id, value) {
  const meter = document.getElementById(id);
  if (!meter) return;
  meter.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
}

function getProjectForm() {
  return document.getElementById('projectForm');
}

function getEndpointList() {
  return document.querySelector('[data-endpoint-list]');
}

function getPresetRow() {
  return document.querySelector('[data-query-preset-row]');
}

function getEndpointPresetRow() {
  return document.querySelector('[data-endpoint-preset-row]');
}

function createEndpointRow(endpoint = {}) {
  endpointRowCount += 1;
  const row = document.createElement('div');
  row.className = 'endpoint-row';
  row.dataset.endpointRow = String(endpointRowCount);
  row.innerHTML = `
    <input name="api.endpoints.name" type="text" placeholder="Endpoint name" value="${escapeHtml(endpoint.name || '')}">
    <select name="api.endpoints.method">
      ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => `<option value="${method}" ${method === (endpoint.method || 'GET') ? 'selected' : ''}>${method}</option>`).join('')}
    </select>
    <input name="api.endpoints.path" type="text" placeholder="/resource/path" value="${escapeHtml(endpoint.path || '')}">
    <input class="endpoint-description" name="api.endpoints.description" type="text" placeholder="Description" value="${escapeHtml(endpoint.description || '')}">
    <button type="button" class="danger-button" data-remove-endpoint aria-label="Remove endpoint">&times;</button>
  `;
  return row;
}

function syncProjectWizardVisibility() {
  const form = getProjectForm();
  if (!form) return;

  const kind = form.elements.kind?.value || 'static';
  const databaseWizard = form.querySelector('.database-wizard');
  const apiWizard = form.querySelector('.api-wizard');

  if (databaseWizard) {
    databaseWizard.hidden = !(kind === 'database' || kind === 'full');
  }

  if (apiWizard) {
    apiWizard.hidden = !(kind === 'api' || kind === 'full');
  }
}

function syncPresetButtons(activePresets = []) {
  const presetRow = getPresetRow();
  if (!presetRow) return;

  presetRow.querySelectorAll('button[data-query-preset]').forEach((button) => {
    button.classList.toggle('is-active', activePresets.includes(button.dataset.queryPreset));
  });
}

function readEndpointRows() {
  const list = getEndpointList();
  if (!list) return [];

  return Array.from(list.querySelectorAll('[data-endpoint-row]')).map((row) => ({
    name: row.querySelector('input[name="api.endpoints.name"]')?.value.trim(),
    method: row.querySelector('select[name="api.endpoints.method"]')?.value,
    path: row.querySelector('input[name="api.endpoints.path"]')?.value.trim(),
    description: row.querySelector('input[name="api.endpoints.description"]')?.value.trim()
  })).filter((endpoint) => endpoint.name || endpoint.path);
}

function readSelectedQueryPresets() {
  const presetRow = getPresetRow();
  if (!presetRow) return [];

  return Array.from(presetRow.querySelectorAll('button[data-query-preset].is-active')).map((button) => button.dataset.queryPreset);
}

function readProjectWizardConfig() {
  const form = getProjectForm();
  if (!form) return null;

  const kind = form.elements.kind.value;
  const database = {
    enabled: kind === 'database' || kind === 'full',
    provider: form.elements['database.provider'].value,
    host: form.elements['database.host'].value.trim(),
    port: Number(form.elements['database.port'].value || 3306),
    databaseName: form.elements['database.databaseName'].value.trim(),
    username: form.elements['database.username'].value.trim(),
    charset: 'utf8mb4'
  };

  const api = {
    enabled: kind === 'api' || kind === 'full',
    baseUrl: form.elements['api.baseUrl'].value.trim(),
    endpoints: readEndpointRows()
  };

  return {
    kind,
    database,
    api,
    queryPresets: readSelectedQueryPresets(),
    notes: form.elements.notes.value.trim()
  };
}

function renderProjectConfigSummary(config = {}) {
  const parts = [];
  const database = config.database || {};
  const api = config.api || {};

  parts.push(`<span class="role-pill">Type: ${escapeHtml(config.kind || 'static')}</span>`);

  if (database.enabled) {
    parts.push(`<span class="role-pill">DB: ${escapeHtml(database.provider || 'mariadb')} @ ${escapeHtml(database.host || '127.0.0.1')}:${escapeHtml(database.port || 3306)}</span>`);
    if (database.databaseName) {
      parts.push(`<span class="role-pill">Schema: ${escapeHtml(database.databaseName)}</span>`);
    }
  }

  if (api.enabled) {
    parts.push(`<span class="role-pill">API base: ${escapeHtml(api.baseUrl || 'unset')}</span>`);
    (api.endpoints || []).slice(0, 4).forEach((endpoint) => {
      parts.push(`<span class="role-pill">${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</span>`);
    });
  }

  if (Array.isArray(config.queryPresets) && config.queryPresets.length) {
    config.queryPresets.forEach((preset) => {
      parts.push(`<span class="role-pill">${escapeHtml(preset)}</span>`);
    });
  }

  if (config.notes) {
    parts.push(`<span class="role-pill">Notes saved</span>`);
  }

  return parts.join('');
}

function buildWizardPreviewFromConfig(config = {}) {
  const database = config.database || {};
  const api = config.api || {};

  const databasePreview = database.enabled
    ? {
        summary: {
          provider: database.provider || 'mariadb',
          host: database.host || 'localhost',
          port: database.port || 3306,
          databaseName: database.databaseName || '<DATABASE_NAME>',
          username: database.username || '<DB_USER>',
          charset: database.charset || 'utf8mb4'
        },
        sql: [
          `CREATE DATABASE IF NOT EXISTS \`${database.databaseName || '<DATABASE_NAME>'}\` CHARACTER SET ${database.charset || 'utf8mb4'} COLLATE ${database.charset || 'utf8mb4'}_unicode_ci;`,
          `CREATE USER IF NOT EXISTS '${database.username || '<DB_USER>'}'@'${database.host || 'localhost'}' IDENTIFIED BY '<PASSWORD>';`,
          `GRANT ALL PRIVILEGES ON \`${database.databaseName || '<DATABASE_NAME>'}\`.* TO '${database.username || '<DB_USER>'}'@'${database.host || 'localhost'}';`,
          'FLUSH PRIVILEGES;'
        ],
        presets: databaseQueryPresets
      }
    : null;

  const apiPreview = api.enabled
    ? {
        summary: {
          baseUrl: api.baseUrl || '',
          endpoints: Array.isArray(api.endpoints) ? api.endpoints : []
        },
        presets: apiEndpointPresets
      }
    : null;

  return {
    database: databasePreview,
    api: apiPreview
  };
}

function renderWizardPreview(target, wizardOrConfig) {
  if (!target) return;

  const preview = wizardOrConfig?.database?.sql
    ? wizardOrConfig
    : buildWizardPreviewFromConfig(wizardOrConfig);

  const databaseSql = preview?.database?.sql || [];
  const databasePresets = preview?.database?.presets || [];
  const apiEndpoints = preview?.api?.summary?.endpoints || [];

  target.innerHTML = `
    <div class="wizard-preview-block">
      <h4>Database Wizard Output</h4>
      ${databaseSql.length ? `<pre>${escapeHtml(databaseSql.join('\n'))}</pre>` : '<p class="message">No database wizard configured yet.</p>'}
    </div>
    <div class="wizard-preview-block">
      <h4>Query Presets</h4>
      ${databasePresets.length ? databasePresets.map((preset) => `<div class="role-pill">${escapeHtml(preset.label)}</div>`).join('') : '<p class="message">No database presets available.</p>'}
    </div>
    <div class="wizard-preview-block">
      <h4>API Endpoints</h4>
      ${apiEndpoints.length ? apiEndpoints.map((endpoint) => `<div class="role-pill">${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</div>`).join('') : '<p class="message">No API endpoints configured yet.</p>'}
    </div>
  `;
}

function setupProjectWizard() {
  const form = getProjectForm();
  if (!form) return;

  const endpointList = getEndpointList();
  const presetRow = getPresetRow();
  const endpointPresetRow = getEndpointPresetRow();
  const addEndpointButton = document.querySelector('[data-add-endpoint]');
  const wizardPreview = document.getElementById('projectWizardPreview');

  if (presetRow && !presetRow.dataset.ready) {
    presetRow.innerHTML = databaseQueryPresets.map((preset) => `
      <button type="button" class="preset-button" data-query-preset="${preset.key}">${escapeHtml(preset.label)}</button>
    `).join('');
    presetRow.dataset.ready = 'true';
  }

  if (endpointPresetRow && !endpointPresetRow.dataset.ready) {
    endpointPresetRow.innerHTML = apiEndpointPresets.map((preset) => `
      <button type="button" class="preset-button" data-api-endpoint-preset="${preset.key}">${escapeHtml(preset.label)}</button>
    `).join('');
    endpointPresetRow.dataset.ready = 'true';
  }

  if (endpointList && !endpointList.children.length) {
    endpointList.appendChild(createEndpointRow());
  }

  form.elements.kind.addEventListener('change', syncProjectWizardVisibility);

  if (addEndpointButton && endpointList) {
    addEndpointButton.addEventListener('click', () => {
      endpointList.appendChild(createEndpointRow());
      syncProjectWizardVisibility();
    });
  }

  if (presetRow) {
    presetRow.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-query-preset]');
      if (!button) return;
      button.classList.toggle('is-active');
      if (wizardPreview) {
        renderWizardPreview(wizardPreview, readProjectWizardConfig());
      }
    });
  }

  if (endpointPresetRow && endpointList) {
    endpointPresetRow.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-api-endpoint-preset]');
      if (!button) return;

      const preset = {
        health: { name: 'Health', method: 'GET', path: '/health', description: 'Service health check' },
        auth: { name: 'Auth', method: 'POST', path: '/auth/login', description: 'Login or token exchange' },
        resources: { name: 'Resources', method: 'GET', path: '/resources', description: 'List resources' },
        'custom-crud': { name: 'CRUD', method: 'POST', path: '/items', description: 'Replace with your resource path' }
      }[button.dataset.apiEndpointPreset];

      if (preset) {
        endpointList.appendChild(createEndpointRow(preset));
        if (wizardPreview) {
          renderWizardPreview(wizardPreview, readProjectWizardConfig());
        }
      }
    });
  }

  if (endpointList) {
    endpointList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-remove-endpoint]');
      if (!button) return;

      const row = button.closest('[data-endpoint-row]');
      if (row) {
        row.remove();
      }

      if (!endpointList.children.length) {
        endpointList.appendChild(createEndpointRow());
      }

      if (wizardPreview) {
        renderWizardPreview(wizardPreview, readProjectWizardConfig());
      }
    });
  }

  const refreshPreview = () => {
    if (wizardPreview) {
      renderWizardPreview(wizardPreview, readProjectWizardConfig());
    }
  };

  form.addEventListener('input', refreshPreview);
  form.addEventListener('change', refreshPreview);

  syncProjectWizardVisibility();
  syncPresetButtons([]);
  if (wizardPreview) {
    renderWizardPreview(wizardPreview, readProjectWizardConfig());
  }
}

function resetProjectWizard() {
  const form = getProjectForm();
  if (!form) return;

  form.reset();

  const endpointList = getEndpointList();
  if (endpointList) {
    endpointList.innerHTML = '';
    endpointList.appendChild(createEndpointRow());
  }

  endpointRowCount = endpointList ? endpointList.children.length : 0;
  syncProjectWizardVisibility();
  syncPresetButtons([]);
}

async function loadStatus() {
  const data = await api('/api/system/status');

  document.getElementById('cpuValue').textContent = `${data.cpu}%`;
  document.getElementById('ramValue').textContent = `${data.ram}%`;
  document.getElementById('diskValue').textContent = data.disk === null ? 'N/A' : `${data.disk}%`;
  document.getElementById('uptimeValue').textContent = formatUptime(data.uptime);

  setMeter('cpuMeter', data.cpu);
  setMeter('ramMeter', data.ram);
  setMeter('diskMeter', data.disk || 0);
}

async function loadServiceStatus(name) {
  const statusNode = document.querySelector(`[data-service-status="${name}"]`);
  if (!statusNode) return;

  try {
    const data = await api(`/api/services/${name}/status`);
    if (data.active === null) {
      statusNode.textContent = 'Unavailable';
    } else {
      statusNode.textContent = data.active ? 'Active' : 'Inactive';
    }
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportError(error, `Loading service status for ${name}`);
    statusNode.textContent = error.message;
  }
}

function renderServices() {
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;

  grid.innerHTML = services.map((service) => `
    <article class="service-card">
      <header>
        <h4>${service}</h4>
        <span class="service-status" data-service-status="${service}">Checking</span>
      </header>
      <div class="service-actions">
        <button type="button" data-service="${service}" data-action="start" ${isAdmin() ? '' : 'disabled'}>Start</button>
        <button class="restart" type="button" data-service="${service}" data-action="restart" ${isAdmin() ? '' : 'disabled'}>Restart</button>
        <button class="stop" type="button" data-service="${service}" data-action="stop" ${isAdmin() ? '' : 'disabled'}>Stop</button>
      </div>
    </article>
  `).join('');

  services.forEach(loadServiceStatus);
}

async function runServiceAction(service, action) {
  const message = document.getElementById('serviceMessage');
  message.textContent = `Running ${action} on ${service}...`;

  try {
    const data = await api(`/api/services/${service}/${action}`, { method: 'POST' });
    message.textContent = data.message;
    await loadServiceStatus(service);
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportError(error, `Running ${action} on ${service}`);
    message.textContent = error.message;
  }
}

async function loadProjects() {
  const grid = document.getElementById('projectsGrid');
  if (!grid) return;

  try {
    const data = await api('/api/projects');
    dashboardState.projects = data.projects;
    grid.innerHTML = data.projects.map((project) => `
      <article class="project-card">
        <h4>${escapeHtml(project.name)}</h4>
        <p>${escapeHtml(project.path)}</p>
        <p>Status: ${escapeHtml(project.status)}</p>
        <div>${renderProjectConfigSummary(project.config || {})}</div>
        <p>Your access: ${escapeHtml(project.current_user_role || 'member')}</p>
        <div>${renderMemberPills(project.members)}</div>
      </article>
    `).join('');
    syncProjectOptions();
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportError(error, 'Loading projects');
    grid.innerHTML = `<p class="message">${error.message}</p>`;
  }
}

function renderMemberPills(members = []) {
  if (!members.length) {
    return '<span class="role-pill">No members</span>';
  }

  return members.map((member) => `
    <span class="role-pill">${escapeHtml(member.username)} - ${escapeHtml(member.project_role)}</span>
  `).join('');
}

async function loadUsers() {
  const table = document.getElementById('usersTable');
  if (!table || !isAdmin()) return;

  try {
    const data = await api('/api/users');
    dashboardState.users = data.users;
    table.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Global Role</th>
            <th>Project Access</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${data.users.map(renderUserRow).join('')}
        </tbody>
      </table>
    `;
    syncUserOptions();
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportError(error, 'Loading users');
    table.innerHTML = `<p class="message">${error.message}</p>`;
  }
}

function renderUserRow(user) {
  const projects = user.projects.length
    ? user.projects.map((project) => `<span class="role-pill">${escapeHtml(project.name)} - ${escapeHtml(project.role)}</span>`).join('')
    : '<span class="role-pill">No projects</span>';
  const isCurrentUser = dashboardState.user && Number(dashboardState.user.id) === Number(user.id);
  const actionCell = isCurrentUser
    ? '<span class="role-pill">Current user</span>'
    : `<button type="button" class="danger-button" data-user-delete="${user.id}">Remove</button>`;

  return `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${projects}</td>
      <td>${new Date(user.created_at).toLocaleString()}</td>
      <td>${actionCell}</td>
    </tr>
  `;
}

function syncProjectOptions() {
  const select = document.querySelector('#memberForm select[name="projectId"]');
  if (!select) return;

  select.innerHTML = '<option value="">Project</option>' + dashboardState.projects.map((project) => (
    `<option value="${project.id}">${escapeHtml(project.name)}</option>`
  )).join('');
}

function syncUserOptions() {
  const select = document.querySelector('#memberForm select[name="userId"]');
  if (!select) return;

  select.innerHTML = '<option value="">User</option>' + dashboardState.users.map((user) => (
    `<option value="${user.id}">${escapeHtml(user.username)} (${escapeHtml(user.role)})</option>`
  )).join('');
}

function setAdminVisibility() {
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = !isAdmin();
  });
}

function bindAdminForms() {
  const userForm = document.getElementById('userForm');
  const projectForm = document.getElementById('projectForm');
  const memberForm = document.getElementById('memberForm');
  const message = document.getElementById('accessMessage');
  const usersTable = document.getElementById('usersTable');
  const wizardPreview = document.getElementById('projectWizardPreview');

  if (userForm) {
    userForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = 'Creating user...';

      try {
        await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: userForm.username.value.trim(),
            password: userForm.password.value,
            role: userForm.role.value
          })
        });
        userForm.reset();
        message.textContent = 'User created';
        await loadUsers();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportError(error, 'Creating user');
        message.textContent = error.message;
      }
    });
  }

  if (projectForm) {
    projectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = 'Creating project...';

      try {
        const config = readProjectWizardConfig();
        const data = await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: projectForm.name.value.trim(),
            slug: projectForm.slug.value.trim(),
            path: projectForm.path.value.trim(),
            config
          })
        });
        resetProjectWizard();
        if (wizardPreview) {
          renderWizardPreview(wizardPreview, data.wizard);
        }
        message.textContent = 'Project created';
        await loadProjects();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportError(error, 'Creating project');
        message.textContent = error.message;
      }
    });
  }

  if (memberForm) {
    memberForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = 'Saving project member...';

      try {
        await api(`/api/projects/${memberForm.projectId.value}/members`, {
          method: 'PUT',
          body: JSON.stringify({
            userId: Number(memberForm.userId.value),
            role: memberForm.role.value
          })
        });
        memberForm.reset();
        message.textContent = 'Project member saved';
        await Promise.all([loadProjects(), loadUsers()]);
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportError(error, 'Saving project member');
        message.textContent = error.message;
      }
    });
  }

  if (usersTable) {
    usersTable.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-user-delete]');
      if (!button) return;

      const userId = button.dataset.userDelete;
      const confirmed = window.confirm('Remove this user from EKAFY? This will delete their account and project access.');
      if (!confirmed) return;

      message.textContent = 'Removing user...';

      try {
        await api(`/api/users/${userId}`, { method: 'DELETE' });
        message.textContent = 'User removed';
        await loadUsers();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportError(error, 'Removing user');
        message.textContent = error.message;
      }
    });
  }
}

function bootLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  api('/api/auth/me')
    .then(() => {
      window.location.href = '/dashboard.html';
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('authMessage');
    message.textContent = 'Signing in...';

    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value
        })
      });

      window.location.href = '/dashboard.html';
    } catch (error) {
      reportError(error, 'Signing in');
      message.textContent = error.message;
    }
  });
}

async function bootDashboard() {
  const dashboard = document.querySelector('.app-shell');
  if (!dashboard) return;

  let session;
  try {
    session = await api('/api/auth/me');
  } catch (error) {
    window.location.href = '/login.html';
    return;
  }

  const user = session.user;
  dashboardState.user = user;
  document.getElementById('userRole').textContent = user ? `${user.username} - ${user.role}` : 'Control panel';
  setAdminVisibility();

  document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (_error) {
      // Clear the local state and redirect even if logout fails.
    }
    clearSession();
    window.location.href = '/login.html';
  });

  document.getElementById('refreshStatusButton').addEventListener('click', () => {
    services.forEach(loadServiceStatus);
  });

  document.getElementById('servicesGrid').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-service][data-action]');
    if (!button) return;
    runServiceAction(button.dataset.service, button.dataset.action);
  });

  renderServices();
  bindAdminForms();
  setupProjectWizard();
  loadProjects();
  loadUsers();
  loadStatus().catch((error) => {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportError(error, 'Loading system status');
  });

  setInterval(() => {
    loadStatus().catch((error) => {
      if (redirectOnAuthError(error)) return;
      reportError(error, 'Refreshing system status');
    });
  }, 5000);
}

bootLogin();
bootDashboard();
