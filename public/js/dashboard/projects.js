import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError } from '../shared/auth.js';
import { dashboardState } from './state.js';

export function renderMemberPills(members = []) {
  if (!members.length) {
    return '<span class="role-pill">No members</span>';
  }

  return members.map((member) => `
    <span class="role-pill">${escapeHtml(member.username)} - ${escapeHtml(member.project_role)}</span>
  `).join('');
}

export function renderProjectConfigSummary(config = {}) {
  const parts = [];
  const database = config.database || {};
  const apiConfig = config.api || {};

  parts.push(`<span class="role-pill">Type: ${escapeHtml(config.kind || 'static')}</span>`);

  if (database.enabled) {
    parts.push(`<span class="role-pill">DB: ${escapeHtml(database.provider || 'mariadb')} @ ${escapeHtml(database.host || '127.0.0.1')}:${escapeHtml(database.port || 3306)}</span>`);
    if (database.databaseName) {
      parts.push(`<span class="role-pill">Schema: ${escapeHtml(database.databaseName)}</span>`);
    }
  }

  if (apiConfig.enabled) {
    parts.push(`<span class="role-pill">API base: ${escapeHtml(apiConfig.baseUrl || 'unset')}</span>`);
    (apiConfig.endpoints || []).slice(0, 4).forEach((endpoint) => {
      parts.push(`<span class="role-pill">${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</span>`);
    });
  }

  if (Array.isArray(config.queryPresets) && config.queryPresets.length) {
    config.queryPresets.forEach((preset) => {
      parts.push(`<span class="role-pill">${escapeHtml(preset)}</span>`);
    });
  }

  if (config.notes) {
    parts.push('<span class="role-pill">Notes saved</span>');
  }

  return parts.join('');
}

export function syncProjectOptions() {
  const select = document.querySelector('#memberForm select[name="projectId"]');
  if (!select) return;

  select.innerHTML = '<option value="">Project</option>' + dashboardState.projects.map((project) => (
    `<option value="${project.id}">${escapeHtml(project.name)}</option>`
  )).join('');
}

export async function loadProjects() {
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
    reportGlobalError(error, 'Loading projects');
    grid.innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
  }
}
