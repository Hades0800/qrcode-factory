// ─── 權限系統（DB 驅動，可由後台調整）──────────────────────────
// 身份組模型：Leader.roles 是逗號字串（例 'admin,pm'），一人可多角色。
// 角色 → 權限的對應存在 DB（Role / Permission / RolePermission），
// 啟動時 seed 預設值並載入記憶體快取，後台改完呼叫 reloadRolePerms() 生效。
//
// 提供的裝飾器：
//   fastify.hasRole(user, 'admin')            → boolean
//   fastify.hasPermission(user, 'upload')     → boolean
//   fastify.requireAdmin                      → onRequest hook
//   fastify.requirePlannerOrAdmin             → onRequest hook
//   fastify.requirePermission('upload')       → 產生 onRequest hook
//   fastify.resolvePermissions(rolesStr)      → 權限 key 陣列（login/me 回傳給前端）
//   fastify.reloadRolePerms()                 → 後台改權限後重新載入快取

// 權限目錄：系統所有可指派的能力（seed 進 Permission 表）
export const PERMISSION_CATALOG = [
  { key: 'view_records',    name: '歷史實態紀錄',                   category: '頁面', sortOrder: 1 },
  { key: 'view_plan_stats', name: '計畫達成統計',                   category: '頁面', sortOrder: 2 },
  { key: 'view_goal_stats', name: '目標達成統計',                   category: '頁面', sortOrder: 3 },
  { key: 'upload',          name: '上傳工單',                       category: '操作', sortOrder: 4 },
  { key: 'modify_records',  name: '修改/取消/補登生產紀錄',         category: '操作', sortOrder: 5 },
  { key: 'delete_order',    name: '刪除工單',                       category: '操作', sortOrder: 6 },
  { key: 'manage_accounts', name: '帳號管理',                       category: '管理', sortOrder: 7 },
  { key: 'admin_tools',     name: '回收桶/重設/永久刪除/稽核/診斷', category: '管理', sortOrder: 8 },
];
export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map(p => p.key);

export const ROLE_CATALOG = [
  { key: 'admin', name: '管理員', isSystem: true, sortOrder: 1 },
  { key: 'qc',    name: '品管',   isSystem: true, sortOrder: 2 },
  { key: 'pm',    name: '生管',   isSystem: true, sortOrder: 3 },
  { key: 'tech',  name: '技術員', isSystem: true, sortOrder: 4 },
];

// 新角色第一次建立時給的預設權限（既有角色不覆蓋，後台改過的設定不會被蓋掉）
const DEFAULT_ROLE_PERMS = {
  admin: ALL_PERMISSION_KEYS,
  qc:    ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records'],
  pm:    ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records', 'upload', 'delete_order'],
  tech:  ['view_records', 'view_plan_stats', 'view_goal_stats'],
};

// 記憶體快取：roleKey -> Set(permKey)。admin 不靠快取（永遠全有，防鎖死）
let rolePermsMap = {};

export function userHasRole(user, role) {
  if (!user || !user.roles) return false;
  return String(user.roles).split(',').map(s => s.trim()).filter(Boolean).includes(role);
}

export function userHasPermission(user, permKey) {
  if (!user || !user.roles) return false;
  const roles = String(user.roles).split(',').map(s => s.trim()).filter(Boolean);
  if (roles.includes('admin')) return true;   // admin 永遠全有
  return roles.some(r => rolePermsMap[r] && rolePermsMap[r].has(permKey));
}

// 角色字串 → 權限 key 陣列（login / me 回傳給前端，前端據此顯示/隱藏功能）
export function resolvePermissions(rolesStr) {
  const roles = String(rolesStr || '').split(',').map(s => s.trim()).filter(Boolean);
  if (roles.includes('admin')) return ALL_PERMISSION_KEYS.slice();
  const out = new Set();
  roles.forEach(r => { if (rolePermsMap[r]) rolePermsMap[r].forEach(k => out.add(k)); });
  return [...out];
}

export async function registerPermissions(fastify) {
  const prisma = fastify.prisma;

  fastify.decorate('hasRole', userHasRole);
  fastify.decorate('hasPermission', userHasPermission);
  fastify.decorate('resolvePermissions', resolvePermissions);

  fastify.decorate('requireAdmin', async (request, reply) => {
    if (!userHasRole(request.user, 'admin')) {
      reply.code(403).send({ error: '需要管理員權限' });
    }
  });

  // pm 或 admin（可上傳工單）
  fastify.decorate('requirePlannerOrAdmin', async (request, reply) => {
    if (!userHasRole(request.user, 'admin') && !userHasRole(request.user, 'pm')) {
      reply.code(403).send({ error: '需要生管或管理員權限' });
    }
  });

  fastify.decorate('requirePermission', (permKey) => async (request, reply) => {
    if (!userHasPermission(request.user, permKey)) {
      reply.code(403).send({ error: '權限不足' });
    }
  });

  // 從 DB 載入角色權限到記憶體（啟動時 + 後台修改後呼叫）
  async function loadRolePermsMap() {
    const map = {};
    try {
      const roles = await prisma.role.findMany({ include: { perms: { include: { permission: true } } } });
      roles.forEach(r => { map[r.key] = new Set(r.perms.map(rp => rp.permission.key)); });
    } catch (e) {
      console.error('⚠️ loadRolePermsMap 失敗:', e.message);
    }
    rolePermsMap = map;
  }
  fastify.decorate('reloadRolePerms', loadRolePermsMap);

  // seed 權限目錄 + 角色 + 預設對應（冪等；只有「新角色」才補預設，不覆蓋既有設定）
  async function seedRolesAndPermissions() {
    try {
      for (const p of PERMISSION_CATALOG) {
        await prisma.permission.upsert({
          where: { key: p.key },
          update: { name: p.name, category: p.category, sortOrder: p.sortOrder },
          create: p,
        });
      }
      const allPerms = await prisma.permission.findMany();
      const permIdByKey = Object.fromEntries(allPerms.map(p => [p.key, p.id]));
      for (const r of ROLE_CATALOG) {
        const existing = await prisma.role.findUnique({ where: { key: r.key } });
        if (!existing) {
          const created = await prisma.role.create({ data: r });
          for (const pk of (DEFAULT_ROLE_PERMS[r.key] || [])) {
            if (permIdByKey[pk]) {
              await prisma.rolePermission.create({ data: { roleId: created.id, permissionId: permIdByKey[pk] } });
            }
          }
        }
      }
    } catch (e) {
      console.error('⚠️ seedRolesAndPermissions 失敗:', e.message);
    }
  }
  fastify.decorate('seedRolesAndPermissions', seedRolesAndPermissions);
}
