import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError, isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

export function renderUserRow(user) {
  const projectsList = user.projects || [];
  const projects = projectsList.length
    ? projectsList.map((project) => `<span class="role-pill">${escapeHtml(project.name)} - ${escapeHtml(project.role)}</span>`).join('')
    : '<span class="role-pill">No projects</span>';
  const isCurrentUser = dashboardState.user && Number(dashboardState.user.id) === Number(user.id);
  const actionCell = isCurrentUser
    ? '<span class="role-pill">Current user</span>'
    : `<button type="button" class="danger-button" data-user-delete="${user.id}">Remove</button>`;

  return `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${escapeHtml(user.role)}</td>
      <td>${projects}</td>
      <td>${new Date(user.created_at).toLocaleString()}</td>
      <td>${actionCell}</td>
    </tr>
  `;
}

function getUserSearchTerm() {
  return document.getElementById('userSearch')?.value.trim().toLowerCase() || '';
}

function userMatchesSearch(user, term) {
  if (!term) return true;

  const projectText = (user.projects || [])
    .map((project) => `${project.name} ${project.role}`)
    .join(' ');
  const haystack = `${user.username} ${user.role} ${projectText}`.toLowerCase();

  return haystack.includes(term);
}

function renderUsersTable() {
  const table = document.getElementById('usersTable');
  if (!table) return;

  const term = getUserSearchTerm();
  const filteredUsers = dashboardState.users.filter((user) => userMatchesSearch(user, term));
  const emptyText = term ? 'No users match your search.' : 'No users yet.';

  table.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Global Role</th>
          <th>Project Access</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${filteredUsers.length
          ? filteredUsers.map(renderUserRow).join('')
          : `<tr><td colspan="5">${escapeHtml(emptyText)}</td></tr>`}
      </tbody>
    </table>
  `;
}

function bindUserSearch() {
  const input = document.getElementById('userSearch');
  if (!input || input.dataset.bound === 'true') return;

  input.dataset.bound = 'true';
  input.addEventListener('input', renderUsersTable);
}

export function syncUserOptions() {
  const select = document.querySelector('#memberForm select[name="userId"]');
  if (!select) return;

  select.innerHTML = '<option value="">User</option>' + dashboardState.users.map((user) => (
    `<option value="${user.id}">${escapeHtml(user.username)} (${escapeHtml(user.role)})</option>`
  )).join('');
}

export async function loadUsers() {
  const table = document.getElementById('usersTable');
  if (!table || !isAdmin(dashboardState.user)) return;

  try {
    const data = await api('/api/users');
    dashboardState.users = data.users;
    bindUserSearch();
    renderUsersTable();
    syncUserOptions();
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportGlobalError(error, 'Loading users');
    table.innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
  }
}
