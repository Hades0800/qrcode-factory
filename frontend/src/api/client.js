// API 統一入口 — 從 .env 讀 base URL，自動帶 token、處理錯誤格式
const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';

export function getToken() {
  return localStorage.getItem('token');
}
export function setToken(t) {
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  const token = getToken();
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    return { ok: false, status: 0, error: '無法連線到伺服器' };
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const error = (data && (data.error || (typeof data.detail === 'string' ? data.detail : null))) || res.statusText;
    return { ok: false, status: res.status, error, data };
  }
  return { ok: true, status: res.status, data };
}
