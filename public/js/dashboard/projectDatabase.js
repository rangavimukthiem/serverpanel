/**
 * projectDatabase.js — Database wizard tab: provision, table list, SQL editor.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError } from '../shared/errors.js';
import { confirmDialog } from '../shared/dialog.js';
import { sqlEditorPresets } from './constants.js';

let lastImportPreview = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeOutput(elementId, text) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}

function clearOutput(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = '';
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status-badge ${cls}`;
}

/**
 * Converts a project slug into a safe MariaDB identifier segment.
 * Replaces hyphens with underscores, strips invalid chars, truncates to 48 chars.
 * e.g. "my-cool-app" → "my_cool_app"
 */
function slugToDbIdent(slug) {
  return (slug || '')
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 48);
}

// ── Tab init ──────────────────────────────────────────────────────────────────

export async function loadDatabaseTab(project) {
  lastImportPreview = null;
  prefillDbFields(project);
  renderSqlPresets();
  bindDatabaseActions(project);
  bindExcelImportActions(project);
  await refreshTablesList(project);
}

/**
 * Auto-fills the DB name and DB user inputs from the project slug.
 * Only fills if the field is currently empty (respects manual edits on re-open).
 * e.g. slug "my-app" → dbName "my_app_db", dbUser "my_app_user"
 */
function prefillDbFields(project) {
  const ident   = slugToDbIdent(project.slug || project.name);
  const dbNameEl = document.getElementById('dbName');
  const dbUserEl = document.getElementById('dbUser');

  // Pre-fill from config if already provisioned, otherwise derive from slug
  const configuredName = project.config?.database?.databaseName;
  const configuredUser = project.config?.database?.username;

  if (dbNameEl && !dbNameEl.value) {
    dbNameEl.value = configuredName || `${ident}_db`;
  }
  if (dbUserEl && !dbUserEl.value) {
    dbUserEl.value = configuredUser || `${ident}_user`;
  }
}

function renderSqlPresets() {
  const row = document.getElementById('sqlPresetRow');
  if (!row || row.dataset.ready) return;
  row.innerHTML = sqlEditorPresets.map((p) =>
    `<button type="button" class="preset-button" data-sql-preset="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>`
  ).join('');
  row.dataset.ready = 'true';
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sql-preset]');
    if (!btn) return;
    const preset = sqlEditorPresets.find((p) => p.key === btn.dataset.sqlPreset);
    if (preset) {
      const editor = document.getElementById('sqlEditor');
      if (editor) editor.value = preset.sql;
    }
  });
}

async function refreshTablesList(project) {
  const list = document.getElementById('tablesList');
  if (!list) {
    populateImportTableSelect([]);
    return [];
  }
  list.innerHTML = '<span class="message">Loading tables…</span>';
  try {
    const data = await api(`/api/projects/${project.id}/database/tables`);
    populateImportTableSelect(data.tables);
    if (!data.tables.length) {
      list.innerHTML = '<span class="message">No tables yet.</span>';
      return data.tables;
    }
    list.innerHTML = data.tables.map((t) =>
      `<span class="table-pill">${escapeHtml(t)}</span>`
    ).join('');
    setBadge('dbBadge', '✓ Connected', 'badge-active');
    return data.tables;
  } catch (err) {
    populateImportTableSelect([]);
    list.innerHTML = `<span class="message">${escapeHtml(err.message)}</span>`;
    setBadge('dbBadge', 'Not provisioned', 'badge-inactive');
    return [];
  }
}

function populateImportTableSelect(tables) {
  const select = document.getElementById('excelImportTable');
  if (!select) return;

  const current = select.value;
  if (!tables.length) {
    select.innerHTML = '<option value="">Create a table first</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = [
    '<option value="">Select target table</option>',
    ...tables.map((table) => `<option value="${escapeHtml(table)}">${escapeHtml(table)}</option>`)
  ].join('');

  if (tables.includes(current)) select.value = current;
}

