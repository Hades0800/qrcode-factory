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
    try {
      await fastify.prisma.auditLog.create({
        data: {
          actorId: request.user?.id || null,
          actorName: request.user?.displayName || null,
          action: 'create_leader',
          target: username,
          detail: `admin=${!!isAdmin} planner=${!!isPlanner}`,
          ip: request.ip || null,
        },
      });
    } catch (e) {}
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
    try {
      await fastify.prisma.auditLog.create({
        data: {
          actorId: request.user?.id || null,
          actorName: request.user?.displayName || null,
          action: 'reset_password',
          target: leader.username,
          ip: request.ip || null,
        },
      });
    } catch (e) {}
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
    try {
      await fastify.prisma.auditLog.create({
        data: {
          actorId: request.user?.id || null,
          actorName: request.user?.displayName || null,
          action: 'delete_leader',
          target: leader.username,
          ip: request.ip || null,
        },
      });
    } catch (e) {}
    return { ok: true };
  });

  // 查單號完整歷史（含已軟刪除的工單、含已取消批次的上傳列）
  // - 用模糊比對：q 是 prefix / 完整單號 / 部分都行
  fastify.get('/find-orderno', async (request, reply) => {
    const q = String(request.query.q || '').trim().toUpperCase();
    if (!q) return reply.code(400).send({ error: '請提供 q 參數' });
    if (q.length > 60) return reply.code(400).send({ error: 'q 太長' });

    // 工單表（同時查使用中 + 已軟刪除，合併）
    // 不依賴 deletedAt:undefined 這種 fragile 寫法；改成兩段顯式 query
    const SELECT_FIELDS = {
      id: true, orderNo: true, machineNo: true, plannedMachineNo: true,
      productSpec: true, moldSpec: true, material: true,
      productionDate: true, createdAt: true, updatedAt: true, deletedAt: true,
      leader: { select: { displayName: true } },
    };
    const [activeOrders, deletedOrders] = await Promise.all([
      // middleware 會自動補 deletedAt: null，這裡只查使用中的
      fastify.prisma.order.findMany({
        where: { orderNo: { contains: q } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: SELECT_FIELDS,
      }),
      // 顯式查已刪除（where 內有 deletedAt 鍵，middleware 不會再注入）
      fastify.prisma.order.findMany({
        where: { orderNo: { contains: q }, deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
        take: 50,
        select: SELECT_FIELDS,
      }),
    ]);
    const orders = [...activeOrders, ...deletedOrders];

    // 上傳列表（含已取消批次）
    const uploadRows = await fastify.prisma.uploadRow.findMany({
      where: { orderNo: { contains: q } },
      orderBy: { id: 'desc' },
      take: 100,
      include: {
        batch: {
          select: {
            id: true, filename: true, uploadedByName: true,
            uploadedAt: true, cancelledAt: true,
          },
        },
      },
    });

    return {
      ok: true,
      orders: orders.map(o => ({
        ...o,
        leaderName: o.leader?.displayName || null,
        leader: undefined,
      })),
      uploadRows,
    };
  });

  // 修正所有工單的 productionDate 為第一筆活動日期（台灣時間）
  fastify.post('/fix-production-dates', async () => {
    const orders = await fastify.prisma.order.findMany({
      include: {
        stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' }, take: 1 },
        pauseEvents: { where: { deletedAt: null }, orderBy: { startAt: 'asc' }, take: 1 },
      },
    });
    let fixed = 0;
    for (const o of orders) {
      const times = [];
      ['step1At','step2At','step3At','step4At','step5At','step6At','step7At','step11At','step21At','step22At','step23At'].forEach(k => {
        if (o[k]) times.push(new Date(o[k]));
      });
      if (o.stepEntries && o.stepEntries.length > 0) times.push(new Date(o.stepEntries[0].recordedAt));
      if (o.pauseEvents && o.pauseEvents.length > 0) times.push(new Date(o.pauseEvents[0].startAt));
      if (times.length === 0) {
        if (o.productionDate) {
          await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: null } });
          fixed++;
        }
        continue;
      }
      const earliest = new Date(Math.min(...times.map(t => t.getTime())));
      const twTime = new Date(earliest.getTime() + 8 * 60 * 60 * 1000);
      const y = twTime.getUTCFullYear(), m = twTime.getUTCMonth(), d = twTime.getUTCDate();
      const correctDate = new Date(Date.UTC(y, m, d));
      const current = o.productionDate ? new Date(o.productionDate).getTime() : null;
      if (current !== correctDate.getTime()) {
        await fastify.prisma.order.update({ where: { id: o.id }, data: { productionDate: correctDate } });
        fixed++;
      }
    }
    return { ok: true, total: orders.length, fixed };
  });
}
