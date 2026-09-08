import axios from 'axios';

import { apiConfig } from './api-config';
import { getCsrfToken } from './bff-session';

export function createApiClient() {
  const client = axios.create({
    baseURL: apiConfig.getUrl(),
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // No Authorization header: the session rides an httpOnly cookie the browser
  // attaches itself (`withCredentials` above), and the token it stands for
  // never reaches this code. A cookie is sent on cross-site requests too, so
  // state-changing calls carry a CSRF token the API checks against the session.
  client.interceptors.request.use((config) => {
    const method = (config.method ?? 'get').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = getCsrfToken();
      if (csrf) config.headers['x-csrf-token'] = csrf;
    }
    return config;
  });

  return client;
}
