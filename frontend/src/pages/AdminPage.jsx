import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { roleLabel, rolesOf, hasPermission } from '../lib/permissions';
import { fmtDate } from '../lib/format';

const VALID_ROLES = ['admin', 'qc', 'pm', 'tech'];
const ROLE_COLORS = { admin: 'var(--brand)', qc: '#1f6feb', pm: '#f0ad4e', tech: '#666' };

const RECOVERY_PAGE_SIZE = 10;
const AUDIT_PAGE_SIZE = 10;

const recoveryHints = {
  deleted: '整張被刪掉的工單。按「救回」會還原工單 + 所有生產紀錄。',
  reset: '工單仍使用中、但生產紀錄被「重設」軟刪除。按「救回紀錄」會還原那些被軟刪的工序與暫停。',
  cancelled: '被取消的上傳批次。按「救回批次」會回填工單上傳欄位，但會跳過已被新批次填過的欄位。',
};

const ACTION_LABELS = {
  delete_order: '刪除工單',
  reset_production: '重設生產紀錄',
  restore_order: '救回工單',
  restore_records: '救回紀錄',
  cancel_batch: '取消上傳批次',
  restore_batch: '救回上傳批次',
  auto_create_order: '自動建單',
  delete_leader: '刪除帳號',
  create_leader: '新增帳號',
  reset_password: '重設密碼',
  clear_production: '清除生產（舊）',
};
const ACTION_COLORS = {
  delete_order: 'var(--brand)', reset_production: '#f0ad4e', cancel_batch: 'var(--brand)',
  restore_order: 'var(--success)', restore_records: 'var(--success)', restore_batch: 'var(--success)',
  auto_create_order: '#1f6feb',
  delete_leader: 'var(--brand)', create_leader: 'var(--success)', reset_password: '#1f6feb',
};

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const ymd = d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return ymd + ' ' + hm;
}

