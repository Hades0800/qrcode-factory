import jwt from '@fastify/jwt';

// 註冊 JWT 與 authenticate（需登入）裝飾器
// ※ 授權相關（requireAdmin / requirePermission…）改由 plugins/permissions.js 提供，
//   因為身份組已從 isAdmin/isPlanner 布林改為 Leader.roles 多角色 + DB 權限表。
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
}
