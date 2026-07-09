export function redirectOnAuthError(error) {
  if (error?.status === 401) {
    window.location.href = '/login.html';
    return true;
  }

  return false;
}

export function clearSession(state) {
  if (state) {
    state.user = null;
  }
}

export function isAdmin(user) {
  return user?.role === 'admin';
}
