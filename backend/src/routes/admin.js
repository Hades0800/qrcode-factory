import bcrypt from 'bcryptjs';

export default async function adminRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onRequest', fastify.requireAdmin);

  // 列出所有小組長
  const VALID_ROLES = ['admin', 'qc', 'pm', 'tech'];
  // 把任意輸入正規化成「合法角色逗號字串」；預設 'qc'
  function normalizeRoles(input) {
    let arr = [];
    if (Array.isArray(input)) arr = input;
    else if (typeof input === 'string') arr = input.split(',');
    else return 'qc';
    const cleaned = arr.map(s => String(s).trim()).filter(Boolean);
    const valid = cleaned.filter(r => VALID_ROLES.includes(r));
    if (valid.length === 0) return 'qc';
    // 依固定順序排（admin, qc, pm, tech）、去重
    return VALID_ROLES.filter(r => valid.includes(r)).join(',');
  }

  fastify.get('/leaders', async () => {
    const leaders = await fastify.prisma.leader.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        displayName: true,
        roles: true,
        createdAt: true,
      },
    });
    return { leaders };
  });

  // 新增
  fastify.post('/leaders', async (request, reply) => {
    const { username, password, displayName, roles } = request.body || {};
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
    const normalizedRoles = normalizeRoles(roles);
    const exists = await fastify.prisma.leader.findUnique({ where: { username } });
    if (exists) return reply.code(409).send({ error: '帳號已存在' });
    const passwordHash = await bcrypt.hash(password, 10);
    const leader = await fastify.prisma.leader.create({
      data: { username, passwordHash, displayName, roles: normalizedRoles },
      select: { id: true, username: true, displayName: true, roles: true, createdAt: true },
    });
    try {
      await fastify.prisma.auditLog.create({
        data: {
          actorId: request.user?.id || null,
          actorName: request.user?.displayName || null,
          action: 'create_leader',
          target: username,
          detail: `roles=${normalizedRoles}`,
          ip: request.ip || null,
        },
      });
    } catch (e) {}
    return { leader };
  });

  // 改角色（admin 可修改任何人的 roles）
  fastify.post('/leaders/:id/roles', async (request, reply) => {
    const id = Number(request.params.id);
    const { roles } = request.body || {};
    const leader = await fastify.prisma.leader.findUnique({ where: { id } });
    if (!leader) return reply.code(404).send({ error: '帳號不存在' });
    const next = normalizeRoles(roles);
    // 保險：不能把最後一個 admin 拔掉
    if (leader.roles && leader.roles.split(',').includes('admin') && !next.split(',').includes('admin')) {
      const otherAdminCount = await fastify.prisma.leader.count({
        where: { roles: { contains: 'admin' }, id: { not: id } },
      });
      if (otherAdminCount === 0) {
        return reply.code(400).send({ error: '不能拔掉最後一個管理員的 admin 角色' });
      }
    }
    await fastify.prisma.leader.update({ where: { id }, data: { roles: next } });
    try {
      await fastify.prisma.auditLog.create({
        data: {
          actorId: request.user?.id || null,
          actorName: request.user?.displayName || null,
          action: 'update_roles',
          target: leader.username,
          detail: `${leader.roles} → ${next}`,
          ip: request.ip || null,
        },
      });
    } catch (e) {}
    return { ok: true, roles: next };
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

    // 對每張工單算「已軟刪除的子紀錄計數」（提示是否能救回 reset 掉的紀錄）
    const orderIds = orders.map(o => o.id);
    const [softDeletedEntries, softDeletedPauses] = orderIds.length === 0 ? [[], []] : await Promise.all([
      fastify.prisma.stepEntry.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds }, deletedAt: { not: null } },
        _count: { _all: true },
      }),
      fastify.prisma.pauseEvent.groupBy({
        by: ['orderId'],
        where: { orderId: { in: orderIds }, deletedAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const entryCountMap = Object.fromEntries(softDeletedEntries.map(g => [g.orderId, g._count._all]));
    const pauseCountMap = Object.fromEntries(softDeletedPauses.map(g => [g.orderId, g._count._all]));

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
        softDeletedEntries: entryCountMap[o.id] || 0,
        softDeletedPauses: pauseCountMap[o.id] || 0,
      })),
      uploadRows,
    };
  });

  // 列出有「軟刪除生產紀錄」但工單仍使用中的工單（reset-production 之後可救回）
  fastify.get('/orders-with-soft-deleted-records', async () => {
    const [softEntryGroups, softPauseGroups] = await Promise.all([
      fastify.prisma.stepEntry.groupBy({
        by: ['orderId'],
        where: { deletedAt: { not: null } },
        _count: { _all: true },
        _max: { deletedAt: true },
      }),
      fastify.prisma.pauseEvent.groupBy({
        by: ['orderId'],
        where: { deletedAt: { not: null } },
        _count: { _all: true },
        _max: { deletedAt: true },
      }),
    ]);
    const orderIds = Array.from(new Set([
      ...softEntryGroups.map(g => g.orderId),
      ...softPauseGroups.map(g => g.orderId),
    ]));
    if (orderIds.length === 0) return { orders: [] };
    // 只列「使用中」的工單（軟刪除工單已在 trash 區塊，避免重複）
    const orders = await fastify.prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: {
        id: true, orderNo: true, machineNo: true, productSpec: true, moldSpec: true,
        plannedDate: true, actualStartDate: true,
        leader: { select: { displayName: true } },
      },
    });
    const entryMap = Object.fromEntries(softEntryGroups.map(g => [g.orderId, g]));
    const pauseMap = Object.fromEntries(softPauseGroups.map(g => [g.orderId, g]));
    return {
      orders: orders.map(o => {
        const e = entryMap[o.id], p = pauseMap[o.id];
        const lastDeletedAt = [e?._max?.deletedAt, p?._max?.deletedAt]
          .filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
        return {
          ...o,
          leaderName: o.leader?.displayName || null,
          leader: undefined,
          softDeletedEntries: e?._count?._all || 0,
          softDeletedPauses: p?._count?._all || 0,
          lastDeletedAt,
        };
      }).sort((a, b) => new Date(b.lastDeletedAt || 0) - new Date(a.lastDeletedAt || 0)),
    };
  });

  // 列出已取消的上傳批次
  fastify.get('/cancelled-upload-batches', async () => {
    const batches = await fastify.prisma.uploadBatch.findMany({
      where: { cancelledAt: { not: null } },
      orderBy: { cancelledAt: 'desc' },
      take: 200,
      select: {
        id: true, filename: true, uploadedByName: true, uploadedAt: true,
        cancelledAt: true, rowCount: true, productionDate: true, orderNos: true,
      },
    });
    return { batches };
  });

  // 操作紀錄（audit log）
  // ?days=7 取最近 7 天；可選 ?action=delete_order 過濾
  fastify.get('/audit-log', async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = { createdAt: { gte: since } };
    if (request.query.action) where.action = String(request.query.action).slice(0, 60);
    const logs = await fastify.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { logs, days };
  });

  // 一次性 migration：把舊 productionDate 拆成 plannedDate + actualStartDate
  // - actualStartDate：用第一筆活動的台灣日期
  // - plannedDate：找最早未取消批次的 productionDate；找不到就用舊 productionDate
  fastify.post('/migrate-dates', async () => {
    const toTwDate = (t) => {
      const d = t instanceof Date ? t : new Date(t);
      const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
      return new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
    };
    const orders = await fastify.prisma.order.findMany({
      include: {
        stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' }, take: 1 },
        pauseEvents: { where: { deletedAt: null }, orderBy: { startAt: 'asc' }, take: 1 },
      },
    });
    let updated = 0;
    for (const o of orders) {
      // 計算 actualStartDate
      const times = [];
      ['step1At','step2At','step3At','step4At','step5At','step6At','step7At','step11At','step21At','step22At','step23At'].forEach(k => {
        if (o[k]) times.push(new Date(o[k]));
      });
      if (o.stepEntries && o.stepEntries.length > 0) times.push(new Date(o.stepEntries[0].recordedAt));
      if (o.pauseEvents && o.pauseEvents.length > 0) times.push(new Date(o.pauseEvents[0].startAt));
      const actualStartDate = times.length > 0
        ? toTwDate(new Date(Math.min(...times.map(t => t.getTime()))))
        : null;

      // 計算 plannedDate：最早一筆未取消批次的 productionDate
      let plannedDate = null;
      const earliestRow = await fastify.prisma.uploadRow.findFirst({
        where: { orderNo: o.orderNo, batch: { cancelledAt: null } },
        include: { batch: { select: { productionDate: true, uploadedAt: true } } },
        orderBy: { batchId: 'asc' },
      });
      if (earliestRow && earliestRow.batch && earliestRow.batch.productionDate) {
        plannedDate = earliestRow.batch.productionDate;
      } else if (o.productionDate) {
        plannedDate = o.productionDate;
      }

      const needUpdate = (
        (actualStartDate && (!o.actualStartDate || new Date(o.actualStartDate).getTime() !== actualStartDate.getTime())) ||
        (plannedDate && (!o.plannedDate || new Date(o.plannedDate).getTime() !== new Date(plannedDate).getTime()))
      );
      if (needUpdate) {
        await fastify.prisma.order.update({
          where: { id: o.id },
          data: { actualStartDate, plannedDate },
        });
        updated++;
      }
    }
    return { ok: true, total: orders.length, updated };
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
