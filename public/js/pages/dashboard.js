import { api } from '../shared/api.js';
import { clearSession } from '../shared/auth.js';
import { dashboardState } from '../dashboard/state.js';
import { renderServices, runServiceAction, refreshServiceStatuses } from '../dashboard/services.js';
import { loadProjects } from '../dashboard/projects.js';
import { loadUsers } from '../dashboard/users.js';
import { bindAdminForms } from '../dashboard/forms.js';
import { setupProjectWizard } from '../dashboard/wizard.js';
import { loadStatus, handleStatusError } from '../dashboard/status.js';

const dashboardTabs = Array.from(document.querySelectorAll('[data-dashboard-tab]'));
const dashboardScreens = Array.from(document.querySelectorAll('[data-dashboard-screen]'));

function setAdminVisibility() {
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = dashboardState.user?.role !== 'admin';
  });
}

function normalizeDashboardTab(value) {
  return ['dashboard', 'services', 'projects', 'access'].includes(value) ? value : 'dashboard';
}

function syncDashboardTabState() {
  let activeTab = normalizeDashboardTab(window.location.hash.replace('#', '') || 'dashboard');

  if (activeTab === 'access' && dashboardState.user?.role !== 'admin') {
    window.location.hash = '#dashboard';
    activeTab = 'dashboard';
  }

  dashboardTabs.forEach((tab) => {
    const isActive = tab.dataset.dashboardTab === activeTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });

  dashboardScreens.forEach((screen) => {
    const isVisible = screen.dataset.dashboardScreen === activeTab;
    screen.hidden = !isVisible;
  });

  const topbarTitle = document.querySelector('.topbar h2');
  const topbarEyebrow = document.querySelector('.topbar .eyebrow');
  const titleMap = {
    dashboard: 'Dashboard',
    services: 'Services',
    projects: 'Projects',
    access: 'Users'
  };
  const eyebrowMap = {
    dashboard: 'Server overview',
    services: 'Service controls',
    projects: 'Deployment workspace',
    access: 'Account access'
  };

  if (topbarTitle) {
    topbarTitle.textContent = titleMap[activeTab];
  }

  if (topbarEyebrow) {
    topbarEyebrow.textContent = eyebrowMap[activeTab];
  }

  const accessTab = document.querySelector('[data-dashboard-tab="access"]');
  if (accessTab) {
    accessTab.hidden = dashboardState.user?.role !== 'admin';
  }
}

async function bootDashboard() {
  const dashboard = document.querySelector('.app-shell');
  if (!dashboard) return;

  let session;
  try {
    session = await api('/api/auth/me');
  } catch (_error) {
    window.location.href = '/login.html';
    return;
  }

  const user = session.user;
  dashboardState.user = user;

  const userRole = document.getElementById('userRole');
  if (userRole) {
    userRole.textContent = user ? `${user.username} - ${user.role}` : 'Control panel';
  }

  setAdminVisibility();

  const logoutButton = document.getElementById('logoutButton');
  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (_error) {
        // Clear the local state and redirect even if logout fails.
      }
      clearSession(dashboardState);
      window.location.href = '/login.html';
    });
  }

  const refreshButton = document.getElementById('refreshStatusButton');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refreshServiceStatuses();
    });
  }

  const servicesGrid = document.getElementById('servicesGrid');
  if (servicesGrid) {
    servicesGrid.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-service][data-action]');
      if (!button) return;
      runServiceAction(button.dataset.service, button.dataset.action);
    });
  }

  renderServices();
  bindAdminForms();
  setupProjectWizard();
  loadProjects();
  loadUsers();

  loadStatus().catch((error) => {
    handleStatusError(error, 'Loading system status');
  });

  setInterval(() => {
    loadStatus().catch((error) => {
      handleStatusError(error, 'Refreshing system status');
    });
  }, 5000);

  syncDashboardTabState();
  window.addEventListener('hashchange', syncDashboardTabState);

  if (!window.location.hash) {
    window.location.hash = '#dashboard';
  }
}

bootDashboard();
