import Fastify from 'fastify';
import cors from '@fastify/cors';
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
});

// 全域注入 prisma
fastify.decorate('prisma', prisma);

await fastify.register(cors, { origin: true });
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
