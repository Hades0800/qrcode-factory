import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { execSync } from 'child_process';

import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import equipmentParamRoutes from './routes/equipmentParams.js';
import v2Routes from './routes/v2.js';
import v2AuthRoutes from './routes/v2/auth.js';

const prisma = new PrismaClient();

// ─── 軟刪除中間件 ─────────────────────────────────
// 對指定 model 自動套用：
//   1. find*/count/aggregate/groupBy 預設加上 deletedAt: null 過濾
//   2. delete / deleteMany 改寫為 update / updateMany，設定 deletedAt = 當下時間
// 逃生口：caller 在 where 內明確指定 deletedAt（即使是 undefined）即可跳過自動過濾，
//        用於「查含已刪除」或「restore 前 lookup」等場景。
// 注意：nested include 不會進 middleware，必須在 include 內手動加 where: { deletedAt: null }
const SOFT_DELETE_MODELS = new Set(['Order', 'Leader', 'IdleEvent', 'StepEntry', 'PauseEvent']);
prisma.$use(async (params, next) => {
  if (!SOFT_DELETE_MODELS.has(params.model)) return next(params);

  if (params.action === 'findUnique' || params.action === 'findFirst') {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      if (params.action === 'findUnique') params.action = 'findFirst';
      params.args.where.deletedAt = null;
    }
  } else if (
    params.action === 'findMany' ||
    params.action === 'count' ||
    params.action === 'aggregate' ||
    params.action === 'groupBy'
  ) {
    params.args = params.args || {};
    params.args.where = params.args.where || {};
    if (!('deletedAt' in params.args.where)) {
      params.args.where.deletedAt = null;
    }
  } else if (params.action === 'delete') {
    params.action = 'update';
    params.args.data = { deletedAt: new Date() };
  } else if (params.action === 'deleteMany') {
    params.action = 'updateMany';
    params.args = params.args || {};
    params.args.data = { ...(params.args.data || {}), deletedAt: new Date() };
  }

  return next(params);
});

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024, // 2MB 限制避免 DoS
  trustProxy: true,
});

// 全域注入 prisma
fastify.decorate('prisma', prisma);

// 壓縮回應（gzip/brotli，大 JSON 回應可省 60~80% 流量）
await fastify.register(compress, {
  global: true,
  encodings: ['br', 'gzip', 'deflate'],
  threshold: 1024,
});

// 安全 headers
await fastify.register(helmet, {
  contentSecurityPolicy: false, // 前端獨立部署，不由後端設 CSP
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
});

// CORS：限制白名單 origin
const ALLOWED_ORIGINS = [
  'https://hades0800.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];
await fastify.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // 允許 curl/Postman 測試
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('不允許的來源'), false);
  },
  credentials: true,
});

// 全域速率限制：每 IP 每分鐘 120 次
await fastify.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, ctx) => ({
    ok: false,
    error: `請求太頻繁，請稍候 ${Math.ceil(ctx.ttl / 1000)} 秒再試`,
  }),
});

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET || 'dev-secret-change-me',
});

// 自訂 authenticate 裝飾器
fastify.decorate('authenticate', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: '請先登入' });
  }
});

// 角色檢查 helper — JWT payload 帶 roles 字串（'admin,pm' 這種）
function userHasRole(user, role) {
  if (!user || !user.roles) return false;
  const arr = String(user.roles).split(',').map(s => s.trim()).filter(Boolean);
  return arr.includes(role);
}
fastify.decorate('hasRole', userHasRole);

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

