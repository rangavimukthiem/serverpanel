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
  services: [],
  databases: [],
  users: [],
  backups: [],
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
  if (!bytes || bytes === 0) return '0 B';
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
  setupSqlConsole();
  setupLogsViewer();

  await loadStats();
  await loadServices();
  await loadTenants();
  await loadProjects();
  await loadDatabases();
  await loadUsers();
  await loadBackups();

  // Auto-refresh stats every 5 seconds
  State.refreshTimer = setInterval(loadStats, 5000);

  document.getElementById('refresh-now-btn').addEventListener('click', () => {
    loadStats();
    showToast('Telemetry refreshed.');
  });
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
      if (tab === 'services') loadServices();
      if (tab === 'logs') loadLogs();
      if (tab === 'tenants') loadTenants();
      if (tab === 'projects') loadProjects();
      if (tab === 'databases') loadDatabases();
      if (tab === 'users') loadUsers();
      if (tab === 'backups') loadBackups();
    });
  });

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('ekafy_token');
      localStorage.removeItem('ekafy_user');
      sessionStorage.clear();
      window.location.href = '/login.html?logout=1';
    });
  }
}

// 1. Load Live Metrics
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

  // CPU
  document.getElementById('metric-cpu-usage').textContent = `${metrics.cpuUsagePct}%`;
  document.getElementById('metric-cpu-bar').style.width = `${metrics.cpuUsagePct}%`;
  document.getElementById('metric-cpu-cores').textContent = `${metrics.cpuCount} Cores (${metrics.cpuModel.split(' ')[0]})`;

  // Memory
  document.getElementById('metric-mem-usage').textContent = `${metrics.memory.usagePercentage}%`;
  document.getElementById('metric-mem-bar').style.width = `${metrics.memory.usagePercentage}%`;
  document.getElementById('metric-mem-details').textContent = `${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`;
  
  // Disk & Uptime
  document.getElementById('metric-disk-usage').textContent = `${metrics.disk.usagePercentage}%`;
  document.getElementById('metric-uptime').textContent = formatUptime(server.uptime);

  // Summaries
  document.getElementById('info-hostname').textContent = server.hostname;
  document.getElementById('info-ip').textContent = server.serverIp;
  document.getElementById('info-os').textContent = server.platform;
  document.getElementById('info-node').textContent = server.nodeVersion;
  document.getElementById('info-panel-domain').textContent = cluster.managerDomain;
  document.getElementById('info-load').textContent = metrics.loadAverage.map(l => l.toFixed(2)).join(', ');

  document.getElementById('summary-tenants').textContent = cluster.tenants;
  document.getElementById('summary-projects').textContent = cluster.projects;
  document.getElementById('summary-users').textContent = cluster.users;
  document.getElementById('summary-core-domain').textContent = `*.${cluster.coreDomain}`;
}

// 2. Load Services
async function loadServices() {
  const container = document.getElementById('services-grid');
  if (!container) return;

  try {
    const res = await API.get('/system/services');
    if (res.success && res.data) {
      State.services = res.data;
      container.innerHTML = State.services.map(s => `
        <div class="service-card">
          <div class="service-info">
            <div class="service-icon">${s.type === 'security' ? '🛡️' : (s.id === 'traefik' ? '🔀' : (s.id === 'mariadb' ? '🐬' : (s.id === 'redis' ? '⚡' : '🚀')))}</div>
            <div>
              <div class="service-name">${s.name}</div>
              <div class="service-desc">${s.description}</div>
              <div style="font-size: 0.72rem; color: var(--primary); margin-top: 0.2rem;" class="mono">Port: ${s.port}</div>
            </div>
          </div>
          <span class="badge badge-success"><span class="pulse-dot"></span> Active</span>
        </div>
      `).join('');
    }
  } catch (err) {
    container.innerHTML = '<div style="color: var(--danger);">Failed to load services.</div>';
  }
}

