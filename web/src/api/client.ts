import { API_URL } from '../utils/config'
import { clearSession, getToken, goToLogin } from '../utils/auth'

// 對應舊版 utils.js 的 api()，加上型別。
// 回傳判別聯集：ok=true 帶 data；ok=false 帶 error。

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; error: string; data?: unknown }

export interface ApiOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  try {
    const token = getToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers || {}) }
    if (token) headers['Authorization'] = 'Bearer ' + token
    const method = (options.method || 'GET').toUpperCase()

    // fastify 對 POST/PUT/PATCH 若 Content-Type 是 application/json 但 body 空會報錯，
    // 沒帶 body 時自動補空物件（與舊版行為一致）。
    let body: string | undefined
    if (options.body !== undefined && options.body !== null) {
      body = JSON.stringify(options.body)
    } else if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
      body = '{}'
    }

    const res = await fetch(API_URL + path, { method, headers, body })

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return { ok: false, status: res.status, error: '伺服器回應錯誤' }
    }

    const errOf = (d: unknown, fallback: string): string =>
      (d && typeof d === 'object' && 'error' in d && typeof (d as { error: unknown }).error === 'string')
        ? (d as { error: string }).error
        : fallback

    if (res.status === 401) {
      clearSession()
      alert('登入已逾期')
      goToLogin()
      return { ok: false, status: 401, error: errOf(data, '請重新登入') }
    }
    if (res.status === 403) return { ok: false, status: 403, error: errOf(data, '權限不足'), data }
    if (!res.ok) return { ok: false, status: res.status, error: errOf(data, '操作失敗'), data }
    return { ok: true, data: data as T }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: '網路錯誤：' + msg }
  }
}
