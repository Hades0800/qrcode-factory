import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { execSync } from 'child_process';

import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';

const prisma = new PrismaClient();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024, // 2MB 限制避免 DoS
  trustProxy: true,
});

// 全域注入 prisma
fastify.decorate('prisma', prisma);

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

fastify.decorate('requireAdmin', async (request, reply) => {
  if (!request.user?.isAdmin) {
    reply.code(403).send({ error: '需要管理員權限' });
  }
});

// 健康檢查
fastify.get('/', async () => ({ ok: true, msg: '工單記錄系統 API 運作中' }));
fastify.get('/health', async () => ({ ok: true }));

// 診斷端點（測 DB 連線、列出環境變數狀態，密碼遮蔽）
fastify.get('/diag', async () => {
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

// 生產無工令事件
fastify.post('/api/idle-events', { onRequest: [fastify.authenticate] }, async (request, reply) => {
  const { machineNo, note } = request.body || {};
  if (!machineNo) return reply.code(400).send({ error: '缺少機台號' });
  const ALLOWED = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40']);
  if (!ALLOWED.has(machineNo)) return reply.code(400).send({ error: '不允許的機台號' });
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

fastify.delete('/api/idle-events/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!id) return reply.code(400).send({ error: '無效 id' });
  const event = await prisma.idleEvent.findUnique({ where: { id } });
  if (!event) return reply.code(404).send({ error: '找不到紀錄' });
  await prisma.idleEvent.delete({ where: { id } });
  return { ok: true };
});

// 自動建立第一位管理員
async function ensureAdmin() {
  const count = await prisma.leader.count({ where: { isAdmin: true } });
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const displayName = process.env.ADMIN_NAME || '管理員';
  if (!username || !password) {
    fastify.log.warn('沒有任何管理員，且 ADMIN_USERNAME/ADMIN_PASSWORD 未設定，跳過建立');
    return;
  }
  const exists = await prisma.leader.findUnique({ where: { username } });
  if (exists) {
    if (!exists.isAdmin) {
      await prisma.leader.update({ where: { id: exists.id }, data: { isAdmin: true } });
      fastify.log.info(`已將 ${username} 設為管理員`);
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.leader.create({
    data: { username, passwordHash, displayName, isAdmin: true },
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
