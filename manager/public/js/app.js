// EKAFY Server Manager Dashboard Frontend
const API = {
  getHeaders() {
    const token = localStorage.getItem('ekafy_token');
    return {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : ''
    };
  },

  async get(endpoint) {
    const res = await fetch(`/api${endpoint}`, { headers: this.getHeaders() });
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
    }
    return res.json();
  },

  async post(endpoint, data) {
    const res = await fetch(`/api${endpoint}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
    }
    return res.json();
  },

  async put(endpoint, data) {
    const res = await fetch(`/api${endpoint}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    if (res.status === 401 || res.status === 403) {
      this.handleAuthError();
    }
    return res.json();
  },

  handleAuthError() {
    localStorage.removeItem('ekafy_token');
    localStorage.removeItem('ekafy_user');
    window.location.href = '/login.html';
  }
};

// Application State
const State = {
  currentTab: 'overview',
  stats: null,
  tenants: [],
  projects: [],
  user: null,
  refreshTimer: null
};

// Toast Notifications
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `badge badge-${type === 'error' ? 'danger' : 'success'}`;
  toast.style.padding = '0.75rem 1.25rem';
  toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
  toast.style.pointerEvents = 'auto';
  toast.textContent = message;
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Formatters
function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.floor(seconds)}s`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Init Dashboard
async function initDashboard() {
  const token = localStorage.getItem('ekafy_token');
  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  // Load User Profile
  try {
    const meRes = await API.get('/auth/me');
    if (meRes.success) {
      State.user = meRes.user;
      document.getElementById('nav-username').textContent = State.user.username || State.user.email.split('@')[0];
      document.getElementById('nav-user-email').textContent = State.user.email;
    } else {
      API.handleAuthError();
      return;
    }
  } catch (err) {
    API.handleAuthError();
    return;
  }

  setupNavigation();
  setupModals();
  await loadStats();
  await loadTenants();
  await loadProjects();

  // Auto-refresh stats every 5 seconds
  State.refreshTimer = setInterval(loadStats, 5000);
}

// Navigation Tabs
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      if (!tab) return;
      
      navItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      const target = document.getElementById(`tab-${tab}`);
      if (target) target.style.display = 'block';

      State.currentTab = tab;
      if (tab === 'tenants') loadTenants();
      if (tab === 'projects') loadProjects();
    });
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = '/login.html';
  });
}

// Load Live Metrics
async function loadStats() {
  try {
    const res = await API.get('/system/stats');
    if (res.success) {
      State.stats = res.data;
      renderMetrics();
    }
  } catch (err) {
    console.warn('Failed to load system stats:', err);
  }
}

function renderMetrics() {
  if (!State.stats) return;
  const { server, metrics, cluster } = State.stats;

  document.getElementById('metric-uptime').textContent = formatUptime(server.uptime);
  document.getElementById('metric-mem-usage').textContent = `${metrics.memory.usagePercentage}%`;
  document.getElementById('metric-mem-bar').style.width = `${metrics.memory.usagePercentage}%`;
  document.getElementById('metric-mem-details').textContent = `${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`;
  
  document.getElementById('metric-tenants-count').textContent = cluster.tenants;
  document.getElementById('metric-projects-count').textContent = cluster.projects;

  // Render Host Info
  document.getElementById('info-hostname').textContent = server.hostname;
  document.getElementById('info-os').textContent = server.platform;
  document.getElementById('info-node').textContent = server.nodeVersion;
  document.getElementById('info-load').textContent = metrics.loadAverage.map(l => l.toFixed(2)).join(', ');

  // Render Cluster URLs
  document.getElementById('domain-manager').textContent = cluster.managerDomain;
  document.getElementById('domain-core').textContent = `*.${cluster.coreDomain}`;
  document.getElementById('domain-webmin').textContent = cluster.webminDomain;
  document.getElementById('domain-webmin-link').href = `https://${cluster.webminDomain}`;
}

