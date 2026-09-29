import { validOrderNo, clipStr } from '../../../lib/validation.js';
import { audit } from '../../../lib/audit.js';
import {
  LABEL_KINDS, buildQrText, parseQrText, makeLabelCode, parseDate, numOrNull, findLabelByScan,
} from '../domain/label.js';
import { stockOf } from '../domain/moves.js';

const SPEC_INCLUDE = { specs: { orderBy: { seq: 'asc' } } };

// QR 標籤:建立(業務助理)、查詢、掃描解析、作廢
export default async function labelRoutes(fastify) {
  const anyone = { onRequest: [fastify.authenticate] };
  const office = { onRequest: [fastify.authenticate, fastify.requireRole('sales', 'warehouse', 'planner')] };

  fastify.post('/', office, async (request, reply) => {
    const b = request.body || {};
    if (!LABEL_KINDS[b.kind]) {
      return reply.code(400).send({ error: '標籤種類需為 material / semi / finished / outsourced' });
    }
    const manuOrderNo = b.manuOrderNo ? String(b.manuOrderNo).trim() : null;
    const processOrderNo = b.processOrderNo ? String(b.processOrderNo).trim() : null;
    if (manuOrderNo && !validOrderNo(manuOrderNo)) return reply.code(400).send({ error: '製造單號格式錯誤(例 F1150810001)' });
    if (processOrderNo && !validOrderNo(processOrderNo)) return reply.code(400).send({ error: '加工單號格式錯誤(例 G1150810006)' });
    if (b.dueDate && !parseDate(b.dueDate)) return reply.code(400).send({ error: '納期格式需為 yyyy.mm.dd' });
    const specs = (Array.isArray(b.specs) ? b.specs : [])
      .filter(s => s && String(s.spec || '').trim())
      .map((s, i) => ({ seq: i + 1, spec: clipStr(String(s.spec).trim(), 120), qty: numOrNull(s.qty, true), weight: numOrNull(s.weight) }));
    if (specs.length > 40) return reply.code(400).send({ error: '規格最多 40 條' });

    const fields = {
      kind: b.kind,
      customer: clipStr(b.customer, 60) || null,
      poNo: clipStr(b.poNo, 40) || null,
      manuOrderNo, processOrderNo,
      location: clipStr(b.location, 40) || null,
      machineNo: clipStr(b.machineNo, 20) || null,
      dueDate: b.dueDate ? parseDate(b.dueDate) : null,
      remark: clipStr(b.remark, 120) || null,
    };
    const qrText = buildQrText({ ...fields, specs });

    let label = null;
    for (let attempt = 0; attempt < 3 && !label; attempt++) {
      try {
        label = await fastify.prisma.label.create({
          data: {
            code: makeLabelCode(), ...fields, qrText,
            createdBy: request.user.id, createdByName: request.user.displayName || null,
            specs: { create: specs },
          },
          include: SPEC_INCLUDE,
        });
      } catch (e) {
        if (e.code !== 'P2002' || attempt === 2) throw e;   // 標籤碼撞號就再抽一次
      }
    }
    // 對回生產 MES 的製造單:掛上標籤,順便把工單沒有的三個欄位補上
    if (manuOrderNo) {
      await fastify.prisma.order.updateMany({
        where: { orderNo: manuOrderNo },
        data: {
          labelId: label.id,
          ...(fields.poNo ? { poNo: fields.poNo } : {}),
          ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
          ...(fields.remark ? { remark: fields.remark } : {}),
        },
      });
    }
    await audit(fastify.prisma, request, 'create_label', label.code, `${LABEL_KINDS[b.kind]} ${manuOrderNo || ''} ${processOrderNo || ''}`.trim());
    return { label };
  });

  fastify.get('/', anyone, async (request) => {
    const { q, kind, status } = request.query || {};
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const where = {
      ...(kind && LABEL_KINDS[kind] ? { kind } : {}),
      ...(status ? { status: String(status) } : {}),
      ...(q ? {
        OR: ['code', 'customer', 'poNo', 'manuOrderNo', 'processOrderNo', 'location']
          .map(k => ({ [k]: { contains: String(q).trim() } })),
      } : {}),
    };
    const labels = await fastify.prisma.label.findMany({ where, include: SPEC_INCLUDE, orderBy: { createdAt: 'desc' }, take: limit });
    return { labels };
  });

  // 掃描解析:六項文字 → 欄位,並對回已建立的標籤(找不到就回 label: null,讓前端決定要不要新建)
  fastify.post('/parse', anyone, async (request, reply) => {
    const text = request.body?.text;
    if (!text || typeof text !== 'string' || text.length > 4000) return reply.code(400).send({ error: '請提供 QR 文字' });
    const fields = parseQrText(text);
    if (!fields) return reply.code(400).send({ error: '不是標籤 QR(至少要有五行)' });
    const { label } = await findLabelByScan(fastify.prisma, { text });
    return { fields, label, stock: label ? await stockOf(fastify.prisma, label.id) : null };
  });

  fastify.get('/:code', anyone, async (request, reply) => {
    const label = await fastify.prisma.label.findFirst({
      where: { code: request.params.code },
      include: { ...SPEC_INCLUDE, moves: { where: { deletedAt: null }, orderBy: { at: 'desc' }, take: 50 } },
    });
    if (!label) return reply.code(404).send({ error: '找不到這張標籤' });
    return { label, stock: await stockOf(fastify.prisma, label.id) };
  });

  // 作廢(軟刪除;有入出庫紀錄的也留著,查歷史用)
  fastify.delete('/:code', office, async (request, reply) => {
    const label = await fastify.prisma.label.findFirst({ where: { code: request.params.code } });
    if (!label) return reply.code(404).send({ error: '找不到這張標籤' });
    await fastify.prisma.label.delete({ where: { id: label.id } });
    await audit(fastify.prisma, request, 'void_label', label.code, label.manuOrderNo || '');
    return { ok: true };
  });
}
