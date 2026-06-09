import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { hasPermission, rolesDisplay } from '../lib/permissions';

export default function Layout() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = (e) => {
    e.preventDefault();
    if (!window.confirm('登出？')) return;
    logout();
    navigate('/login');
  };

  // 各 nav 連結對應的權限（沒權限就不顯示）
  const navItems = [
    { to: '/',           label: '生產實態紀錄', show: true },
    { to: '/records',    label: '歷史實態紀錄', show: hasPermission(me, 'view_records') },
    { to: '/realtime',   label: '即時生產資訊', show: true },
    { to: '/plan-stats', label: '計畫達成統計', show: hasPermission(me, 'view_plan_stats') },
    { to: '/goal-stats', label: '目標達成統計', show: hasPermission(me, 'view_goal_stats') },
    { to: '/upload',     label: '📤 上傳',     show: hasPermission(me, 'upload') },
    { to: '/machines',   label: '🏷 機台 QR Code', show: true },
    { to: '/qrcodes',    label: '🏷 工項 QR Code', show: true },
    { to: '/admin',      label: '⚙ 管理',     show: hasPermission(me, 'manage_accounts') },
  ];

  return (
    <>
      <header className="app-header">
        <div className="brand-wrap">
          <img src="/logo.jpg" alt="上鎧鋼鐵" />
          <div className="brand-text">
            <div className="title">上鎧鋼鐵 工單系統</div>
            <div className="sub">
              {me ? me.displayName + '（' + rolesDisplay(me) + '）' : '未登入'}
            </div>
          </div>
        </div>
        <button className="menu-toggle" onClick={() => setOpen(o => !o)}>☰</button>
      </header>

      {open && (
        <div className="dropdown-menu" onClick={() => setOpen(false)}>
          {navItems.filter(i => i.show).map(i => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.to === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {i.label}
            </NavLink>
          ))}
          <div className="menu-sep" />
          <a href="#" onClick={handleLogout} style={{ color: 'var(--muted)' }}>登出</a>
        </div>
      )}

      <main>
        <Outlet />
      </main>
    </>
  );
}