// Load Tenants Data
async function loadTenants() {
  const tbody = document.getElementById('tenants-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem;">Loading tenants...</td></tr>';

  try {
    const res = await API.get('/tenants');
    if (res.success && res.data) {
      State.tenants = res.data;
      renderTenants();
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--danger);">Failed to load tenants.</td></tr>';
  }
}

function renderTenants() {
  const tbody = document.getElementById('tenants-tbody');
  if (State.tenants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem; color: var(--text-dim);">No SaaS tenants provisioned yet. Click "+ Provision Tenant" to create one.</td></tr>';
    return;
  }

  const coreDomain = State.stats ? State.stats.cluster.coreDomain : 'ekafy.com';

  tbody.innerHTML = State.tenants.map(t => {
    const appUrl = `https://${t.subdomain}.${coreDomain}`;
    const isSuspended = t.status === 'suspended';
    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #fff;">${t.name}</div>
          <a href="${appUrl}" target="_blank" style="font-size: 0.78rem; color: var(--primary); text-decoration: none;">
            ${t.subdomain}.${coreDomain} ↗
          </a>
        </td>
        <td><span class="mono">${t.db_name}</span></td>
        <td><span class="badge badge-accent">${t.plan_type.toUpperCase()}</span></td>
        <td>
          <span class="badge ${isSuspended ? 'badge-warning' : 'badge-success'}">
            <span class="pulse-dot"></span> ${t.status}
          </span>
        </td>
        <td style="font-size: 0.8rem; color: var(--text-dim);">${new Date(t.created_at).toLocaleDateString()}</td>
        <td style="text-align: right;">
          <button class="btn btn-secondary btn-sm" onclick="toggleTenantStatus(${t.id}, '${isSuspended ? 'active' : 'suspended'}')">
            ${isSuspended ? 'Activate' : 'Suspend'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Toggle Tenant Status
window.toggleTenantStatus = async function(id, nextStatus) {
  try {
    const res = await API.put(`/tenants/${id}/status`, { status: nextStatus });
    if (res.success) {
      showToast(`Tenant status updated to ${nextStatus}!`);
      loadTenants();
      loadStats();
    }
  } catch (err) {
    showToast('Failed to update tenant status', 'error');
  }
};

// Load Projects Data
async function loadProjects() {
  const tbody = document.getElementById('projects-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 2rem;">Loading projects...</td></tr>';

  try {
    const res = await API.get('/projects');
    if (res.success && res.data) {
      State.projects = res.data;
      renderProjects();
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--danger);">Failed to load projects.</td></tr>';
  }
}

function renderProjects() {
  const tbody = document.getElementById('projects-tbody');
  if (State.projects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 2rem; color: var(--text-dim);">No agency projects recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = State.projects.map(p => `
    <tr>
      <td style="font-weight: 600; color: #fff;">${p.name}</td>
      <td>${p.client_name || 'Direct Client'}</td>
      <td><span class="badge badge-primary">${p.project_type.toUpperCase()}</span></td>
      <td><span class="badge badge-success">${p.status.replace(/_/g, ' ')}</span></td>
      <td style="font-size: 0.8rem; color: var(--text-dim);">${new Date(p.created_at).toLocaleDateString()}</td>
    </tr>
  `).join('');
}

// Modal Handlers
function setupModals() {
  const modalBackdrop = document.getElementById('tenant-modal-backdrop');
  const openBtn = document.getElementById('open-create-tenant-btn');
  const closeBtn = document.getElementById('close-tenant-modal-btn');
  const cancelBtn = document.getElementById('cancel-tenant-modal-btn');
  const form = document.getElementById('create-tenant-form');

  if (!modalBackdrop) return;

  const openModal = () => modalBackdrop.classList.add('open');
  const closeModal = () => {
    modalBackdrop.classList.remove('open');
    form.reset();
  };

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('submit-tenant-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Provisioning Database...';

    const name = document.getElementById('tenant-name-input').value.trim();
    const subdomain = document.getElementById('tenant-subdomain-input').value.trim();
    const plan = document.getElementById('tenant-plan-select').value;

    try {
      const res = await API.post('/tenants', { name, subdomain, plan_type: plan });
      if (res.success) {
        showToast(`Tenant "${name}" successfully provisioned with dedicated database!`);
        closeModal();
        loadTenants();
        loadStats();
      } else {
        alert(`Error: ${res.error || 'Failed to provision tenant'}`);
      }
    } catch (err) {
      alert('Network or server error while provisioning tenant.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Provision Tenant';
    }
  });
}

// Start
document.addEventListener('DOMContentLoaded', initDashboard);
