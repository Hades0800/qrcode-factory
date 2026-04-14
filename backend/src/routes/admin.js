import bcrypt from 'bcryptjs';

export default async function adminRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onRequest', fastify.requireAdmin);

  // 列出所有小組長
  fastify.get('/leaders', async () => {
    const leaders = await fastify.prisma.leader.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        isAdmin: true,
        isPlanner: true,
        createdAt: true,
      },
    });
    return { leaders };
  });

  // 新增
  fastify.post('/leaders', async (request, reply) => {
    const { username, password, displayName, isAdmin, isPlanner } = request.body || {};
    if (!username || !password || !displayName) {
      return reply.code(400).send({ error: '請填寫帳號、密碼、顯示名稱' });
    }
    if (!/^[a-zA-Z0-9_]{2,30}$/.test(username)) {
      return reply.code(400).send({ error: '帳號限英數底線 2~30 字' });
    }
    if (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 30) {
      return reply.code(400).send({ error: '顯示名稱長度需 1~30 字' });
    }
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
      return reply.code(400).send({ error: '密碼長度需 6~200 字' });
    }
    const exists = await fastify.prisma.leader.findUnique({ where: { username } });
    if (exists) return reply.code(409).send({ error: '帳號已存在' });
    const passwordHash = await bcrypt.hash(password, 10);
    const leader = await fastify.prisma.leader.create({
      data: { username, passwordHash, displayName, isAdmin: !!isAdmin, isPlanner: !!isPlanner },
      select: { id: true, username: true, displayName: true, isAdmin: true, isPlanner: true, createdAt: true },
    });
    return { leader };
  });

  // 重設密碼
  fastify.post('/leaders/:id/reset-password', async (request, reply) => {
    const id = Number(request.params.id);
    const { newPassword } = request.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
      return reply.code(400).send({ error: '密碼長度需 6~200 字' });
    }
    const leader = await fastify.prisma.leader.findUnique({ where: { id } });
    if (!leader) return reply.code(404).send({ error: '帳號不存在' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await fastify.prisma.leader.update({ where: { id }, data: { passwordHash } });
    return { ok: true };
  });

  // 刪除
  fastify.delete('/leaders/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user.id) {
      return reply.code(400).send({ error: '不能刪除自己' });
    }
    const leader = await fastify.prisma.leader.findUnique({ where: { id } });
    if (!leader) return reply.code(404).send({ error: '帳號不存在' });
    // 清空關聯
    await fastify.prisma.order.updateMany({ where: { leaderId: id }, data: { leaderId: null } });
    await fastify.prisma.leader.delete({ where: { id } });
    return { ok: true };
  });
}
