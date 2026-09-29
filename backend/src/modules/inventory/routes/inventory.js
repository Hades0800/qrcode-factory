import { clipStr } from '../../../lib/validation.js';
import { audit } from '../../../lib/audit.js';
import { STAGES, numOrNull, findLabelByScan } from '../domain/label.js';
import { recordMove, stockOf, summarize, validStage } from '../domain/moves.js';

// 入庫 / 出庫 / 庫存 / 儲位(倉管人員)
export default async function inventoryRoutes(fastify) {
  const anyone = { onRequest: [fastify.authenticate] };
  const warehouse = { onRequest: [fastify.authenticate, fastify.requireRole('warehouse', 'sales')] };

  // 掃標籤入庫或出庫:body 給 code(標籤碼)或 text(QR 文字)
  fastify.post('/moves', warehouse, async (request, reply) => {
    const b = request.body || {};
    if (b.type !== 'in' && b.type !== 'out') return reply.code(400).send({ error: 'type 需為 in(入庫)或 out(出庫)' });
    if (!validStage(b.stage)) return reply.code(400).send({ error: 'stage 需為 ' + Object.keys(STAGES).join(' / ') });
    const { label } = await findLabelByScan(fastify.prisma, { code: b.code, text: b.text });
    if (!label) return reply.code(404).send({ error: '找不到這張標籤,請先建立標籤' });
    if (label.status === 'shipped') return reply.code(409).send({ error: '這張標籤已出貨' });
    const qty = numOrNull(b.qty, true);
    const weight = numOrNull(b.weight);
    const current = await stockOf(fastify.prisma, label.id);
    if (b.type === 'out' && current && qty !== null && qty > current.qty) {
      return reply.code(409).send({ error: `庫存只有 ${current.qty},不能出 ${qty}` });
    }
    const move = await recordMove(fastify.prisma, {
      label, type: b.type, stage: b.stage,
      location: clipStr(b.location, 40) || null, qty, weight,
      refType: clipStr(b.refType, 20) || 'manual', refNo: clipStr(b.refNo, 40) || null,
      note: b.note, actor: request.user,
    });
    await audit(fastify.prisma, request, b.type === 'in' ? 'stock_in' : 'stock_out', label.code,
      `${STAGES[b.stage]} ${qty ?? ''}pcs ${weight ?? ''}kg ${move.location || ''}`.trim());
    return { move, label, stock: await stockOf(fastify.prisma, label.id) };
  });

  fastify.get('/moves', anyone, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const where = {};
    if (request.query.code) {
      const label = await fastify.prisma.label.findFirst({ where: { code: String(request.query.code) } });
      if (!label) return reply.code(404).send({ error: '找不到這張標籤' });
      where.labelId = label.id;
    }
    const moves = await fastify.prisma.stockMove.findMany({
      where, include: { label: { select: { code: true, kind: true, customer: true, manuOrderNo: true, processOrderNo: true } } },
      orderBy: { at: 'desc' }, take: limit,
    });
    return { moves };
  });

  // 庫存:每張標籤的目前數量(入減出),只列還有東西的
  fastify.get('/stock', anyone, async (request) => {
    const { kind, location, q } = request.query || {};
    const labels = await fastify.prisma.label.findMany({
      where: {
        status: { not: 'shipped' },
        ...(kind ? { kind: String(kind) } : {}),
        ...(location ? { location: { contains: String(location) } } : {}),
        ...(q ? { OR: ['customer', 'manuOrderNo', 'processOrderNo', 'code'].map(k => ({ [k]: { contains: String(q) } })) } : {}),
      },
      include: { specs: { orderBy: { seq: 'asc' } }, moves: { where: { deletedAt: null } } },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });
    const rows = [];
    for (const l of labels) {
      const s = summarize(l.moves);
      if (!s || s.qty <= 0 && s.weight <= 0) continue;
      const { moves, ...rest } = l;
      rows.push({ ...rest, stock: s });
    }
    return { stock: rows };
  });

  fastify.get('/locations', anyone, async () => {
    const locations = await fastify.prisma.location.findMany({ orderBy: { code: 'asc' } });
    return { locations };
  });

  fastify.post('/locations', warehouse, async (request, reply) => {
    const code = clipStr(request.body?.code, 40);
    if (!code || !code.trim()) return reply.code(400).send({ error: '請填儲位代碼(例 D-C-F123)' });
    const exists = await fastify.prisma.location.findFirst({ where: { code: code.trim() } });
    if (exists) return reply.code(409).send({ error: '儲位已存在' });
    const location = await fastify.prisma.location.create({
      data: { code: code.trim(), name: clipStr(request.body?.name, 60) || null, zone: clipStr(request.body?.zone, 20) || null },
    });
    return { location };
  });
}