function bindDatabaseActions(project) {
  // Provision
  const provBtn = document.getElementById('provisionDb');
  if (provBtn) {
    const fresh = provBtn.cloneNode(true);
    provBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      const dbName = document.getElementById('dbName')?.value.trim();
      const dbUser = document.getElementById('dbUser')?.value.trim();
      if (!dbName || !dbUser) {
        writeOutput('sqlOutput', '✗ Database name and username are required.');
        return;
      }
      fresh.disabled = true;
      clearOutput('sqlOutput');
      writeOutput('sqlOutput', `Provisioning database "${dbName}" with user "${dbUser}"…`);
      try {
        const data = await api(`/api/projects/${project.id}/database/provision`, {
          method: 'POST',
          body: JSON.stringify({ databaseName: dbName, dbUser })
        });
        writeOutput('sqlOutput', `✓ ${data.message}`);
        writeOutput('sqlOutput', `  DB: ${data.databaseName} @ ${data.dbHost}`);
        writeOutput('sqlOutput', '  Password saved to project .env (not shown here)');
        setBadge('dbBadge', '✓ Provisioned', 'badge-provisioned');
        await refreshTablesList(project);
        window.dispatchEvent(new CustomEvent('projectRefreshNeeded'));
      } catch (err) {
        writeOutput('sqlOutput', `✗ ${err.message}`);
        reportGlobalError(err, 'DB provision');
      } finally {
        fresh.disabled = false;
      }
    });
  }

  // Refresh tables
  const refreshBtn = document.getElementById('refreshTables');
  if (refreshBtn) {
    const fresh = refreshBtn.cloneNode(true);
    refreshBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => refreshTablesList(project));
  }

  // Run SQL
  const runBtn = document.getElementById('runSql');
  if (runBtn) {
    const fresh = runBtn.cloneNode(true);
    runBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      const sql = document.getElementById('sqlEditor')?.value.trim();
      if (!sql) return;

      clearOutput('sqlOutput');
      writeOutput('sqlOutput', `> ${sql.split('\n')[0]}…`);
      fresh.disabled = true;
      const resultTable = document.getElementById('sqlResultTable');
      if (resultTable) resultTable.hidden = true;

      try {
        const data = await api(`/api/projects/${project.id}/database/query`, {
          method: 'POST',
          body: JSON.stringify({ sql })
        });

        if (data.type === 'select') {
          writeOutput('sqlOutput', `✓ ${data.rowCount} row(s) returned`);
          if (resultTable && data.rows.length > 0) {
            resultTable.hidden = false;
            resultTable.innerHTML = buildResultTable(data.columns, data.rows);
          }
          await refreshTablesList(project);
        } else {
          writeOutput('sqlOutput', `✓ OK — ${data.affectedRows} row(s) affected`);
          if (data.insertId) writeOutput('sqlOutput', `  Insert ID: ${data.insertId}`);
          await refreshTablesList(project);
        }
      } catch (err) {
        writeOutput('sqlOutput', `✗ ${err.message}`);
      } finally {
        fresh.disabled = false;
      }
    });
  }
}

function bindExcelImportActions(project) {
  const form = document.getElementById('excelImportForm');
  if (!form) return;

  const fresh = form.cloneNode(true);
  form.replaceWith(fresh);

  const previewBtn = fresh.querySelector('#previewExcelImport');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => submitExcelImport(project, fresh, 'preview'));
  }

  fresh.addEventListener('submit', (event) => {
    event.preventDefault();
    submitExcelImport(project, fresh, 'import');
  });

  fresh.addEventListener('change', (event) => {
    if (event.target.matches('#excelImportTable, #excelImportFile, #excelHeaderRow, #excelSheetName')) {
      lastImportPreview = null;
    }
  });
}

async function submitExcelImport(project, form, mode) {
  const tableName = form.querySelector('#excelImportTable')?.value.trim();
  const file = form.querySelector('#excelImportFile')?.files?.[0];
  const headerRow = form.querySelector('#excelHeaderRow')?.value || '1';
  const sheetName = form.querySelector('#excelSheetName')?.value.trim() || '';

  if (!tableName) {
    renderImportMessage('error', 'Select the target database table first.');
    return;
  }
  if (!file) {
    renderImportMessage('error', 'Choose an .xlsx Excel file first.');
    return;
  }

  if (mode === 'import') {
    if (!previewMatchesCurrentSelection(lastImportPreview, file, tableName, headerRow, sheetName)) {
      renderImportMessage('error', 'Preview this exact file and table selection before importing.');
      return;
    }
    if (!lastImportPreview.suggestedMapping.length) {
      renderImportMessage('error', 'No matching Excel headers were found for importable table columns.');
      return;
    }

    const confirmed = await confirmDialog({
      eyebrow: 'Database import',
      title: 'Import Excel rows?',
      message: `Import rows from "${file.name}" into table "${tableName}"? Only the previewed mapped columns will be inserted.`,
      confirmLabel: 'Import Rows',
      variant: 'success'
    });
    if (!confirmed) return;
  }

  const formData = new FormData();
  formData.append('mode', mode);
  formData.append('tableName', tableName);
  formData.append('headerRow', headerRow);
  if (sheetName) formData.append('sheetName', sheetName);
  formData.append('file', file);
  if (mode === 'import') {
    formData.append('mapping', JSON.stringify(lastImportPreview.suggestedMapping));
  }

  setExcelImportBusy(form, true);
  renderImportMessage('info', mode === 'preview' ? 'Reading workbook and building preview...' : 'Importing rows into database...');

  try {
    const data = await api(`/api/projects/${project.id}/database/import`, {
      method: 'POST',
      body: formData
    });

    if (mode === 'preview') {
      lastImportPreview = data;
      renderImportPreview(data);
    } else {
      lastImportPreview = null;
      renderImportComplete(data);
      await refreshTablesList(project);
    }
  } catch (err) {
    renderImportMessage('error', err.message);
    reportGlobalError(err, mode === 'preview' ? 'Excel import preview' : 'Excel import');
  } finally {
    setExcelImportBusy(form, false);
  }
}

