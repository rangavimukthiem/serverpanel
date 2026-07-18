/**
 * projectServices.js — Project-linked systemd services tab.
 *
 * Key improvements:
 *  - Wizard with "Create & Register" vs "Link Existing" modes
 *  - Auto-fills service name (from project slug), label, and ExecStart from runtime
 *  - Preset ExecStart chips (npm start, node server.js, python3 app.py …)
 *  - Hides ExecStart fields in Link-only mode so users can't accidentally
 *    skip unit creation then try to start a non-existent unit
 *  - Inline status badge on each card (active / inactive / unavailable)
 *  - "Delete unit + Unlink" combined button replaces bare "Unlink"
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';
import { isAdmin } from '../shared/auth.js';
import { confirmDialog } from '../shared/dialog.js';
import { dashboardState } from './state.js';
import { projectRuntimeMap } from './constants.js';

// ── Runtime helpers ───────────────────────────────────────────────────────────

const EXEC_PRESETS = {
  'node-app':    'npm start',
  'python-api':  'python3 app.py',
  'static-api':  'npm start',
  'static-site': 'npm start',
  'php-site':    null,       // PHP doesn't need a service unit
  'wordpress-site': null
};

function runtimeNeedsUnit(runtime) {
  return Boolean(projectRuntimeMap[runtime]?.needsPort);
}

function defaultExecForRuntime(runtime) {
  return EXEC_PRESETS[runtime] || 'npm start';
}

function slugToServiceName(slug) {
  // Convert project slug to a valid systemd-friendly service name
  return (slug || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ── Status badge ──────────────────────────────────────────────────────────────

function activeLabel(active) {
  if (active === null) return '<span class="service-status unknown">Unavailable</span>';
  return active
    ? '<span class="service-status active">● Active</span>'
    : '<span class="service-status inactive">○ Inactive</span>';
}

// ── Service card render ───────────────────────────────────────────────────────

function renderServiceCards(services, projectId, canManage) {
  if (!services.length) {
    return `
      <div class="empty-services-notice">
        <p>No linked services yet.</p>
        <p class="muted-text">Click <strong>+ Add Service</strong> to create and register a systemd unit for this project.</p>
      </div>`;
  }

  return services.map((svc) => {
    const name = escapeHtml(svc.service_name);
    const label = escapeHtml(svc.label || svc.service_name);
    const disabled = canManage ? '' : 'disabled';

    return `
    <article class="service-card" data-project-svc="${name}">
      <header class="service-card-header">
        <div class="service-title-group">
          <h4>${label}</h4>
          <code class="service-unit-name">${name}</code>
        </div>
        ${activeLabel(svc.active)}
      </header>

      <div class="service-card-actions">
        <div class="service-control-btns">
          <button type="button"
            data-psvc="${name}" data-action="start"
            class="svc-btn" title="Start service" ${disabled}>
            ▶ Start
          </button>
          <button type="button"
            data-psvc="${name}" data-action="restart"
            class="svc-btn restart" title="Restart service" ${disabled}>
            ↺ Restart
          </button>
          <button type="button"
            data-psvc="${name}" data-action="stop"
            class="svc-btn stop" title="Stop service" ${disabled}>
            ■ Stop
          </button>
        </div>

        ${canManage ? `
        <div class="service-mgmt-btns">
          <button type="button"
            class="ghost-button svc-btn-edit"
            data-unit-svc="${name}"
            data-unit-label="${escapeHtml(svc.label || svc.service_name)}"
            title="Edit / recreate unit file">
            ✎ Edit unit
          </button>
          <button type="button"
            class="ghost-button svc-btn-danger"
            data-remove-svc="${name}"
            title="Stop, delete unit and unlink service">
            🗑 Remove
          </button>
        </div>` : ''}
      </div>
    </article>`;
  }).join('');
}

// ── Load tab ──────────────────────────────────────────────────────────────────

export async function loadServicesTab(project) {
  const admin     = isAdmin(dashboardState.user);
  const canManage = admin || project.current_user_role === 'manager';
  await refreshProjectServices(project, canManage);
  bindServiceCardActions(project, canManage);
  bindWizard(project, admin);
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

// ── Service card event delegation ─────────────────────────────────────────────

function bindServiceCardActions(project, canManage) {
  if (!canManage) return;
  const container = document.getElementById('projectServicesList');
  if (!container) return;

  // Remove old listeners by cloning
  const fresh = container.cloneNode(false);
  container.replaceWith(fresh);

  // Re-fetch rendered cards into the new node
  refreshProjectServices(project, canManage).then(() => {
    document.getElementById('projectServicesList')
      ?.addEventListener('click', (e) => handleCardClick(e, project, canManage));
  });
}

async function handleCardClick(e, project, canManage) {
  // Start / Restart / Stop
  const actionBtn = e.target.closest('[data-psvc][data-action]');
  if (actionBtn) {
    const svcName = actionBtn.dataset.psvc;
    const action  = actionBtn.dataset.action;
    actionBtn.disabled = true;
    try {
      await api(`/api/projects/${project.id}/services/${encodeURIComponent(svcName)}/${action}`, { method: 'POST' });
      await refreshProjectServices(project, canManage);
    } catch (err) {
      reportGlobalError(err, `${action} ${svcName}`);
    } finally {
      actionBtn.disabled = false;
    }
    return;
  }

  // Edit unit — open wizard pre-filled
  const editBtn = e.target.closest('[data-unit-svc]');
  if (editBtn) {
    const svcName = editBtn.dataset.unitSvc;
    const label   = editBtn.dataset.unitLabel || svcName;
    openWizard(project, { prefillName: svcName, prefillLabel: label, mode: 'create' });
    return;
  }

  // Remove (stop + delete unit + unlink)
  const removeBtn = e.target.closest('[data-remove-svc]');
  if (removeBtn) {
    const svcName = removeBtn.dataset.removeSvc;
    const confirmed = await confirmDialog({
      eyebrow: 'Remove service',
      title: `Remove "${svcName}"?`,
      message: 'This will stop the service, delete the unit file from /etc/systemd/system/, and unlink it from this project.',
      confirmLabel: 'Yes, remove',
      variant: 'danger'
    });
    if (!confirmed) return;
    try {
      // Delete unit first (stop + disable + rm)
      await api(`/api/projects/${project.id}/services/${encodeURIComponent(svcName)}/unit?unlink=true`, { method: 'DELETE' });
      showGlobalMessage(`${svcName} removed`, 'success');
    } catch (unitErr) {
      // Unit might not exist — fall through to plain unlink
      try {
        await api(`/api/projects/${project.id}/services/${encodeURIComponent(svcName)}`, { method: 'DELETE' });
        showGlobalMessage(`${svcName} unlinked`, 'success');
      } catch (unlinkErr) {
        reportGlobalError(unlinkErr, 'Remove service');
      }
    }
    await refreshProjectServices(project, canManage);
  }
}

// ── Wizard ────────────────────────────────────────────────────────────────────

function openWizard(project, opts = {}) {
  const wizard = document.getElementById('addServiceWizard');
  if (!wizard) return;

  const runtime = project.config?.runtime || 'node-app';
  const mode    = opts.mode || 'create';

  // Set mode radio
  const radioCreate = document.getElementById('modeCreate');
  const radioLink   = document.getElementById('modeLink');
  if (mode === 'link' && radioLink) radioLink.checked = true;
  else if (radioCreate) radioCreate.checked = true;

  // Auto-fill identity fields
  const nameInput  = document.getElementById('newSvcName');
  const labelInput = document.getElementById('newSvcLabel');
  const execInput  = document.getElementById('newSvcExec');

  if (nameInput)  nameInput.value  = opts.prefillName  || slugToServiceName(project.slug);
  if (labelInput) labelInput.value = opts.prefillLabel || `${project.name || project.slug} service`;
  if (execInput)  execInput.value  = opts.prefillExec  || (runtimeNeedsUnit(runtime) ? defaultExecForRuntime(runtime) : '');

  updateWizardMode(mode);

  // Title
  const title = document.getElementById('wizardTitle');
  if (title) title.textContent = mode === 'link' ? 'Link existing service' : 'Create & register service';

  wizard.hidden = false;
  wizard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Focus the name field only if it's empty (editing = focus exec)
  if (nameInput && !opts.prefillName) nameInput.focus();
  else if (execInput) execInput.focus();
}

function closeWizard() {
  const wizard = document.getElementById('addServiceWizard');
  const form   = document.getElementById('addServiceForm');
  const msg    = document.getElementById('serviceWizardMsg');
  if (wizard) wizard.hidden = true;
  if (form)   form.reset();
  if (msg)    msg.textContent = '';
}

function updateWizardMode(mode) {
  const createFields = document.getElementById('createUnitFields');
  const title        = document.getElementById('wizardTitle');
  const submitBtn    = document.getElementById('saveServiceBtn');

  if (createFields) createFields.hidden = (mode === 'link');

  if (mode === 'link') {
    if (title)     title.textContent = 'Link existing service';
    if (submitBtn) submitBtn.textContent = 'Link Service';
  } else {
    if (title)     title.textContent = 'Create & register service';
    if (submitBtn) submitBtn.textContent = 'Save Service';
  }
}

function bindWizard(project, isAdminUser) {
  const canManage = isAdminUser || project.current_user_role === 'manager';

  // Open wizard
  const addBtn = document.getElementById('addServiceBtn');
  if (addBtn) {
    const fresh = addBtn.cloneNode(true);
    addBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      const wizard = document.getElementById('addServiceWizard');
      if (wizard && !wizard.hidden) { closeWizard(); return; }
      openWizard(project);
    });
  }

  // Cancel
  const cancelBtn = document.getElementById('cancelAddService');
  if (cancelBtn) {
    const fresh = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(fresh);
    fresh.addEventListener('click', closeWizard);
  }

  // Mode radio switches
  ['modeCreate', 'modeLink'].forEach((id) => {
    const radio = document.getElementById(id);
    if (!radio) return;
    radio.addEventListener('change', () => {
      if (radio.checked) updateWizardMode(radio.value);
    });
  });

  // Preset chips
  const wizard = document.getElementById('addServiceWizard');
  if (wizard) {
    wizard.addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip[data-preset]');
      if (!chip) return;
      const execInput = document.getElementById('newSvcExec');
      if (execInput) {
        execInput.value = chip.dataset.preset;
        execInput.focus();
      }
    });
  }

  // Live service name hint — strip .service suffix in display
  const nameInput = document.getElementById('newSvcName');
  const nameHint  = document.getElementById('svcNameHint');
  if (nameInput && nameHint) {
    nameInput.addEventListener('input', () => {
      const raw  = nameInput.value.trim();
      const unit = raw && !raw.endsWith('.service') ? `${raw}.service` : raw;
      nameHint.textContent = unit ? `→ ${unit}` : '';
    });
  }

  // Form submit
  const form = document.getElementById('addServiceForm');
  if (form) {
    const fresh = form.cloneNode(true);
    form.replaceWith(fresh);

    // Re-attach preset chip listener after clone
    fresh.addEventListener('click', (e) => {
      const chip = e.target.closest('.preset-chip[data-preset]');
      if (!chip) return;
      const execInput = fresh.querySelector('#newSvcExec');
      if (execInput) {
        execInput.value = chip.dataset.preset;
        execInput.focus();
      }
    });

    // Name hint on fresh node
    const freshName = fresh.querySelector('#newSvcName');
    const freshHint = fresh.querySelector('#svcNameHint') || document.getElementById('svcNameHint');
    if (freshName && freshHint) {
      freshName.addEventListener('input', () => {
        const raw  = freshName.value.trim();
        const unit = raw && !raw.endsWith('.service') ? `${raw}.service` : raw;
        freshHint.textContent = unit ? `→ ${unit}` : '';
      });
    }

    fresh.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleWizardSubmit(fresh, project, canManage);
    });
  }
}

async function handleWizardSubmit(form, project, canManage) {
  const msg         = document.getElementById('serviceWizardMsg');
  const submitBtn   = document.getElementById('saveServiceBtn');
  const modeCreate  = document.getElementById('modeCreate');
  const mode        = modeCreate?.checked ? 'create' : 'link';
  const createUnit  = (mode === 'create');

  const serviceName = form.querySelector('#newSvcName')?.value.trim();
  const label       = form.querySelector('#newSvcLabel')?.value.trim() || serviceName;
  const execStart   = form.querySelector('#newSvcExec')?.value.trim();
  const startNow    = Boolean(form.querySelector('#newSvcStart')?.checked);

  if (!serviceName) {
    if (msg) msg.textContent = 'Service name is required.';
    return;
  }

  if (createUnit && !execStart) {
    if (msg) msg.textContent = 'ExecStart command is required when creating a unit.';
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (msg)       msg.textContent = createUnit
    ? `Creating unit for ${serviceName}…`
    : `Linking ${serviceName}…`;

  try {
    const body = {
      serviceName,
      label,
      createUnit,
      execStart:    createUnit ? execStart : undefined,
      runtime:      project.config?.runtime,
      enable:       true,
      start:        createUnit ? startNow : false
    };

    const data = await api(`/api/projects/${project.id}/services`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    showGlobalMessage(data.message || 'Service saved', 'success');
    closeWizard();
    await refreshProjectServices(project, canManage);
  } catch (err) {
    reportGlobalError(err, createUnit ? 'Create service unit' : 'Link service');
    if (msg) msg.textContent = err.message || 'Failed — see error above.';
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
