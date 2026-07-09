import { api } from '../shared/api.js';
import { clearSession } from '../shared/auth.js';
import { dashboardState } from '../dashboard/state.js';
import { renderServices, runServiceAction, refreshServiceStatuses } from '../dashboard/services.js';
import { loadProjects } from '../dashboard/projects.js';
import { loadUsers } from '../dashboard/users.js';
import { bindAdminForms } from '../dashboard/forms.js';
import { setupProjectWizard } from '../dashboard/wizard.js';
import { loadStatus, handleStatusError } from '../dashboard/status.js';

function setAdminVisibility() {
  document.querySelectorAll('.admin-only').forEach((node) => {
    node.hidden = dashboardState.user?.role !== 'admin';
  });
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
}

bootDashboard();