export default function AdminPage() {
  const toast = useToast();
  const { me } = useAuth();

  const [leaders, setLeaders] = useState([]);
  const [loadingLeaders, setLoadingLeaders] = useState(false);

  // 新增帳號表單
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', roles: ['qc'] });
  const [creating, setCreating] = useState(false);

  // 角色權限矩陣
  const [rolePerm, setRolePerm] = useState(null);   // { permissions, roles }
  const [matrix, setMatrix] = useState({});         // { roleKey: Set(permKey) }
  const [savingPerms, setSavingPerms] = useState(false);
  const [permResult, setPermResult] = useState({ text: '', color: 'var(--muted)' });

  // 回收桶
  const [recoveryTab, setRecoveryTab] = useState('deleted');
  const [recoveryData, setRecoveryData] = useState({ deleted: null, reset: null, cancelled: null });
  const [recoveryPage, setRecoveryPage] = useState({ deleted: 1, reset: 1, cancelled: 1 });
  const [recoveryLoading, setRecoveryLoading] = useState(true);

  // 操作紀錄
  const [auditDays, setAuditDays] = useState('7');
  const [auditLogs, setAuditLogs] = useState(null);
  const [auditLoadedDays, setAuditLoadedDays] = useState('7');
  const [auditPage, setAuditPage] = useState(1);

  // 查單號歷史
  const [findInput, setFindInput] = useState('');
  const [findResult, setFindResult] = useState(null); // { orders, uploadRows } | null
  const [finding, setFinding] = useState(false);

  // 系統工具
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState('');
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState('');

  // ── 帳號 ──
  const loadLeaders = useCallback(async () => {
    setLoadingLeaders(true);
    const r = await api('/api/admin/leaders');
    setLoadingLeaders(false);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); return; }
    setLeaders(r.data.leaders || []);
  }, [toast]);

  const loadRolePerm = useCallback(async () => {
    const r = await api('/api/admin/roles-permissions');
    if (!r.ok) { toast(r.error || '載入權限失敗', 'error'); return; }
    setRolePerm(r.data);
    const m = {};
    r.data.roles.forEach(role => {
      m[role.key] = new Set(role.key === 'admin' ? r.data.permissions.map(p => p.key) : role.permissions);
    });
    setMatrix(m);
  }, [toast]);

  // ── 回收桶 ──
  const loadRecovery = useCallback(async () => {
    setRecoveryLoading(true);
    const [trash, reset, batches] = await Promise.all([
      api('/api/orders/trash'),
      api('/api/admin/orders-with-soft-deleted-records'),
      api('/api/admin/cancelled-upload-batches'),
    ]);
    const deleted = trash.ok ? (trash.data.orders || []) : [];
    const resetArr = reset.ok ? (reset.data.orders || []) : [];
    const cancelled = batches.ok ? (batches.data.batches || []) : [];
    deleted.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
    resetArr.sort((a, b) => new Date(b.lastDeletedAt || 0) - new Date(a.lastDeletedAt || 0));
    cancelled.sort((a, b) => new Date(b.cancelledAt) - new Date(a.cancelledAt));
    setRecoveryData({ deleted, reset: resetArr, cancelled });
    setRecoveryLoading(false);
  }, []);

  // ── 操作紀錄 ──
  const loadAuditLog = useCallback(async (days) => {
    const d = days || auditDays || '7';
    const r = await api('/api/admin/audit-log?days=' + encodeURIComponent(d));
    setAuditLoadedDays(d);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); setAuditLogs([]); return; }
    setAuditLogs(r.data.logs || []);
    setAuditPage(1);
  }, [auditDays, toast]);

  useEffect(() => {
    loadLeaders();
    loadRolePerm();
    loadRecovery();
    loadAuditLog('7');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 新增帳號 ──
  const toggleNewRole = (r) => {
    setNewUser(u => {
      const arr = new Set(u.roles);
      if (arr.has(r)) arr.delete(r); else arr.add(r);
      return { ...u, roles: [...arr] };
    });
  };

  const createLeader = async () => {
    const username = newUser.username.trim();
    const displayName = newUser.displayName.trim();
    const password = newUser.password;
    const roles = newUser.roles;
    if (!username || !displayName || !password) { toast('請填寫完整', 'error'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { toast('帳號只能用英數和底線', 'error'); return; }
    if (password.length < 6) { toast('密碼至少 6 字', 'error'); return; }
    if (roles.length === 0) { toast('請至少選一個角色', 'error'); return; }
    setCreating(true);
    const r = await api('/api/admin/leaders', { method: 'POST', body: { username, displayName, password, roles } });
    setCreating(false);
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('已新增 ' + displayName, 'success');
    setNewUser({ username: '', displayName: '', password: '', roles: ['qc'] });
    loadLeaders();
  };

  const resetPassword = async (id, name) => {
    const newPassword = prompt('為「' + name + '」設定新密碼（至少 6 字）：', '');
    if (!newPassword) return;
    if (newPassword.length < 6) { alert('密碼至少 6 字'); return; }
    const r = await api('/api/admin/leaders/' + id + '/reset-password', { method: 'POST', body: { newPassword } });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('密碼已重設', 'success');
  };

  const editRoles = async (id, name, currentRoles) => {
    const current = (currentRoles || '').split(',').map(s => s.trim()).filter(Boolean);
    const input = prompt(
      `「${name}」目前角色：${current.map(roleLabel).join('、') || '（無）'}\n\n` +
      `輸入新角色，逗號分隔（admin / qc / pm / tech）：`,
      current.join(',')
    );
    if (input == null) return;
    const r = await api('/api/admin/leaders/' + id + '/roles', { method: 'POST', body: { roles: input } });
    if (!r.ok) { toast(r.error || '修改失敗', 'error'); return; }
    toast('角色已更新：' + (r.data.roles.split(',').map(roleLabel).join('、') || '（無）'), 'success');
    loadLeaders();
  };

  const deleteLeader = async (id, name) => {
    if (!window.confirm('確定刪除「' + name + '」？\n該帳號歷史工單會保留，但失去關聯。')) return;
    const r = await api('/api/admin/leaders/' + id, { method: 'DELETE' });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('已刪除', 'success');
    loadLeaders();
  };

  // ── 角色權限矩陣 ──
  const togglePerm = (roleKey, permKey) => {
    if (roleKey === 'admin') return;
    setMatrix(m => {
      const next = { ...m };
      const set = new Set(next[roleKey]);
      if (set.has(permKey)) set.delete(permKey); else set.add(permKey);
      next[roleKey] = set;
      return next;
    });
  };

  const savePerms = async () => {
    if (!rolePerm) return;
    setSavingPerms(true);
    setPermResult({ text: '儲存中...', color: 'var(--muted)' });
    let failed = 0;
    for (const role of rolePerm.roles) {
      if (role.key === 'admin') continue;
      const perms = [...(matrix[role.key] || [])];
      const r = await api('/api/admin/roles/' + encodeURIComponent(role.key) + '/permissions', {
        method: 'PUT', body: { permissions: perms },
      });
      if (!r.ok) failed++;
    }
    setSavingPerms(false);
    if (failed) {
      setPermResult({ text: '✗ 有 ' + failed + ' 個角色儲存失敗', color: 'var(--brand)' });
    } else {
      setPermResult({ text: '✓ 已儲存（即時生效；使用者重新登入後前端選單才會更新）', color: 'var(--success)' });
      toast('權限已更新', 'success');
    }
    loadRolePerm();
  };

  // ── 救回 / 永久刪除 ──
  const restoreOrder = async (orderNo) => {
    if (!window.confirm('確定救回工單「' + orderNo + '」？\n如果工單已被刪除，會還原工單；不論如何，所有被軟刪除的工序 / 暫停紀錄都會還原。')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/restore', { method: 'POST' });
    if (!r.ok) {
      console.error('Restore failed:', { orderNo, status: r.status, error: r.error, data: r.data });
      toast('救回失敗（' + (r.status || '?') + '）：' + (r.error || '未知錯誤'), 'error');
      return;
    }
    const entries = r.data.entries || 0;
    const pauses = r.data.pauses || 0;
    const orderPart = r.data.orderRestored ? '工單' : '';
    const detail = (entries || pauses) ? `（${orderPart ? orderPart + '＋' : ''}工序 ${entries} 筆、停機 ${pauses} 筆）` : (orderPart ? `（${orderPart}）` : '');
    toast('已救回 ' + orderNo + detail, 'success');
    loadRecovery();
    loadAuditLog();
    if (findResult) findOrderNo();
  };

  const restoreBatch = async (id, filename) => {
    if (!window.confirm('救回上傳批次「' + filename + '」？\n會回填工單的上傳欄位，但會跳過已被新批次填過的欄位（不蓋新值）。')) return;
    const r = await api('/api/orders/upload-batches/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    if (!r.ok) { toast(r.error || '救回失敗', 'error'); return; }
    toast('已救回 ' + filename + '（回填 ' + r.data.restored + ' 張、跳過 ' + r.data.skipped + ' 張）', 'success');
    loadRecovery();
    loadAuditLog();
  };

  const purgeOrder = async (orderNo) => {
    if (!window.confirm('⛔ 永久刪除工單「' + orderNo + '」？\n\n會從資料庫**完全抹除**，包含所有工序與暫停紀錄。\n**無法救回**。\n\n通常只用在清測試單。確定要繼續？')) return;
    const typed = prompt('再次確認：請輸入工單號「' + orderNo + '」表示同意永久刪除');
    if (!typed || typed.trim().toUpperCase() !== String(orderNo).toUpperCase()) {
      toast('輸入不一致，已取消', 'error');
      return;
    }
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/purge', { method: 'POST' });
    if (!r.ok) { toast(r.error || '永久刪除失敗', 'error'); return; }
    const detail = (r.data.entries || r.data.pauses) ? '（含工序 ' + (r.data.entries || 0) + ' 筆、停機 ' + (r.data.pauses || 0) + ' 筆）' : '';
    toast('已永久刪除 ' + orderNo + detail, 'success');
    if (findResult) findOrderNo();
    loadRecovery();
    loadAuditLog();
  };

  // ── 查單號歷史 ──
  const findInputRef = useRef(findInput);
  findInputRef.current = findInput;

  const findOrderNo = useCallback(async () => {
    const q = findInputRef.current.trim().toUpperCase();
    if (!q) { toast('請輸入單號（或部分）', 'error'); return; }
    setFinding(true);
    const r = await api('/api/admin/find-orderno?q=' + encodeURIComponent(q));
    setFinding(false);
    if (!r.ok) { setFindResult({ error: r.error || '查詢失敗' }); return; }
    setFindResult({ orders: r.data.orders || [], uploadRows: r.data.uploadRows || [] });
  }, [toast]);

  const deleteOrderFromFind = async (orderNo) => {
    if (!window.confirm('確定刪除工單「' + orderNo + '」？\n\n會連同所有生產紀錄一起軟刪除，可從「已刪除工單」區塊救回完整狀態。')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '?force=true', { method: 'DELETE' });
    if (!r.ok) { toast(r.error || '刪除失敗', 'error'); return; }
    const detail = (r.data.entries || r.data.pauses)
      ? '（含工序 ' + (r.data.entries || 0) + ' 筆、停機 ' + (r.data.pauses || 0) + ' 筆）'
      : '';
    toast('已刪除 ' + orderNo + detail, 'success');
    findOrderNo();
    loadRecovery();
    loadAuditLog();
  };

  // ── 系統工具 ──
  const migrateDates = async () => {
    if (!window.confirm('遷移 productionDate → plannedDate + actualStartDate？\n\n會掃所有工單，依第一筆活動算實際日期、依最早未取消批次算計畫日期。\n建議備份 DB 後再執行。')) return;
    setMigrating(true);
    const r = await api('/api/admin/migrate-dates', { method: 'POST', body: {} });
    setMigrating(false);
    if (!r.ok) { toast(r.error || '遷移失敗', 'error'); return; }
    setMigrateResult('✓ 完成：共 ' + r.data.total + ' 張工單，更新 ' + r.data.updated + ' 張');
    toast('遷移完成', 'success');
  };

  const fixDates = async () => {
    if (!window.confirm('確定修正所有工單的生產日期？\n\n將根據第一筆實際活動時間重新設定。')) return;
    setFixing(true);
    const r = await api('/api/fix-dates', { method: 'POST', body: {} });
    setFixing(false);
    if (!r.ok) { toast(r.error || '修正失敗', 'error'); return; }
    setFixResult('✓ 完成：共 ' + r.data.total + ' 筆工單，修正了 ' + r.data.fixed + ' 筆');
    toast('修正完成', 'success');
  };

  // ── 回收桶 render helpers ──
  const recCounts = {
    deleted: (recoveryData.deleted || []).length,
    reset: (recoveryData.reset || []).length,
    cancelled: (recoveryData.cancelled || []).length,
  };

  const renderRecoveryRow = (tab, it) => {
    if (tab === 'deleted') {
      const spec = [it.productSpec, it.moldSpec].filter(Boolean).join(' / ') || '—';
      const time = String(it.deletedAt).slice(11, 16);
      return (
        <div key={it.orderNo} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 6px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
          <span style={{ color: '#666', minWidth: 48 }}>{time}</span>
          <div style={{ flex: 1, minWidth: 160 }}>
            <strong>{it.orderNo}</strong>
            <div style={{ color: '#888', fontSize: 12 }}>{spec}</div>
          </div>
          <button className="btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => restoreOrder(it.orderNo)}>救回</button>
          <button onClick={() => purgeOrder(it.orderNo)} title="從 DB 永久抹除，無法救回" style={{ padding: '6px 12px', fontSize: 12, background: '#1c1c1e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>永久刪除</button>
        </div>
      );
    }
    if (tab === 'reset') {
      const spec = [it.productSpec, it.moldSpec].filter(Boolean).join(' / ') || '—';
      const time = it.lastDeletedAt ? String(it.lastDeletedAt).slice(11, 16) : '—';
      const detail = '工序 ' + (it.softDeletedEntries || 0) + ' 筆' + (it.softDeletedPauses ? '、暫停 ' + it.softDeletedPauses + ' 筆' : '');
      return (
        <div key={it.orderNo} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
          <span style={{ color: '#666', minWidth: 48 }}>{time}</span>
          <div style={{ flex: 1, minWidth: 160 }}>
            <strong>{it.orderNo}</strong>{' '}
            <span style={{ color: '#888', fontSize: 12 }}>{(it.machineNo || '—') + ' / ' + spec}</span>
            <div style={{ color: '#a98e44', fontSize: 11 }}>{detail}</div>
          </div>
          <button onClick={() => restoreOrder(it.orderNo)} style={{ padding: '6px 12px', fontSize: 12, background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>救回紀錄</button>
        </div>
      );
    }
    // cancelled
    const time = String(it.cancelledAt).slice(11, 16);
    return (
      <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
        <span style={{ color: '#666', minWidth: 48 }}>{time}</span>
        <div style={{ flex: 1, minWidth: 160 }}>
          <strong>{it.filename}</strong>
          <div style={{ color: '#888', fontSize: 12 }}>
            {(it.uploadedByName || '—') + ' 上傳於 ' + fmtDateTime(it.uploadedAt) + ' / ' + (it.rowCount || 0) + ' 列 / ' + (it.orderNos || []).length + ' 張單'}
          </div>
        </div>
        <button onClick={() => restoreBatch(it.id, it.filename)} style={{ padding: '6px 12px', fontSize: 12, background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>救回批次</button>
      </div>
    );
  };

  const renderRecoveryContent = () => {
    if (recoveryLoading) {
      return <div style={{ color: 'var(--muted)', padding: '8px 0', fontSize: 13 }}>載入中...</div>;
    }
    const tab = recoveryTab;
    const items = recoveryData[tab] || [];
    if (items.length === 0) {
      return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 0', textAlign: 'center' }}>目前沒有可救回的項目</div>;
    }
    const totalPages = Math.max(1, Math.ceil(items.length / RECOVERY_PAGE_SIZE));
    let page = recoveryPage[tab];
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * RECOVERY_PAGE_SIZE;
    const slice = items.slice(start, start + RECOVERY_PAGE_SIZE);

    const dateOf = (it) => String(
      tab === 'deleted' ? it.deletedAt :
        tab === 'reset' ? it.lastDeletedAt :
          it.cancelledAt
    ).slice(0, 10);
    const groups = {};
    slice.forEach(it => { (groups[dateOf(it)] = groups[dateOf(it)] || []).push(it); });
    const days = Object.keys(groups).sort().reverse();

    return (
      <>
        {days.map(day => (
          <div key={day}>
            <div className="rec-day-header" style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '12px 0 6px', padding: '4px 0', borderBottom: '2px solid var(--border)' }}>
              {day + '（' + groups[day].length + ' 筆）'}
            </div>
            {groups[day].map(it => renderRecoveryRow(tab, it))}
          </div>
        ))}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 14 }}>
            <button
              disabled={page <= 1}
              onClick={() => setRecoveryPage(p => ({ ...p, [tab]: Math.max(1, p[tab] - 1) }))}
              style={{ padding: '6px 14px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1 }}
            >‹ 上一頁</button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{'第 ' + page + ' / ' + totalPages + ' 頁（共 ' + items.length + ' 筆）'}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setRecoveryPage(p => ({ ...p, [tab]: Math.min(totalPages, p[tab] + 1) }))}
              style={{ padding: '6px 14px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.4 : 1 }}
            >下一頁 ›</button>
          </div>
        )}
      </>
    );
  };

  // ── 操作紀錄 render ──
  const renderAuditLog = () => {
    if (auditLogs == null) {
      return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 0' }}>載入中...</div>;
    }
    if (!auditLogs.length) {
      return <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 0' }}>{'最近 ' + auditLoadedDays + ' 天沒有任何操作紀錄'}</div>;
    }
    const totalPages = Math.max(1, Math.ceil(auditLogs.length / AUDIT_PAGE_SIZE));
    let page = auditPage;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * AUDIT_PAGE_SIZE;
    const slice = auditLogs.slice(start, start + AUDIT_PAGE_SIZE);

    const groups = {};
    slice.forEach(l => {
      const day = String(l.createdAt).slice(0, 10);
      (groups[day] = groups[day] || []).push(l);
    });
    const days = Object.keys(groups).sort().reverse();

    return (
      <>
        {days.map(day => (
          <div key={day}>
            <div className="rec-day-header" style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', margin: '12px 0 6px', padding: '4px 0', borderBottom: '2px solid var(--border)' }}>{day}</div>
            {groups[day].map((l, i) => {
              const action = ACTION_LABELS[l.action] || l.action;
              const color = ACTION_COLORS[l.action] || 'var(--muted)';
              const time = String(l.createdAt).slice(11, 16);
              return (
                <div key={l.id || (day + i)} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: '#666', minWidth: 48 }}>{time}</span>
                  <span style={{ color: '#666', minWidth: 60 }}>{l.actorName || '—'}</span>
                  <span style={{ color, fontWeight: 600 }}>{action}</span>
                  {l.target ? <strong>{' ' + l.target}</strong> : null}
                  {l.detail ? <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>{'（' + l.detail + '）'}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <button disabled={page <= 1} onClick={() => setAuditPage(p => Math.max(1, p - 1))}
              style={{ padding: '6px 14px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1 }}>‹ 上一頁</button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{'第 ' + page + ' / ' + totalPages + ' 頁（共 ' + auditLogs.length + ' 筆）'}</span>
            <button disabled={page >= totalPages} onClick={() => setAuditPage(p => Math.min(totalPages, p + 1))}
              style={{ padding: '6px 14px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 8, background: '#fff', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.4 : 1 }}>下一頁 ›</button>
          </div>
        )}
      </>
    );
  };

  // ── 查單號歷史 render ──
  const renderFindResult = () => {
    if (!findResult) return null;
    if (findResult.error) {
      return <span style={{ color: 'var(--brand)' }}>{findResult.error}</span>;
    }
    const orders = findResult.orders || [];
    const uploadRows = findResult.uploadRows || [];
    if (orders.length === 0 && uploadRows.length === 0) {
      return <div style={{ color: 'var(--muted)', padding: '8px 0' }}>查無此單號（DB 跟所有上傳批次裡都沒有）</div>;
    }
    return (
      <>
        {orders.length > 0 && (
          <>
            <h3 style={{ margin: '8px 0', fontSize: 13, color: 'var(--muted)' }}>{'工單表（' + orders.length + ' 筆）'}</h3>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table style={{ minWidth: 640 }}>
                <thead><tr><th>工單號</th><th>機台 / 規格</th><th>狀態</th><th>建立 / 更新</th><th>操作</th></tr></thead>
                <tbody>
                  {orders.map(o => {
                    const softCount = (o.softDeletedEntries || 0) + (o.softDeletedPauses || 0);
                    const spec = [o.productSpec, o.moldSpec, o.material].filter(Boolean).join(' / ') || '—';
                    const machine = (o.machineNo || '—') + (o.plannedMachineNo && o.plannedMachineNo !== o.machineNo ? '（原計劃 ' + o.plannedMachineNo + '）' : '');
                    return (
                      <tr key={o.orderNo}>
                        <td><strong>{o.orderNo}</strong></td>
                        <td>
                          <div>{machine}</div>
                          <div style={{ color: '#888', fontSize: 12 }}>{spec}</div>
                        </td>
                        <td>
                          {o.deletedAt ? (
                            <span style={{ color: 'var(--brand)' }}>{'已刪除 ' + fmtDateTime(o.deletedAt)}</span>
                          ) : (
                            <>
                              <span style={{ color: 'var(--success)' }}>使用中</span>
                              {softCount > 0 && (
                                <><br /><span style={{ color: '#a98e44', fontSize: 11 }}>{'含 ' + (o.softDeletedEntries || 0) + ' 筆已刪工序、' + (o.softDeletedPauses || 0) + ' 筆已刪暫停'}</span></>
                              )}
                            </>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: '#666' }}>{'建：' + fmtDateTime(o.createdAt)}<br />{'更：' + fmtDateTime(o.updatedAt)}</td>
                        <td>
                          {o.deletedAt ? (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <button className="btn-secondary" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => restoreOrder(o.orderNo)}>救回</button>
                              <button onClick={() => purgeOrder(o.orderNo)} title="從 DB 永久抹除，無法救回" style={{ padding: '6px 10px', fontSize: 12, background: '#1c1c1e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>永久刪除</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {softCount > 0 && (
                                <button onClick={() => restoreOrder(o.orderNo)} title="把 reset 軟刪除的紀錄救回" style={{ padding: '6px 10px', fontSize: 12, background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>{'救回紀錄 (' + softCount + ')'}</button>
                              )}
                              <button className="btn-danger" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => deleteOrderFromFind(o.orderNo)}>刪除</button>
                              <button onClick={() => purgeOrder(o.orderNo)} title="從 DB 永久抹除，無法救回" style={{ padding: '6px 10px', fontSize: 12, background: '#1c1c1e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>永久刪除</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {uploadRows.length > 0 && (
          <>
            <h3 style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--muted)' }}>{'上傳記錄（' + uploadRows.length + ' 筆，含已取消批次）'}</h3>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table style={{ minWidth: 720 }}>
                <thead><tr><th>檔名 / 上傳人</th><th>單號 / 規格</th><th>處理</th><th>批次狀態</th><th>批次時間</th></tr></thead>
                <tbody>
                  {uploadRows.map((u, idx) => {
                    const b = u.batch || {};
                    const spec = [u.productSpec, u.moldSpec, u.material].filter(Boolean).join(' / ') || '—';
                    let rowStatus;
                    if (u.status === 'error') {
                      const msg = String(u.errorMsg || '').slice(0, 200);
                      rowStatus = <span style={{ color: 'var(--brand)', fontSize: 11, background: '#fdf2f2', padding: '2px 6px', borderRadius: 4 }} title={msg}>失敗</span>;
                    } else if (u.status === 'created') {
                      rowStatus = <span style={{ color: 'var(--success)', fontSize: 11 }}>新建</span>;
                    } else if (u.status === 'updated') {
                      rowStatus = <span style={{ color: '#1f6feb', fontSize: 11 }}>更新</span>;
                    } else if (u.status === 'skipped') {
                      rowStatus = <span style={{ color: '#f0ad4e', fontSize: 11 }} title={u.errorMsg || ''}>跳過</span>;
                    } else {
                      rowStatus = <span style={{ fontSize: 11 }}>{u.status}</span>;
                    }
                    return (
                      <tr key={(u.orderNo || '') + '-' + (b.id || idx)}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <div>{b.filename || '?'}</div>
                          <div style={{ color: '#888', fontSize: 12 }}>{b.uploadedByName || '—'}</div>
                        </td>
                        <td>
                          <div><strong>{u.orderNo}</strong></div>
                          <div style={{ color: '#888', fontSize: 12 }}>{spec}</div>
                        </td>
                        <td>{rowStatus}</td>
                        <td>
                          {b.cancelledAt ? (
                            <span style={{ color: 'var(--brand)', whiteSpace: 'nowrap' }}>已取消<br /><span style={{ fontSize: 11 }}>{fmtDateTime(b.cancelledAt)}</span></span>
                          ) : (
                            <span style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>有效</span>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>{fmtDateTime(b.uploadedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </>
    );
  };

  // 整頁需 manage_accounts 權限
  if (!hasPermission(me, 'manage_accounts')) {
    return (
      <div className="container">
        <div className="card"><div className="error">需要管理員權限</div></div>
      </div>
    );
  }

  const recTabStyle = (tab) => ({
    padding: '8px 14px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    ...(recoveryTab === tab
      ? { background: 'var(--brand)', color: '#fff', border: '1px solid var(--brand)' }
      : { background: '#fff', color: 'var(--ink)', border: '1px solid var(--border)' }),
  });

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      {/* 新增小組長 */}
      <div className="card">
        <h2>新增小組長</h2>
        <label>帳號（只能英數，登入用，例：wang、lin01）</label>
        <input type="text" autoCapitalize="none" autoComplete="off" placeholder="例：wang"
          value={newUser.username} onChange={e => setNewUser({ ...newUser, username: e.target.value })} />
        <label>顯示名稱（中文，記錄到工單上的人名）</label>
        <input type="text" placeholder="例：王大明"
          value={newUser.displayName} onChange={e => setNewUser({ ...newUser, displayName: e.target.value })} />
        <label>密碼（至少 6 字）</label>
        <input type="password" autoComplete="new-password"
          value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} />
        <label>角色（可多選）</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 12px' }}>
          {VALID_ROLES.map(r => {
            const active = newUser.roles.includes(r);
            return (
              <label key={r} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer', userSelect: 'none',
                background: active ? 'var(--brand-soft)' : 'var(--bg)',
                border: '1.5px solid ' + (active ? 'var(--brand)' : 'var(--border)'),
                color: active ? 'var(--brand)' : 'inherit', fontWeight: active ? 600 : 400,
              }}>
                <input type="checkbox" checked={active} onChange={() => toggleNewRole(r)} style={{ width: 16, height: 16, accentColor: 'var(--brand)', margin: 0 }} />
                <span>{roleLabel(r)}</span>
              </label>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', margin: '-8px 0 12px', lineHeight: 1.5 }}>
          管理員 = 所有頁面 + 帳號管理；品管 = 實態 / 歷史 / 即時 / 統計；
          生管 = 同品管 + 上傳；技術員 = 實態 / 即時
        </div>
        <button className="btn-primary btn-block" disabled={creating} onClick={createLeader}>
          {creating ? '新增中...' : '新增帳號'}
        </button>
      </div>

      {/* 所有小組長 */}
      <div className="card">
        <h2>所有小組長</h2>
        {loadingLeaders ? <div style={{ color: 'var(--muted)' }}>載入中...</div> : (
          leaders.length === 0 ? <div style={{ color: '#999' }}>尚無帳號</div> : (
            <table>
              <thead><tr><th>姓名 / 帳號</th><th>建立日期</th><th>操作</th></tr></thead>
              <tbody>
                {leaders.map(l => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.displayName}</strong>{' '}
                      {rolesOf(l).map(r => (
                        <span key={r} className="badge" style={{ background: ROLE_COLORS[r] || '#999' }}>{roleLabel(r)}</span>
                      ))}
                      <br />
                      <span style={{ color: '#888', fontSize: 12 }}>@{l.username}</span>
                    </td>
                    <td style={{ fontSize: 12, color: '#666' }}>{fmtDate(l.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn-secondary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => editRoles(l.id, l.displayName, l.roles)}>改角色</button>
                        <button className="btn-secondary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => resetPassword(l.id, l.displayName)}>改密碼</button>
                        {l.id !== me?.id && (
                          <button className="btn-danger" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => deleteLeader(l.id, l.displayName)}>刪除</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {/* 角色權限 */}
      <div className="card">
        <h2>角色權限</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          勾選各角色可使用的功能。管理員永遠擁有全部權限（不可調整）。改完按「儲存權限」即時生效。
        </p>
        {!rolePerm ? <div style={{ color: 'var(--muted)' }}>載入中...</div> : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>權限</th>
                    {rolePerm.roles.map(role => (
                      <th key={role.key} style={{ padding: '8px 10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {role.name}<br /><span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{role.key}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let lastCat = null;
                    return rolePerm.permissions.flatMap(p => {
                      const out = [];
                      if (p.category && p.category !== lastCat) {
                        lastCat = p.category;
                        out.push(
                          <tr key={'cat-' + p.category}>
                            <td colSpan={rolePerm.roles.length + 1} style={{ background: '#f6f6f8', fontSize: 11, color: 'var(--muted)', fontWeight: 700, padding: '5px 10px' }}>{p.category}</td>
                          </tr>
                        );
                      }
                      out.push(
                        <tr key={p.key}>
                          <td style={{ padding: '6px 10px', fontSize: 13 }}>{p.name}{' '}<span style={{ fontSize: 10, color: 'var(--muted)' }}>{p.key}</span></td>
                          {rolePerm.roles.map(role => {
                            const locked = role.key === 'admin';
                            const checked = locked ? true : !!matrix[role.key]?.has(p.key);
                            return (
                              <td key={role.key} style={{ textAlign: 'center', padding: '6px 10px' }}>
                                <input type="checkbox" checked={checked} disabled={locked} onChange={() => togglePerm(role.key, p.key)}
                                  style={{ width: 18, height: 18, accentColor: 'var(--brand)', cursor: locked ? 'not-allowed' : 'pointer' }} />
                              </td>
                            );
                          })}
                        </tr>
                      );
                      return out;
                    });
                  })()}
                </tbody>
              </table>
            </div>
            <button className="btn-primary" style={{ marginTop: 12, padding: '10px 20px' }} disabled={savingPerms} onClick={savePerms}>
              {savingPerms ? '儲存中...' : '儲存權限'}
            </button>
            <div style={{ fontSize: 12, marginTop: 8, minHeight: 14, color: permResult.color }}>{permResult.text}</div>
          </>
        )}
      </div>

      {/* 回收桶 */}
      <div className="card">
        <h2>回收桶（可救回）</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          <button style={recTabStyle('deleted')} onClick={() => setRecoveryTab('deleted')}>
            已刪除工單 <span style={{ fontSize: 11, opacity: 0.85, marginLeft: 4 }}>({recCounts.deleted})</span>
          </button>
          <button style={recTabStyle('reset')} onClick={() => setRecoveryTab('reset')}>
            已重設紀錄 <span style={{ fontSize: 11, opacity: 0.85, marginLeft: 4 }}>({recCounts.reset})</span>
          </button>
          <button style={recTabStyle('cancelled')} onClick={() => setRecoveryTab('cancelled')}>
            已取消批次 <span style={{ fontSize: 11, opacity: 0.85, marginLeft: 4 }}>({recCounts.cancelled})</span>
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 10px' }}>{recoveryHints[recoveryTab]}</p>
        <div>{renderRecoveryContent()}</div>
      </div>

      {/* 操作紀錄 */}
      <div className="card">
        <h2>操作紀錄</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>最近</span>
          <select value={auditDays} onChange={e => { setAuditDays(e.target.value); loadAuditLog(e.target.value); }}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }}>
            <option value="1">1 天</option>
            <option value="3">3 天</option>
            <option value="7">7 天</option>
            <option value="14">14 天</option>
            <option value="30">30 天</option>
          </select>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>的所有刪除 / 重設 / 取消 / 救回 / 自動建單動作</span>
        </div>
        <div>{renderAuditLog()}</div>
      </div>

      {/* 查單號歷史 */}
      <div className="card">
        <h2>查單號歷史</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
          輸入工單號（可只輸入部分）查所有相關紀錄：含已刪除工單、含已取消批次。
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="text" placeholder="例：F1159421004" autoCapitalize="characters" autoComplete="off" style={{ flex: 1 }}
            value={findInput} onChange={e => setFindInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') findOrderNo(); }} />
          <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} disabled={finding} onClick={findOrderNo}>查詢</button>
        </div>
        <div style={{ marginTop: 12 }}>{renderFindResult()}</div>
      </div>

      {/* 系統工具 */}
      <div className="card">
        <h2>系統工具</h2>
        <button className="btn-primary btn-block" style={{ marginBottom: 6 }} disabled={migrating} onClick={migrateDates}>
          {migrating ? '遷移中...' : '遷移：拆分計畫日期 / 實際開始日期'}
        </button>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px' }}>
          把舊 productionDate 拆成「計畫日期 (plannedDate)」與「實際開始日期 (actualStartDate)」。執行後即時頁、紀錄頁、製造概覽會以實際日期為準，並標出計畫日期不同處。建議只跑一次。
        </p>
        {migrateResult && <div style={{ margin: '0 0 14px' }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{migrateResult}</span></div>}

        <button className="btn-secondary btn-block" style={{ marginBottom: 6 }} disabled={fixing} onClick={fixDates}>
          {fixing ? '修正中...' : '舊版：修正所有工單生產日期'}
        </button>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
          舊功能（依第一筆活動重設 productionDate）。新流程已用「遷移」取代，平常不需要按。
        </p>
        {fixResult && <div style={{ marginTop: 8 }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{fixResult}</span></div>}
      </div>
    </div>
  );
}
