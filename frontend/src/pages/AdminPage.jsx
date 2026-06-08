import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { roleLabel } from '../lib/permissions';
import { fmtDate } from '../lib/format';

const VALID_ROLES = ['admin', 'qc', 'pm', 'tech'];

export default function AdminPage() {
  const toast = useToast();
  const [leaders, setLeaders] = useState([]);
  const [loadingLeaders, setLoadingLeaders] = useState(false);

  // 新增帳號表單
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', roles: ['qc'] });
  const [creating, setCreating] = useState(false);

  // 角色權限矩陣
  const [rolePerm, setRolePerm] = useState(null);   // { permissions, roles }
  const [matrix, setMatrix] = useState({});         // { roleKey: Set(permKey) }
  const [savingPerms, setSavingPerms] = useState(false);

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

  useEffect(() => { loadLeaders(); loadRolePerm(); }, [loadLeaders, loadRolePerm]);

  // 新增帳號
  const toggleNewRole = (r) => {
    setNewUser(u => {
      const arr = new Set(u.roles);
      arr.has(r) ? arr.delete(r) : arr.add(r);
      return { ...u, roles: [...arr] };
    });
  };

  const createLeader = async () => {
    const { username, displayName, password, roles } = newUser;
    if (!username || !displayName || !password) { toast('請填寫完整', 'error'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { toast('帳號只能英數底線', 'error'); return; }
    if (password.length < 6) { toast('密碼至少 6 字', 'error'); return; }
    if (!roles.length) { toast('請至少選一個角色', 'error'); return; }
    setCreating(true);
    const r = await api('/api/admin/leaders', { method: 'POST', body: { username, displayName, password, roles } });
    setCreating(false);
    if (!r.ok) { toast(r.error || '新增失敗', 'error'); return; }
    toast('已新增 ' + displayName, 'success');
    setNewUser({ username: '', displayName: '', password: '', roles: ['qc'] });
    loadLeaders();
  };

  // 改密碼
  const resetPassword = async (id, name) => {
    const newPwd = prompt(`為「${name}」設定新密碼（至少 6 字）：`, '');
    if (!newPwd) return;
    if (newPwd.length < 6) { alert('密碼至少 6 字'); return; }
    const r = await api(`/api/admin/leaders/${id}/reset-password`, { method: 'POST', body: { newPassword: newPwd } });
    if (!r.ok) toast(r.error || '失敗', 'error');
    else toast('密碼已重設', 'success');
  };

  // 改角色
  const editRoles = async (id, name, current) => {
    const cur = (current || '').split(',').map(s => s.trim()).filter(Boolean);
    const input = prompt(
      `「${name}」目前角色：${cur.map(roleLabel).join('、') || '（無）'}\n\n輸入新角色（admin / qc / pm / tech，逗號分隔）：`,
      cur.join(',')
    );
    if (input == null) return;
    const r = await api(`/api/admin/leaders/${id}/roles`, { method: 'POST', body: { roles: input } });
    if (!r.ok) { toast(r.error || '失敗', 'error'); return; }
    toast('角色已更新', 'success');
    loadLeaders();
  };

  // 刪除帳號
  const deleteLeader = async (id, name) => {
    if (!window.confirm(`確定刪除「${name}」？`)) return;
    const r = await api(`/api/admin/leaders/${id}`, { method: 'DELETE' });
    if (!r.ok) toast(r.error || '失敗', 'error');
    else { toast('已刪除', 'success'); loadLeaders(); }
  };

  // 矩陣切換
  const togglePerm = (roleKey, permKey) => {
    if (roleKey === 'admin') return;
    setMatrix(m => {
      const next = { ...m };
      const set = new Set(next[roleKey]);
      set.has(permKey) ? set.delete(permKey) : set.add(permKey);
      next[roleKey] = set;
      return next;
    });
  };

  const savePerms = async () => {
    if (!rolePerm) return;
    setSavingPerms(true);
    let failed = 0;
    for (const role of rolePerm.roles) {
      if (role.key === 'admin') continue;
      const perms = [...(matrix[role.key] || [])];
      const r = await api(`/api/admin/roles/${encodeURIComponent(role.key)}/permissions`, {
        method: 'PUT', body: { permissions: perms },
      });
      if (!r.ok) failed++;
    }
    setSavingPerms(false);
    if (failed) toast(`有 ${failed} 個角色儲存失敗`, 'error');
    else { toast('權限已更新（即時生效，使用者重新登入後前端選單才會更新）', 'success'); loadRolePerm(); }
  };

  return (
    <div className="container" style={{ maxWidth: 1100 }}>
      {/* 新增帳號 */}
      <div className="card">
        <h2>新增帳號</h2>
        <label>帳號（英數底線 2~30 字）</label>
        <input type="text" value={newUser.username} onChange={e => setNewUser({ ...newUser, username: e.target.value })} />
        <label>顯示名稱</label>
        <input type="text" value={newUser.displayName} onChange={e => setNewUser({ ...newUser, displayName: e.target.value })} />
        <label>密碼（至少 6 字）</label>
        <input type="password" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} />
        <label>角色（可多選）</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 16px' }}>
          {VALID_ROLES.map(r => (
            <label key={r} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', background: 'var(--bg)', border: '1.5px solid var(--border)',
              borderRadius: 20, fontSize: 13, cursor: 'pointer',
              ...(newUser.roles.includes(r) ? { background: 'var(--brand-soft)', borderColor: 'var(--brand)', color: 'var(--brand)', fontWeight: 600 } : {}),
            }}>
              <input type="checkbox" checked={newUser.roles.includes(r)} onChange={() => toggleNewRole(r)} />
              <span>{roleLabel(r)}</span>
            </label>
          ))}
        </div>
        <button className="btn-primary btn-block" disabled={creating} onClick={createLeader}>
          {creating ? '新增中...' : '新增帳號'}
        </button>
      </div>

      {/* 帳號列表 */}
      <div className="card">
        <h2>所有帳號</h2>
        {loadingLeaders ? <div className="muted">載入中...</div> : (
          leaders.length === 0 ? <div className="muted">尚無帳號</div> : (
            <table>
              <thead><tr><th>姓名 / 帳號</th><th>建立日期</th><th>操作</th></tr></thead>
              <tbody>
                {leaders.map(l => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.displayName}</strong>{' '}
                      {(l.roles || '').split(',').filter(Boolean).map(r => (
                        <span key={r} className="badge" style={{ marginLeft: 4, background: r === 'admin' ? 'var(--brand)' : r === 'pm' ? '#f0ad4e' : r === 'qc' ? '#1f6feb' : '#666' }}>
                          {roleLabel(r)}
                        </span>
                      ))}
                      <br />
                      <span className="muted" style={{ fontSize: 12 }}>@{l.username}</span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{fmtDate(l.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn-secondary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => editRoles(l.id, l.displayName, l.roles)}>改角色</button>
                        <button className="btn-secondary" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => resetPassword(l.id, l.displayName)}>改密碼</button>
                        <button className="btn-danger" style={{ padding: '7px 12px', fontSize: 12 }} onClick={() => deleteLeader(l.id, l.displayName)}>刪除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {/* 角色權限矩陣 */}
      <div className="card">
        <h2>角色權限</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          管理員永遠擁有全部權限（不可調整）。改完按「儲存權限」即時生效。
        </p>
        {!rolePerm ? <div className="muted">載入中...</div> : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>權限</th>
                    {rolePerm.roles.map(r => (
                      <th key={r.key} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {r.name}<br /><span className="muted" style={{ fontSize: 10 }}>{r.key}</span>
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
                            <td colSpan={rolePerm.roles.length + 1} style={{ background: '#f6f6f8', fontSize: 11, color: 'var(--muted)', fontWeight: 700, padding: '5px 10px' }}>
                              {p.category}
                            </td>
                          </tr>
                        );
                      }
                      out.push(
                        <tr key={p.key}>
                          <td>{p.name}{' '}<span className="muted" style={{ fontSize: 10 }}>{p.key}</span></td>
                          {rolePerm.roles.map(role => {
                            const checked = role.key === 'admin' ? true : matrix[role.key]?.has(p.key);
                            const locked = role.key === 'admin';
                            return (
                              <td key={role.key} style={{ textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={!!checked}
                                  disabled={locked}
                                  onChange={() => togglePerm(role.key, p.key)}
                                  style={{ width: 18, height: 18, accentColor: 'var(--brand)', cursor: locked ? 'not-allowed' : 'pointer' }}
                                />
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
            <button className="btn-primary" style={{ marginTop: 12 }} disabled={savingPerms} onClick={savePerms}>
              {savingPerms ? '儲存中...' : '儲存權限'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
