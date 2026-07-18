/**
 * projectServices.js — Project-linked systemd services tab.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';
import { isAdmin } from '../shared/auth.js';
import { confirmDialog } from '../shared/dialog.js';
import { dashboardState } from './state.js';
import { projectRuntimeMap } from './constants.js';

// ── Render ────────────────────────────────────────────────────────────────────

function activeLabel(active) {
  if (active === null) return '<span class="service-status unknown">Unavailable</span>';
  return active
    ? '<span class="service-status active">Active</span>'
    : '<span class="service-status inactive">Inactive</span>';
}

function defaultExecStart(project) {
  return project.config?.runtime === 'python-api' ? 'python3 app.py' : 'npm start';
}

function serviceRuntimeNeedsUnit(project) {
  const runtime = project.config?.runtime || 'static-site';
  return Boolean(projectRuntimeMap[runtime]?.needsPort);
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
        <button type="button" data-unit-svc="${escapeHtml(svc.service_name)}" data-unit-label="${escapeHtml(svc.label)}" ${canManage ? '' : 'disabled'}>Unit</button>
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
      const confirmed = await confirmDialog({
        eyebrow: 'Linked service',
        title: 'Unlink service?',
        message: `Unlink service "${svcName}" from this project?`,
        confirmLabel: 'Unlink',
        variant: 'warning'
      });
      if (!confirmed) return;
      try {
        await api(`/api/projects/${project.id}/services/${svcName}`, { method: 'DELETE' });
        await refreshProjectServices(project, canManage);
      } catch (err) {
        reportGlobalError(err, 'Unlink service');
      }
      return;
    }

    const unitBtn = e.target.closest('[data-unit-svc]');
    if (unitBtn) {
      const svcName = unitBtn.dataset.unitSvc;
      const form = document.getElementById('addServiceForm');
      if (!form) return;
      form.hidden = false;
      const serviceName = form.querySelector('#newSvcName');
      const label = form.querySelector('#newSvcLabel');
      const execStart = form.querySelector('#newSvcExec');
      const createUnit = form.querySelector('#newSvcCreateUnit');
      const start = form.querySelector('#newSvcStart');
      if (serviceName) serviceName.value = svcName;
      if (label) label.value = unitBtn.dataset.unitLabel || svcName;
      if (execStart) execStart.value = defaultExecStart(project);
      if (createUnit) createUnit.checked = true;
      if (start) start.checked = false;
      execStart?.focus();
    }
  });
}

function bindAddServiceForm(project, isAdminUser) {
  const addBtn    = document.getElementById('addServiceBtn');
  const addForm   = document.getElementById('addServiceForm');
  let formNode = addForm;

  if (addForm) {
    formNode = addForm.cloneNode(true);
    addForm.replaceWith(formNode);
    formNode.addEventListener('submit', async (e) => {
      e.preventDefault();
      const serviceName = formNode.querySelector('#newSvcName')?.value.trim();
      const label       = formNode.querySelector('#newSvcLabel')?.value.trim() || serviceName;
      const execStart   = formNode.querySelector('#newSvcExec')?.value.trim();
      const createUnit  = Boolean(formNode.querySelector('#newSvcCreateUnit')?.checked);
      const start       = Boolean(formNode.querySelector('#newSvcStart')?.checked);
      if (!serviceName) return;

      try {
        const data = await api(`/api/projects/${project.id}/services`, {
          method: 'POST',
          body: JSON.stringify({
            serviceName,
            label,
            createUnit,
            execStart,
            runtime: project.config?.runtime,
            enable: true,
            start
          })
        });
        showGlobalMessage(data.message || 'Service saved', 'success');
        formNode.hidden = true;
        formNode.reset();
        await refreshProjectServices(project, isAdminUser || project.current_user_role === 'manager');
      } catch (err) {
        reportGlobalError(err, createUnit ? 'Create service unit' : 'Link service');
      }
    });
  }

  if (addBtn) {
    const fresh = addBtn.cloneNode(true);
    addBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      const form = document.getElementById('addServiceForm');
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) {
        const serviceName = form.querySelector('#newSvcName');
        const label = form.querySelector('#newSvcLabel');
        const execStart = form.querySelector('#newSvcExec');
        const createUnit = form.querySelector('#newSvcCreateUnit');
        if (serviceName && !serviceName.value) serviceName.value = project.slug || '';
        if (label && !label.value) label.value = `${project.name || project.slug} service`;
        if (execStart && !execStart.value) execStart.value = defaultExecStart(project);
        if (createUnit) createUnit.checked = serviceRuntimeNeedsUnit(project);
      }
    });
  }

  const cancelBtn = document.getElementById('cancelAddService');
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      const form = document.getElementById('addServiceForm');
      if (form) form.hidden = true;
    });
  }
}
