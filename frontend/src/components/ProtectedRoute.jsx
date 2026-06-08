import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { hasPermission } from '../lib/permissions';

export default function ProtectedRoute({ children, permission }) {
  const { me, loading } = useAuth();
  const loc = useLocation();

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>載入中...</div>;
  }
  if (!me) {
    return <Navigate to="/login" state={{ from: loc }} replace />;
  }
  if (permission && !hasPermission(me, permission)) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <h2 style={{ color: 'var(--brand)' }}>沒有權限</h2>
        <p className="muted">此頁需要「{permission}」權限</p>
      </div>
    );
  }
  return children;
}
