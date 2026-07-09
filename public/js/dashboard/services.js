/**
 * services.js — Global services panel.
 * Fetches the service list from GET /api/services instead of a hardcoded constant.
 */

import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError, isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';

// ── Render ────────────────────────────────────────────────────────────────────

function activeStatusBadge(active) {
  if (active === null) return '<span class="service-status unknown">Unavailable</span>';
  return active
    ? '<span class="service-status active">Active</span>'
    : '<span class="service-status inactive">Inactive</span>';
}

function renderServiceCard(svc) {
  const admin    = isAdmin(dashboardState.user);
  const disabled = admin ? '' : 'disabled';
  return `
    <article class="service-card">
      <header>
        <h4>${escapeHtml(svc.label || svc.name)}</h4>
        ${activeStatusBadge(svc.active)}
      </header>
      <div class="service-actions">
        <button type="button" data-service="${escapeHtml(svc.name)}" data-action="start"   ${disabled}>Start</button>
        <button type="button" data-service="${escapeHtml(svc.name)}" data-action="restart" class="restart" ${disabled}>Restart</button>
        <button type="button" data-service="${escapeHtml(svc.name)}" data-action="stop"    class="stop"    ${disabled}>Stop</button>
      </div>
    </article>
  `;
}

// ── Load from API ─────────────────────────────────────────────────────────────

export async function loadServices() {
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;

  try {
    const data = await api('/api/services');
    grid.innerHTML = data.services.map(renderServiceCard).join('');
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, 'Loading services');
    grid.innerHTML = `<p class="message">${escapeHtml(error.message)}</p>`;
  }
}

// ── Refresh individual status ─────────────────────────────────────────────────

export async function refreshServiceStatuses() {
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;

  // Get all service names currently rendered
  const names = Array.from(grid.querySelectorAll('[data-service][data-action="start"]'))
    .map((btn) => btn.dataset.service)
    .filter(Boolean);

  await Promise.all(names.map(async (name) => {
    try {
      const data = await api(`/api/services/${name}/status`);
      // Find the badge inside the card for this service and update it
      const card = grid.querySelector(`[data-service="${name}"]`)?.closest('.service-card');
      if (!card) return;
      const badge = card.querySelector('.service-status');
      if (!badge) return;
      if (data.active === null) {
        badge.textContent = 'Unavailable'; badge.className = 'service-status unknown';
      } else if (data.active) {
        badge.textContent = 'Active';      badge.className = 'service-status active';
      } else {
        badge.textContent = 'Inactive';    badge.className = 'service-status inactive';
      }
    } catch (_) { /* skip individual failures */ }
  }));
}

// ── Service action ────────────────────────────────────────────────────────────

export async function runServiceAction(serviceName, action) {
  const msg = document.getElementById('serviceMessage');
  if (msg) msg.textContent = `Running ${action} on ${serviceName}…`;

  try {
    const data = await api(`/api/services/${serviceName}/${action}`, { method: 'POST' });
    if (msg) msg.textContent = data.message;
    await refreshServiceStatuses();
  } catch (error) {
    if (redirectOnAuthError(error)) return;
    reportGlobalError(error, `${action} ${serviceName}`);
    if (msg) msg.textContent = error.message;
  }
}
