import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

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

try {
  await ensureAdmin();
  await fastify.listen({ port, host });
  console.log(`Listening on ${host}:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
