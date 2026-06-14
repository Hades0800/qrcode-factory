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
}
