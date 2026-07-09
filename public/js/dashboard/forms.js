/**
 * forms.js — Admin form bindings: user creation, project creation (via modal),
 * and project member assignment.
 */

import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { redirectOnAuthError } from '../shared/auth.js';
import { loadProjects } from './projects.js';
import { loadUsers } from './users.js';
import { resetProjectWizard, readProjectWizardConfig } from './wizard.js';

// ── Project modal ─────────────────────────────────────────────────────────────

export function openNewProjectModal() {
  const modal = document.getElementById('newProjectModal');
  if (modal) modal.hidden = false;
}

export function closeNewProjectModal() {
  const modal = document.getElementById('newProjectModal');
  if (modal) modal.hidden = true;
}

// ── Main form binder ──────────────────────────────────────────────────────────

export function bindAdminForms() {
  bindUserForm();
  bindProjectForm();
  bindMemberForm();
  bindProjectModalTriggers();
}

function bindProjectModalTriggers() {
  const newBtn    = document.getElementById('newProjectButton');
  const closeBtn  = document.getElementById('closeModal');
  const cancelBtn = document.getElementById('cancelCreateProject');

  if (newBtn)    newBtn.addEventListener('click', openNewProjectModal);
  if (closeBtn)  closeBtn.addEventListener('click', closeNewProjectModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeNewProjectModal);

  // Close modal on overlay click
  const modal = document.getElementById('newProjectModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeNewProjectModal();
    });
  }
}

function bindUserForm() {
  const form    = document.getElementById('userForm');
  const message = document.getElementById('accessMessage');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (message) message.textContent = 'Creating user…';
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          role:     form.role.value
        })
      });
      form.reset();
      if (message) message.textContent = 'User created.';
      await loadUsers();
    } catch (error) {
      if (redirectOnAuthError(error)) return;
      reportGlobalError(error, 'Creating user');
      if (message) message.textContent = error.message;
    }
  });
}

function bindProjectForm() {
  const form = document.getElementById('projectForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const config = readProjectWizardConfig();
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name:       form.name.value.trim(),
          slug:       form.slug.value.trim(),
          path:       form.path.value.trim(),
          domain:     form.domain?.value.trim() || undefined,
          port:       form.port?.value ? Number(form.port.value) : undefined,
          gitRepoUrl: form.gitRepoUrl?.value.trim() || undefined,
          gitBranch:  form.gitBranch?.value.trim()  || 'main',
          config
        })
      });
      resetProjectWizard();
      closeNewProjectModal();
      await loadProjects();
    } catch (error) {
      if (redirectOnAuthError(error)) return;
      reportGlobalError(error, 'Creating project');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function bindMemberForm() {
  const form    = document.getElementById('memberForm');
  const message = document.getElementById('accessMessage');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (message) message.textContent = 'Saving…';
    try {
      await api(`/api/projects/${form.projectId.value}/members`, {
        method: 'PUT',
        body: JSON.stringify({
          userId: Number(form.userId.value),
          role:   form.role.value
        })
      });
      form.reset();
      if (message) message.textContent = 'Member saved.';
      await Promise.all([loadProjects(), loadUsers()]);
    } catch (error) {
      if (redirectOnAuthError(error)) return;
      reportGlobalError(error, 'Saving member');
      if (message) message.textContent = error.message;
    }
  });

  // Delete user
  const usersTable = document.getElementById('usersTable');
  if (usersTable) {
    usersTable.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-user-delete]');
      if (!btn) return;
      if (!window.confirm('Delete this user? This removes their account and all project access.')) return;
      if (message) message.textContent = 'Removing…';
      try {
        await api(`/api/users/${btn.dataset.userDelete}`, { method: 'DELETE' });
        if (message) message.textContent = 'User removed.';
        await loadUsers();
      } catch (error) {
        if (redirectOnAuthError(error)) return;
        reportGlobalError(error, 'Removing user');
        if (message) message.textContent = error.message;
      }
    });
  }
}
