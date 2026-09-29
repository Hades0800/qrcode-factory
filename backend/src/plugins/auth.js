import jwt from '@fastify/jwt';

// 註冊 JWT 與授權裝飾器：authenticate（需登入）、requireAdmin（需管理員）
export async function registerAuth(fastify) {
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

  // 角色檢查(關聯表的擔當同仁):roles 是逗號字串,見 lib/roles.js。
  // 用法:{ onRequest: [fastify.authenticate, fastify.requireRole('warehouse', 'sales')] }
  // 過渡期規則:管理員一律通過;帳號還沒指定任何角色的也通過——現況是所有登入者都能做
  // 所有事,等管理員把角色指定下去之後才開始限制,不會一上線大家都被擋在外面。
  fastify.decorate('requireRole', (...roles) => async (request, reply) => {
    const u = request.user || {};
    if (u.isAdmin) return;
    const mine = String(u.roles || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!mine.length) return;
    if (!roles.some(r => mine.includes(r))) {
      reply.code(403).send({ error: '需要角色:' + roles.join(' / ') });
    }
  });
}