// ─── 權限系統（DB 驅動，可由後台調整）────────────────────
// 權限目錄：系統所有可指派的能力（seed 進 Permission 表）
const PERMISSION_CATALOG = [
  { key: 'view_records',    name: '歷史實態紀錄',                   category: '頁面', sortOrder: 1 },
  { key: 'view_plan_stats', name: '計畫達成統計',                   category: '頁面', sortOrder: 2 },
  { key: 'view_goal_stats', name: '目標達成統計',                   category: '頁面', sortOrder: 3 },
  { key: 'upload',          name: '上傳工單',                       category: '操作', sortOrder: 4 },
  { key: 'modify_records',  name: '修改/取消/補登生產紀錄',         category: '操作', sortOrder: 5 },
  { key: 'delete_order',    name: '刪除工單',                       category: '操作', sortOrder: 6 },
  { key: 'manage_accounts', name: '帳號管理',                       category: '管理', sortOrder: 7 },
  { key: 'admin_tools',     name: '回收桶/重設/永久刪除/稽核/診斷', category: '管理', sortOrder: 8 },
];
const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map(p => p.key);
const ROLE_CATALOG = [
  { key: 'admin', name: '管理員', isSystem: true, sortOrder: 1 },
  { key: 'qc',    name: '品管',   isSystem: true, sortOrder: 2 },
  { key: 'pm',    name: '生管',   isSystem: true, sortOrder: 3 },
  { key: 'tech',  name: '技術員', isSystem: true, sortOrder: 4 },
];
const DEFAULT_ROLE_PERMS = {
  admin: ALL_PERMISSION_KEYS,
  qc:    ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records'],
  pm:    ['view_records', 'view_plan_stats', 'view_goal_stats', 'modify_records', 'upload', 'delete_order'],
  tech:  ['view_records', 'view_plan_stats', 'view_goal_stats'],
};

// 記憶體快取：roleKey -> Set(permKey)；admin 不靠快取（永遠全有）
let rolePermsMap = {};

// admin 角色永遠擁有全部權限（防鎖死）
function userHasPermission(user, permKey) {
  if (!user || !user.roles) return false;
  const roles = String(user.roles).split(',').map(s => s.trim()).filter(Boolean);
  if (roles.includes('admin')) return true;
  for (const r of roles) {
    if (rolePermsMap[r] && rolePermsMap[r].has(permKey)) return true;
  }
  return false;
}
fastify.decorate('hasPermission', userHasPermission);
fastify.decorate('requirePermission', (permKey) => async (request, reply) => {
  if (!userHasPermission(request.user, permKey)) {
    reply.code(403).send({ error: '權限不足' });
  }
});

// 把角色字串展開成權限 key 陣列（login / me 回傳給前端用）
function resolvePermissions(rolesStr) {
  const roles = String(rolesStr || '').split(',').map(s => s.trim()).filter(Boolean);
  if (roles.includes('admin')) return ALL_PERMISSION_KEYS.slice();
  const out = new Set();
  roles.forEach(r => { if (rolePermsMap[r]) rolePermsMap[r].forEach(k => out.add(k)); });
  return [...out];
}
fastify.decorate('resolvePermissions', resolvePermissions);

// 從 DB 載入角色權限到記憶體（啟動 + 後台修改後呼叫）
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

// seed 權限目錄 + 角色 + 預設對應（idempotent；新角色才補預設，不覆蓋既有設定）
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

// 健康檢查
fastify.get('/', async () => ({ ok: true, msg: '工單記錄系統 API 運作中' }));
fastify.get('/health', async () => ({ ok: true }));

// 診斷端點（僅管理員）
fastify.get('/diag', { onRequest: [fastify.authenticate, fastify.requirePermission('admin_tools')] }, async () => {
  const env = {
    DATABASE_URL: process.env.DATABASE_URL ? '已設定 (' + process.env.DATABASE_URL.slice(0, 25) + '...)' : '❌ 未設定',
    JWT_SECRET: process.env.JWT_SECRET ? '已設定' : '❌ 未設定',
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || '❌ 未設定',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? '已設定' : '❌ 未設定',
    ADMIN_NAME: process.env.ADMIN_NAME || '❌ 未設定',
  };
  let dbStatus = 'unknown';
  let dbError = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = '✓ 連線成功';
  } catch (err) {
    dbStatus = '❌ 連線失敗';
    dbError = String(err.message || err);
  }
  let leaderCount = null;
  try { leaderCount = await prisma.leader.count(); } catch (e) { leaderCount = 'error: ' + e.message; }
  return { env, dbStatus, dbError, leaderCount };
});

