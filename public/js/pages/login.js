import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { initThemeSelector } from '../shared/theme.js';

initThemeSelector();

async function bootLogin() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  const query = new URLSearchParams(window.location.search);
  const oauthError = query.get('oauth_error');
  const initialMessage = document.getElementById('authMessage');
  if (oauthError && initialMessage) initialMessage.textContent = oauthError;

  const googleButton = document.getElementById('googleAuthButton');
  const googleMessage = document.getElementById('googleAuthMessage');
  const setGoogleAvailability = (enabled, message = '') => {
    if (googleButton) {
      googleButton.setAttribute('aria-disabled', String(!enabled));
      googleButton.tabIndex = enabled ? 0 : -1;
    }
    if (googleMessage) {
      googleMessage.textContent = message;
      googleMessage.hidden = !message;
    }
  };

  googleButton?.addEventListener('click', (event) => {
    if (googleButton.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });

  api('/api/auth/google/status')
    .then(({ enabled }) => setGoogleAvailability(
      enabled,
      enabled ? '' : 'Google sign-in has not been configured by the administrator.'
    ))
    .catch(() => setGoogleAvailability(false, 'Google sign-in availability could not be checked.'));

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
