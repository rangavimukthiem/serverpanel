import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { escapeHtml } from '../shared/dom.js';
import { redirectOnAuthError, isAdmin } from '../shared/auth.js';
import { dashboardState } from './state.js';
import { services } from './constants.js';

export async function loadServiceStatus(name) {
  const statusNode = document.querySelector(`[data-service-status="${name}"]`);
  if (!statusNode) return;

  try {
    const data = await api(`/api/services/${name}/status`);
    if (data.active === null) {
      statusNode.textContent = 'Unavailable';
    } else {
      statusNode.textContent = data.active ? 'Active' : 'Inactive';
    }
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportGlobalError(error, `Loading service status for ${name}`);
    statusNode.textContent = error.message;
  }
}

export function refreshServiceStatuses() {
  services.forEach(loadServiceStatus);
}

export function renderServices() {
  const grid = document.getElementById('servicesGrid');
  if (!grid) return;

  grid.innerHTML = services.map((service) => `
    <article class="service-card">
      <header>
        <h4>${escapeHtml(service)}</h4>
        <span class="service-status" data-service-status="${service}">Checking</span>
      </header>
      <div class="service-actions">
        <button type="button" data-service="${service}" data-action="start" ${isAdmin(dashboardState.user) ? '' : 'disabled'}>Start</button>
        <button class="restart" type="button" data-service="${service}" data-action="restart" ${isAdmin(dashboardState.user) ? '' : 'disabled'}>Restart</button>
        <button class="stop" type="button" data-service="${service}" data-action="stop" ${isAdmin(dashboardState.user) ? '' : 'disabled'}>Stop</button>
      </div>
    </article>
  `).join('');

  refreshServiceStatuses();
}

export async function runServiceAction(service, action) {
  const message = document.getElementById('serviceMessage');
  if (!message) return;

  message.textContent = `Running ${action} on ${service}...`;

  try {
    const data = await api(`/api/services/${service}/${action}`, { method: 'POST' });
    message.textContent = data.message;
    await loadServiceStatus(service);
  } catch (error) {
    if (redirectOnAuthError(error)) {
      return;
    }
    reportGlobalError(error, `Running ${action} on ${service}`);
    message.textContent = error.message;
  }
}
