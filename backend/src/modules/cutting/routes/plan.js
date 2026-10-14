// 現場工單畫面（裁切加工計畫表）。
//
// 對照「系統運作工作項目摘要表」生產人員的七步：
//   1 接收當天計畫  2 確認原料、調整順位  3 確認後鎖住計畫
//   4 依序開單、記開始與完成時間  5 完成後跳下一張  6 持續到當日做完  7 績效顯示
//
// 鎖定前現場可以調順序、標等待材料；鎖定後只能開工與回報，要再動得生管解鎖並填原因。
import { clipStr, validOrderNo } from '../../../lib/validation.js';
import { audit } from '../../../lib/audit.js';
import { numOrNull } from '../../inventory/domain/label.js';
import { recordMove } from '../../inventory/domain/moves.js';

// 日期處理。這個專案裡有兩套慣例並存：
//   parseDate（建單路由用）存「台北午夜」→ 2026-10-14 會存成 2026-10-13T16:00Z
//   QRP / Excel 解析器存「UTC 午夜」→ 2026-10-14T00:00Z
// 直接用等號查 plannedDate 會兩邊對不上，所以一律以「台北當日的時間區間」查，
// 兩種寫法都落在同一天內。
function dayStr(s) {
  const m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(String(s || '').trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
// 資料庫取出的時間戳 → 台北的日曆日。兩種寫入慣例（台北午夜 / UTC 午夜）都會得到正確的那一天
const dayOf = d => (d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : null);

// 查詢用：台北當日 00:00 ～ 隔日 00:00
function dayRange(s) {
  const d = dayStr(s);
  if (!d) return null;
  const start = new Date(`${d}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 86400000);
  return { gte: start, lt: end };
}
// @db.Date 欄位用（CuttingPlanLock / CuttingPlanChange）：只有日期，用 UTC 午夜避免被時區推掉一天
function dateOnly(s) {
  const d = dayStr(s);
  return d ? new Date(`${d}T00:00:00Z`) : null;
}

const ORDER_INCLUDE = {
  items: { where: { deletedAt: null }, orderBy: { seq: 'asc' } },
  entries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' } },
  label: { select: { id: true, code: true, status: true, location: true } },
};

export default async function planRoutes(fastify) {
  const anyone = { onRequest: [fastify.authenticate] };
  const shop = { onRequest: [fastify.authenticate, fastify.requireRole('processing', 'production')] };
  const planner = { onRequest: [fastify.authenticate, fastify.requireRole('planner')] };

  async function loadPlan(machineNo, day) {
    const range = dayRange(day);
    const [orders, lock] = await Promise.all([
      fastify.prisma.processOrder.findMany({
        where: { machineNo, plannedDate: range, deletedAt: null },
        orderBy: [{ seqNo: 'asc' }, { processNo: 'asc' }],
        include: ORDER_INCLUDE,
      }),
      fastify.prisma.cuttingPlanLock.findFirst({ where: { machineNo, planDate: dateOnly(day) } }),
    ]);
    const locked = !!lock && !lock.unlockedAt;
    // 進行中的那張：已開工未完工；都沒有就指向第一張還沒做的
    const current = orders.find(o => o.startedAt && !o.finishedAt)
      ?? orders.find(o => !o.finishedAt && !o.waitingMaterial)
      ?? null;
    const done = orders.filter(o => o.finishedAt).length;
    return {
      machineNo,
      date: dayStr(day),
      locked,
      lock: locked ? { lockedAt: lock.lockedAt, lockedByName: lock.lockedByName } : null,
      orders,
      currentProcessNo: current?.processNo ?? null,
      progress: { total: orders.length, done, waiting: orders.filter(o => o.waitingMaterial).length },
    };
  }

  // 當天某機台的工單（第 1 步：接收計畫）
  fastify.get('/plan', anyone, async (request, reply) => {
    const machineNo = clipStr(request.query.machineNo, 20);
    if (!machineNo) return reply.code(400).send({ error: '請指定機台' });
    const date = dayStr(request.query.date) || today();
    if (!date) return reply.code(400).send({ error: '日期格式需為 yyyy-mm-dd' });
    return loadPlan(machineNo, date);
  });

  // 調整順序（第 2 步）。鎖定後不給調
  fastify.patch('/plan/reorder', shop, async (request, reply) => {
    const { machineNo, order } = request.body || {};
    const date = dayStr(request.body?.date) || today();
    if (!machineNo || !Array.isArray(order) || !order.length) {
      return reply.code(400).send({ error: '需要 machineNo 與 order（加工單號陣列）' });
    }
    const lock = await fastify.prisma.cuttingPlanLock.findFirst({ where: { machineNo, planDate: dateOnly(date) } });
    if (lock && !lock.unlockedAt) return reply.code(409).send({ error: '計畫已確認鎖定，要調整請找生管解鎖' });

    const orders = await fastify.prisma.processOrder.findMany({
      where: { machineNo, plannedDate: dayRange(date), deletedAt: null },
      select: { id: true, processNo: true, seqNo: true },
    });
    const byNo = new Map(orders.map(o => [o.processNo, o]));
    const unknown = order.filter(no => !byNo.has(no));
    if (unknown.length) return reply.code(400).send({ error: `不在這張計畫裡：${unknown.join('、')}` });

    await fastify.prisma.$transaction(
      order.flatMap((no, i) => {
        const o = byNo.get(no);
        const seq = i + 1;
        if (o.seqNo === seq) return [];
        return [
          fastify.prisma.processOrder.update({ where: { id: o.id }, data: { seqNo: seq } }),
          fastify.prisma.cuttingPlanChange.create({
            data: {
              machineNo, planDate: dateOnly(date), processNo: no, oldSeq: o.seqNo, newSeq: seq, action: 'reorder',
              changedBy: request.user.id, changedName: request.user.displayName || null,
            },
          }),
        ];
      }),
    );
    await audit(fastify.prisma, request, 'reorder_cutting_plan', machineNo, order.join(','));
    return loadPlan(machineNo, date);
  });

  // 標記 / 解除等待材料（第 2 步）
  fastify.patch('/plan/waiting', shop, async (request, reply) => {
    const { processNo, waiting } = request.body || {};
    if (!validOrderNo(String(processNo || ''))) return reply.code(400).send({ error: '加工單號格式錯誤' });
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo, deletedAt: null } });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    await fastify.prisma.processOrder.update({ where: { id: po.id }, data: { waitingMaterial: !!waiting } });
    await fastify.prisma.cuttingPlanChange.create({
      data: {
        machineNo: po.machineNo || '', planDate: dateOnly(dayOf(po.plannedDate) || today()), processNo,
        action: waiting ? 'wait' : 'resume', reason: clipStr(request.body?.reason, 120) || null,
        changedBy: request.user.id, changedName: request.user.displayName || null,
      },
    });
    return loadPlan(po.machineNo, dayOf(po.plannedDate) || today());
  });

  // 確認計畫 → 鎖定（第 3 步）
  fastify.post('/plan/lock', shop, async (request, reply) => {
    const machineNo = clipStr(request.body?.machineNo, 20);
    const date = dayStr(request.body?.date) || today();
    if (!machineNo) return reply.code(400).send({ error: '請指定機台' });
    const count = await fastify.prisma.processOrder.count({ where: { machineNo, plannedDate: dayRange(date), deletedAt: null } });
    if (!count) return reply.code(400).send({ error: '這天這台機台沒有工單，不用鎖定' });

    await fastify.prisma.cuttingPlanLock.upsert({
      where: { machineNo_planDate: { machineNo, planDate: dateOnly(date) } },
      update: { lockedAt: new Date(), lockedBy: request.user.id, lockedByName: request.user.displayName || null, unlockedAt: null, unlockedBy: null, unlockReason: null },
      create: { machineNo, planDate: dateOnly(date), lockedBy: request.user.id, lockedByName: request.user.displayName || null },
    });
    await fastify.prisma.cuttingPlanChange.create({
      data: { machineNo, planDate: dateOnly(date), processNo: '', action: 'lock', changedBy: request.user.id, changedName: request.user.displayName || null },
    });
    await audit(fastify.prisma, request, 'lock_cutting_plan', machineNo, date);
    return loadPlan(machineNo, date);
  });

  // 解鎖：只有生管，而且要填原因
  fastify.post('/plan/unlock', planner, async (request, reply) => {
    const machineNo = clipStr(request.body?.machineNo, 20);
    const date = dayStr(request.body?.date) || today();
    const reason = clipStr(request.body?.reason, 120);
    if (!machineNo) return reply.code(400).send({ error: '請指定機台' });
    if (!reason) return reply.code(400).send({ error: '解鎖要填原因' });
    const lock = await fastify.prisma.cuttingPlanLock.findFirst({ where: { machineNo, planDate: dateOnly(date) } });
    if (!lock || lock.unlockedAt) return reply.code(409).send({ error: '這張計畫沒有鎖定' });

    await fastify.prisma.cuttingPlanLock.update({
      where: { id: lock.id },
      data: { unlockedAt: new Date(), unlockedBy: request.user.id, unlockReason: reason },
    });
    await fastify.prisma.cuttingPlanChange.create({
      data: { machineNo, planDate: dateOnly(date), processNo: '', action: 'unlock', reason, changedBy: request.user.id, changedName: request.user.displayName || null },
    });
    await audit(fastify.prisma, request, 'unlock_cutting_plan', machineNo, reason);
    return loadPlan(machineNo, date);
  });

  // 開始生產（第 4 步）。要先鎖定計畫
  fastify.post('/plan/:processNo/start', shop, async (request, reply) => {
    const po = await fastify.prisma.processOrder.findFirst({ where: { processNo: request.params.processNo, deletedAt: null } });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    if (po.startedAt) return reply.code(409).send({ error: '這張已經開始了' });
    if (po.waitingMaterial) return reply.code(409).send({ error: '這張標記為等待材料，請先解除' });
    const date = dayOf(po.plannedDate) || today();
    const lock = await fastify.prisma.cuttingPlanLock.findFirst({ where: { machineNo: po.machineNo || '', planDate: dateOnly(date) } });
    if (!lock || lock.unlockedAt) return reply.code(409).send({ error: '請先確認計畫（鎖定）再開工' });

    await fastify.prisma.$transaction([
      fastify.prisma.processOrder.update({
        where: { id: po.id },
        data: { startedAt: new Date(), operatorName: request.user.displayName || null },
      }),
      fastify.prisma.processEntry.create({
        data: { processOrderId: po.id, stepNo: '2', note: '裁切開始', leaderId: request.user.id, leaderName: request.user.displayName || null },
      }),
    ]);
    await audit(fastify.prisma, request, 'start_process_order', po.processNo, po.machineNo || '');
    return loadPlan(po.machineNo, date);
  });

  // 完成回報（第 4、5 步）：記完成時間、當班人數、入庫儲位，順便結案入庫
  fastify.post('/plan/:processNo/finish', shop, async (request, reply) => {
    const b = request.body || {};
    const po = await fastify.prisma.processOrder.findFirst({
      where: { processNo: request.params.processNo, deletedAt: null },
      include: { label: true },
    });
    if (!po) return reply.code(404).send({ error: '找不到這張加工單' });
    if (!po.startedAt) return reply.code(409).send({ error: '還沒開始，不能回報完成' });
    if (po.finishedAt) return reply.code(409).send({ error: '這張已經回報完成了' });

    const qty = numOrNull(b.qty, true);
    const weight = numOrNull(b.weight);
    const workers = numOrNull(b.totalWorkers, true);   // 當班人數
    const location = clipStr(b.storageLocation, 40) || null;
    const date = dayOf(po.plannedDate) || today();

    await fastify.prisma.$transaction([
      fastify.prisma.processOrder.update({
        where: { id: po.id },
        data: {
          finishedAt: new Date(), totalWorkers: workers, storageLocation: location,
          oddCutting: b.oddCutting === true || b.oddCutting === 'true',
          status: 'done', completedAt: new Date(), completedQty: qty, completedWeight: weight,
        },
      }),
      fastify.prisma.processEntry.create({
        data: {
          processOrderId: po.id, stepNo: '3',
          note: clipStr(b.note, 200) || '裁切完成',
          leaderId: request.user.id, leaderName: request.user.displayName || null,
        },
      }),
    ]);

    // 結案入庫（沿用既有的標籤與異動邏輯）
    let move = null;
    if (po.label) {
      await fastify.prisma.label.update({ where: { id: po.label.id }, data: { status: 'closed' } });
      move = await recordMove(fastify.prisma, {
        label: po.label, type: 'in', stage: 'finished', location, qty, weight,
        refType: 'process', refNo: po.processNo, note: '裁切完成入庫', actor: request.user,
      });
    }
    await audit(fastify.prisma, request, 'finish_process_order', po.processNo,
      `${qty ?? ''}pcs ${workers ?? ''}人 ${location ?? ''}`.trim());

    const plan = await loadPlan(po.machineNo, date);
    return { ...plan, move, next: plan.currentProcessNo };  // next 讓前端自動跳下一張
  });

  // 當日績效（第 7 步）
  fastify.get('/plan/summary', anyone, async (request, reply) => {
    const machineNo = clipStr(request.query.machineNo, 20);
    const date = dayStr(request.query.date) || today();
    const orders = await fastify.prisma.processOrder.findMany({
      where: { ...(machineNo ? { machineNo } : {}), plannedDate: dayRange(date), deletedAt: null },
      select: {
        processNo: true, machineNo: true, qty: true, completedQty: true,
        startedAt: true, finishedAt: true, totalWorkers: true, waitingMaterial: true,
      },
    });
    const done = orders.filter(o => o.finishedAt);
    const minutes = done.reduce((s, o) => s + (o.finishedAt - o.startedAt) / 60000, 0);
    const manMinutes = done.reduce((s, o) => s + ((o.finishedAt - o.startedAt) / 60000) * (o.totalWorkers || 1), 0);
    return {
      date,
      machineNo: machineNo || null,
      total: orders.length,
      done: done.length,
      waiting: orders.filter(o => o.waitingMaterial).length,
      plannedQty: orders.reduce((s, o) => s + (o.qty || 0), 0),
      completedQty: done.reduce((s, o) => s + (o.completedQty || 0), 0),
      workMinutes: Math.round(minutes),
      manMinutes: Math.round(manMinutes),       // 工時 = Σ(時長 × 當班人數)
      utilization: Math.round((minutes / 450) * 1000) / 10,   // 對每日標準 450 分
    };
  });
}
