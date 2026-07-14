/**
 * projectSetup.js — Scaffold / Nginx / SSL setup tab.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError, showGlobalMessage } from '../shared/errors.js';
import { projectRuntimeMap } from './constants.js';

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

function formatApiDetails(error) {
  const details = error?.details;
  if (!details) return '';
  if (typeof details === 'string') return details;

  return [details.stderr, details.stdout, details.message]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function syncRuntimeFields(runtime) {
  const option = projectRuntimeMap[runtime] || projectRuntimeMap['static-site'];
  const portInput = document.getElementById('setupPort');
  const phpSocketInput = document.getElementById('setupPhpSocket');

  if (portInput) {
    portInput.disabled = !option.needsPort;
    if (!option.needsPort) portInput.value = '';
  }

  if (phpSocketInput) {
    phpSocketInput.disabled = !option.needsPhp;
    if (!option.needsPhp) phpSocketInput.value = '';
    if (option.needsPhp && !phpSocketInput.value) {
      phpSocketInput.value = '/run/php/php8.1-fpm.sock';
    }
  }
}

// ── Tab init ──────────────────────────────────────────────────────────────────

export function loadSetupTab(project) {
  // Pre-fill domain and port from project record
  const domainInput = document.getElementById('setupDomain');
  const portInput   = document.getElementById('setupPort');
  const runtimeSelect = document.getElementById('setupRuntime');
  const phpSocketInput = document.getElementById('setupPhpSocket');
  if (domainInput) domainInput.value = project.domain || '';
  if (portInput)   portInput.value   = project.port   || '';
  if (runtimeSelect) runtimeSelect.value = project.config?.runtime || 'static-site';
  if (phpSocketInput) phpSocketInput.value = project.config?.php?.fpmSocket || '/run/php/php8.1-fpm.sock';
  syncRuntimeFields(runtimeSelect?.value || 'static-site');

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
    const runtimeSelect = document.getElementById('setupRuntime');
    if (runtimeSelect) {
      runtimeSelect.onchange = () => syncRuntimeFields(runtimeSelect.value);
    }
    fresh.addEventListener('click', async () => {
      const domain = document.getElementById('setupDomain')?.value.trim();
      const port   = document.getElementById('setupPort')?.value.trim();
      const runtime = document.getElementById('setupRuntime')?.value || 'static-site';
      const phpFpmSocket = document.getElementById('setupPhpSocket')?.value.trim();
      const option = projectRuntimeMap[runtime] || projectRuntimeMap['static-site'];

      if (!domain) { writeOutput('setupOutput', '✗ Domain is required', 'err'); return; }
      if (option.needsPort && !port) { writeOutput('setupOutput', '✗ App/API port is required for this runtime', 'err'); return; }
      if (option.needsPhp && !phpFpmSocket) { writeOutput('setupOutput', '✗ PHP-FPM socket is required for this runtime', 'err'); return; }

      clearOutput('setupOutput');
      fresh.disabled = true;
      writeOutput('setupOutput', `Generating nginx config for ${domain}…`, 'info');
      try {
        const data = await api(`/api/projects/${project.id}/setup/nginx`, {
          method: 'POST',
          body: JSON.stringify({
            domain,
            runtime,
            port: option.needsPort ? Number(port) : undefined,
            phpFpmSocket: option.needsPhp ? phpFpmSocket : undefined
          })
        });
        writeOutput('setupOutput', data.message, 'ok');
        writeOutput('setupOutput', `  Config: ${data.configPath}`);
        writeOutput('setupOutput', `  Domain: ${data.domain}`);
        writeOutput('setupOutput', `  Runtime: ${data.runtime}`);
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
        const details = formatApiDetails(err);
        if (details) writeOutput('setupOutput', details, 'err');
        reportGlobalError(err, 'SSL provisioning');
      } finally {
        fresh.disabled = false;
      }
    });
  }
}
