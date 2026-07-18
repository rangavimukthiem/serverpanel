let activeDialog = null;

function ensureDialogRoot() {
  let root = document.getElementById('confirmDialogRoot');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'confirmDialogRoot';
  root.className = 'confirm-dialog-overlay';
  root.hidden = true;
  root.innerHTML = `
    <section class="confirm-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="confirmDialogTitle" aria-describedby="confirmDialogMessage">
      <div class="confirm-dialog-header">
        <div>
          <p class="eyebrow" id="confirmDialogEyebrow">Confirm action</p>
          <h3 id="confirmDialogTitle">Are you sure?</h3>
        </div>
        <button type="button" class="ghost-button confirm-dialog-close" aria-label="Close dialog">&times;</button>
      </div>
      <p class="confirm-dialog-message" id="confirmDialogMessage"></p>
      <div class="confirm-dialog-actions">
        <button type="button" class="ghost-button" data-confirm-cancel>Cancel</button>
        <button type="button" data-confirm-accept>Confirm</button>
      </div>
    </section>
  `;
  document.body.appendChild(root);
  return root;
}

function finishDialog(result) {
  if (!activeDialog) return;

  const { root, previousFocus, resolve, keyHandler } = activeDialog;
  document.removeEventListener('keydown', keyHandler);
  root.hidden = true;
  document.body.classList.remove('has-confirm-dialog');
  activeDialog = null;

  if (previousFocus && typeof previousFocus.focus === 'function') {
    previousFocus.focus();
  }

  resolve(result);
}

export function confirmDialog({
  eyebrow = 'Confirm action',
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger'
} = {}) {
  if (activeDialog) {
    finishDialog(false);
  }

  const root = ensureDialogRoot();
  const previousFocus = document.activeElement;
  const panel = root.querySelector('.confirm-dialog-panel');
  const titleEl = root.querySelector('#confirmDialogTitle');
  const eyebrowEl = root.querySelector('#confirmDialogEyebrow');
  const messageEl = root.querySelector('#confirmDialogMessage');
  const closeBtn = root.querySelector('.confirm-dialog-close');
  const cancelBtn = root.querySelector('[data-confirm-cancel]');
  const acceptBtn = root.querySelector('[data-confirm-accept]');

  eyebrowEl.textContent = eyebrow;
  titleEl.textContent = title;
  messageEl.textContent = message;
  cancelBtn.textContent = cancelLabel;
  acceptBtn.textContent = confirmLabel;
  acceptBtn.className = variant === 'danger' ? 'danger-button' : variant === 'warning' ? 'warn-button' : '';

  root.hidden = false;
  document.body.classList.add('has-confirm-dialog');

  return new Promise((resolve) => {
    const keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishDialog(false);
      }
      if (event.key === 'Tab') {
        const focusable = Array.from(panel.querySelectorAll('button:not([disabled])'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    activeDialog = { root, previousFocus, resolve, keyHandler };
    document.addEventListener('keydown', keyHandler);

    closeBtn.onclick = () => finishDialog(false);
    cancelBtn.onclick = () => finishDialog(false);
    acceptBtn.onclick = () => finishDialog(true);
    root.onclick = (event) => {
      if (event.target === root) finishDialog(false);
    };

    acceptBtn.focus();
  });
}
