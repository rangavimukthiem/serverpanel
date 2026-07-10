/**
 * projectSetup.js — Scaffold / Nginx / SSL setup tab.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';

// ── Terminal helper ───────────────────────────────────────────────────────────

function writeOutput(elementId, text, type = 'info') {
  const el = document.getElementById(elementId);
  if (!el) return;
  const line = document.createElement('div');
  line.className = `terminal-line-${type}`;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearOutput(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = '';
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status-badge ${cls}`;
}

// ── Tab init ──────────────────────────────────────────────────────────────────

export function loadSetupTab(project) {
  // Pre-fill domain and port from project record
  const domainInput = document.getElementById('setupDomain');
  const portInput   = document.getElementById('setupPort');
  if (domainInput) domainInput.value = project.domain || '';
  if (portInput)   portInput.value   = project.port   || '';

  // Set badges based on what we know
  setBadge('scaffoldBadge', project.status === 'active' ? '—' : '✓ Done', project.status === 'provisioned' ? 'badge-provisioned' : 'badge-inactive');
  setBadge('nginxBadge', project.nginx_config_path ? '✓ Done' : '—', project.nginx_config_path ? 'badge-active' : 'badge-inactive');
  setBadge('sslBadge', project.ssl_enabled ? '✓ SSL' : '—', project.ssl_enabled ? 'badge-ssl' : 'badge-inactive');

  bindSetupButtons(project);
}

function bindSetupButtons(project) {
  // Scaffold
  const scaffoldBtn = document.getElementById('runScaffold');
  if (scaffoldBtn) {
    // Clone to remove old listeners
    const fresh = scaffoldBtn.cloneNode(true);
    scaffoldBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      clearOutput('setupOutput');
      fresh.disabled = true;
      writeOutput('setupOutput', `Scaffolding ${project.path}…`, 'info');
      try {
        const data = await api(`/api/projects/${project.id}/setup/scaffold`, { method: 'POST' });
        writeOutput('setupOutput', data.message, 'ok');
        data.directories?.forEach((d) => writeOutput('setupOutput', `  ✓ ${d}`));
        if (data.envFile) writeOutput('setupOutput', `  ✓ .env → ${data.envFile}`);
        setBadge('scaffoldBadge', '✓ Done', 'badge-provisioned');
        showGlobalMessage('Folder structure created successfully!', 'success');
        // Refresh project in state
        window.dispatchEvent(new CustomEvent('projectRefreshNeeded'));
      } catch (err) {
        writeOutput('setupOutput', `✗ ${err.message}`, 'err');
        reportGlobalError(err, 'Scaffold');
      } finally {
        fresh.disabled = false;
      }
    });
  }

  // Nginx
  const nginxBtn = document.getElementById('runNginx');
  if (nginxBtn) {
    const fresh = nginxBtn.cloneNode(true);
    nginxBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      const domain = document.getElementById('setupDomain')?.value.trim();
      const port   = document.getElementById('setupPort')?.value.trim();
      const type   = document.getElementById('setupNginxType')?.value || 'proxy';

      if (!domain) { writeOutput('setupOutput', '✗ Domain is required', 'err'); return; }

      clearOutput('setupOutput');
      fresh.disabled = true;
      writeOutput('setupOutput', `Generating nginx config for ${domain}…`, 'info');
      try {
        const data = await api(`/api/projects/${project.id}/setup/nginx`, {
          method: 'POST',
          body: JSON.stringify({ domain, port: Number(port) || undefined, type })
        });
        writeOutput('setupOutput', data.message, 'ok');
        writeOutput('setupOutput', `  Config: ${data.configPath}`);
        writeOutput('setupOutput', `  Domain: ${data.domain}`);
        setBadge('nginxBadge', '✓ Done', 'badge-active');
        showGlobalMessage('Nginx configuration generated and reloaded!', 'success');
        window.dispatchEvent(new CustomEvent('projectRefreshNeeded'));
      } catch (err) {
        writeOutput('setupOutput', `✗ ${err.message}`, 'err');
        reportGlobalError(err, 'Nginx setup');
      } finally {
        fresh.disabled = false;
      }
    });
  }

  // SSL
  const sslBtn = document.getElementById('runSsl');
  if (sslBtn) {
    const fresh = sslBtn.cloneNode(true);
    sslBtn.replaceWith(fresh);
    fresh.addEventListener('click', async () => {
      clearOutput('setupOutput');
      fresh.disabled = true;
      writeOutput('setupOutput', 'Provisioning SSL certificate…', 'info');
      try {
        const data = await api(`/api/projects/${project.id}/setup/ssl`, { method: 'POST' });
        writeOutput('setupOutput', data.message, 'ok');
        writeOutput('setupOutput', `  Method: ${data.method}`);
        if (data.output) writeOutput('setupOutput', data.output);
        setBadge('sslBadge', '✓ SSL', 'badge-ssl');
        showGlobalMessage(`SSL certificate successfully provisioned (${data.method})!`, 'success');
        window.dispatchEvent(new CustomEvent('projectRefreshNeeded'));
      } catch (err) {
        writeOutput('setupOutput', `✗ ${err.message}`, 'err');
        reportGlobalError(err, 'SSL provisioning');
      } finally {
        fresh.disabled = false;
      }
    });
  }
}
