import bcrypt from 'bcryptjs';

export default async function authRoutes(fastify) {
  // 登入
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: '請輸入帳號密碼' });
    }
    const leader = await fastify.prisma.leader.findUnique({ where: { username } });
    if (!leader) return reply.code(401).send({ error: '帳號或密碼錯誤' });
    const ok = await bcrypt.compare(password, leader.passwordHash);
    if (!ok) return reply.code(401).send({ error: '帳號或密碼錯誤' });

    const token = fastify.jwt.sign(
      { id: leader.id, username: leader.username, displayName: leader.displayName, isAdmin: leader.isAdmin },
      { expiresIn: '30d' },
    );
    return {
      token,
      leader: {
        id: leader.id,
        username: leader.username,
        displayName: leader.displayName,
        isAdmin: leader.isAdmin,
      },
    };
  });

  // 取得目前登入者
  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request) => {
    return { leader: request.user };
  });

  // 改密碼
  fastify.post('/change-password', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { oldPassword, newPassword } = request.body || {};
    if (!oldPassword || !newPassword) {
      return reply.code(400).send({ error: '請填寫舊密碼與新密碼' });
    }
    if (newPassword.length < 6) {
      return reply.code(400).send({ error: '新密碼至少 6 字' });
    }
    const leader = await fastify.prisma.leader.findUnique({ where: { id: request.user.id } });
    if (!leader) return reply.code(404).send({ error: '帳號不存在' });
    const ok = await bcrypt.compare(oldPassword, leader.passwordHash);
    if (!ok) return reply.code(401).send({ error: '舊密碼錯誤' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await fastify.prisma.leader.update({ where: { id: leader.id }, data: { passwordHash } });
    return { ok: true };
  });
}
