/**
 * projectDetail.js — Orchestrates the project detail drawer.
 *
 * Listens for 'projectSelected' events from projects.js, shows the drawer,
 * and lazy-loads each tab panel when first opened.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { isAdmin } from '../shared/auth.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';
import { confirmDialog } from '../shared/dialog.js';
import { dashboardState } from './state.js';
import { loadProjects, renderMemberPills } from './projects.js';
import { loadSetupTab } from './projectSetup.js';
import { loadDatabaseTab } from './projectDatabase.js';
import { loadGitTab } from './projectGit.js';
import { loadEndpointsTab } from './projectEndpoints.js';
import { loadServicesTab } from './projectServices.js';
import { projectRuntimeMap } from './constants.js';

// Track which tabs have been loaded for the current project
const loadedTabs = new Set();
let currentTab = 'overview';

// ── Tab switching ─────────────────────────────────────────────────────────────

function showPanel(tabName) {
  document.querySelectorAll('.detail-panel').forEach((p) => { p.hidden = true; });
  document.querySelectorAll('.detail-tab').forEach((t) => t.classList.remove('active'));

  const panel = document.getElementById(`detail${capitalize(tabName)}`);
  const tab   = document.querySelector(`[data-detail-tab="${tabName}"]`);

  if (panel) panel.hidden = false;
  if (tab)   tab.classList.add('active');

  currentTab = tabName;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function switchTab(tabName, project) {
  showPanel(tabName);

  // Lazy-load on first open
  if (!loadedTabs.has(tabName)) {
    loadedTabs.add(tabName);
    switch (tabName) {
      case 'overview':  renderOverview(project); break;
      case 'setup':     loadSetupTab(project);    break;
      case 'database':  await loadDatabaseTab(project); break;
      case 'endpoints': await loadEndpointsTab(project); break;
      case 'git':       loadGitTab(project);      break;
      case 'services':  await loadServicesTab(project); break;
    }
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────

function renderOverview(project) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  };

  set('ovStatus', project.status);
  set('ovDomain', project.domain);
  set('ovPort',   project.port ? `:${project.port}` : null);
  set('ovKind',   project.config?.kind || 'static');
  set('ovRuntime', projectRuntimeMap[project.config?.runtime]?.label || 'Static HTML/CSS/JS');
  set('ovBranch', project.git_branch || 'main');

  const ovPath = document.getElementById('ovPath');
  if (ovPath) ovPath.textContent = project.path;

  const ovMembers = document.getElementById('ovMembers');
  if (ovMembers) ovMembers.innerHTML = renderMemberPills(project.members);

  bindProjectManagement(project);

  // Show/hide env section based on admin
  const envSection = document.getElementById('envSection');
  if (envSection) envSection.hidden = !isAdmin(dashboardState.user);

  if (isAdmin(dashboardState.user)) {
    loadEnvKeys(project);
    bindEnvForm(project);
  }
}

function bindProjectManagement(project) {
  const section = document.getElementById('projectManagementSection');
  if (section) section.hidden = !isAdmin(dashboardState.user);
  if (!section || !isAdmin(dashboardState.user)) return;

  const statusMeta = document.getElementById('projectManagementStatus');
  const message = document.getElementById('projectManagementMessage');
  const disableBtn = document.getElementById('disableProjectStatus') || document.getElementById('toggleProjectStatus');
  const enableBtn = document.getElementById('enableProjectStatus');
  const deleteBtn = document.getElementById('deleteProject');
  const isInactive = project.status === 'inactive';

  if (statusMeta) statusMeta.textContent = `Current status: ${project.status}`;
  if (message) message.textContent = '';

  bindProjectStatusButton({
    button: disableBtn,
    project,
    nextStatus: 'inactive',
    disabled: isInactive,
    message,
    confirmOptions: {
      eyebrow: 'Project management',
      title: 'Disable project?',
      message: `Disable project "${project.name}"? The project will remain on disk, but it will be marked inactive in EKAFY.`,
      confirmLabel: 'Disable Project',
      variant: 'warning'
    }
  });

  bindProjectStatusButton({
    button: enableBtn,
    project,
    nextStatus: 'active',
    disabled: !isInactive,
    message,
    confirmOptions: {
      eyebrow: 'Project management',
      title: 'Enable project?',
      message: `Enable project "${project.name}" and mark it active again in EKAFY?`,
      confirmLabel: 'Enable Project',
      variant: 'success'
    }
  });

  if (deleteBtn) {
    const fresh = deleteBtn.cloneNode(true);
    deleteBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        eyebrow: 'Destructive action',
        title: 'Remove project?',
        message: `Remove project "${project.name}"? This wipes the project record, nginx config, linked systemd services, database/user, API endpoint registry, Git repo, and project files.`,
        confirmLabel: 'Remove Project',
        variant: 'danger'
      });
      if (!confirmed) return;

      fresh.disabled = true;
      if (message) message.textContent = 'Removing project...';

      try {
        const data = await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        closeDrawer();
        await loadProjects();

        const warnings = Array.isArray(data.warnings) && data.warnings.length
          ? `Warnings: ${data.warnings.join(' | ')}`
          : null;
        showGlobalMessage(`Project "${project.name}" removed.`, 'success', warnings);
      } catch (error) {
        if (message) message.textContent = error.message;
        reportGlobalError(error, 'Removing project');
      } finally {
        fresh.disabled = false;
      }
    });
  }
}

function bindProjectStatusButton({ button, project, nextStatus, disabled, message, confirmOptions }) {
  if (!button) return;

  const fresh = button.cloneNode(true);
  button.replaceWith(fresh);
  fresh.disabled = disabled;
  fresh.setAttribute('aria-disabled', String(disabled));

  fresh.addEventListener('click', async () => {
    const confirmed = await confirmDialog(confirmOptions);
    if (!confirmed) return;

    fresh.disabled = true;
    if (message) {
      message.textContent = nextStatus === 'inactive' ? 'Disabling project...' : 'Enabling project...';
    }

    try {
      const data = await api(`/api/projects/${project.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus })
      });

      dashboardState.selectedProject = data.project;
      await loadProjects();
      renderOverview(data.project);
      showGlobalMessage(`Project "${data.project.name}" ${nextStatus === 'inactive' ? 'disabled' : 'enabled'}.`, 'success');
    } catch (error) {
      if (message) message.textContent = error.message;
      reportGlobalError(error, 'Changing project status');
    } finally {
      fresh.disabled = false;
    }
  });
}

async function loadEnvKeys(project) {
  const container = document.getElementById('envKeysList');
  if (!container) return;
  try {
    const data = await api(`/api/projects/${project.id}/env`);
    if (!data.envKeys.length) {
      container.innerHTML = '<p class="message" style="font-size:12px">No variables set yet.</p>';
      return;
    }
    container.innerHTML = data.envKeys.map((kv) => `
      <div class="env-key-row">
        <div>
          <span class="env-key-name">${escapeHtml(kv.env_key)}</span>
          <span class="env-key-meta"> — updated ${new Date(kv.updated_at).toLocaleString()}</span>
        </div>
        <button type="button" class="danger-button" data-delete-env="${escapeHtml(kv.env_key)}">Remove</button>
      </div>
    `).join('');

    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-delete-env]');
      if (!btn) return;
      const key = btn.dataset.deleteEnv;
      const confirmed = await confirmDialog({
        eyebrow: 'Environment variable',
        title: 'Remove variable?',
        message: `Remove env variable "${key}"?`,
        confirmLabel: 'Remove',
        variant: 'danger'
      });
      if (!confirmed) return;
      try {
        await api(`/api/projects/${project.id}/env/${encodeURIComponent(key)}`, { method: 'DELETE' });
        await loadEnvKeys(project);
      } catch (err) {
        reportGlobalError(err, 'Remove env');
      }
    }, { once: true });
  } catch (err) {
    container.innerHTML = `<p class="message">${escapeHtml(err.message)}</p>`;
  }
}

function bindEnvForm(project) {
  const toggleBtn = document.getElementById('toggleEnvForm');
  const envForm   = document.getElementById('envForm');
  const cancelBtn = document.getElementById('cancelEnvForm');

  if (toggleBtn) {
    const f = toggleBtn.cloneNode(true);
    toggleBtn.replaceWith(f);
    f.addEventListener('click', () => { if (envForm) envForm.hidden = !envForm.hidden; });
  }

  if (cancelBtn) {
    const f = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(f);
    f.addEventListener('click', () => { if (envForm) envForm.hidden = true; });
  }

  if (envForm) {
    const f = envForm.cloneNode(true);
    envForm.replaceWith(f);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key   = document.getElementById('envKey')?.value.trim();
      const value = document.getElementById('envValue')?.value;
      if (!key) return;
      try {
        await api(`/api/projects/${project.id}/env`, {
          method: 'PUT',
          body: JSON.stringify({ key, value })
        });
        f.hidden = true;
        document.getElementById('envKey').value   = '';
        document.getElementById('envValue').value = '';
        await loadEnvKeys(project);
      } catch (err) {
        reportGlobalError(err, 'Set env');
      }
    });
  }
}

// ── Drawer open / close ───────────────────────────────────────────────────────

function openDrawer(project) {
  const drawer = document.getElementById('projectDetail');
  if (!drawer) return;

  // Reset tab state for the new project
  loadedTabs.clear();

  // Clear DB provisioning inputs so auto-fill works cleanly for each project
  const dbNameEl = document.getElementById('dbName');
  const dbUserEl = document.getElementById('dbUser');
  if (dbNameEl) dbNameEl.value = '';
  if (dbUserEl) dbUserEl.value = '';

  // Update header
  const nameEl = document.getElementById('detailProjectName');
  const slugEl = document.getElementById('detailProjectSlug');
  if (nameEl) nameEl.textContent = project.name;
  if (slugEl) slugEl.textContent = project.slug;

  drawer.hidden = false;
  showPanel('overview');
  renderOverview(project);
  loadedTabs.add('overview');
}

function closeDrawer() {
  const drawer = document.getElementById('projectDetail');
  if (drawer) drawer.hidden = true;
  dashboardState.selectedProject = null;
  loadedTabs.clear();
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initProjectDetail() {
  // Listen for project selection events
  window.addEventListener('projectSelected', (e) => {
    const project = e.detail.project;
    dashboardState.selectedProject = project;
    openDrawer(project);
  });

  // Listen for refresh-needed events from sub-tabs
  window.addEventListener('projectRefreshNeeded', async () => {
    if (!dashboardState.selectedProject) return;
    try {
      const data = await api('/api/projects');
      dashboardState.projects = data.projects;
      const refreshed = data.projects.find((p) => p.id === dashboardState.selectedProject.id);
      if (refreshed) {
        dashboardState.selectedProject = refreshed;
        // Re-render only the overview panel if it's visible
        if (currentTab === 'overview') renderOverview(refreshed);
      }
    } catch (_) {}
  });

  // Close button
  const closeBtn = document.getElementById('closeDetail');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  // Tab buttons
  document.querySelectorAll('.detail-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.detailTab;
      const project = dashboardState.selectedProject;
      if (project) switchTab(tabName, project);
    });
  });
}
