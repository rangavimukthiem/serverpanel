const tokenKey = 'ekafy_token';
const userKey = 'ekafy_user';

const services = ['nginx', 'mysql', 'mariadb', 'apache2'];

let dashboardState = {
  user: null,
  projects: [],
  users: []
};

function getToken() {
  return localStorage.getItem(tokenKey);
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem(userKey));
  } catch (_error) {
    return null;
  }
}

function setSession({ token, user }) {
  localStorage.setItem(tokenKey, token);
  localStorage.setItem(userKey, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(userKey);
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

  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || 'Request failed');
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
        <p>Your access: ${escapeHtml(project.current_user_role || 'member')}</p>
        <div>${renderMemberPills(project.members)}</div>
      </article>
    `).join('');
    syncProjectOptions();
  } catch (error) {
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
          </tr>
        </thead>
        <tbody>
          ${data.users.map(renderUserRow).join('')}
        </tbody>
      </table>
    `;
    syncUserOptions();
  } catch (error) {
    table.innerHTML = `<p class="message">${error.message}</p>`;
  }
}

function renderUserRow(user) {
  const projects = user.projects.length
    ? user.projects.map((project) => `<span class="role-pill">${escapeHtml(project.name)} - ${escapeHtml(project.role)}</span>`).join('')
    : '<span class="role-pill">No projects</span>';

  return `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${projects}</td>
      <td>${new Date(user.created_at).toLocaleString()}</td>
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
        message.textContent = error.message;
      }
    });
  }

  if (projectForm) {
    projectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = 'Creating project...';

      try {
        await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: projectForm.name.value.trim(),
            slug: projectForm.slug.value.trim(),
            path: projectForm.path.value.trim()
          })
        });
        projectForm.reset();
        message.textContent = 'Project created';
        await loadProjects();
      } catch (error) {
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
        message.textContent = error.message;
      }
    });
  }
}

function bootLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  if (getToken()) {
    window.location.href = '/dashboard.html';
    return;
  }

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

      setSession(data);
      window.location.href = '/dashboard.html';
    } catch (error) {
      message.textContent = error.message;
    }
  });
}

function bootDashboard() {
  const dashboard = document.querySelector('.app-shell');
  if (!dashboard) return;

  if (!getToken()) {
    window.location.href = '/login.html';
    return;
  }

  const user = getUser();
  dashboardState.user = user;
  document.getElementById('userRole').textContent = user ? `${user.username} - ${user.role}` : 'Control panel';
  setAdminVisibility();

  document.getElementById('logoutButton').addEventListener('click', () => {
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
  loadProjects();
  loadUsers();
  loadStatus().catch((error) => {
    if (error.message.includes('token')) {
      clearSession();
      window.location.href = '/login.html';
    }
  });

  setInterval(() => {
    loadStatus().catch(console.warn);
  }, 5000);
}

bootLogin();
bootDashboard();
