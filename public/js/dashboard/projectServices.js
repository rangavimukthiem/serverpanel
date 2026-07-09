/**
 * projectServices.js — Project-linked systemd services tab.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError } from '../shared/errors.js';
import { isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

// ── Render ────────────────────────────────────────────────────────────────────

function activeLabel(active) {
  if (active === null) return '<span class="service-status unknown">Unavailable</span>';
  return active
    ? '<span class="service-status active">Active</span>'
    : '<span class="service-status inactive">Inactive</span>';
}

function renderServiceCards(services, projectId, canManage) {
  if (!services.length) {
    return '<p class="message">No linked services. Click "+ Link" to register a systemd service for this project.</p>';
  }
  return services.map((svc) => `
    <article class="service-card" data-project-svc="${escapeHtml(svc.service_name)}">
      <header>
        <h4>${escapeHtml(svc.label)}</h4>
        ${activeLabel(svc.active)}
      </header>
      <p style="font-family:var(--font-mono);font-size:12px;color:var(--muted)">${escapeHtml(svc.service_name)}</p>
      <div class="service-actions">
        <button type="button" data-psvc="${escapeHtml(svc.service_name)}" data-action="start"   ${canManage ? '' : 'disabled'}>Start</button>
        <button type="button" data-psvc="${escapeHtml(svc.service_name)}" data-action="restart" class="restart" ${canManage ? '' : 'disabled'}>Restart</button>
        <button type="button" data-psvc="${escapeHtml(svc.service_name)}" data-action="stop"    class="stop"    ${canManage ? '' : 'disabled'}>Stop</button>
      </div>
      ${canManage
        ? `<button type="button" class="ghost-button" style="font-size:12px" data-unlink-svc="${escapeHtml(svc.service_name)}">Unlink</button>`
        : ''}
    </article>
  `).join('');
}

// ── Load tab ──────────────────────────────────────────────────────────────────

export async function loadServicesTab(project) {
  const admin     = isAdmin(dashboardState.user);
  const canManage = admin || project.current_user_role === 'manager';
  await refreshProjectServices(project, canManage);
  bindServiceActions(project, canManage);
  bindAddServiceForm(project, admin);
}

async function refreshProjectServices(project, canManage) {
  const container = document.getElementById('projectServicesList');
  if (!container) return;
  container.innerHTML = '<p class="message">Loading…</p>';
  try {
    const data = await api(`/api/projects/${project.id}/services`);
    container.innerHTML = renderServiceCards(data.services, project.id, canManage);
  } catch (err) {
    container.innerHTML = `<p class="message">${escapeHtml(err.message)}</p>`;
  }
}

function bindServiceActions(project, canManage) {
  if (!canManage) return;
  const container = document.getElementById('projectServicesList');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    // Control (start/stop/restart)
    const actionBtn = e.target.closest('[data-psvc][data-action]');
    if (actionBtn) {
      const svcName = actionBtn.dataset.psvc;
      const action  = actionBtn.dataset.action;
      actionBtn.disabled = true;
      try {
        const data = await api(`/api/projects/${project.id}/services/${svcName}/${action}`, { method: 'POST' });
        await refreshProjectServices(project, canManage);
      } catch (err) {
        reportGlobalError(err, `${action} ${svcName}`);
      } finally {
        actionBtn.disabled = false;
      }
      return;
    }

    // Unlink
    const unlinkBtn = e.target.closest('[data-unlink-svc]');
    if (unlinkBtn) {
      const svcName = unlinkBtn.dataset.unlinkSvc;
      if (!window.confirm(`Unlink service "${svcName}" from this project?`)) return;
      try {
        await api(`/api/projects/${project.id}/services/${svcName}`, { method: 'DELETE' });
        await refreshProjectServices(project, canManage);
      } catch (err) {
        reportGlobalError(err, 'Unlink service');
      }
    }
  });
}

function bindAddServiceForm(project, isAdminUser) {
  const addBtn    = document.getElementById('addServiceBtn');
  const addForm   = document.getElementById('addServiceForm');
  const cancelBtn = document.getElementById('cancelAddService');

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
    fresh.addEventListener('click', () => { if (addForm) addForm.hidden = true; });
  }

  if (addForm) {
    const fresh = addForm.cloneNode(true);
    addForm.replaceWith(fresh);
    fresh.addEventListener('submit', async (e) => {
      e.preventDefault();
      const serviceName = document.getElementById('newSvcName')?.value.trim();
      const label       = document.getElementById('newSvcLabel')?.value.trim() || serviceName;
      if (!serviceName) return;

      try {
        await api(`/api/projects/${project.id}/services`, {
          method: 'POST',
          body: JSON.stringify({ serviceName, label })
        });
        fresh.hidden = true;
        document.getElementById('newSvcName').value  = '';
        document.getElementById('newSvcLabel').value = '';
        await refreshProjectServices(project, isAdminUser || project.current_user_role === 'manager');
      } catch (err) {
        reportGlobalError(err, 'Link service');
      }
    });
  }
}
