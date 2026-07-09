/**
 * projectEndpoints.js — API Endpoints CRUD tab.
 * Endpoints are stored in project config_json.api.endpoints[] and are
 * fully editable (add / inline-edit / delete) at any time.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError } from '../shared/errors.js';
import { isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function methodBadge(method) {
  return `<span class="method-badge method-${escapeHtml(method)}">${escapeHtml(method)}</span>`;
}

function methodOptions(selected) {
  return METHODS.map((m) =>
    `<option value="${m}" ${m === selected ? 'selected' : ''}>${m}</option>`
  ).join('');
}

// ── Render endpoint table ─────────────────────────────────────────────────────

function renderEndpointsTable(endpoints, projectId, canManage) {
  if (!endpoints.length) {
    return '<div class="endpoints-table-wrap"><p class="message" style="padding:16px">No endpoints yet. Click "+ Add" to register your first endpoint.</p></div>';
  }

  const rows = endpoints.map((ep, idx) => `
    <div class="endpoint-table-row" data-ep-idx="${idx}">
      <span class="ep-name">${escapeHtml(ep.name)}</span>
      <span>${methodBadge(ep.method)}</span>
      <span class="ep-path" style="font-family:var(--font-mono);font-size:12px">${escapeHtml(ep.path)}</span>
      <span class="ep-desc" style="color:var(--muted);font-size:12px">${escapeHtml(ep.description || '—')}</span>
      <span class="endpoint-row-actions">
        ${canManage
          ? `<button type="button" class="ghost-button" data-edit-ep="${idx}" title="Edit">✏</button>
             <button type="button" class="danger-button" data-delete-ep="${idx}" title="Delete">✕</button>`
          : ''}
      </span>
    </div>
  `).join('');

  return `
    <div class="endpoints-table-wrap">
      <div class="endpoint-table-header">
        <span>Name</span><span>Method</span><span>Path</span><span>Description</span><span></span>
      </div>
      ${rows}
    </div>
  `;
}

function renderEditRow(ep, idx) {
  return `
    <div class="endpoint-table-row endpoint-row-edit" data-ep-idx="${idx}" style="background:var(--panel-soft)">
      <input class="ep-edit-name"   type="text"   value="${escapeHtml(ep.name)}"        placeholder="Name" style="min-height:32px">
      <select class="ep-edit-method" style="min-height:32px">${methodOptions(ep.method)}</select>
      <input class="ep-edit-path"   type="text"   value="${escapeHtml(ep.path)}"        placeholder="/path" style="font-family:var(--font-mono);font-size:12px;min-height:32px">
      <input class="ep-edit-desc"   type="text"   value="${escapeHtml(ep.description || '')}" placeholder="Description" style="min-height:32px">
      <span class="endpoint-row-actions">
        <button type="button" data-save-ep="${idx}">Save</button>
        <button type="button" class="ghost-button" data-cancel-ep="${idx}">✕</button>
      </span>
    </div>
  `;
}

// ── Load tab ──────────────────────────────────────────────────────────────────

export async function loadEndpointsTab(project) {
  const canManage = isAdmin(dashboardState.user) ||
    project.current_user_role === 'manager';

  await refreshEndpoints(project, canManage);
  bindAddEndpoint(project, canManage);
}

async function refreshEndpoints(project, canManage) {
  const container = document.getElementById('endpointsList');
  if (!container) return;
  container.innerHTML = '<p class="message">Loading…</p>';

  try {
    const data = await api(`/api/projects/${project.id}/endpoints`);
    container.innerHTML = renderEndpointsTable(data.endpoints, project.id, canManage);
    bindEndpointTableEvents(project, data.endpoints, canManage);
  } catch (err) {
    container.innerHTML = `<p class="message">${escapeHtml(err.message)}</p>`;
    reportGlobalError(err, 'Loading endpoints');
  }
}

function bindEndpointTableEvents(project, endpoints, canManage) {
  if (!canManage) return;
  const container = document.getElementById('endpointsList');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    // Edit
    const editBtn = e.target.closest('[data-edit-ep]');
    if (editBtn) {
      const idx = Number(editBtn.dataset.editEp);
      const row = container.querySelector(`[data-ep-idx="${idx}"]`);
      if (row) row.outerHTML = renderEditRow(endpoints[idx] || {}, idx);
      return;
    }

    // Cancel edit
    const cancelBtn = e.target.closest('[data-cancel-ep]');
    if (cancelBtn) {
      await refreshEndpoints(project, canManage);
      return;
    }

    // Save edit
    const saveBtn = e.target.closest('[data-save-ep]');
    if (saveBtn) {
      const idx = Number(saveBtn.dataset.saveEp);
      const row = container.querySelector(`[data-ep-idx="${idx}"]`);
      if (!row) return;
      const body = {
        name:        row.querySelector('.ep-edit-name')?.value.trim(),
        method:      row.querySelector('.ep-edit-method')?.value,
        path:        row.querySelector('.ep-edit-path')?.value.trim(),
        description: row.querySelector('.ep-edit-desc')?.value.trim()
      };
      try {
        await api(`/api/projects/${project.id}/endpoints/${idx}`, {
          method: 'PUT', body: JSON.stringify(body)
        });
        await refreshEndpoints(project, canManage);
      } catch (err) {
        reportGlobalError(err, 'Update endpoint');
      }
      return;
    }

    // Delete
    const deleteBtn = e.target.closest('[data-delete-ep]');
    if (deleteBtn) {
      const idx = Number(deleteBtn.dataset.deleteEp);
      if (!window.confirm(`Remove endpoint "${endpoints[idx]?.name}"?`)) return;
      try {
        await api(`/api/projects/${project.id}/endpoints/${idx}`, { method: 'DELETE' });
        await refreshEndpoints(project, canManage);
      } catch (err) {
        reportGlobalError(err, 'Delete endpoint');
      }
    }
  }, { once: false });
}

function bindAddEndpoint(project, canManage) {
  if (!canManage) return;

  const addBtn    = document.getElementById('addEndpointBtn');
  const addForm   = document.getElementById('addEndpointForm');
  const saveBtn   = document.getElementById('saveNewEndpoint');
  const cancelBtn = document.getElementById('cancelNewEndpoint');

  if (addBtn) {
    const fresh = addBtn.cloneNode(true);
    addBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      if (addForm) addForm.hidden = !addForm.hidden;
    });
  }

  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      if (addForm) addForm.hidden = true;
    });
  }

  if (saveBtn) {
    const fresh = saveBtn.cloneNode(true);
    saveBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      const body = {
        name:        document.getElementById('newEpName')?.value.trim(),
        method:      document.getElementById('newEpMethod')?.value,
        path:        document.getElementById('newEpPath')?.value.trim(),
        description: document.getElementById('newEpDesc')?.value.trim()
      };
      try {
        await api(`/api/projects/${project.id}/endpoints`, {
          method: 'POST', body: JSON.stringify(body)
        });
        if (addForm) { addForm.hidden = true; addForm.reset?.(); }
        // Clear inputs
        ['newEpName','newEpPath','newEpDesc'].forEach((id) => {
          const el = document.getElementById(id); if (el) el.value = '';
        });
        await refreshEndpoints(project, canManage);
      } catch (err) {
        reportGlobalError(err, 'Add endpoint');
      }
    });
  }
}