function previewMatchesCurrentSelection(preview, file, tableName, headerRow, sheetName) {
  return Boolean(
    preview &&
    preview.fileName === file.name &&
    Number(preview.fileSize) === Number(file.size) &&
    preview.tableName === tableName &&
    String(preview.headerRow) === String(headerRow) &&
    (!sheetName || preview.selectedSheet === sheetName)
  );
}

function setExcelImportBusy(form, busy) {
  form.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
}

function renderImportMessage(kind, message) {
  const output = document.getElementById('excelImportOutput');
  if (!output) return;
  output.innerHTML = `<div class="import-status import-status-${escapeHtml(kind)}">${escapeHtml(message)}</div>`;
}

function renderImportPreview(data) {
  const output = document.getElementById('excelImportOutput');
  if (!output) return;

  const mappedColumns = data.suggestedMapping.map((item) => `
    <span class="import-map-pill">
      <strong>${escapeHtml(item.header)}</strong>
      <span>${escapeHtml(item.column)}</span>
    </span>
  `).join('');

  const unmapped = data.unmappedHeaders?.length
    ? `<p class="message">Unmapped headers: ${escapeHtml(data.unmappedHeaders.join(', '))}</p>`
    : '';

  output.innerHTML = `
    <div class="import-preview-summary">
      <div>
        <strong>${escapeHtml(data.fileName)}</strong>
        <span>${escapeHtml(data.selectedSheet)} / row ${escapeHtml(data.headerRow)}</span>
      </div>
      <div>
        <strong>${escapeHtml(data.suggestedMapping.length)} column(s)</strong>
        <span>Max ${escapeHtml(data.maxRows)} rows per import</span>
      </div>
    </div>
    ${renderImportWarnings(data.warnings)}
    <div class="import-mapping-list">
      ${mappedColumns || '<p class="message">No Excel headers matched importable table columns.</p>'}
    </div>
    ${unmapped}
    ${buildImportSampleTable(data)}
  `;
}

function renderImportComplete(data) {
  const output = document.getElementById('excelImportOutput');
  if (!output) return;
  output.innerHTML = `
    <div class="import-status import-status-success">
      <strong>${escapeHtml(data.message)}</strong>
      <span>${escapeHtml(data.skippedRows)} blank row(s) skipped.</span>
    </div>
    ${renderImportWarnings(data.warnings)}
  `;
}

function renderImportWarnings(warnings = []) {
  if (!warnings.length) return '';
  return `
    <ul class="import-warning-list">
      ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}
    </ul>
  `;
}

function buildImportSampleTable(data) {
  const columns = data.suggestedMapping.map((item) => item.column);
  if (!columns.length || !data.sampleRows.length) {
    return '<p class="message">No sample rows found below the header row.</p>';
  }

  const head = ['Source row', ...columns].map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = data.sampleRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.sourceRow)}</td>
      ${columns.map((column) => `<td>${escapeHtml(formatImportCell(row.values[column]))}</td>`).join('')}
    </tr>
  `).join('');

  return `
    <div class="table-panel import-sample-table">
      <table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>
  `;
}

function formatImportCell(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildResultTable(columns, rows) {
  const head = columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join('');
  const body = rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escapeHtml(cell === null ? 'NULL' : String(cell))}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
