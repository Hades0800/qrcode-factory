import type { Me } from '../api/types'
import { LOGIN_PAGE } from './config'

// 登入狀態與舊頁面共用同一份 localStorage（key: token / me），
// 使用者在舊頁登入後進到 React 頁不需重新登入，反之亦然。

export function getToken(): string {
  return localStorage.getItem('token') || ''
}

export function getMe(): Me | null {
  try {
    return JSON.parse(localStorage.getItem('me') || 'null')
  } catch {
    return null
  }
}

export function clearSession(): void {
  localStorage.removeItem('token')
  localStorage.removeItem('me')
}

export function goToLogin(): void {
  location.href = LOGIN_PAGE
}

// 對應舊版 utils.js 的 requireLogin()：未登入就導回登入頁
export function requireLogin(): Me | null {
  const token = getToken()
  const me = getMe()
  if (!token || !me) {
    alert('請先登入')
    goToLogin()
    return null
  }
  return me
}