// 路由
await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(orderRoutes, { prefix: '/api/orders' });
await fastify.register(adminRoutes, { prefix: '/api/admin' });
await fastify.register(equipmentParamRoutes, { prefix: '/api/equipment-params' });
// v2 API（新 React 前端用）— 已實作模組各自註冊；其餘端點還在 v2.js 當 stub
await fastify.register(v2AuthRoutes, { prefix: '/v2' });
await fastify.register(v2Routes, { prefix: '/v2' });

// ── 修正工單日期 ──
fastify.post('/api/fix-dates', {
  onRequest: [fastify.authenticate, fastify.requirePermission('admin_tools')],
}, async () => {
  const orders = await fastify.prisma.order.findMany({
    include: {
      stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' }, take: 1 },
      pauseEvents: { where: { deletedAt: null }, orderBy: { startAt: 'asc' }, take: 1 },
    },
  });
  let fixed = 0;
  for (const o of orders) {
    const times = [];
    ['step1At','step2At','step3At','step4At','step5At','step6At','step7At','step11At','step21At','step22At','step23At'].forEach(k => {
      if (o[k]) times.push(new Date(o[k]));
    });
    if (o.stepEntries && o.stepEntries.length > 0) times.push(new Date(o.stepEntries[0].recordedAt));
    if (o.pauseEvents && o.pauseEvents.length > 0) times.push(new Date(o.pauseEvents[0].startAt));
    if (times.length === 0) {
      if (o.productionDate) {
        await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: null } });
        fixed++;
      }
      continue;
    }
    const earliest = new Date(Math.min(...times.map(t => t.getTime())));
    const twTime = new Date(earliest.getTime() + 8 * 60 * 60 * 1000);
    const y = twTime.getUTCFullYear(), m = twTime.getUTCMonth(), d = twTime.getUTCDate();
    const correctDate = new Date(Date.UTC(y, m, d));
    const current = o.productionDate ? new Date(o.productionDate).getTime() : null;
    if (current !== correctDate.getTime()) {
      await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: correctDate } });
      fixed++;
    }
  }
  return { ok: true, total: orders.length, fixed };
});

// ── 無工令事件 ──
const ALLOWED_MACHINES = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40']);

fastify.post('/api/idle-events', {
  onRequest: [fastify.authenticate],
  config: {
    rateLimit: { max: 10, timeWindow: '1 minute' },
  },
}, async (request, reply) => {
  const { machineNo, note } = request.body || {};
  if (!machineNo) return reply.code(400).send({ error: '缺少機台號' });
  if (!ALLOWED_MACHINES.has(machineNo)) return reply.code(400).send({ error: '不允許的機台號' });
  const event = await prisma.idleEvent.create({
    data: {
      machineNo,
      leaderId: request.user.id,
      leaderName: request.user.displayName || null,
      note: note ? String(note).slice(0, 500) : null,
    },
  });
  return { ok: true, event };
});

fastify.get('/api/idle-events', { onRequest: [fastify.authenticate] }, async (request) => {
  const limit = Math.min(Number(request.query.limit) || 100, 500);
  const events = await prisma.idleEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return { events };
});

// 刪除無工令事件（管理員或建立者本人）
fastify.delete('/api/idle-events/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!id) return reply.code(400).send({ error: '無效 id' });
  const event = await prisma.idleEvent.findUnique({ where: { id } });
  if (!event) return reply.code(404).send({ error: '找不到紀錄' });
  if (!fastify.hasPermission(request.user, 'admin_tools') && event.leaderId !== request.user.id) {
    return reply.code(403).send({ error: '只能取消自己建立的紀錄' });
  }
  await prisma.idleEvent.delete({ where: { id } });
  return { ok: true };
});

// 自動建立第一位管理員
function _hasAdminRole(rolesStr) {
  return typeof rolesStr === 'string' && rolesStr.split(',').map(s => s.trim()).includes('admin');
}

