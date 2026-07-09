/**
 * projects.js — Project list rendering and card click → detail drawer.
 */

import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError, isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

// ── Event system ──────────────────────────────────────────────────────────────

/** Dispatched when user clicks a project card. Detail module listens for this. */
function emitProjectSelected(project) {
  window.dispatchEvent(new CustomEvent('projectSelected', { detail: { project } }));
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

function statusBadge(status) {
  const map = {
    active:      'badge-active',
    inactive:    'badge-inactive',
    provisioned: 'badge-provisioned',
    error:       'badge-error',
    pending:     'badge-pending'
  };
  const cls = map[status] || 'badge-inactive';
  return `<span class="status-badge ${cls}">${escapeHtml(status)}</span>`;
}

function kindBadge(kind) {
  return `<span class="kind-badge">${escapeHtml(kind || 'static')}</span>`;
}

// ── Card render ───────────────────────────────────────────────────────────────

function renderProjectCard(project, isSelected) {
  const domain = project.domain ? `<span class="project-card-meta">${escapeHtml(project.domain)}</span>` : '';
  const ssl    = project.ssl_enabled ? '<span class="status-badge badge-ssl">SSL</span>' : '';

  return `
    <div class="project-list-card ${isSelected ? 'selected' : ''}"
         data-project-id="${project.id}" role="button" tabindex="0"
         aria-label="Open ${escapeHtml(project.name)}">
      <div class="project-card-top">
        <span class="project-card-name">${escapeHtml(project.name)}</span>
        ${statusBadge(project.status)}
      </div>
      ${domain}
      <div class="project-card-tags">
        ${kindBadge(project.config?.kind)}
        ${project.port ? `<span class="status-badge badge-inactive">:${project.port}</span>` : ''}
        ${ssl}
      </div>
      <span class="project-card-meta">${escapeHtml(project.path)}</span>
    </div>
  `;
}

// ── Member pills ──────────────────────────────────────────────────────────────

export function renderMemberPills(members = []) {
  if (!members.length) return '<span class="role-pill">No members</span>';
  return members.map((m) =>
    `<span class="role-pill">${escapeHtml(m.username)} — ${escapeHtml(m.project_role)}</span>`
  ).join('');
}

// ── Project options for member form ──────────────────────────────────────────

export function syncProjectOptions() {
  const select = document.querySelector('#memberForm select[name="projectId"]');
  if (!select) return;
  select.innerHTML = '<option value="">Select project</option>' +
    dashboardState.projects.map((p) =>
      `<option value="${p.id}">${escapeHtml(p.name)}</option>`
    ).join('');
}

// ── Load + render list ────────────────────────────────────────────────────────

export async function loadProjects() {
  const list = document.getElementById('projectsList');
  if (!list) return;

  try {
    const data = await api('/api/projects');
    dashboardState.projects = data.projects;

    const selectedId = dashboardState.selectedProject?.id;
    list.innerHTML = data.projects.length
      ? data.projects.map((p) => renderProjectCard(p, p.id === selectedId)).join('')
      : '<p class="message">No projects yet.</p>';

    // Update selectedProject object if it's currently open
    if (selectedId) {
      const refreshed = data.projects.find((p) => p.id === selectedId);
      if (refreshed) dashboardState.selectedProject = refreshed;
    }

    syncProjectOptions();
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, 'Loading projects');
    list.innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
  }
}

// ── Click delegation ──────────────────────────────────────────────────────────

export function bindProjectListClicks() {
  const list = document.getElementById('projectsList');
  if (!list) return;

  list.addEventListener('click', (event) => {
    const card = event.target.closest('[data-project-id]');
    if (!card) return;

    const projectId = Number(card.dataset.projectId);
    const project   = dashboardState.projects.find((p) => p.id === projectId);
    if (!project) return;

    // Mark selected
    list.querySelectorAll('.project-list-card').forEach((el) => el.classList.remove('selected'));
    card.classList.add('selected');

    dashboardState.selectedProject = project;
    emitProjectSelected(project);
  });

  // Keyboard support
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.target.closest('[data-project-id]')?.click();
    }
  });
}
