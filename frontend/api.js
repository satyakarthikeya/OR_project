/**
 * One thin wrapper per endpoint. The Pydantic schemas in backend/schemas are the
 * contract (AGENT.md); nothing here reshapes a response, so a schema change
 * surfaces in the UI rather than being quietly patched over.
 *
 * Served same-origin by FastAPI's StaticFiles mount, so requests are relative
 * and no CORS handling is needed. Opening this file from disk will not work.
 */
(function () {
  'use strict';

  /** Errors that carry the API's own status code and detail. */
  class ApiError extends Error {
    constructor(message, status, detail) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.detail = detail;
    }
  }

  function describe(status, payload) {
    const detail = payload && payload.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      // FastAPI validation errors: surface the field that failed.
      return detail
        .map((d) => `${(d.loc || []).slice(1).join('.') || 'input'}: ${d.msg}`)
        .join('; ');
    }
    if (detail && detail.errors) return detail.errors.join('; ');
    return `Request failed with status ${status}`;
  }

  async function request(path, options) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (cause) {
      throw new ApiError(
        'Cannot reach the API. Is the server still running?', 0, cause
      );
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new ApiError(describe(response.status, payload), response.status, payload);
    }
    return payload;
  }

  const get = (path) => request(path, { method: 'GET' });

  const post = (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  window.api = {
    ApiError,

    health: () => get('/api/health'),

    loadBundledDataset: () => post('/api/datasets/bundled', {}),

    uploadDataset: (file) => {
      const form = new FormData();
      form.append('file', file);
      return request('/api/datasets', { method: 'POST', body: form });
    },

    datasetSummary: (datasetId) => get(`/api/datasets/${datasetId}/summary`),

    lpParameters: (body) => post('/api/lp/parameters', body),
    lpSolve: (body) => post('/api/lp/solve', body),
    lpSensitivity: (body) => post('/api/lp/sensitivity', body),

    ipBatch: (body) => post('/api/ip/batch', body),
    ipSolve: (body) => post('/api/ip/solve', body),
  };
})();
