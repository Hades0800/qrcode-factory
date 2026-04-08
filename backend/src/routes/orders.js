const STEP_COLS = {
  '1': { time: 'step1At', note: null },
  '2': { time: 'step2At', note: null },
  '3': { time: 'step3At', note: null },
  '4': { time: 'step4At', note: 'step4Note' },
  '5': { time: 'step5At', note: null },
  '6': { time: 'step6At', note: null },
  '7': { time: 'step7At', note: 'step7Note' },
};

function serializeOrder(o) {
  if (!o) return null;
  return {
    orderNo: o.orderNo,
    machineNo: o.machineNo || '',
    leaderId: o.leaderId,
    leaderName: o.leader?.displayName || '',
    step1At: o.step1At,
    step2At: o.step2At,
    step3At: o.step3At,
    step4At: o.step4At,
    step4Note: o.step4Note,
    step5At: o.step5At,
    step6At: o.step6At,
    step7At: o.step7At,
    step7Note: o.step7Note,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

export default async function orderRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // 取得（不存在自動建立）
  fastify.get('/:orderNo', async (request, reply) => {
    const { orderNo } = request.params;
    if (!orderNo) return reply.code(400).send({ error: '缺少工單號' });
    let order = await fastify.prisma.order.findUnique({
      where: { orderNo },
      include: { leader: true },
    });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
        include: { leader: true },
      });
    }
    return { order: serializeOrder(order) };
  });

  // 設定機台號
  fastify.post('/:orderNo/machine', async (request, reply) => {
    const { orderNo } = request.params;
    const { machineNo } = request.body || {};
    if (!orderNo) return reply.code(400).send({ error: '缺少工單號' });
    if (!machineNo || !String(machineNo).trim()) {
      return reply.code(400).send({ error: '機台號不可空白' });
    }
    let order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
      });
    }
    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: { machineNo: String(machineNo).trim().slice(0, 60), leaderId: request.user.id },
      include: { leader: true },
    });
    return { order: serializeOrder(updated) };
  });

  // 紀錄某步驟
  fastify.post('/:orderNo/steps/:step', async (request, reply) => {
    const { orderNo, step } = request.params;
    const { note } = request.body || {};
    const cols = STEP_COLS[step];
    if (!cols) return reply.code(400).send({ error: '無效步驟' });

    let order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
      });
    }

    if (order[cols.time]) {
      const existing = await fastify.prisma.order.findUnique({
        where: { orderNo },
        include: { leader: true },
      });
      return reply.code(409).send({
        error: `此項目已記錄過：${order[cols.time].toISOString()}`,
        order: serializeOrder(existing),
      });
    }

    const updateData = {
      [cols.time]: new Date(),
      leaderId: request.user.id,
    };
    if (cols.note && note) updateData[cols.note] = String(note).slice(0, 500);

    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: { leader: true },
    });
    return { order: serializeOrder(updated) };
  });

  // 取消某步驟
  fastify.delete('/:orderNo/steps/:step', async (request, reply) => {
    const { orderNo, step } = request.params;
    const cols = STEP_COLS[step];
    if (!cols) return reply.code(400).send({ error: '無效步驟' });

    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });

    const updateData = { [cols.time]: null };
    if (cols.note) updateData[cols.note] = null;

    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: { leader: true },
    });
    return { order: serializeOrder(updated) };
  });

  // 刪除工單（僅管理員）
  fastify.delete('/:orderNo', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '只有管理員可以刪除工單' });
    }
    const { orderNo } = request.params;
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    await fastify.prisma.order.delete({ where: { orderNo } });
    return { ok: true };
  });

  // 列出近期工單（給管理者或自己查）
  fastify.get('/', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const where = request.user.isAdmin ? {} : { leaderId: request.user.id };
    const orders = await fastify.prisma.order.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { leader: true },
    });
    return { orders: orders.map(serializeOrder) };
  });
}
