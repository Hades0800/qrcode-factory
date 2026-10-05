import { validOrderNo, clipStr } from '../../../lib/validation.js';
import { audit } from '../../../lib/audit.js';
import { parseDate, numOrNull, findLabelByScan } from '../../inventory/domain/label.js';
import { recordMove } from '../../inventory/domain/moves.js';

const INCLUDE = {
  label: { select: { id: true, code: true, kind: true, status: true, location: true } },
  entries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' } },
};

// 加工單(G 號):建立(業務助理/生管)、裁切工序、結案(加工人員)
export default async function processOrderRoutes(fastify) {
  const anyone = { onRequest: [fastify.authenticate] };
  const office = { onRequest: [fastify.authenticate, fastify.requireRole('sales', 'planner')] };
  const shop = { onRequest: [fastify.authenticate, fastify.requireRole('processing', 'production')] };

  fastify.post('/process-orders', office, async (request, reply) => {
    const b = request.body || {};
    const processNo = String(b.processNo || '').trim();
    if (!validOrderNo(processNo)) return reply.code(400).send({ error: '加工單號格式錯誤(例 G1150810006)' });
    const manuOrderNo = b.manuOrderNo ? String(b.manuOrderNo).trim() : null;
    if (manuOrderNo && !validOrderNo(manuOrderNo)) return reply.code(400).send({ error: '製造單號格式錯誤(例 F1150810001)' });
    for (const [k, label] of [['dispatchDate', '派工日'], ['plannedDate', '預計日'], ['finishDate', '完工日']]) {
      if (b[k] && !parseDate(b[k])) return reply.code(400).send({ error: `${label}格式需為 yyyy.mm.dd` });
    }
    if (b.dueDate && !parseDate(b.dueDate)) return reply.code(400).send({ error: '納期格式需為 yyyy.mm.dd' });
    const exists = await fastify.prisma.processOrder.findFirst({ where: { processNo } });
    if (exists) return reply.code(409).send({ error: '加工單已存在' });

    // 綁定標籤:給了標籤碼就用它;沒給就找製造單最新的那張(關聯表「含加工單-綁定」)
    let label = null;
    if (b.labelCode) ({ label } = await findLabelByScan(fastify.prisma, { code: b.labelCode }));
    else if (manuOrderNo) label = await fastify.prisma.label.findFirst({ where: { manuOrderNo }, orderBy: { createdAt: 'desc' } });

    const po = await fastify.prisma.processOrder.create({
      data: {
        processNo, manuOrderNo, labelId: label?.id ?? null,
        customer: clipStr(b.customer, 60) || null,
        spec: clipStr(b.spec, 600) || null,
        qty: numOrNull(b.qty, true), weight: numOrNull(b.weight),
        machineNo: clipStr(b.machineNo, 20) || null,
        dispatchDate: b.dispatchDate ? parseDate(b.dispatchDate) : null,
        plannedDate: b.plannedDate ? parseDate(b.plannedDate) : null,
        finishDate: b.finishDate ? parseDate(b.finishDate) : null,
        dueDate: b.dueDate ? parseDate(b.dueDate) : null,
        remark: clipStr(b.remark, 120) || null,
        createdBy: request.user.id, createdByName: request.user.displayName || null,
      },
      include: INCLUDE,
    });
    if (label && label.processOrderNo !== processNo) {
      await fastify.prisma.label.update({ where: { id: label.id }, data: { processOrderNo: processNo } });
    }
    await audit(fastify.prisma, request, 'create_process_order', processNo, manuOrderNo || '');
    return { processOrder: po };
  });

  fastify.get('/process-orders', anyone, async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const { status, q } = request.query || {};
    const processOrders = await fastify.prisma.processOrder.findMany({
      where: {
        ...(status ? { status: String(status) } : {}),
        ...(q ? { OR: ['processNo', 'manuOrderNo', 'customer'].map(k => ({ [k]: { contains: String(q) } })) } : {}),
      },
      include: INCLUDE, orderBy: [{ plannedDate: 'asc' }, { dispatchDate: 'asc' }, { createdAt: 'desc' }], take: limit,
    });
    return { processOrders };
  });

  fastify.get('/process-orders/:processNo', anyone, async (request, reply) => {
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo: request.params.processNo }, include: INCLUDE });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    return { processOrder: po };
  });

  // 裁切工序:1 領料 / 2 裁切開始 / 3 裁切完成 / 4 包裝 / 9 其他
  fastify.post('/process-orders/:processNo/entries', shop, async (request, reply) => {
    const stepNo = String(request.body?.stepNo || '').trim();
    if (!['1', '2', '3', '4', '9'].includes(stepNo)) return reply.code(400).send({ error: 'stepNo 需為 1 / 2 / 3 / 4 / 9' });
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo: request.params.processNo } });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    if (po.status === 'done') return reply.code(409).send({ error: '這張加工單已結案' });
    const entry = await fastify.prisma.processEntry.create({
      data: { processOrderId: po.id, stepNo, note: clipStr(request.body?.note, 300) || null,
              leaderId: request.user.id, leaderName: request.user.displayName || null },
    });
    return { entry };
  });

  // 結案 = 關聯表的「QR Code 結案」:加工單 done、標籤 closed、成品入庫(finished)
  fastify.post('/process-orders/:processNo/complete', shop, async (request, reply) => {
    const b = request.body || {};
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo: request.params.processNo }, include: { label: true } });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    if (po.status === 'done') return reply.code(409).send({ error: '這張加工單已結案' });
    const qty = numOrNull(b.qty, true), weight = numOrNull(b.weight);
    const updated = await fastify.prisma.processOrder.update({
      where: { id: po.id },
      data: { status: 'done', completedAt: new Date(), completedQty: qty, completedWeight: weight },
      include: INCLUDE,
    });
    let move = null;
    if (po.label) {
      await fastify.prisma.label.update({ where: { id: po.label.id }, data: { status: 'closed' } });
      move = await recordMove(fastify.prisma, {
        label: po.label, type: 'in', stage: 'finished',
        location: clipStr(b.location, 40) || null, qty, weight,
        refType: 'process', refNo: po.processNo, note: '裁切結案入庫', actor: request.user,
      });
    }
    await audit(fastify.prisma, request, 'complete_process_order', po.processNo, `${qty ?? ''}pcs ${weight ?? ''}kg`.trim());
    return { processOrder: updated, move };
  });

  fastify.delete('/process-orders/:processNo', office, async (request, reply) => {
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo: request.params.processNo } });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    await fastify.prisma.processOrder.delete({ where: { id: po.id } });
    await audit(fastify.prisma, request, 'delete_process_order', po.processNo, '');
    return { ok: true };
  });
}
