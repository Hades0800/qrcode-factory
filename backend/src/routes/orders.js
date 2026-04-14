const ORDER_NO_RE = /^[A-Z]\d{10}$/;
const ALLOWED_MACHINES = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40']);

function validOrderNo(s) { return typeof s === 'string' && ORDER_NO_RE.test(s); }
function validMachine(s) { return !s || ALLOWED_MACHINES.has(String(s)); }
function clipStr(s, max) { return s == null ? null : String(s).slice(0, max); }

const STEP_COLS = {
  '1':  { time: 'step1At',  note: null },
  '2':  { time: 'step2At',  note: null },
  '3':  { time: 'step3At',  note: null },
  '4':  { time: 'step4At',  note: null },
  '5':  { time: 'step5At',  note: null },
  '6':  { time: 'step6At',  note: null },
  '7':  { time: 'step7At',  note: null },
  '11': { time: 'step11At', note: null },
  '12': { time: 'step12At', note: 'step12Note' },
  '13': { time: 'step13At', note: 'step13Note' },
};

function serializeOrder(o) {
  if (!o) return null;
  const events = o.pauseEvents || [];
  const summarize = (type) => {
    const items = events.filter(e => e.type === type);
    const closed = items.filter(e => e.endAt);
    const active = items.find(e => !e.endAt) || null;
    return {
      count: closed.length,
      totalSec: closed.reduce((s, e) => s + (e.duration || 0), 0),
      active: active ? { id: active.id, startAt: active.startAt, note: active.note, activeStep: active.activeStep } : null,
      history: items.map(e => ({
        id: e.id, activeStep: e.activeStep, startAt: e.startAt, endAt: e.endAt,
        duration: e.duration, note: e.note,
      })),
    };
  };
  return {
    orderNo: o.orderNo,
    machineNo: o.machineNo || '',
    leaderId: o.leaderId,
    leaderName: o.leader?.displayName || '',
    step1At: o.step1At, step2At: o.step2At, step3At: o.step3At,
    step4At: o.step4At, step5At: o.step5At, step6At: o.step6At,
    step7At: o.step7At, step11At: o.step11At,
    productionDate: o.productionDate, productSpec: o.productSpec || '',
    moldSpec: o.moldSpec || '', material: o.material || '',
    dispatchQty: o.dispatchQty, bladeCount: o.bladeCount,
    machineSPM: o.machineSPM, unitWeight: o.unitWeight, totalWeight: o.totalWeight,
    pause12: summarize('12'),
    pause13: summarize('13'),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

const ORDER_INCLUDE = { leader: true, pauseEvents: true };

export default async function orderRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // 取得（不存在自動建立）
  fastify.get('/:orderNo', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤（需 1 英文 + 10 數字）' });
    let order = await fastify.prisma.order.findUnique({
      where: { orderNo },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
        include: ORDER_INCLUDE,
      });
    }
    return { order: serializeOrder(order) };
  });

  // 設定機台號
  fastify.post('/:orderNo/machine', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { machineNo } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!machineNo || !String(machineNo).trim()) {
      return reply.code(400).send({ error: '機台號不可空白' });
    }
    if (!validMachine(machineNo)) {
      return reply.code(400).send({ error: '不允許的機台號' });
    }
    let order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
      });
    }
    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: { machineNo: clipStr(String(machineNo).trim(), 60), leaderId: request.user.id },
      include: ORDER_INCLUDE,
    });
    return { order: serializeOrder(updated) };
  });

  // 紀錄某步驟
  fastify.post('/:orderNo/steps/:step', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { step } = request.params;
    const { note } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
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
        include: ORDER_INCLUDE,
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
    if (cols.note && note) updateData[cols.note] = clipStr(note, 500);

    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: ORDER_INCLUDE,
    });
    return { order: serializeOrder(updated) };
  });

  // 取消某步驟
  fastify.delete('/:orderNo/steps/:step', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { step } = request.params;
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const cols = STEP_COLS[step];
    if (!cols) return reply.code(400).send({ error: '無效步驟' });

    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });

    const updateData = { [cols.time]: null };
    if (cols.note) updateData[cols.note] = null;

    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: ORDER_INCLUDE,
    });
    return { order: serializeOrder(updated) };
  });

  // 開始暫停 / 異常
  fastify.post('/:orderNo/pause', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { type, note, activeStep } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!['12', '13'].includes(type)) return reply.code(400).send({ error: '無效類型' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const active = await fastify.prisma.pauseEvent.findFirst({
      where: { orderId: order.id, type, endAt: null },
    });
    if (active) return reply.code(409).send({ error: '已在暫停中，請先恢復' });
    await fastify.prisma.pauseEvent.create({
      data: { orderId: order.id, type, note: clipStr(note, 500), activeStep: clipStr(activeStep, 100) },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { order: serializeOrder(updated) };
  });

  // 恢復（結束暫停）
  fastify.post('/:orderNo/resume', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { type } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!['12', '13'].includes(type)) return reply.code(400).send({ error: '無效類型' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const active = await fastify.prisma.pauseEvent.findFirst({
      where: { orderId: order.id, type, endAt: null },
    });
    if (!active) return reply.code(404).send({ error: '沒有進行中的暫停' });
    const now = new Date();
    const duration = Math.round((now - active.startAt) / 1000);
    await fastify.prisma.pauseEvent.update({
      where: { id: active.id },
      data: { endAt: now, duration },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { order: serializeOrder(updated), resumed: { type, duration } };
  });

  // 批次上傳工單（生管 or 管理員）
  fastify.post('/bulk-upload', async (request, reply) => {
    if (!request.user.isAdmin && !request.user.isPlanner) {
      return reply.code(403).send({ error: '需要生管或管理員權限' });
    }
    const { orders: rows } = request.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: '沒有資料' });
    }
    if (rows.length > 500) {
      return reply.code(400).send({ error: '單次上傳上限 500 筆' });
    }
    let created = 0, updated = 0, errors = [];
    for (const row of rows) {
      try {
        const orderNo = String(row.orderNo || '').toUpperCase();
        if (!validOrderNo(orderNo)) { errors.push((row.orderNo || '(空)') + '：工單號格式錯誤'); continue; }
        if (row.machineNo && !validMachine(row.machineNo)) {
          errors.push(orderNo + '：不允許的機台號 ' + row.machineNo); continue;
        }
        const data = {
          productionDate: row.productionDate ? new Date(row.productionDate) : null,
          productSpec: clipStr(row.productSpec, 200),
          moldSpec: clipStr(row.moldSpec, 100),
          material: clipStr(row.material, 200),
          dispatchQty: row.dispatchQty ? Math.max(0, Math.min(1e6, Number(row.dispatchQty) || 0)) : null,
          bladeCount: row.bladeCount ? Math.max(0, Math.min(1e6, Number(row.bladeCount) || 0)) : null,
          machineSPM: row.machineSPM ? Math.max(0, Math.min(1e5, Number(row.machineSPM) || 0)) : null,
          unitWeight: row.unitWeight ? Math.max(0, Math.min(1e6, Number(row.unitWeight) || 0)) : null,
          totalWeight: row.totalWeight ? Math.max(0, Math.min(1e9, Number(row.totalWeight) || 0)) : null,
          machineNo: row.machineNo ? clipStr(row.machineNo, 60) : null,
        };
        const existing = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (existing) {
          await fastify.prisma.order.update({ where: { orderNo }, data });
          updated++;
        } else {
          await fastify.prisma.order.create({ data: { orderNo, ...data } });
          created++;
        }
      } catch (e) {
        errors.push((row.orderNo || '?') + ': ' + e.message);
      }
    }
    return { ok: true, created, updated, errors, total: rows.length };
  });

  // 刪除工單（僅管理員；允許清理任何舊格式資料）
  fastify.delete('/:orderNo', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '只有管理員可以刪除工單' });
    }
    const rawNo = String(request.params.orderNo || '').trim();
    if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
    // 先試原樣，不存在再試轉大寫
    let order = await fastify.prisma.order.findUnique({ where: { orderNo: rawNo } });
    let orderNo = rawNo;
    if (!order) {
      orderNo = rawNo.toUpperCase();
      order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    }
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    await fastify.prisma.order.delete({ where: { orderNo: order.orderNo } });
    return { ok: true };
  });

  // 列出近期工單（所有登入者都能看全部）
  fastify.get('/', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const orders = await fastify.prisma.order.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: ORDER_INCLUDE,
    });
    return { orders: orders.map(serializeOrder) };
  });
}
