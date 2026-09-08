/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { setTokenHeader } from './headers-helpers';
import * as endpoints from './api-endpoints';
import type * as t from './types';

async function _get<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response.data;
}

async function _getResponse<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  return await axios.get(url, { ...options });
}

/* === VIVENTIUM START ===
 * Permit scoped Axios request options without changing other request deadlines.
 */
async function _post(url: string, data?: any, options?: AxiosRequestConfig) {
  const response = await axios.post(url, JSON.stringify(data), {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}
/* === VIVENTIUM END === */

async function _postMultiPart(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

async function _postTTS(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function _put(url: string, data?: any) {
  const response = await axios.put(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _delete<T>(url: string): Promise<T> {
  const response = await axios.delete(url);
  return response.data;
}

async function _deleteWithOptions<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.delete(url, { ...options });
  return response.data;
}

async function _patch(url: string, data?: any) {
  const response = await axios.patch(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

let isRefreshing = false;
let failedQueue: { resolve: (value?: any) => void; reject: (reason?: any) => void }[] = [];

/* === VIVENTIUM START ===
 * A session check must settle so the existing auth retry lifecycle can recover.
 */
const refreshToken = (retry?: boolean): Promise<t.TRefreshTokenResponse | undefined> =>
  _post(endpoints.refreshToken(retry), undefined, { timeout: 15_000 });
/* === VIVENTIUM END === */

const dispatchTokenUpdatedEvent = (token: string) => {
  setTokenHeader(token);
  window.dispatchEvent(new CustomEvent('tokenUpdated', { detail: token }));
};

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

if (typeof window !== 'undefined') {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      if (!error.response) {
        return Promise.reject(error);
      }

      if (originalRequest.url?.includes('/api/auth/2fa') === true) {
        return Promise.reject(error);
      }
      if (originalRequest.url?.includes('/api/auth/logout') === true) {
        return Promise.reject(error);
      }
      /* === VIVENTIUM START ===
       * A rejected refresh must settle its waiting requests, never join its own queue.
       */
      if (originalRequest.url?.split('?')[0] === endpoints.refreshToken()) {
        return Promise.reject(error);
      }
      /* === VIVENTIUM END === */

      /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
       *  but allow shared link requests to proceed so auth recovery/redirect can happen */
      if (
        !axios.defaults.headers.common['Authorization'] &&
        !window.location.pathname.startsWith('/share/')
      ) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && !originalRequest._retry) {
        console.warn('401 error, refreshing token');
        originalRequest._retry = true;

        if (isRefreshing) {
          try {
            const token = await new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            });
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            return await axios(originalRequest);
          } catch (err) {
            return Promise.reject(err);
          }
        }

        isRefreshing = true;

        try {
          const response = await refreshToken();

          const token = response?.token ?? '';

          if (token) {
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            dispatchTokenUpdatedEvent(token);
            processQueue(null, token);
            return await axios(originalRequest);
          } else {
            processQueue(error, null);
            window.location.href = endpoints.apiBaseUrl() + endpoints.buildLoginRedirectUrl();
          }
        } catch (err) {
          processQueue(err as AxiosError, null);
          return Promise.reject(err);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    },
  );
}

export default {
  get: _get,
  getResponse: _getResponse,
  post: _post,
  postMultiPart: _postMultiPart,
  postTTS: _postTTS,
  put: _put,
  delete: _delete,
  deleteWithOptions: _deleteWithOptions,
  patch: _patch,
  refreshToken,
  dispatchTokenUpdatedEvent,
};
