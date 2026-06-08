import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

export default function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const goAfterLogin = loc.state?.from?.pathname || '/';

  useEffect(() => {
    if (me) navigate(goAfterLogin, { replace: true });
  }, [me, navigate, goAfterLogin]);

  const submit = async (e) => {
    e.preventDefault();
    if (!username || !password) { toast('請輸入帳號密碼', 'error'); return; }
    setBusy(true);
    const r = await login(username.trim(), password);
    setBusy(false);
    if (!r.ok) { toast(r.error || '登入失敗', 'error'); return; }
    toast('登入成功', 'success');
    navigate(goAfterLogin, { replace: true });
  };

  return (
    <div className="container" style={{ paddingTop: 60, maxWidth: 420 }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <img src="/logo.jpg" alt="上鎧鋼鐵" style={{ height: 60 }} />
        <h1 style={{ fontSize: 18, marginTop: 12 }}>上鎧鋼鐵 工單系統</h1>
      </div>
      <form className="card" onSubmit={submit} autoComplete="off">
        <label>帳號</label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoCapitalize="none"
          autoComplete="username"
          autoFocus
        />
        <label>密碼</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button
          type="submit"
          className="btn-primary btn-block"
          style={{ marginTop: 20 }}
          disabled={busy}
        >
          {busy ? '登入中...' : '登入'}
        </button>
      </form>
    </div>
  );
}
