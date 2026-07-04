const tokenKey = 'ekafy_token';
const userKey = 'ekafy_user';

const services = ['nginx', 'mysql', 'mariadb', 'apache2'];

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
        <button type="button" data-service="${service}" data-action="start">Start</button>
        <button class="restart" type="button" data-service="${service}" data-action="restart">Restart</button>
        <button class="stop" type="button" data-service="${service}" data-action="stop">Stop</button>
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
    grid.innerHTML = data.projects.map((project) => `
      <article class="project-card">
        <h4>${project.name}</h4>
        <p>${project.path}</p>
        <p>Status: ${project.status}</p>
      </article>
    `).join('');
  } catch (error) {
    grid.innerHTML = `<p class="message">${error.message}</p>`;
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
  document.getElementById('userRole').textContent = user ? `${user.username} · ${user.role}` : 'Control panel';

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
  loadProjects();
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
