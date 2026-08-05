import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';

async function bootLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const query = new URLSearchParams(window.location.search);
  const oauthError = query.get('oauth_error');
  const initialMessage = document.getElementById('authMessage');
  if (oauthError && initialMessage) initialMessage.textContent = oauthError;

  api('/api/auth/google/status')
    .then(({ enabled }) => {
      const section = document.getElementById('googleAuthSection');
      if (section) section.hidden = !enabled;
    })
    .catch(() => {});

  api('/api/auth/me')
    .then(() => {
      window.location.href = '/dashboard.html';
    })
    .catch(() => {});

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('authMessage');
    if (message) {
      message.textContent = 'Signing in...';
    }

    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value
        })
      });

      window.location.href = '/dashboard.html';
    } catch (error) {
      reportGlobalError(error, 'Signing in');
      if (message) {
        message.textContent = error.message;
      }
    }
  });
}

bootLogin();
