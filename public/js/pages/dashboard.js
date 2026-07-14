/**
 * pages/dashboard.js — Main dashboard bootstrap.
 *
 * Wires together all modules: auth, tab routing, services, projects,
 * project detail drawer, forms, admin, and system status auto-refresh.
 */

import { api } from '../shared/api.js';
import { clearSession } from '../shared/auth.js';
import { dashboardState } from '../dashboard/state.js';
import { loadServices, runServiceAction, refreshServiceStatuses } from '../dashboard/services.js';
import { loadProjects, bindProjectListClicks } from '../dashboard/projects.js';
import { loadUsers } from '../dashboard/users.js';
import { bindAdminForms } from '../dashboard/forms.js';
import { setupProjectWizard } from '../dashboard/wizard.js';
import { initProjectDetail } from '../dashboard/projectDetail.js';
import { loadStatus, handleStatusError } from '../dashboard/status.js';
import { reportGlobalError } from '../shared/errors.js';

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = ['dashboard', 'services', 'projects', 'access'];
const TITLE_MAP = {
  dashboard: ['Dashboard',  'Server overview'],
  services:  ['Services',   'Systemd service controls'],
  projects:  ['Projects',   'Deployment workspace'],
  access:    ['Users',      'Account access']
};

// ── Admin visibility ──────────────────────────────────────────────────────────

function setAdminVisibility() {
  const isAdmin = dashboardState.user?.role === 'admin';
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = !isAdmin;
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function normalizeDashboardTab(value) {
  return TABS.includes(value) ? value : 'dashboard';
}

function syncDashboardTabState() {
  let activeTab = normalizeDashboardTab(window.location.hash.replace('#', '') || 'dashboard');

  if (activeTab === 'access' && dashboardState.user?.role !== 'admin') {
    window.location.hash = '#dashboard';
    activeTab = 'dashboard';
  }

  document.querySelectorAll('[data-dashboard-tab]').forEach((tab) => {
    const isActive = tab.dataset.dashboardTab === activeTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  document.querySelectorAll('[data-dashboard-screen]').forEach((screen) => {
    screen.hidden = screen.dataset.dashboardScreen !== activeTab;
  });

  const [title, eyebrow] = TITLE_MAP[activeTab] || ['Dashboard', ''];
  const titleEl   = document.getElementById('topbarTitle');
  const eyebrowEl = document.getElementById('topbarEyebrow');
  if (titleEl)   titleEl.textContent   = title;
  if (eyebrowEl) eyebrowEl.textContent = eyebrow;

  // Load content when switching to these tabs
  if (activeTab === 'services')  loadServices();
  if (activeTab === 'projects')  loadProjects();
  if (activeTab === 'access')    { loadUsers(); }
}

function initDashboardModule(label, initFn) {
  try {
    initFn();
  } catch (error) {
    console.error(`${label} init failed`, error);
    reportGlobalError(error, label);
  }
}

function startSystemStatusLoop() {
  loadStatus().catch((e) => handleStatusError(e, 'Loading system status'));
  setInterval(() => {
    loadStatus().catch((e) => handleStatusError(e, 'Refreshing system status'));
  }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function bootDashboard() {
  let session;
  try {
    session = await api('/api/auth/me');
  } catch (_) {
    window.location.href = '/login.html';
    return;
  }

  const user = session.user;
  dashboardState.user = user;

  const userRoleEl = document.getElementById('userRole');
  if (userRoleEl) userRoleEl.textContent = `${user.username} · ${user.role}`;

  setAdminVisibility();

  // Logout
  const logoutBtn = document.getElementById('logoutButton');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      clearSession(dashboardState);
      window.location.href = '/login.html';
    });
  }

  // Services refresh button
  const refreshBtn = document.getElementById('refreshStatusButton');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => { loadServices(); refreshServiceStatuses(); });
  }

  // Services action delegation
  const servicesGrid = document.getElementById('servicesGrid');
  if (servicesGrid) {
    servicesGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-service][data-action]');
      if (btn) runServiceAction(btn.dataset.service, btn.dataset.action);
    });
  }

  // ── Init modules ────────────────────────────────────────────────────────────
  syncDashboardTabState();
  window.addEventListener('hashchange', syncDashboardTabState);
  if (!window.location.hash) window.location.hash = '#dashboard';
  startSystemStatusLoop();

  initDashboardModule('Project wizard', setupProjectWizard);
  initDashboardModule('Project list', bindProjectListClicks);
  initDashboardModule('Project detail', initProjectDetail);
  initDashboardModule('Admin forms', bindAdminForms);

  // Initial data load
  await loadProjects();
  if (user.role === 'admin') loadUsers();

}

bootDashboard().catch((error) => {
  console.error('Dashboard boot failed', error);
  reportGlobalError(error, 'Dashboard');
});
