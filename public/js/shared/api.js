import { ApiError } from './errors.js';

export async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include'
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      data.message || 'Request failed',
      response.status,
      data.code || 'REQUEST_FAILED',
      data.details || null
    );
  }

  return data;
}
