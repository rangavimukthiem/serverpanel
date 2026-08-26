/**
 * pages/dashboard.js — Main dashboard bootstrap.
 *
 * Wires together all modules: auth, tab routing, services, projects,
 * project detail drawer, forms, admin, and system status auto-refresh.
 */

import { api } from '../shared/api.js';
import { clearSession } from '../shared/auth.js';
import { dashboardState } from '../dashboard/state.js';
import { loadServices, runServiceAction, refreshServiceStatuses, saveEkafyServiceLimits, initSystemLogsView } from '../dashboard/services.js';
import { loadProjects, bindProjectListClicks } from '../dashboard/projects.js';
import { loadUsers } from '../dashboard/users.js';
import { bindAdminForms } from '../dashboard/forms.js';
import { setupProjectWizard } from '../dashboard/wizard.js';
import { initProjectDetail } from '../dashboard/projectDetail.js';
import { loadStatus, handleStatusError } from '../dashboard/status.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';
import { initThemeSelector } from '../shared/theme.js';
import { initBackups, loadBackups } from '../dashboard/backups.js';

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = ['dashboard', 'services', 'logs', 'projects', 'backups', 'access'];
const TITLE_MAP = {
  dashboard: ['Dashboard',  'Server overview'],
  services:  ['Services',   'Systemd service controls'],
  logs:      ['System Logs', 'Service journal viewer'],
  projects:  ['Projects',   'Deployment workspace'],
  backups:   ['Backups & Restore', 'Project recovery policies'],
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

  if (['access', 'backups'].includes(activeTab) && dashboardState.user?.role !== 'admin') {
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
  if (activeTab === 'logs')      initSystemLogsView();
  if (activeTab === 'projects')  loadProjects();
  if (activeTab === 'backups')   loadBackups();
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
    loadStatus().catch((e) => handleStatusError(e, 'Refreshing system status', { silent: true }));
  }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function bootDashboard() {
  initThemeSelector();

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

  const refreshLogsBtn = document.getElementById('refreshLogsButton');
  if (refreshLogsBtn) {
    refreshLogsBtn.addEventListener('click', () => initSystemLogsView());
  }

  // Dashboard update button
  const updateAppButton = document.getElementById('updateAppButton');
  if (updateAppButton) {
    updateAppButton.addEventListener('click', async () => {
      const confirmed = window.confirm('Update the server manager from GitHub? Configuration, databases, projects, uploads, and app data will be preserved.');
      if (!confirmed) return;

      updateAppButton.disabled = true;
      updateAppButton.textContent = 'Updating…';

      try {
        const data = await api('/api/system/update', { method: 'POST' });
        const content = data.output ? data.output.slice(0, 400) : '';
        showGlobalMessage(data.message || 'Dashboard updated', 'success', content || null);
      } catch (error) {
        reportGlobalError(error, 'Dashboard update');
      } finally {
        updateAppButton.disabled = false;
        updateAppButton.textContent = '↺ Update manager';
      }
    });
  }

  // Server manager restart button
  const restartManagerButton = document.getElementById('restartManagerButton');
  if (restartManagerButton) {
    restartManagerButton.addEventListener('click', async () => {
      const confirmed = window.confirm('Restart the EKAFY server manager? The dashboard may be unavailable for a few seconds.');
      if (!confirmed) return;

      restartManagerButton.disabled = true;
      restartManagerButton.textContent = 'Restarting…';
      try {
        const data = await api('/api/system/restart', { method: 'POST' });
        showGlobalMessage(data.message || 'Server manager restart scheduled', 'success');
        setTimeout(() => window.location.reload(), 4000);
      } catch (error) {
        reportGlobalError(error, 'Server manager restart');
        restartManagerButton.disabled = false;
        restartManagerButton.textContent = '↻ Restart manager';
      }
    });
  }

  // Services action delegation
  ['servicesGrid', 'ekafyServicesGrid'].forEach((gridId) => {
    const grid = document.getElementById(gridId);
    if (!grid) return;

    grid.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-service][data-action]');
      if (!btn) return;

      btn.disabled = true;
      try {
        await runServiceAction(btn.dataset.service, btn.dataset.action, {
          scope: btn.dataset.scope || 'global',
          projectId: btn.dataset.projectId
        });
      } finally {
        btn.disabled = false;
      }
    });

    grid.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-service-limit-form]');
      if (!form) return;
      e.preventDefault();

      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      try {
        await saveEkafyServiceLimits(form);
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  });

  // ── Init modules ────────────────────────────────────────────────────────────
  syncDashboardTabState();
  window.addEventListener('hashchange', syncDashboardTabState);
  if (!window.location.hash) window.location.hash = '#dashboard';
  startSystemStatusLoop();

  initDashboardModule('Project wizard', setupProjectWizard);
  initDashboardModule('Project list', bindProjectListClicks);
  initDashboardModule('Project detail', initProjectDetail);
  initDashboardModule('Admin forms', bindAdminForms);
  initDashboardModule('Backups', initBackups);

  // Initial data load
  await loadProjects();
  if (user.role === 'admin') loadUsers();

}

bootDashboard().catch((error) => {
  console.error('Dashboard boot failed', error);
  reportGlobalError(error, 'Dashboard');
});
