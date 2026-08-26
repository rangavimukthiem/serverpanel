export class ApiError extends Error {
  constructor(message, status = 500, code = 'REQUEST_FAILED', details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function ensureGlobalMessageBar() {
  let bar = document.getElementById('globalMessageBar');

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'globalMessageBar';
    bar.className = 'global-message-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML = `
      <span class="global-message-text"></span>
      <button type="button" class="global-message-close" aria-label="Dismiss message">&times;</button>
    `;
    document.body.prepend(bar);
  }

  return bar;
}

export function hideGlobalMessage() {
  const bar = document.getElementById('globalMessageBar');
  if (!bar) return;

  bar.className = 'global-message-bar';
  bar.hidden = true;
  document.body.classList.remove('has-global-message');
}

export function showGlobalMessage(message, variant = 'error', details = null) {
  const bar = ensureGlobalMessageBar();
  const text = bar.querySelector('.global-message-text');
  const closeButton = bar.querySelector('.global-message-close');
  const detailText = details ? ` ${details}` : '';

  bar.hidden = false;
  bar.dataset.variant = variant;
  bar.className = `global-message-bar is-visible is-${variant}`;
  text.textContent = `${message}${detailText}`;
  bar.title = details ? `${message}\n${details}` : message;
  document.body.classList.add('has-global-message');

  closeButton.onclick = () => hideGlobalMessage();
}

function formatErrorDetails(error) {
  if (!error) return '';

  const parts = [];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.status) parts.push(`status=${error.status}`);
  if (error.details && typeof error.details === 'object') {
    parts.push(`details=${JSON.stringify(error.details)}`);
  } else if (error.details) {
    parts.push(`details=${String(error.details)}`);
  }

  return parts.join(' | ');
}

export function reportGlobalError(error, context = '') {
  const message = error?.message || 'Request failed';
  const details = formatErrorDetails(error);
  const prefix = context ? `${context}: ` : '';

  console.error(context || 'App error', error);
  showGlobalMessage(`${prefix}${message}`, 'error', details);
}
