import { ApiError } from './errors.js';

export async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: 'include'
    });
  } catch (error) {
    throw new ApiError(
      'Cannot reach server',
      0,
      'NETWORK_ERROR',
      error?.message || null
    );
  }

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
