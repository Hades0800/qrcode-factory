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

// 健康檢查
fastify.get('/', async () => ({ ok: true, msg: '工單記錄系統 API 運作中' }));
fastify.get('/health', async () => ({ ok: true }));

// 診斷端點（僅管理員）
fastify.get('/diag', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
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

// ── 修正工單日期 ──
fastify.post('/api/fix-dates', {
  onRequest: [fastify.authenticate, fastify.requireAdmin],
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
  if (!fastify.hasRole(request.user, 'admin') && event.leaderId !== request.user.id) {
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
  // 找任何一個 roles 含 'admin' 的使用者
  const adminCount = await prisma.leader.count({
    where: { roles: { contains: 'admin' } },
  });
  if (adminCount > 0) return;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const displayName = process.env.ADMIN_NAME || '管理員';
  if (!username || !password) {
    fastify.log.warn('沒有任何管理員，且 ADMIN_USERNAME/ADMIN_PASSWORD 未設定，跳過建立');
    return;
  }
  // 含已軟刪除（逃生口：deletedAt 鍵出現即繞過 middleware 自動過濾）
  const exists = await prisma.leader.findFirst({ where: { username, deletedAt: undefined } });
  if (exists) {
    const patch = {};
    if (exists.deletedAt) patch.deletedAt = null;
    if (!_hasAdminRole(exists.roles)) {
      // 把 admin 加進現有 roles
      const cur = (exists.roles || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes('admin')) cur.unshift('admin');
      patch.roles = cur.join(',');
    }
    if (Object.keys(patch).length > 0) {
      await prisma.leader.update({ where: { id: exists.id }, data: patch });
      fastify.log.info(`已恢復/提升管理員：${username}`);
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.leader.create({
    data: { username, passwordHash, displayName, roles: 'admin' },
  });
  fastify.log.info(`✓ 已建立第一位管理員: ${username}`);
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
