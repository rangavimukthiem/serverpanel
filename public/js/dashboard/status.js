import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { formatUptime, setMeter } from '../shared/dom.js';
import { redirectOnAuthError } from '../shared/auth.js';

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

  const refreshPill = document.getElementById('refreshPill');
  if (refreshPill) refreshPill.textContent = 'Auto-refresh 5s';
}

export function handleStatusError(error, context, options = {}) {
  if (redirectOnAuthError(error)) {
    return true;
  }

  ['cpuValue', 'ramValue', 'diskValue'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = 'ERR';
  });
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