async function ensureAdmin() {
  // ── Leader（v1）─────────────────────────────────
  // 找任何一個 roles 含 'admin' 的使用者；活的 admin 已存在就跳過建立
  let leaderAdmin = await prisma.leader.findFirst({
    where: { roles: { contains: 'admin' } },
  });

  if (!leaderAdmin) {
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    const displayName = process.env.ADMIN_NAME || '管理員';
    if (!username || !password) {
      fastify.log.warn('沒有任何管理員，且 ADMIN_USERNAME/ADMIN_PASSWORD 未設定，跳過建立');
    } else {
      // 含已軟刪除（逃生口：deletedAt 鍵出現即繞過 middleware 自動過濾）
      const exists = await prisma.leader.findFirst({ where: { username, deletedAt: undefined } });
      if (exists) {
        const patch = {};
        if (exists.deletedAt) patch.deletedAt = null;
        if (!_hasAdminRole(exists.roles)) {
          const cur = (exists.roles || '').split(',').map(s => s.trim()).filter(Boolean);
          if (!cur.includes('admin')) cur.unshift('admin');
          patch.roles = cur.join(',');
        }
        if (Object.keys(patch).length > 0) {
          await prisma.leader.update({ where: { id: exists.id }, data: patch });
          fastify.log.info(`已恢復/提升 Leader 管理員：${username}`);
        }
        leaderAdmin = await prisma.leader.findUnique({ where: { id: exists.id } });
      } else {
        const passwordHash = await bcrypt.hash(password, 10);
        leaderAdmin = await prisma.leader.create({
          data: { username, passwordHash, displayName, roles: 'admin' },
        });
        fastify.log.info(`✓ 已建立 Leader 第一位管理員: ${username}`);
      }
    }
  }

  // ── Account（v2 新表）─────────────────────────
  // 確保至少有一個「有效」(deletedAt=null + enable=true) 的 admin Account
  // 來源優先序：1) 跟 Leader admin 同帳號同密碼同步 / 2) 沒有 Leader 就用 ENV
  // 註：Account 不在 SOFT_DELETE_MODELS，prisma 查詢不會自動過濾 deletedAt
  await ensureAccountAdmin(leaderAdmin);
}

async function ensureAccountAdmin(leaderAdmin) {
  const existingActive = await prisma.account.findFirst({
    where: { roles: { contains: 'admin' }, deletedAt: null, enable: true },
  });
  if (existingActive) return;

  // 沒有有效 admin Account → 決定來源
  let username, passwordHash, displayName, roles;
  if (leaderAdmin) {
    username = leaderAdmin.username;
    passwordHash = leaderAdmin.passwordHash;        // 同一份 hash，v1 / v2 密碼一致
    displayName = leaderAdmin.displayName;
    roles = _hasAdminRole(leaderAdmin.roles) ? leaderAdmin.roles : 'admin';
  } else {
    username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    displayName = process.env.ADMIN_NAME || '管理員';
    if (!username || !password) {
      fastify.log.warn('Account 沒有 admin，且 ADMIN_USERNAME/ADMIN_PASSWORD 未設定，跳過建立');
      return;
    }
    passwordHash = await bcrypt.hash(password, 10);
    roles = 'admin';
  }

  // 看 username 在 Account 是否已存在（可能是軟刪/停用狀態）
  const exists = await prisma.account.findUnique({ where: { username } });
  if (exists) {
    const patch = {};
    if (exists.deletedAt) patch.deletedAt = null;
    if (exists.enable === false) patch.enable = true;
    if (!_hasAdminRole(exists.roles)) {
      const cur = (exists.roles || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes('admin')) cur.unshift('admin');
      patch.roles = cur.join(',');
    }
    if (Object.keys(patch).length > 0) {
      await prisma.account.update({ where: { id: exists.id }, data: patch });
      fastify.log.info(`已恢復/提升 Account 管理員：${username}`);
    } else {
      fastify.log.info(`Account 已有 admin（${username}），跳過`);
    }
    return;
  }

  await prisma.account.create({
    data: { username, passwordHash, displayName, roles, enable: true },
  });
  fastify.log.info(`✓ 已建立 Account 第一位管理員：${username}`);
}

