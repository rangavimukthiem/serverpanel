import { escapeHtml } from '../shared/dom.js';
import { databaseQueryPresets, apiEndpointPresets, apiEndpointPresetMap } from './constants.js';
import { nextEndpointRowId, resetEndpointRowCount } from './state.js';

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

  const kind = form.elements.kind?.value || 'static';
  const databaseWizard = form.querySelector('.database-wizard');
  const apiWizard = form.querySelector('.api-wizard');

  if (databaseWizard) {
    databaseWizard.hidden = !(kind === 'database' || kind === 'full');
  }

  if (apiWizard) {
    apiWizard.hidden = !(kind === 'api' || kind === 'full');
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

  const kind = form.elements.kind.value;
  const database = {
    enabled: kind === 'database' || kind === 'full',
    provider: form.elements['database.provider'].value,
    host: form.elements['database.host'].value.trim(),
    port: Number(form.elements['database.port'].value || 3306),
    databaseName: form.elements['database.databaseName'].value.trim(),
    username: form.elements['database.username'].value.trim(),
    charset: 'utf8mb4'
  };

  const api = {
    enabled: kind === 'api' || kind === 'full',
    baseUrl: form.elements['api.baseUrl'].value.trim(),
    endpoints: readEndpointRows()
  };

  return {
    kind,
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

  form.elements.kind.addEventListener('change', syncProjectWizardVisibility);

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
}

export function resetProjectWizard() {
  const form = getProjectForm();
  if (!form) return;

  form.reset();

  const endpointList = getEndpointList();
  if (endpointList) {
    endpointList.innerHTML = '';
    endpointList.appendChild(createEndpointRow());
  }

  resetEndpointRowCount(endpointList ? endpointList.children.length : 0);
  syncProjectWizardVisibility();
  syncPresetButtons([]);
}
