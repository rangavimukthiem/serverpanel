import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { formatUptime, setMeter } from '../shared/dom.js';
import { redirectOnAuthError } from '../shared/auth.js';

export async function loadStatus() {
  const data = await api('/api/system/status');

  const cpuValue = document.getElementById('cpuValue');
  const ramValue = document.getElementById('ramValue');
  const diskValue = document.getElementById('diskValue');
  const uptimeValue = document.getElementById('uptimeValue');

  if (cpuValue) cpuValue.textContent = `${data.cpu}%`;
  if (ramValue) ramValue.textContent = `${data.ram}%`;
  if (diskValue) diskValue.textContent = data.disk === null ? 'N/A' : `${data.disk}%`;
  if (uptimeValue) uptimeValue.textContent = formatUptime(data.uptime);

  setMeter('cpuMeter', data.cpu);
  setMeter('ramMeter', data.ram);
  setMeter('diskMeter', data.disk || 0);
}

export function handleStatusError(error, context) {
  if (redirectOnAuthError(error)) {
    return true;
  }

  reportGlobalError(error, context);
  return false;
}
