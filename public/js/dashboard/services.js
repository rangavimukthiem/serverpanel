/**
 * services.js - Top-level systemd services panel.
 */

import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError, isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

const SERVICE_ACTIONS = [
  { action: 'start', label: 'Start', className: '' },
  { action: 'restart', label: 'Restart', className: 'restart' },
  { action: 'stop', label: 'Stop', className: 'stop' }
];

const NGINX_SERVICE_ACTIONS = [
  { action: 'start', label: 'Start', className: '' },
  { action: 'reload', label: 'Reload', className: 'restart' },
  { action: 'stop', label: 'Stop', className: 'stop' }
];

function activeStatusBadge(active) {
  if (active === null) return '<span class="service-status unknown">Unavailable</span>';
  return active
    ? '<span class="service-status active">Active</span>'
    : '<span class="service-status inactive">Inactive</span>';
}

function formatNumber(value, fallback = 'None') {
  return value === null || value === undefined ? fallback : String(value);
}

function formatBytes(value, fallback = 'No reading') {
  if (value === null || value === undefined || value === 'infinity') return fallback;

  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return fallback;
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const precision = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytesLimit(value) {
  if (value === null || value === undefined || value === 'infinity') return 'Unlimited';
  return formatBytes(value, 'Unknown');
}

function formatTasksLimit(value) {
  if (value === null || value === undefined || value === 'infinity') return 'Unlimited';
  return String(value);
}

function formatDurationNs(value) {
  const ns = Number(value);
  if (!Number.isFinite(ns) || ns < 0) return 'No reading';

  const seconds = ns / 1_000_000_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseSystemdTimeToMicros(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(us|ms|s)$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === 's') return amount * 1_000_000;
  if (match[2] === 'ms') return amount * 1000;
  return amount;
}

function formatCpuQuota(value) {
  if (value === null || value === undefined || value === 'infinity') return 'Unlimited';

  const numeric = Number(value);
  const micros = Number.isFinite(numeric) ? numeric : parseSystemdTimeToMicros(value);
  if (micros !== null && micros >= 0) {
    const percent = (micros / 1_000_000) * 100;
    return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
  }

  return String(value);
}

function detailPair(label, value, className = '') {
  return `
    <div class="service-detail-row ${className}">
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderServiceDetails(details) {
  if (!details?.available) {
    return `<p class="service-detail-unavailable">${escapeHtml(details?.message || 'Details unavailable')}</p>`;
  }

  const resources = details.resources || {};
  const state = [details.activeState, details.subState].filter(Boolean).join(' / ') || 'Unknown';
  const memory = `${formatBytes(resources.memoryCurrent)} / ${formatBytesLimit(resources.memoryMax)}`;
  const tasks = `${formatNumber(resources.tasksCurrent, 'No reading')} / ${formatTasksLimit(resources.tasksMax)}`;

  return `
    <dl class="service-detail-list">
      ${detailPair('State', state)}
      ${detailPair('PID', formatNumber(details.mainPid))}
      ${detailPair('Memory', memory)}
      ${detailPair('CPU time', formatDurationNs(resources.cpuUsageNSec))}
      ${detailPair('CPU limit', formatCpuQuota(resources.cpuQuotaPerSecUSec))}
      ${detailPair('Tasks', tasks)}
      ${detailPair('Restarts', formatNumber(details.restarts, '0'))}
      ${detailPair('Unit file', details.fragmentPath || 'Not loaded', 'is-path')}
    </dl>
  `;
}

function renderServiceActions(svc, scope) {
  const admin = isAdmin(dashboardState.user);
  const disabled = admin ? '' : 'disabled';
  const projectId = svc.project?.id ? `data-project-id="${escapeHtml(svc.project.id)}"` : '';
  const actions = scope === 'global' && svc.name === 'nginx' ? NGINX_SERVICE_ACTIONS : SERVICE_ACTIONS;

  return `
    <div class="service-actions">
      ${actions.map((item) => `
        <button
          type="button"
          data-service="${escapeHtml(svc.name)}"
          data-scope="${escapeHtml(scope)}"
          data-action="${escapeHtml(item.action)}"
          ${projectId}
          class="${escapeHtml(item.className)}"
          ${disabled}
        >${escapeHtml(item.label)}</button>
      `).join('')}
    </div>
  `;
}

function renderLimitForm(svc) {
  if (!isAdmin(dashboardState.user)) return '';

  return `
    <form class="service-limit-form" data-service-limit-form data-service="${escapeHtml(svc.name)}">
      <label>
        <span>CPU</span>
        <input name="cpuQuota" type="text" placeholder="50% or infinity">
      </label>
      <label>
        <span>Memory</span>
        <input name="memoryMax" type="text" placeholder="512M or infinity">
      </label>
      <label>
        <span>Tasks</span>
        <input name="tasksMax" type="text" placeholder="128 or infinity">
      </label>
      <button type="submit" class="ghost-button">Apply limits</button>
    </form>
  `;
}

function renderServiceCard(svc, scope = 'global') {
  const ekafy = scope === 'ekafy';
  const project = svc.project || {};
  const description = svc.details?.description || svc.name;

  return `
    <article class="service-card ${ekafy ? 'is-ekafy' : ''}">
      <header>
        <div class="service-title-group">
          <h4>${escapeHtml(svc.label || svc.name)}</h4>
          <p class="service-unit">${escapeHtml(svc.name)}</p>
        </div>
        ${activeStatusBadge(svc.active)}
      </header>
      ${ekafy
        ? `<p class="service-project">${escapeHtml(project.name || 'Project')} <span>${escapeHtml(project.slug || '')}</span></p>`
        : `<p class="service-project">${escapeHtml(description)}</p>`}
      ${renderServiceDetails(svc.details)}
      ${renderServiceActions(svc, scope)}
      ${ekafy ? renderLimitForm(svc) : ''}
    </article>
  `;
}

function renderEmptyServices(message) {
  return `<p class="message">${escapeHtml(message)}</p>`;
}

export async function loadServices() {
  const globalGrid = document.getElementById('servicesGrid');
  const ekafyGrid = document.getElementById('ekafyServicesGrid');
  if (!globalGrid) return;

  globalGrid.innerHTML = renderEmptyServices('Loading services...');
  if (ekafyGrid) ekafyGrid.innerHTML = renderEmptyServices('Loading EKAFY services...');

  try {
    const [globalData, ekafyData] = await Promise.all([
      api('/api/services'),
      ekafyGrid ? api('/api/services/ekafy') : Promise.resolve({ services: [] })
    ]);

    globalGrid.innerHTML = globalData.services?.length
      ? globalData.services.map((svc) => renderServiceCard(svc, 'global')).join('')
      : renderEmptyServices('No global services found.');

    if (ekafyGrid) {
      ekafyGrid.innerHTML = ekafyData.services?.length
        ? ekafyData.services.map((svc) => renderServiceCard(svc, 'ekafy')).join('')
        : renderEmptyServices('No EKAFY project services linked yet.');
    }
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, 'Loading services');
    globalGrid.innerHTML = renderEmptyServices(error.message);
    if (ekafyGrid) ekafyGrid.innerHTML = renderEmptyServices(error.message);
  }
}

export async function refreshServiceStatuses() {
  await loadServices();
}

export async function runServiceAction(serviceName, action, context = {}) {
  const msg = document.getElementById('serviceMessage');
  const scope = context.scope || 'global';
  if (msg) msg.textContent = `Running ${action} on ${serviceName}...`;

  try {
    const encodedName = encodeURIComponent(serviceName);
    const endpoint = scope === 'ekafy'
      ? `/api/projects/${context.projectId}/services/${encodedName}/${action}`
      : `/api/services/${encodedName}/${action}`;

    const data = await api(endpoint, { method: 'POST' });
    if (msg) msg.textContent = data.message;
    await loadServices();
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, `${action} ${serviceName}`);
    if (msg) msg.textContent = error.message;
  }
}

export async function saveEkafyServiceLimits(form) {
  const serviceName = form.dataset.service;
  const msg = document.getElementById('serviceMessage');
  const body = {};

  ['cpuQuota', 'memoryMax', 'tasksMax'].forEach((name) => {
    const value = form.elements[name]?.value.trim();
    if (value) body[name] = value;
  });

  if (!Object.keys(body).length) {
    if (msg) msg.textContent = 'Enter at least one limit value.';
    return;
  }

  if (msg) msg.textContent = `Updating limits for ${serviceName}...`;

  try {
    const data = await api(`/api/services/ekafy/${encodeURIComponent(serviceName)}/limits`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });

    form.reset();
    if (msg) msg.textContent = data.message;
    await loadServices();
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, `Update limits for ${serviceName}`);
    if (msg) msg.textContent = error.message;
  }
}