const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

// 啟動時自動執行 prisma db push（建立 / 同步資料表）
function runDbPush() {
  if (!process.env.DATABASE_URL) {
    console.error('⚠️ DATABASE_URL 未設定，跳過 prisma db push');
    return;
  }
  try {
    console.log('→ 執行 prisma db push...');
    execSync('npx prisma db push --skip-generate --accept-data-loss', { stdio: 'inherit' });
    console.log('✓ prisma db push 完成');
  } catch (err) {
    console.error('⚠️ prisma db push 失敗，但 server 仍會啟動，請訪問 /diag 看狀態：');
    console.error(err.message);
  }
}

// 角色欄位遷移：把舊的 isAdmin/isPlanner 兩個 boolean 欄轉成新的 roles 字串欄
// 必須在 prisma db push 之前跑（否則 --accept-data-loss 會把舊欄位直接 drop 掉導致資料遺失）
async function ensureRolesColumn() {
  if (!process.env.DATABASE_URL) return;
  try {
    // 1. 加上 roles 欄位（若還沒有）
    await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" ADD COLUMN IF NOT EXISTS "roles" TEXT`);

    // 2. 看 isAdmin / isPlanner 還在不在
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Leader'
    `);
    const colSet = new Set((cols || []).map(c => c.column_name));
    const hasIsAdmin = colSet.has('isAdmin');
    const hasIsPlanner = colSet.has('isPlanner');

    // 3. 把 boolean 欄轉成 roles 字串（只填空值，已遷移過的不動）
    if (hasIsAdmin || hasIsPlanner) {
      const adminExpr = hasIsAdmin ? '"isAdmin"' : 'FALSE';
      const plannerExpr = hasIsPlanner ? '"isPlanner"' : 'FALSE';
      await prisma.$executeRawUnsafe(`
        UPDATE "Leader" SET "roles" = (
          CASE
            WHEN ${adminExpr} = true AND ${plannerExpr} = true THEN 'admin,pm'
            WHEN ${adminExpr} = true THEN 'admin'
            WHEN ${plannerExpr} = true THEN 'pm'
            ELSE 'qc'
          END
        ) WHERE "roles" IS NULL OR "roles" = ''
      `);
      if (hasIsAdmin) await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" DROP COLUMN IF EXISTS "isAdmin"`);
      if (hasIsPlanner) await prisma.$executeRawUnsafe(`ALTER TABLE "Leader" DROP COLUMN IF EXISTS "isPlanner"`);
      console.log('✓ Leader.roles 遷移完成（舊 isAdmin/isPlanner 已 drop）');
    }

    // 4. 兜底：任何還是 NULL 的設成預設 'qc'
    await prisma.$executeRawUnsafe(`UPDATE "Leader" SET "roles" = 'qc' WHERE "roles" IS NULL OR "roles" = ''`);
  } catch (err) {
    console.error('⚠️ ensureRolesColumn 失敗，但 server 仍會啟動：', err.message);
  }
}

await ensureRolesColumn();
runDbPush();

// 角色 / 權限：seed 預設 + 載入記憶體快取（失敗不擋啟動）
try {
  await seedRolesAndPermissions();
  await loadRolePermsMap();
} catch (err) {
  console.error('⚠️ 角色權限初始化失敗，但 server 仍會啟動：', err.message);
}

// 不讓 ensureAdmin 失敗導致 server 不啟動 — 改成警告，server 仍要啟動方便除錯
try {
  await ensureAdmin();
} catch (err) {
  console.error('⚠️ ensureAdmin 失敗，但 server 仍會啟動，可訪問 /diag 看狀態：');
  console.error(err);
}

try {
  await fastify.listen({ port, host });
  console.log(`✓ Listening on ${host}:${port}`);
  console.log(`✓ 測試: GET https://你的網址/diag 可看 DB 連線狀態`);
} catch (err) {
  console.error('❌ 無法啟動 server:');
  console.error(err);
  process.exit(1);
}
