import { ALLOWED_MACHINES } from '../lib/machines.js';
import { audit } from '../lib/audit.js';

// 無工令事件（機台閒置紀錄），註冊於根路徑（路徑含 /api/idle-events）
export default async function idleEventRoutes(fastify) {
  fastify.post('/api/idle-events', {
    onRequest: [fastify.authenticate],
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { machineNo, note } = request.body || {};
    if (!machineNo) return reply.code(400).send({ error: '缺少機台號' });
    if (!ALLOWED_MACHINES.has(machineNo)) return reply.code(400).send({ error: '不允許的機台號' });
    const event = await fastify.prisma.idleEvent.create({
      data: {
        machineNo,
        leaderId: request.user.id,
        leaderName: request.user.displayName || null,
        note: note ? String(note).slice(0, 500) : null,
      },
    });
    return { ok: true, event };
  });

  fastify.get('/api/idle-events', { onRequest: [fastify.authenticate] }, async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const events = await fastify.prisma.idleEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { events };
  });

  // 取消無工令事件（任何登入者皆可）
  // 現場換班常見：A 班標了無工令，B 班接到工單就該能自己取消，不用等管理員。
  // 是軟刪除（見 plugins/prisma.js 的 SOFT_DELETE_MODELS），誤刪可由管理員救回，
  // 且會寫入操作紀錄，事後查得到是誰取消的。
  fastify.delete('/api/idle-events/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!id) return reply.code(400).send({ error: '無效 id' });
    const event = await fastify.prisma.idleEvent.findUnique({ where: { id } });
    if (!event) return reply.code(404).send({ error: '找不到紀錄' });
    await fastify.prisma.idleEvent.delete({ where: { id } });
    await audit(fastify.prisma, request, 'cancel_idle_event', event.machineNo,
      `取消無工令（原記錄者：${event.leaderName || '—'}）`);
    return { ok: true };
  });
}