// 3. Load System Logs
async function loadLogs() {
  const viewer = document.getElementById('log-viewer-box');
  const service = document.getElementById('logs-service-select').value;
  viewer.textContent = `Streaming logs for ${service}...`;

  try {
    const res = await API.get(`/system/logs?service=${service}&lines=50`);
    if (res.success && res.data) {
      viewer.innerHTML = res.data.map(l => `<div>${l}</div>`).join('');
      viewer.scrollTop = viewer.scrollHeight;
    }
  } catch (err) {
    viewer.textContent = 'Failed to fetch logs.';
  }
}

function setupLogsViewer() {
  document.getElementById('fetch-logs-btn').addEventListener('click', loadLogs);
  document.getElementById('logs-service-select').addEventListener('change', loadLogs);
}

// 4. Load Tenants Data
async function loadTenants() {
  const tbody = document.getElementById('tenants-tbody');
  if (!tbody) return;
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

// 5. Load Projects Data
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
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem; color: var(--text-dim);">No active project deployments yet. Click "+ Deploy New Project" to launch an app.</td></tr>';
    return;
  }

  tbody.innerHTML = State.projects.map(p => {
    const isGit = p.git_repo_url && p.git_repo_url.startsWith('http');
    const domain = isGit ? (p.domain || p.name) : p.git_repo_url;
    const projectUrl = domain && !domain.startsWith('http') ? `https://${domain}` : domain;
    const isStopped = p.status === 'stopped';

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #fff;">${p.name}</div>
          ${domain ? `<a href="${projectUrl}" target="_blank" style="font-size: 0.78rem; color: var(--primary); text-decoration: none;">${domain} ↗</a>` : ''}
        </td>
        <td>
          <span class="mono" style="font-size: 0.78rem; color: #94a3b8;">${isGit ? p.git_repo_url : 'Local Directory'}</span>
        </td>
        <td><span class="badge badge-primary">${(p.project_type || 'EXPRESS').toUpperCase()}</span></td>
        <td>
          <span class="badge ${isStopped ? 'badge-warning' : 'badge-success'}">
            <span class="pulse-dot"></span> ${p.status || 'deployed'}
          </span>
        </td>
        <td style="font-size: 0.8rem; color: var(--text-dim);">${new Date(p.created_at).toLocaleDateString()}</td>
        <td style="text-align: right; white-space: nowrap;">
          <div style="display: inline-flex; gap: 0.4rem; align-items: center; justify-content: flex-end;">
            ${isStopped ? `
              <button class="btn btn-sm" style="background: #10b981; color: #fff; padding: 0.3rem 0.65rem; font-size: 0.75rem;" onclick="startProject(${p.id}, '${p.name}')">
                ▲ Start
              </button>
            ` : `
              <button class="btn btn-secondary btn-sm" style="padding: 0.3rem 0.65rem; font-size: 0.75rem;" onclick="stopProject(${p.id}, '${p.name}')">
                ▼ Stop
              </button>
            `}
            <button class="btn btn-secondary btn-sm" style="padding: 0.3rem 0.65rem; font-size: 0.75rem;" onclick="restartProject(${p.id}, '${p.name}')">
              ↺ Restart
            </button>
            <button class="btn btn-sm" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #fca5a5; font-weight: 600; padding: 0.3rem 0.65rem; font-size: 0.75rem;" onclick="deleteProject(${p.id}, '${p.name}')">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.startProject = async function(id, name) {
  try {
    const res = await API.post(`/projects/${id}/start`);
    if (res.success) {
      showToast(`Project "${name}" started (UP)!`);
      loadProjects();
      loadStats();
    } else {
      alert(`Error starting project: ${res.error || 'Failed'}`);
    }
  } catch (err) {
    alert('Server error while starting project.');
  }
};

window.stopProject = async function(id, name) {
  try {
    const res = await API.post(`/projects/${id}/stop`);
    if (res.success) {
      showToast(`Project "${name}" stopped (DOWN)!`);
      loadProjects();
      loadStats();
    } else {
      alert(`Error stopping project: ${res.error || 'Failed'}`);
    }
  } catch (err) {
    alert('Server error while stopping project.');
  }
};

window.restartProject = async function(id, name) {
  try {
    const res = await API.post(`/projects/${id}/restart`);
    if (res.success) {
      showToast(`Project "${name}" restarted!`);
      loadProjects();
      loadStats();
    } else {
      alert(`Error restarting project: ${res.error || 'Failed'}`);
    }
  } catch (err) {
    alert('Server error while restarting project.');
  }
};

window.deleteProject = async function(id, name) {
  if (!confirm(`Are you sure you want to completely delete "${name}"?\n\nThis will stop and remove the container, remove the SSL route, and drop its database.`)) {
    return;
  }

  try {
    const res = await API.delete(`/projects/${id}?drop_db=true&delete_files=true`);
    if (res.success) {
      showToast(`Project "${name}" deleted completely!`);
      loadProjects();
      loadDatabases();
      loadStats();
    } else {
      alert(`Error deleting project: ${res.error || 'Failed'}`);
    }
  } catch (err) {
    alert('Server error while deleting project.');
  }
};

// 6. Load Databases & SQL Console
async function loadDatabases() {
  const tbody = document.getElementById('databases-tbody');
  const select = document.getElementById('sql-target-db');
  if (!tbody) return;

  try {
    const res = await API.get('/system/databases');
    if (res.success && res.data) {
      State.databases = res.data;
      tbody.innerHTML = State.databases.map(d => `
        <tr>
          <td style="font-weight: 600; color: #fff;" class="mono">${d.name}</td>
          <td><span class="badge ${d.type.includes('Master') ? 'badge-primary' : 'badge-accent'}">${d.type}</span></td>
          <td>${d.tableCount} tables</td>
          <td><span class="badge badge-success"><span class="pulse-dot"></span> Online</span></td>
        </tr>
      `).join('');

      select.innerHTML = State.databases.map(d => `
        <option value="${d.name}">${d.name} (${d.type})</option>
      `).join('');
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" style="color: var(--danger);">Failed to load databases.</td></tr>';
  }
}

function setupSqlConsole() {
  const execBtn = document.getElementById('execute-sql-btn');
  const queryInput = document.getElementById('sql-query-input');
  const targetDb = document.getElementById('sql-target-db');
  const resultsBox = document.getElementById('sql-results-container');

  if (!execBtn) return;

  execBtn.addEventListener('click', async () => {
    const query = queryInput.value.trim();
    if (!query) return;

    execBtn.disabled = true;
    execBtn.textContent = 'Executing...';
    resultsBox.style.display = 'block';
    resultsBox.innerHTML = '<div style="padding: 1rem; color: var(--text-dim);">Running query...</div>';

    try {
      const res = await API.post('/system/databases/query', {
        database: targetDb.value,
        query: query
      });

      if (res.success) {
        if (res.columns && res.columns.length > 0) {
          resultsBox.innerHTML = `
            <table>
              <thead>
                <tr>${res.columns.map(c => `<th>${c}</th>`).join('')}</tr>
              </thead>
              <tbody>
                ${res.rows.map(r => `
                  <tr>${res.columns.map(c => `<td class="mono">${r[c] !== null ? r[c] : 'NULL'}</td>`).join('')}</tr>
                `).join('')}
              </tbody>
            </table>
          `;
        } else {
          resultsBox.innerHTML = `<div style="padding: 1rem; color: var(--success);">Query executed successfully. Affected rows: ${res.rows[0].affectedRows}</div>`;
        }
      } else {
        resultsBox.innerHTML = `<div style="padding: 1rem; color: var(--danger);">SQL Error: ${res.error}</div>`;
      }
    } catch (err) {
      resultsBox.innerHTML = `<div style="padding: 1rem; color: var(--danger);">Failed to execute query.</div>`;
    } finally {
      execBtn.disabled = false;
      execBtn.textContent = 'Execute SQL';
    }
  });
}

// 7. Load Users
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  try {
    const res = await API.get('/system/users');
    if (res.success && res.data) {
      State.users = res.data;
      tbody.innerHTML = State.users.map(u => `
        <tr>
          <td style="font-weight: 600; color: #fff;">${u.username || u.email.split('@')[0]}</td>
          <td>${u.email}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-primary' : 'badge-accent'}">${u.role.toUpperCase()}</span></td>
          <td style="font-size: 0.8rem; color: var(--text-dim);">${new Date(u.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" style="color: var(--danger);">Failed to load users.</td></tr>';
  }
}

// 8. Load Backups
async function loadBackups() {
  const tbody = document.getElementById('backups-tbody');
  const targetLabel = document.getElementById('backup-storage-target');
  if (!tbody) return;

  try {
    const res = await API.get('/system/backups');
    if (res.success) {
      if (res.storageTarget) targetLabel.textContent = res.storageTarget;
      State.backups = res.data || [];
      if (State.backups.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 2rem; color: var(--text-dim);">No backup snapshots found in /app/backups.</td></tr>';
      } else {
        tbody.innerHTML = State.backups.map(b => `
          <tr>
            <td class="mono" style="color: #fff;">${b.filename}</td>
            <td>${formatBytes(b.sizeBytes)}</td>
            <td style="font-size: 0.8rem; color: var(--text-dim);">${new Date(b.createdAt).toLocaleString()}</td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" style="color: var(--danger);">Failed to load backups.</td></tr>';
  }
}

// Modal Handlers
function setupModals() {
  // 1. Tenant Modal
  const tenantModalBackdrop = document.getElementById('tenant-modal-backdrop');
  const openTenantBtn = document.getElementById('open-create-tenant-btn');
  const closeTenantBtn = document.getElementById('close-tenant-modal-btn');
  const cancelTenantBtn = document.getElementById('cancel-tenant-modal-btn');
  const tenantForm = document.getElementById('create-tenant-form');

  if (tenantModalBackdrop) {
    const openModal = () => tenantModalBackdrop.classList.add('open');
    const closeModal = () => {
      tenantModalBackdrop.classList.remove('open');
      tenantForm.reset();
    };

    openTenantBtn.addEventListener('click', openModal);
    closeTenantBtn.addEventListener('click', closeModal);
    cancelTenantBtn.addEventListener('click', closeModal);

    tenantForm.addEventListener('submit', async (e) => {
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
          loadDatabases();
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

  // 2. Project Deployment Wizard Modal
  const projectModalBackdrop = document.getElementById('project-modal-backdrop');
  const openProjectBtn = document.getElementById('open-deploy-project-btn');
  const closeProjectBtn = document.getElementById('close-project-modal-btn');
  const cancelProjectBtn = document.getElementById('cancel-project-modal-btn');
  const projectForm = document.getElementById('deploy-project-form');

  if (projectModalBackdrop && openProjectBtn) {
    const openModal = () => projectModalBackdrop.classList.add('open');
    const closeModal = () => {
      projectModalBackdrop.classList.remove('open');
      projectForm.reset();
    };

    openProjectBtn.addEventListener('click', openModal);
    closeProjectBtn.addEventListener('click', closeModal);
    cancelProjectBtn.addEventListener('click', closeModal);

    projectForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('submit-project-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Cloning & Deploying Container...';

      const name = document.getElementById('project-name-input').value.trim();
      const slug = document.getElementById('project-slug-input').value.trim();
      const domain = document.getElementById('project-domain-input').value.trim();
      const git_repo_url = document.getElementById('project-git-input').value.trim();
      const git_branch = document.getElementById('project-branch-input').value.trim() || 'main';
      const runtime_type = document.getElementById('project-runtime-select').value;
      const port = document.getElementById('project-port-input').value;
      const create_database = document.getElementById('project-db-checkbox').checked;
      const env_vars = document.getElementById('project-env-input').value.trim();

      try {
        const res = await API.post('/projects/deploy', {
          name,
          slug,
          domain,
          git_repo_url,
          git_branch,
          runtime_type,
          port,
          create_database,
          env_vars
        });

        if (res.success) {
          showToast(`Project "${name}" deployed successfully! Live at https://${domain}`);
          closeModal();
          loadProjects();
          loadDatabases();
          loadStats();
        } else {
          alert(`Deployment Error: ${res.error || 'Failed to deploy project'}`);
        }
      } catch (err) {
        alert('Server error during automated project deployment.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Deploy Project';
      }
    });
  }
}

// Start
document.addEventListener('DOMContentLoaded', initDashboard);
