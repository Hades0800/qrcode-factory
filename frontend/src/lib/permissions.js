// 角色 / 權限 helper（對應原 utils.js 的權限段）
// leader.permissions 從後端 login / me 回傳；舊 session 無此欄時用 FALLBACK

const FALLBACK_ROLE_PERMS = {
  qc:   ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records'],
  pm:   ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records', 'upload', 'delete_order'],
  tech: ['view_records', 'view_plan_stats', 'view_goal_stats'],
};

export const ROLE_LABEL = { admin: '管理員', qc: '品管', pm: '生管', tech: '技術員' };

export function rolesOf(leader) {
  if (!leader || !leader.roles) return [];
  return String(leader.roles).split(',').map(s => s.trim()).filter(Boolean);
}

export function hasRole(leader, role) {
  return rolesOf(leader).includes(role);
}

export function hasPermission(leader, key) {
  if (!leader) return false;
  if (Array.isArray(leader.permissions)) return leader.permissions.includes(key);
  const roles = rolesOf(leader);
  if (roles.includes('admin')) return true;
  return roles.some(r => (FALLBACK_ROLE_PERMS[r] || []).includes(key));
}

export const isAdminUser = (leader) => hasPermission(leader, 'manage_accounts');
export const canUpload = (leader) => hasPermission(leader, 'upload');
export const canModifyRecords = (leader) => hasPermission(leader, 'modify_records');

export function roleLabel(key) { return ROLE_LABEL[key] || key; }
export function rolesDisplay(leader) {
  return rolesOf(leader).map(roleLabel).join('、') || '—';
}
