import bcrypt from 'bcryptjs';

export default async function authRoutes(fastify) {
  // 登入：每 IP 每 15 分鐘最多 10 次（防暴力破解）
  fastify.post('/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        errorResponseBuilder: () => ({
          ok: false,
          error: '登入嘗試過多，請 15 分鐘後再試',
        }),
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: '請輸入帳號密碼' });
    }
    if (typeof username !== 'string' || typeof password !== 'string' ||
        username.length > 60 || password.length > 200) {
      return reply.code(400).send({ error: '輸入格式錯誤' });
    }
    const leader = await fastify.prisma.leader.findUnique({ where: { username } });
    // 不區分帳號存在與否，避免帳號列舉
    const fakeHash = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VjWZSp9YJ0.dFaVBRYHx3N4L5UoEe';
    const hash = leader ? leader.passwordHash : fakeHash;
    const ok = await bcrypt.compare(password, hash);
    if (!leader || !ok) return reply.code(401).send({ error: '帳號或密碼錯誤' });

    const token = fastify.jwt.sign(
      {
        id: leader.id,
        username: leader.username,
        displayName: leader.displayName,
        roles: leader.roles || 'qc',
      },
      { expiresIn: '7d' },
    );
    return {
      token,
      leader: {
        id: leader.id,
        username: leader.username,
        displayName: leader.displayName,
        roles: leader.roles || 'qc',
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
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 200) {
      return reply.code(400).send({ error: '新密碼長度需 6~200 字' });
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
