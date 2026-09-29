import { clipStr } from '../../../lib/validation.js';
import { audit } from '../../../lib/audit.js';
import { parseDate, numOrNull, findLabelByScan } from '../../inventory/domain/label.js';
import { recordMove, stockOf } from '../../inventory/domain/moves.js';

const INCLUDE = {
  items: {
    where: { deletedAt: null }, orderBy: { id: 'asc' },
    include: { label: { select: { id: true, code: true, kind: true, status: true, location: true, manuOrderNo: true, customer: true } } },
  },
};

// 出貨單:建立(業務助理)、加明細(庫存 QR / 零購 QR)、倉管 QR 檢核、出庫
export default async function shipmentRoutes(fastify) {
  const anyone = { onRequest: [fastify.authenticate] };
  const office = { onRequest: [fastify.authenticate, fastify.requireRole('sales', 'warehouse')] };
  const warehouse = { onRequest: [fastify.authenticate, fastify.requireRole('warehouse')] };

  fastify.post('/shipments', office, async (request, reply) => {
    const b = request.body || {};
    const shipNo = clipStr(b.shipNo, 40);
    if (!shipNo || !shipNo.trim()) return reply.code(400).send({ error: '請填出貨單號' });
    if (b.shipDate && !parseDate(b.shipDate)) return reply.code(400).send({ error: '出貨日格式需為 yyyy.mm.dd' });
    const exists = await fastify.prisma.shipment.findFirst({ where: { shipNo: shipNo.trim() } });
    if (exists) return reply.code(409).send({ error: '出貨單已存在' });
    const shipment = await fastify.prisma.shipment.create({
      data: {
        shipNo: shipNo.trim(), customer: clipStr(b.customer, 60) || null,
        shipDate: b.shipDate ? parseDate(b.shipDate) : null, note: clipStr(b.note, 300) || null,
        createdBy: request.user.id, createdByName: request.user.displayName || null,
      },
      include: INCLUDE,
    });
    await audit(fastify.prisma, request, 'create_shipment', shipment.shipNo, shipment.customer || '');
    return { shipment };
  });

  fastify.get('/shipments', anyone, async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const { status, q } = request.query || {};
    const shipments = await fastify.prisma.shipment.findMany({
      where: {
        ...(status ? { status: String(status) } : {}),
        ...(q ? { OR: ['shipNo', 'customer'].map(k => ({ [k]: { contains: String(q) } })) } : {}),
      },
      include: INCLUDE, orderBy: { createdAt: 'desc' }, take: limit,
    });
    return { shipments };
  });

  const load = async (shipNo) => fastify.prisma.shipment.findFirst({ where: { shipNo }, include: INCLUDE });

  fastify.get('/shipments/:shipNo', anyone, async (request, reply) => {
    const shipment = await load(request.params.shipNo);
    if (!shipment) return reply.code(404).send({ error: '找不到這張出貨單' });
    return { shipment };
  });

  // 加明細:source=stock 掃庫存 QR(一定要對到標籤);source=retail 零購,標籤可有可無
  fastify.post('/shipments/:shipNo/items', office, async (request, reply) => {
    const b = request.body || {};
    const shipment = await load(request.params.shipNo);
    if (!shipment) return reply.code(404).send({ error: '找不到這張出貨單' });
    if (shipment.status === 'shipped') return reply.code(409).send({ error: '這張出貨單已出庫' });
    if (b.source !== 'stock' && b.source !== 'retail') return reply.code(400).send({ error: 'source 需為 stock(庫存)或 retail(零購)' });
    let label = null;
    if (b.code || b.text) ({ label } = await findLabelByScan(fastify.prisma, { code: b.code, text: b.text }));
    if (b.source === 'stock') {
      if (!label) return reply.code(404).send({ error: '庫存 QR 對不到標籤' });
      if (label.status === 'shipped') return reply.code(409).send({ error: '這張標籤已出貨' });
      if (shipment.items.some(i => i.labelId === label.id)) return reply.code(409).send({ error: '這張標籤已在出貨單裡' });
    }
    const qty = numOrNull(b.qty, true), weight = numOrNull(b.weight);
    const item = await fastify.prisma.shipmentItem.create({
      data: {
        shipmentId: shipment.id, labelId: label?.id ?? null, source: b.source,
        spec: clipStr(b.spec, 120) || label?.specs?.map(s => s.spec).join(' / ') || null,
        qty: qty ?? (label ? (await stockOf(fastify.prisma, label.id))?.qty ?? null : null),
        weight,
      },
    });
    return { item, shipment: await load(shipment.shipNo) };
  });

  fastify.delete('/shipments/:shipNo/items/:id', office, async (request, reply) => {
    const shipment = await load(request.params.shipNo);
    if (!shipment) return reply.code(404).send({ error: '找不到這張出貨單' });
    if (shipment.status === 'shipped') return reply.code(409).send({ error: '這張出貨單已出庫' });
    const id = Number(request.params.id);
    if (!shipment.items.some(i => i.id === id)) return reply.code(404).send({ error: '找不到這筆明細' });
    await fastify.prisma.shipmentItem.delete({ where: { id } });
    return { ok: true, shipment: await load(shipment.shipNo) };
  });

  // 倉管 QR 檢核:掃到的標籤要在這張出貨單裡;全部掃完出貨單變 checked
  fastify.post('/shipments/:shipNo/check', warehouse, async (request, reply) => {
    const b = request.body || {};
    const shipment = await load(request.params.shipNo);
    if (!shipment) return reply.code(404).send({ error: '找不到這張出貨單' });
    if (shipment.status === 'shipped') return reply.code(409).send({ error: '這張出貨單已出庫' });
    const { label } = await findLabelByScan(fastify.prisma, { code: b.code, text: b.text });
    if (!label) return reply.code(404).send({ error: '對不到標籤' });
    const item = shipment.items.find(i => i.labelId === label.id);
    if (!item) return reply.code(409).send({ error: `標籤 ${label.code} 不在這張出貨單裡` });
    if (item.checkedAt) return reply.code(409).send({ error: '這筆已檢核過' });
    await fastify.prisma.shipmentItem.update({ where: { id: item.id }, data: { checkedAt: new Date(), checkedByName: request.user.displayName || null } });
    const fresh = await load(shipment.shipNo);
    const pending = fresh.items.filter(i => i.labelId && !i.checkedAt).length;
    if (!pending && fresh.status === 'open') {
      await fastify.prisma.shipment.update({ where: { id: fresh.id }, data: { status: 'checked' } });
    }
    return { ok: true, pending, shipment: await load(shipment.shipNo) };
  });

  // 出庫:有標籤的明細都要檢核過;每一筆記一則出庫、標籤變 shipped
  fastify.post('/shipments/:shipNo/ship', warehouse, async (request, reply) => {
    const shipment = await load(request.params.shipNo);
    if (!shipment) return reply.code(404).send({ error: '找不到這張出貨單' });
    if (shipment.status === 'shipped') return reply.code(409).send({ error: '這張出貨單已出庫' });
    if (!shipment.items.length) return reply.code(400).send({ error: '出貨單沒有明細' });
    const unchecked = shipment.items.filter(i => i.labelId && !i.checkedAt);
    if (unchecked.length) return reply.code(409).send({ error: `還有 ${unchecked.length} 筆沒有 QR 檢核` });
    const moves = [];
    for (const item of shipment.items) {
      if (!item.labelId) continue;
      const label = await fastify.prisma.label.findFirst({ where: { id: item.labelId } });
      if (!label) continue;
      moves.push(await recordMove(fastify.prisma, {
        label, type: 'out', stage: 'finished', qty: item.qty, weight: item.weight,
        refType: 'shipment', refNo: shipment.shipNo, note: '出貨出庫', actor: request.user,
      }));
      await fastify.prisma.label.update({ where: { id: label.id }, data: { status: 'shipped' } });
    }
    const updated = await fastify.prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: 'shipped', shipDate: shipment.shipDate || new Date() },
      include: INCLUDE,
    });
    await audit(fastify.prisma, request, 'ship', shipment.shipNo, `${moves.length} 筆出庫`);
    return { shipment: updated, moves };
  });
}
