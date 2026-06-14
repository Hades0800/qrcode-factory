import bcrypt from 'bcryptjs';

// 自動建立第一位管理員（用 fastify.prisma / fastify.log）
export async function ensureAdmin(fastify) {
  const prisma = fastify.prisma;
  const count = await prisma.leader.count({ where: { isAdmin: true } });
  if (count > 0) return;
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
    if (!exists.isAdmin) patch.isAdmin = true;
    if (Object.keys(patch).length > 0) {
      await prisma.leader.update({ where: { id: exists.id }, data: patch });
      fastify.log.info(`已恢復/提升管理員：${username}`);
    }
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.leader.create({
    data: { username, passwordHash, displayName, isAdmin: true },
  });
  fastify.log.info(`✓ 已建立第一位管理員: ${username}`);
}
