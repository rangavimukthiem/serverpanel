import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { confirmDialog } from '../shared/dialog.js';
import { reportGlobalError } from '../shared/errors.js';

const present = (value, fallback) => value === null || value === undefined ? fallback : value;
const formatDate = (value) => value ? new Date(value).toLocaleString() : 'Never';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderRule(rule, driveConfigured) {
  const frequency = present(rule.frequency, 'manual');
  return `<form class="wizard-card backup-rule-card" data-backup-rule="${Number(rule.project_id)}">
    <div class="section-heading"><div><h4>${escapeHtml(rule.project_name)}</h4><p class="eyebrow">${escapeHtml(rule.project_slug)}</p></div>
      <button type="button" data-run-backup="${Number(rule.project_id)}">Back up now</button></div>
    <div class="backup-rule-fields">
      <label>Schedule<select name="frequency">${['manual','daily','weekly'].map((item) => `<option value="${item}" ${frequency === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
      <label>Hour<input name="runHour" type="number" min="0" max="23" value="${present(rule.run_hour, 2)}"></label>
      <label>Minute<input name="runMinute" type="number" min="0" max="59" value="${present(rule.run_minute, 0)}"></label>
      <label>Weekday<select name="runWeekday">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day, index) => `<option value="${index}" ${Number(present(rule.run_weekday, 0)) === index ? 'selected' : ''}>${day}</option>`).join('')}</select></label>
      <label>Keep<input name="localRetention" type="number" min="1" max="100" value="${present(rule.local_retention, 7)}"></label>
    </div>
    <div class="backup-options">
      <label><input name="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}> Automatic</label>
      <label><input name="includeFiles" type="checkbox" ${rule.include_files === 0 ? '' : 'checked'}> Files</label>
      <label><input name="includeDatabase" type="checkbox" ${Number(rule.include_database) === 1 ? 'checked' : ''}> Database</label>
      <label title="${driveConfigured ? '' : 'Set GOOGLE_DRIVE_REMOTE first'}"><input name="googleDriveEnabled" type="checkbox" ${rule.google_drive_enabled ? 'checked' : ''} ${driveConfigured ? '' : 'disabled'}> Google Drive</label>
    </div>
    <div class="backup-rule-footer"><span>Next: ${escapeHtml(formatDate(rule.next_run_at))}</span><button class="ghost-button" type="submit">Save rule</button></div>
  </form>`;
}

function renderRuns(runs) {
  if (!runs.length) return '<p class="message">No backups have run yet.</p>';
  return `<table class="data-table"><thead><tr><th>Project</th><th>Started</th><th>Trigger</th><th>Status</th><th>Size</th><th>Storage</th><th></th></tr></thead><tbody>${runs.map((run) =>
    `<tr><td>${escapeHtml(run.project_name)}</td><td>${escapeHtml(formatDate(run.started_at))}</td><td>${escapeHtml(run.trigger_type)}</td>
    <td>${escapeHtml(run.status)}${run.error_message ? `<small>${escapeHtml(run.error_message)}</small>` : ''}</td><td>${formatBytes(run.size_bytes)}</td>
    <td>${run.google_drive_path ? 'Local + Drive' : 'Local'}</td><td>${run.status === 'completed' ? `<button class="danger-button" type="button" data-restore-backup="${run.id}" data-project="${escapeHtml(run.project_name)}">Restore</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
}

export async function loadBackups() {
  try {
    const data = await api('/api/backups');
    document.getElementById('backupSummary').innerHTML = `<strong>Local destination</strong><code>${escapeHtml(data.backupRoot)}</code><p class="message">Google Drive: ${data.googleDriveConfigured ? 'Configured' : 'Not configured'}</p>`;
    document.getElementById('backupRules').innerHTML = data.rules.map((rule) => renderRule(rule, data.googleDriveConfigured)).join('');
    document.getElementById('backupHistory').innerHTML = renderRuns(data.runs);
  } catch (error) { reportGlobalError(error, 'Loading backups'); }
}

function serializeRule(form) {
  return { enabled: form.enabled.checked, frequency: form.frequency.value, runHour: Number(form.runHour.value),
    runMinute: Number(form.runMinute.value), runWeekday: Number(form.runWeekday.value), localRetention: Number(form.localRetention.value),
    includeFiles: form.includeFiles.checked, includeDatabase: form.includeDatabase.checked,
    googleDriveEnabled: form.googleDriveEnabled.checked };
}

export function initBackups() {
  document.getElementById('refreshBackups')?.addEventListener('click', loadBackups);
  document.getElementById('backupRules')?.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-backup-rule]');
    if (!form) return;
    event.preventDefault();
    try { await api(`/api/backups/rules/${form.dataset.backupRule}`, { method: 'PUT', body: JSON.stringify(serializeRule(form)) }); await loadBackups(); }
    catch (error) { reportGlobalError(error, 'Saving backup rule'); }
  });
  document.getElementById('backupRules')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-run-backup]');
    if (!button) return;
    button.disabled = true;
    try { await api(`/api/backups/projects/${button.dataset.runBackup}/run`, { method: 'POST' }); await loadBackups(); }
    catch (error) { reportGlobalError(error, 'Creating backup'); }
    finally { button.disabled = false; }
  });
  document.getElementById('backupHistory')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore-backup]');
    if (!button) return;
    const confirmed = await confirmDialog({ eyebrow: 'Destructive operation', title: `Restore ${button.dataset.project}?`,
      message: 'A safety backup will run first. Existing files will be overwritten and the database dump replayed.',
      confirmLabel: 'Back up and restore', variant: 'danger' });
    if (!confirmed) return;
    button.disabled = true;
    try { await api(`/api/backups/runs/${button.dataset.restoreBackup}/restore`, { method: 'POST', body: JSON.stringify({ restoreFiles: true, restoreDatabase: true }) }); await loadBackups(); }
    catch (error) { reportGlobalError(error, 'Restoring backup'); }
    finally { button.disabled = false; }
  });
}
