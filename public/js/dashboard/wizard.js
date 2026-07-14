import { escapeHtml } from '../shared/dom.js';
import { databaseQueryPresets, apiEndpointPresets, apiEndpointPresetMap, projectRuntimeMap } from './constants.js';
import { nextEndpointRowId, resetEndpointRowCount, dashboardState } from './state.js';

// ── Auto-fill utilities ───────────────────────────────────────────────────────

/**
 * Convert a project name into a URL/filesystem-safe slug.
 * e.g. "My Awesome App 2!" → "my-awesome-app-2"
 */
export function toSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Convert a slug to a SQL/filesystem identifier (underscores, no leading/trailing).
 * e.g. "my-awesome-app" → "my_awesome_app"
 */
function toDbIdentifier(slug) {
  return slug.replace(/-/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Find the next open port starting from 4001,
 * skipping any ports already used by existing projects.
 */
function nextAvailablePort() {
  const used = new Set(
    (dashboardState.projects || []).map((p) => p.port).filter(Boolean)
  );
  let port = 4001;
  while (used.has(port)) port++;
  return port;
}

/** Set a form field's value and mark it as auto-filled (unless manually locked). */
function setAutoField(el, value) {
  if (!el || el.dataset.manualEdit === 'true') return;
  el.value = value;
  el.dataset.autoValue = String(value);
  el.classList.add('is-auto-filled');
}

/** Lock a field from further auto-fill once the user has typed in it. */
function lockField(el) {
  if (!el) return;
  el.dataset.manualEdit = 'true';
  el.classList.remove('is-auto-filled');
}

/** Clear all auto-fill marks from a form (on reset). */
function clearAutoFillState(form) {
  form.querySelectorAll('.is-auto-filled, [data-manual-edit], [data-auto-value]').forEach((el) => {
    el.classList.remove('is-auto-filled');
    delete el.dataset.manualEdit;
    delete el.dataset.autoValue;
  });
}

const AUTO_FIELD_NAMES = ['slug', 'path', 'port', 'database.databaseName', 'database.username'];

function runtimeToKind(runtime) {
  if (runtime === 'wordpress-site') return 'database';
  if (runtime === 'static-api' || runtime === 'node-app' || runtime === 'python-api') return 'api';
  return 'static';
}

function getField(form, name) {
  return form.querySelector(`[name="${name}"]`);
}

/** Wire the auto-fill listeners on the project name input. */
function initAutoFill(form) {
  if (form.dataset.autoFillReady === 'true') return;
  form.dataset.autoFillReady = 'true';

  // When user manually edits any auto-fill field → lock it from future auto-fills
  AUTO_FIELD_NAMES.forEach((fieldName) => {
    const el = getField(form, fieldName);
    if (!el) return;
    el.addEventListener('input', () => lockField(el));
  });

  const nameInput = getField(form, 'name');
  if (!nameInput) return;

  nameInput.addEventListener('input', () => {
    const slug  = toSlug(nameInput.value);
    const dbId  = toDbIdentifier(slug);
    const port  = nextAvailablePort();
    const runtime = form.elements.runtime?.value || 'static-site';
    const needsPort = Boolean(projectRuntimeMap[runtime]?.needsPort);

    setAutoField(getField(form, 'slug'),                 slug);
    setAutoField(getField(form, 'path'),                 slug ? `/srv/${slug}` : '');
    setAutoField(getField(form, 'port'),                 slug && needsPort ? port : '');
    setAutoField(getField(form, 'database.databaseName'), dbId ? dbId.slice(0, 63) : '');
    setAutoField(getField(form, 'database.username'),     dbId ? dbId.slice(0, 16) : '');
  });
}

function getProjectForm() {
  return document.getElementById('projectForm');
}

function getEndpointList() {
  return document.querySelector('[data-endpoint-list]');
}

function getPresetRow() {
  return document.querySelector('[data-query-preset-row]');
}

function getEndpointPresetRow() {
  return document.querySelector('[data-endpoint-preset-row]');
}

function createEndpointRow(endpoint = {}) {
  const rowId = nextEndpointRowId();
  const row = document.createElement('div');
  row.className = 'endpoint-row';
  row.dataset.endpointRow = String(rowId);
  row.innerHTML = `
    <input name="api.endpoints.name" type="text" placeholder="Endpoint name" value="${escapeHtml(endpoint.name || '')}">
    <select name="api.endpoints.method">
      ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => `<option value="${method}" ${method === (endpoint.method || 'GET') ? 'selected' : ''}>${method}</option>`).join('')}
    </select>
    <input name="api.endpoints.path" type="text" placeholder="/resource/path" value="${escapeHtml(endpoint.path || '')}">
    <input class="endpoint-description" name="api.endpoints.description" type="text" placeholder="Description" value="${escapeHtml(endpoint.description || '')}">
    <button type="button" class="danger-button" data-remove-endpoint aria-label="Remove endpoint">&times;</button>
  `;
  return row;
}

function syncProjectWizardVisibility() {
  const form = getProjectForm();
  if (!form) return;

  const runtime = form.elements.runtime?.value || 'static-site';
  const option = projectRuntimeMap[runtime] || projectRuntimeMap['static-site'];
  const kind = runtimeToKind(runtime);
  const databaseWizard = form.querySelector('.database-wizard');
  const apiWizard = form.querySelector('.api-wizard');
  const phpWizard = form.querySelector('.php-wizard');
  const portInput = form.elements.port;

  if (databaseWizard) {
    databaseWizard.hidden = !(option.hasDatabase || kind === 'database' || kind === 'full');
  }

  if (apiWizard) {
    apiWizard.hidden = !option.hasApi;
  }

  if (phpWizard) {
    phpWizard.hidden = !option.needsPhp;
  }

  if (portInput) {
    portInput.disabled = !option.needsPort;
    if (!option.needsPort) portInput.value = '';
    if (option.needsPort && !portInput.value) {
      setAutoField(portInput, nextAvailablePort());
    }
  }
}

function syncPresetButtons(activePresets = []) {
  const presetRow = getPresetRow();
  if (!presetRow) return;

  presetRow.querySelectorAll('button[data-query-preset]').forEach((button) => {
    button.classList.toggle('is-active', activePresets.includes(button.dataset.queryPreset));
  });
}

function readEndpointRows() {
  const list = getEndpointList();
  if (!list) return [];

  return Array.from(list.querySelectorAll('[data-endpoint-row]')).map((row) => ({
    name: row.querySelector('input[name="api.endpoints.name"]')?.value.trim(),
    method: row.querySelector('select[name="api.endpoints.method"]')?.value,
    path: row.querySelector('input[name="api.endpoints.path"]')?.value.trim(),
    description: row.querySelector('input[name="api.endpoints.description"]')?.value.trim()
  })).filter((endpoint) => endpoint.name || endpoint.path);
}

function readSelectedQueryPresets() {
  const presetRow = getPresetRow();
  if (!presetRow) return [];

  return Array.from(presetRow.querySelectorAll('button[data-query-preset].is-active')).map((button) => button.dataset.queryPreset);
}

export function readProjectWizardConfig() {
  const form = getProjectForm();
  if (!form) return null;

  const runtime = form.elements.runtime?.value || 'static-site';
  const option = projectRuntimeMap[runtime] || projectRuntimeMap['static-site'];
  const kind = runtimeToKind(runtime);
  const database = {
    enabled: option.hasDatabase || kind === 'database' || kind === 'full',
    provider: form.elements['database.provider'].value,
    host: form.elements['database.host'].value.trim(),
    port: Number(form.elements['database.port'].value || 3306),
    databaseName: form.elements['database.databaseName'].value.trim(),
    username: form.elements['database.username'].value.trim(),
    charset: 'utf8mb4'
  };

  const api = {
    enabled: option.hasApi,
    baseUrl: form.elements['api.baseUrl'].value.trim(),
    endpoints: readEndpointRows()
  };

  return {
    kind,
    runtime,
    php: {
      fpmSocket: form.elements['php.fpmSocket']?.value.trim() || '/run/php/php8.1-fpm.sock'
    },
    database,
    api,
    queryPresets: readSelectedQueryPresets(),
    notes: form.elements.notes.value.trim()
  };
}

function buildWizardPreviewFromConfig(config = {}) {
  const database = config.database || {};
  const apiConfig = config.api || {};

  const databasePreview = database.enabled
    ? {
        summary: {
          provider: database.provider || 'mariadb',
          host: database.host || 'localhost',
          port: database.port || 3306,
          databaseName: database.databaseName || '<DATABASE_NAME>',
          username: database.username || '<DB_USER>',
          charset: database.charset || 'utf8mb4'
        },
        sql: [
          `CREATE DATABASE IF NOT EXISTS \`${database.databaseName || '<DATABASE_NAME>'}\` CHARACTER SET ${database.charset || 'utf8mb4'} COLLATE ${database.charset || 'utf8mb4'}_unicode_ci;`,
          `CREATE USER IF NOT EXISTS '${database.username || '<DB_USER>'}'@'${database.host || 'localhost'}' IDENTIFIED BY '<PASSWORD>';`,
          `GRANT ALL PRIVILEGES ON \`${database.databaseName || '<DATABASE_NAME>'}\`.* TO '${database.username || '<DB_USER>'}'@'${database.host || 'localhost'}';`,
          'FLUSH PRIVILEGES;'
        ],
        presets: databaseQueryPresets
      }
    : null;

  const apiPreview = apiConfig.enabled
    ? {
        summary: {
          baseUrl: apiConfig.baseUrl || '',
          endpoints: Array.isArray(apiConfig.endpoints) ? apiConfig.endpoints : []
        },
        presets: apiEndpointPresets
      }
    : null;

  return {
    database: databasePreview,
    api: apiPreview
  };
}

export function renderWizardPreview(target, wizardOrConfig) {
  if (!target) return;

  const preview = wizardOrConfig?.database?.sql
    ? wizardOrConfig
    : buildWizardPreviewFromConfig(wizardOrConfig);

  const databaseSql = preview?.database?.sql || [];
  const databasePresets = preview?.database?.presets || [];
  const apiEndpoints = preview?.api?.summary?.endpoints || [];

  target.innerHTML = `
    <div class="wizard-preview-block">
      <h4>Database Wizard Output</h4>
      ${databaseSql.length ? `<pre>${escapeHtml(databaseSql.join('\n'))}</pre>` : '<p class="message">No database wizard configured yet.</p>'}
    </div>
    <div class="wizard-preview-block">
      <h4>Query Presets</h4>
      ${databasePresets.length ? databasePresets.map((preset) => `<div class="role-pill">${escapeHtml(preset.label)}</div>`).join('') : '<p class="message">No database presets available.</p>'}
    </div>
    <div class="wizard-preview-block">
      <h4>API Endpoints</h4>
      ${apiEndpoints.length ? apiEndpoints.map((endpoint) => `<div class="role-pill">${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</div>`).join('') : '<p class="message">No API endpoints configured yet.</p>'}
    </div>
  `;
}

export function setupProjectWizard() {
  const form = getProjectForm();
  if (!form || form.dataset.ready === 'true') return;

  const endpointList = getEndpointList();
  const presetRow = getPresetRow();
  const endpointPresetRow = getEndpointPresetRow();
  const addEndpointButton = document.querySelector('[data-add-endpoint]');
  const wizardPreview = document.getElementById('projectWizardPreview');

  if (presetRow && !presetRow.dataset.ready) {
    presetRow.innerHTML = databaseQueryPresets.map((preset) => `
      <button type="button" class="preset-button" data-query-preset="${preset.key}">${escapeHtml(preset.label)}</button>
    `).join('');
    presetRow.dataset.ready = 'true';
  }

  if (endpointPresetRow && !endpointPresetRow.dataset.ready) {
    endpointPresetRow.innerHTML = apiEndpointPresets.map((preset) => `
      <button type="button" class="preset-button" data-api-endpoint-preset="${preset.key}">${escapeHtml(preset.label)}</button>
    `).join('');
    endpointPresetRow.dataset.ready = 'true';
  }

  if (endpointList && !endpointList.children.length) {
    endpointList.appendChild(createEndpointRow());
  }

  resetEndpointRowCount(endpointList ? endpointList.children.length : 0);
  form.dataset.ready = 'true';

  form.elements.runtime?.addEventListener('change', syncProjectWizardVisibility);

  if (addEndpointButton && endpointList) {
    addEndpointButton.addEventListener('click', () => {
      endpointList.appendChild(createEndpointRow());
      syncProjectWizardVisibility();
    });
  }

  if (presetRow) {
    presetRow.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-query-preset]');
      if (!button) return;
      button.classList.toggle('is-active');
      if (wizardPreview) {
        renderWizardPreview(wizardPreview, readProjectWizardConfig());
      }
    });
  }

  if (endpointPresetRow && endpointList) {
    endpointPresetRow.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-api-endpoint-preset]');
      if (!button) return;

      const preset = apiEndpointPresetMap[button.dataset.apiEndpointPreset];
      if (preset) {
        endpointList.appendChild(createEndpointRow(preset));
        if (wizardPreview) {
          renderWizardPreview(wizardPreview, readProjectWizardConfig());
        }
      }
    });
  }

  if (endpointList) {
    endpointList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-remove-endpoint]');
      if (!button) return;

      const row = button.closest('[data-endpoint-row]');
      if (row) {
        row.remove();
      }

      if (!endpointList.children.length) {
        endpointList.appendChild(createEndpointRow());
      }

      if (wizardPreview) {
        renderWizardPreview(wizardPreview, readProjectWizardConfig());
      }
    });
  }

  const refreshPreview = () => {
    if (wizardPreview) {
      renderWizardPreview(wizardPreview, readProjectWizardConfig());
    }
  };

  form.addEventListener('input', refreshPreview);
  form.addEventListener('change', refreshPreview);

  syncProjectWizardVisibility();
  syncPresetButtons([]);
  if (wizardPreview) {
    renderWizardPreview(wizardPreview, readProjectWizardConfig());
  }

  // Wire the name → auto-fill listeners
  initAutoFill(form);
}

export function resetProjectWizard() {
  const form = getProjectForm();
  if (!form) return;

  form.reset();
  clearAutoFillState(form);        // ← unlock all auto-fill fields
  delete form.dataset.autoFillReady; // ← allow re-init on next open

  const endpointList = getEndpointList();
  if (endpointList) {
    endpointList.innerHTML = '';
    endpointList.appendChild(createEndpointRow());
  }

  resetEndpointRowCount(endpointList ? endpointList.children.length : 0);
  syncProjectWizardVisibility();
  syncPresetButtons([]);
}
