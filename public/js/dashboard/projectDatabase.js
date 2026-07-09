/**
 * projectDatabase.js — Database wizard tab: provision, table list, SQL editor.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError } from '../shared/errors.js';
import { sqlEditorPresets } from './constants.js';

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

// ── Tab init ──────────────────────────────────────────────────────────────────

export async function loadDatabaseTab(project) {
  renderSqlPresets();
  bindDatabaseActions(project);
  await refreshTablesList(project);
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
  if (!list) return;
  list.innerHTML = '<span class="message">Loading tables…</span>';
  try {
    const data = await api(`/api/projects/${project.id}/database/tables`);
    if (!data.tables.length) {
      list.innerHTML = '<span class="message">No tables yet.</span>';
      return;
    }
    list.innerHTML = data.tables.map((t) =>
      `<span class="table-pill">${escapeHtml(t)}</span>`
    ).join('');
    setBadge('dbBadge', '✓ Connected', 'badge-active');
  } catch (err) {
    list.innerHTML = `<span class="message">${escapeHtml(err.message)}</span>`;
    setBadge('dbBadge', 'Not provisioned', 'badge-inactive');
  }
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

function buildResultTable(columns, rows) {
  const head = columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join('');
  const body = rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escapeHtml(cell === null ? 'NULL' : String(cell))}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
