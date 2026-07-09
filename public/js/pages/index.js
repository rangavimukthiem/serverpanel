import { api } from '../shared/api.js';

async function bootIndex() {
  try {
    await api('/api/auth/me');
    window.location.href = '/dashboard.html';
  } catch (_error) {
    window.location.href = '/login.html';
  }
}

bootIndex();
