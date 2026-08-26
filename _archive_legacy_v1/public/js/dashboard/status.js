import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { formatUptime, setMeter } from '../shared/dom.js';
import { redirectOnAuthError } from '../shared/auth.js';

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? '--';
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';
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

function formatServerTime(serverTime) {
  const date = serverTime?.iso ? new Date(serverTime.iso) : null;
  if (!date || Number.isNaN(date.getTime())) return 'N/A';

  try {
    return date.toLocaleString(undefined, {
      timeZone: serverTime.timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (_error) {
    return date.toLocaleString();
  }
}

function formatPlatform(server = {}) {
  return [server.platform, server.release, server.arch].filter(Boolean).join(' ') || 'N/A';
}

function formatProjectKinds(projects) {
  const kinds = projects?.byKind || {};
  const parts = [
    ['Static', kinds.static],
    ['API', kinds.api],
    ['DB', kinds.database],
    ['Full', kinds.full]
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${label} ${Number(value)}`);

  return parts.length ? parts.join(' / ') : 'None';
}

function formatLoadAverage(loadAverage = []) {
  if (!Array.isArray(loadAverage) || !loadAverage.length) return 'N/A';
  return loadAverage
    .slice(0, 3)
    .map((value) => Number(value).toFixed(2))
    .join(' / ');
}

export async function loadStatus() {
  const data = await api('/api/system/status');
  const cpu = Number(data.cpu);
  const ram = Number(data.ram);
  const disk = data.disk === null ? null : Number(data.disk);

  const cpuValue = document.getElementById('cpuValue');
  const ramValue = document.getElementById('ramValue');
  const diskValue = document.getElementById('diskValue');
  const uptimeValue = document.getElementById('uptimeValue');

  if (cpuValue) cpuValue.textContent = Number.isFinite(cpu) ? `${cpu}%` : 'N/A';
  if (ramValue) ramValue.textContent = Number.isFinite(ram) ? `${ram}%` : 'N/A';
  if (diskValue) diskValue.textContent = disk === null || !Number.isFinite(disk) ? 'N/A' : `${disk}%`;
  if (uptimeValue) uptimeValue.textContent = formatUptime(data.uptime);

  setMeter('cpuMeter', cpu);
  setMeter('ramMeter', ram);
  setMeter('diskMeter', disk || 0);

  const server = data.server || {};
  const memory = data.memory || {};
  const diskDetails = data.diskDetails || {};
  const projects = data.projects || {};

  setText('serverIpValue', server.primaryIp || 'N/A');
  setText('serverHostValue', server.hostname || 'N/A');
  setText('panelHostValue', server.panelHost || 'N/A');
  setText('serverOsValue', formatPlatform(server));
  setText('nodeVersionValue', server.nodeVersion || 'N/A');

  setText('projectCountValue', Number(projects.total || 0));
  setText('activeProjectsValue', Number(projects.active || 0));
  setText('inactiveProjectsValue', Number(projects.inactive || 0));
  setText('provisionedProjectsValue', Number(projects.provisioned || 0));
  setText('projectKindValue', formatProjectKinds(projects));

  setText('serverTimeValue', formatServerTime(data.serverTime));
  setText('timezoneValue', data.serverTime?.timezone || server.timezone || 'N/A');
  setText('cpuDetailValue', `${server.cpuCount || 'N/A'} cores${server.cpuModel ? ` / ${server.cpuModel}` : ''}`);
  setText('memoryDetailValue', `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`);
  setText('diskDetailValue', diskDetails.size ? `${formatBytes(diskDetails.used)} / ${formatBytes(diskDetails.size)} (${diskDetails.percent}%)` : 'N/A');
  setText('loadAverageValue', formatLoadAverage(server.loadAverage));

  const refreshPill = document.getElementById('refreshPill');
  if (refreshPill) refreshPill.textContent = 'Auto-refresh 5s';
}

export function handleStatusError(error, context, options = {}) {
  if (redirectOnAuthError(error)) {
    return true;
  }

  [
    'cpuValue',
    'ramValue',
    'diskValue',
    'serverIpValue',
    'serverHostValue',
    'panelHostValue',
    'serverOsValue',
    'nodeVersionValue',
    'projectCountValue',
    'activeProjectsValue',
    'inactiveProjectsValue',
    'provisionedProjectsValue',
    'projectKindValue',
    'serverTimeValue',
    'timezoneValue',
    'cpuDetailValue',
    'memoryDetailValue',
    'diskDetailValue',
    'loadAverageValue'
  ].forEach((id) => setText(id, 'ERR'));
  setMeter('cpuMeter', 0);
  setMeter('ramMeter', 0);
  setMeter('diskMeter', 0);

  const refreshPill = document.getElementById('refreshPill');
  if (refreshPill) refreshPill.textContent = 'Status unavailable';

  if (options.silent) {
    console.warn(context, error);
    return false;
  }

  reportGlobalError(error, context);
  return false;
}
