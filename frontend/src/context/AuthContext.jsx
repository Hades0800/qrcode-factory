import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // me 從 localStorage 啟動值 — 避免重整時閃白
  const [me, setMeState] = useState(() => {
    try {
      const raw = localStorage.getItem('me');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  const setMe = useCallback((leader) => {
    setMeState(leader);
    if (leader) localStorage.setItem('me', JSON.stringify(leader));
    else localStorage.removeItem('me');
  }, []);

  // 載入後跟後端 /me 對一次，拿最新 permissions
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (!getToken()) { setLoading(false); return; }
      const r = await api('/api/auth/me');
      if (cancelled) return;
      if (r.ok && r.data?.leader) {
        setMe({ ...me, ...r.data.leader });
      } else if (r.status === 401) {
        // token 失效 → 清除
        setToken(null);
        setMe(null);
      }
      setLoading(false);
    }
    refresh();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (!r.ok) return { ok: false, error: r.error };
    setToken(r.data.token);
    setMe(r.data.leader);
    return { ok: true };
  }, [setMe]);

  const logout = useCallback(() => {
    setToken(null);
    setMe(null);
    localStorage.removeItem('token');
    localStorage.removeItem('me');
  }, [setMe]);

  return (
    <AuthContext.Provider value={{ me, loading, login, logout, setMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 AuthProvider 內');
  return ctx;
}
