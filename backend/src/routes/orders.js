// ── 共用常數與 helper ──
const ORDER_NO_RE = /^[A-Z]\d{10}$/;
const ALLOWED_MACHINES = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40']);

function validOrderNo(s) { return typeof s === 'string' && ORDER_NO_RE.test(s); }
function validMachine(s) { return !s || ALLOWED_MACHINES.has(String(s)); }
function clipStr(s, max) { return s == null ? null : String(s).slice(0, max); }
function hasActivity(o) {
  return !!(o.step1At || o.step2At || o.step3At || o.step4At ||
    o.step5At || o.step6At || o.step7At || o.step11At ||
    o.step21At || o.step22At || o.step23At);
}

// 完整版：同時檢查新格式 stepEntries / pauseEvents（需要 DB 查詢）
// 新格式紀錄只寫 stepEntry，不寫 stepXAt；只看 hasActivity 會誤判為「沒活動」
async function hasAnyActivity(prisma, order) {
  if (hasActivity(order)) return true;
  const entryCount = await prisma.stepEntry.count({ where: { orderId: order.id } });
  if (entryCount > 0) return true;
  const pauseCount = await prisma.pauseEvent.count({ where: { orderId: order.id } });
  return pauseCount > 0;
}

// 把任意時間轉成「台灣日期」（UTC 午夜，當作純日期標記）
function toTaiwanDate(t) {
  const d = t instanceof Date ? t : new Date(t || Date.now());
  const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()));
}

// 設定 actualStartDate 為實際開始日期（台灣時間）
// 規則：actualStartDate 一旦有值就永遠不再覆寫；reset-production 才會清空
// 第一次有活動時（含補登），把那筆活動時間的台灣日期寫入
async function setActualStartDate(fastify, order, eventTime) {
  if (order.actualStartDate) return; // 已有值，鎖死不再變
  await fastify.prisma.order.update({
    where: { orderNo: order.orderNo },
    data: { actualStartDate: toTaiwanDate(eventTime) },
  });
}

async function audit(prisma, request, action, target, detail) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: request.user?.id || null,
        actorName: request.user?.displayName || null,
        action,
        target: target ? String(target).slice(0, 200) : null,
        detail: detail ? String(detail).slice(0, 500) : null,
        ip: request.ip || null,
      },
    });
  } catch (e) { /* ignore audit errors */ }
}

const STEP_COLS = {
  '21': { time: 'step21At', note: null },
  '22': { time: 'step22At', note: null },
  '23': { time: 'step23At', note: null },
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
    plannedMachineNo: o.plannedMachineNo || '',
    leaderId: o.leaderId,
    leaderName: o.leader?.displayName || '',
    step21At: o.step21At, step22At: o.step22At, step23At: o.step23At,
    step1At: o.step1At, step2At: o.step2At, step3At: o.step3At,
    step4At: o.step4At, step5At: o.step5At, step6At: o.step6At,
    step7At: o.step7At, step11At: o.step11At,
    // 三個日期：
    //   plannedDate     = 上傳的計畫日（生管說「這張要 X 做」）
    //   actualStartDate = 第一筆活動的台灣日期（現場第一次掃 QR 那天）
    //   productionDate  = 兼容舊邏輯，等同於 actualStartDate || plannedDate
    plannedDate: o.plannedDate || o.productionDate || null,
    actualStartDate: o.actualStartDate || null,
    productionDate: o.actualStartDate || o.plannedDate || o.productionDate || null,
    specType: o.specType || null,           // 'new' | 'mass' | null
    difficultyFactor: o.difficultyFactor || null,  // 新製規格才有
    productSpec: o.productSpec || '',
    moldSpec: o.moldSpec || '', material: o.material || '',
    dispatchQty: o.dispatchQty, bladeCount: o.bladeCount,
    machineSPM: o.machineSPM, unitWeight: o.unitWeight, totalWeight: o.totalWeight,
    pause12: summarize('12'),
    pause13: summarize('13'),
    stepEntries: (o.stepEntries || []).map(e => ({
      id: e.id, stepNo: e.stepNo, seq: e.seq,
      recordedAt: e.recordedAt, isManual: e.isManual || false,
      leaderName: e.leaderName,
    })),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

const ORDER_INCLUDE = {
  leader: true,
  pauseEvents: { where: { deletedAt: null } },
  stepEntries: { where: { deletedAt: null }, orderBy: { recordedAt: 'asc' } },
};

export default async function orderRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // 上傳批次列表（必須在 /:orderNo 之前定義避免路由衝突）
  fastify.get('/upload-batches', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const batches = await fastify.prisma.uploadBatch.findMany({
      orderBy: { uploadedAt: 'desc' },
      take: limit,
    });
    return { batches };
  });

  // 取消整個上傳批次
  fastify.delete('/upload-batches/:id', async (request, reply) => {
    if (!request.user.isAdmin && !request.user.isPlanner) {
      return reply.code(403).send({ error: '需要生管或管理員權限' });
    }
    const id = Number(request.params.id);
    if (!id) return reply.code(400).send({ error: '無效 id' });
    const batch = await fastify.prisma.uploadBatch.findUnique({ where: { id } });
    if (!batch) return reply.code(404).send({ error: '找不到上傳批次' });
    if (batch.cancelledAt) return reply.code(400).send({ error: '此批次已取消過' });

    // 取消上傳只動「上傳資料」：把工單的上傳欄位清空 + 標記批次取消
    // 工單本身（含 productionDate、機台、所有生產紀錄）都不動
    // 如要刪空殼工單請另行用 admin 的「徹底刪除」
    let cleared = 0;
    for (const orderNo of (batch.orderNos || [])) {
      try {
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        await fastify.prisma.order.update({
          where: { orderNo },
          data: {
            productSpec: null, moldSpec: null,
            material: null, dispatchQty: null, bladeCount: null,
            machineSPM: null, unitWeight: null, totalWeight: null,
          },
        });
        cleared++;
      } catch (e) { /* ignore */ }
    }
    await fastify.prisma.uploadBatch.update({
      where: { id },
      data: { cancelledAt: new Date() },
    });
    await audit(fastify.prisma, request, 'cancel_batch', batch.id,
      `filename=${batch.filename} cleared=${cleared}`);
    return { ok: true, cleared };
  });

  // 救回已取消的上傳批次：把批次標記取消移除 + 回填工單上傳欄位
  // 規則：只填工單目前為 null 的欄位（避免覆蓋後續批次填的新值）
  // - Admin only
  fastify.post('/upload-batches/:id/restore', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const id = Number(request.params.id);
    if (!id) return reply.code(400).send({ error: '無效 id' });
    const batch = await fastify.prisma.uploadBatch.findUnique({ where: { id } });
    if (!batch) return reply.code(404).send({ error: '找不到上傳批次' });
    if (!batch.cancelledAt) return reply.code(400).send({ error: '此批次未取消，無需救回' });

    const fields = ['productSpec', 'moldSpec', 'material', 'dispatchQty', 'bladeCount', 'machineSPM', 'unitWeight', 'totalWeight'];
    let restored = 0, skipped = 0;
    for (const orderNo of (batch.orderNos || [])) {
      try {
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) { skipped++; continue; }
        // 拿該批次的第一筆 UploadRow（有效狀態）
        const row = await fastify.prisma.uploadRow.findFirst({
          where: { batchId: id, orderNo, status: { in: ['created', 'updated'] } },
          orderBy: { id: 'asc' },
        });
        if (!row) { skipped++; continue; }
        // 只填 order 仍為 null 的欄位（新批次填過的不蓋）
        const data = {};
        for (const k of fields) {
          if (order[k] === null || order[k] === undefined) {
            if (row[k] !== null && row[k] !== undefined) data[k] = row[k];
          }
        }
        // plannedDate 同樣處理（用批次的 productionDate）
        if (!order.plannedDate && batch.productionDate) {
          data.plannedDate = batch.productionDate;
        }
        if (Object.keys(data).length > 0) {
          await fastify.prisma.order.update({ where: { id: order.id }, data });
          restored++;
        } else {
          skipped++;
        }
      } catch (e) { /* ignore single-row errors */ }
    }
    await fastify.prisma.uploadBatch.update({
      where: { id },
      data: { cancelledAt: null },
    });
    await audit(fastify.prisma, request, 'restore_batch', batch.id,
      `filename=${batch.filename} restored=${restored} skipped=${skipped}`);
    return { ok: true, restored, skipped };
  });

  // 取得（不存在自動建立）
  // 為支援「先做後上傳」流程，所有已登入使用者都能觸發自動建立。
  // 但回傳 wasCreated:true 讓前端可顯示警告，提醒班長確認單號正確
  fastify.get('/:orderNo', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤（需 1 英文 + 10 數字）' });
    let order = await fastify.prisma.order.findUnique({
      where: { orderNo },
      include: ORDER_INCLUDE,
    });
    let wasCreated = false;
    if (!order) {
      // findUnique 受軟刪除中間件過濾影響，可能 DB 裡有但 deletedAt 不為 null。
      // 用顯式查詢確認是否真的不存在（否則 create 會撞 unique constraint）
      const softDeleted = await fastify.prisma.order.findFirst({
        where: { orderNo, deletedAt: { not: null } },
      });
      if (softDeleted) {
        return reply.code(409).send({
          error: '此工單號之前已被刪除，無法直接重新建立',
          code: 'SOFT_DELETED',
          hint: '請聯絡管理員到 admin 頁面「回收桶」救回此工單，或請使用其他工單號',
          deletedAt: softDeleted.deletedAt,
        });
      }
      // 真的不存在 → 嘗試 create；用 try/catch 處理 race condition（兩個 request 同時建）
      try {
        order = await fastify.prisma.order.create({
          data: { orderNo, leaderId: request.user.id },
          include: ORDER_INCLUDE,
        });
        wasCreated = true;
        await audit(fastify.prisma, request, 'auto_create_order', orderNo,
          `via=GET user=${request.user.username || request.user.id}`);
      } catch (e) {
        if (e.code === 'P2002') {
          // 別的 request 剛建好；再讀一次
          order = await fastify.prisma.order.findUnique({
            where: { orderNo }, include: ORDER_INCLUDE,
          });
          if (!order) throw e; // 仍然找不到就讓錯誤往外拋
        } else {
          throw e;
        }
      }
    }
    return { order: serializeOrder(order), wasCreated };
  });

  // 記錄工序（可重複，日誌式；支援補登自訂時間）
  fastify.post('/:orderNo/step-entries', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { stepNo, recordedAt: manualTime } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const validSteps = ['1','2','3','4','5','6','7','21','22','23','12','13'];
    if (!validSteps.includes(stepNo)) {
      return reply.code(400).send({ error: '無效工序編號' });
    }
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const prevCount = await fastify.prisma.stepEntry.count({
      where: { orderId: order.id, stepNo },
    });
    const isManual = !!manualTime;
    let time = new Date();
    if (manualTime) {
      const parsed = new Date(manualTime);
      if (isNaN(parsed) || parsed.getFullYear() < 2000 || parsed.getFullYear() > 2100) {
        return reply.code(400).send({ error: '補登時間格式錯誤' });
      }
      if (parsed > new Date()) {
        return reply.code(400).send({ error: '補登時間不能超過現在' });
      }
      time = parsed;
    }
    await setActualStartDate(fastify, order, time);
    const entry = await fastify.prisma.stepEntry.create({
      data: {
        orderId: order.id,
        stepNo,
        seq: prevCount + 1,
        recordedAt: time,
        isManual,
        leaderId: request.user.id,
        leaderName: request.user.displayName || null,
      },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { entry, order: serializeOrder(updated) };
  });

  // 取消工序紀錄（5 分鐘內）
  fastify.delete('/:orderNo/step-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!id) return reply.code(400).send({ error: '無效 id' });
    const entry = await fastify.prisma.stepEntry.findUnique({ where: { id } });
    if (!entry) return reply.code(404).send({ error: '找不到紀錄' });
    const elapsed = Date.now() - new Date(entry.recordedAt).getTime();
    if (elapsed > 5 * 60 * 1000 && !request.user.isAdmin) {
      return reply.code(403).send({ error: '已超過 5 分鐘，無法取消（管理員不受此限制）' });
    }
    await fastify.prisma.stepEntry.delete({ where: { id } });
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { ok: true, order: updated ? serializeOrder(updated) : null };
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

  // 設定規格類型（現場技術員選擇）
  // 用 raw SQL 寫入避免 Prisma client 沒 regenerate 時拋錯
  // body: { specType: 'new' | 'mass', difficultyFactor?: 1.1~1.6 }
  fastify.post('/:orderNo/spec-type', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      const { specType, difficultyFactor } = request.body || {};
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
      if (!['new', 'mass'].includes(specType)) {
        return reply.code(400).send({ error: '無效規格類型（需為 new 或 mass）' });
      }
      let factor = null;
      if (specType === 'new') {
        const allowed = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
        const f = Number(difficultyFactor);
        const match = allowed.find(a => Math.abs(a - f) < 0.001);
        if (!match) {
          return reply.code(400).send({ error: '難易係數必須為 1.1 / 1.2 / 1.3 / 1.4 / 1.5 / 1.6 之一' });
        }
        factor = match;
      }
      // 先確保欄位存在（idempotent，沒有就建、有就略過）—— 為了在 prisma client 沒 regenerate 的環境也能跑
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "specType" TEXT, ADD COLUMN IF NOT EXISTS "difficultyFactor" DOUBLE PRECISION'
      );
      // 寫入 raw SQL（繞過 Prisma client 是否認識新欄位的限制）
      const result = await fastify.prisma.$executeRaw`
        UPDATE "Order"
        SET "specType" = ${specType}, "difficultyFactor" = ${factor}
        WHERE "orderNo" = ${orderNo}
      `;
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      // 不 include 完整 order（避免 select 撞到 client schema mismatch）
      return { ok: true, specType, difficultyFactor: factor };
    } catch (e) {
      request.log.error(e, 'spec-type failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
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

    const stepTime = new Date();
    await setActualStartDate(fastify, order, stepTime);

    const updateData = {
      [cols.time]: stepTime,
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
    const pauseStart = new Date();
    await setActualStartDate(fastify, order, pauseStart);
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
    // 補一道保險：若 pause 那次因故沒寫入 actualStartDate，這裡用 pause 開始時間補
    await setActualStartDate(fastify, order, active.startAt);
    const duration = Math.round((now - active.startAt) / 1000);
    await fastify.prisma.pauseEvent.update({
      where: { id: active.id },
      data: { endAt: now, duration },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { order: serializeOrder(updated), resumed: { type, duration } };
  });

  // 補登暫停（已結束的暫停事件）
  fastify.post('/:orderNo/pause-backfill', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { type, note, startAt: startStr, endAt: endStr } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!['12', '13'].includes(type)) return reply.code(400).send({ error: '無效類型' });
    if (!startStr || !endStr) return reply.code(400).send({ error: '請填寫開始和結束時間' });
    const startAt = new Date(startStr);
    const endAt = new Date(endStr);
    if (isNaN(startAt) || isNaN(endAt)) return reply.code(400).send({ error: '時間格式錯誤' });
    if (endAt <= startAt) return reply.code(400).send({ error: '結束時間必須晚於開始時間' });
    if (endAt > new Date()) return reply.code(400).send({ error: '補登時間不能超過現在' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const duration = Math.round((endAt - startAt) / 1000);
    const backfillNote = '【補登】' + (note || '');
    await setActualStartDate(fastify, order, startAt);
    await fastify.prisma.pauseEvent.create({
      data: { orderId: order.id, type, note: clipStr(backfillNote, 500), startAt, endAt, duration },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { ok: true, order: serializeOrder(updated) };
  });

  // 批次上傳工單（生管 or 管理員）
  fastify.post('/bulk-upload', async (request, reply) => {
    if (!request.user.isAdmin && !request.user.isPlanner) {
      return reply.code(403).send({ error: '需要生管或管理員權限' });
    }
    const { orders: rows, filename, uploadDate } = request.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: '沒有資料' });
    }
    if (rows.length > 500) {
      return reply.code(400).send({ error: '單次上傳上限 500 筆' });
    }
    // 清理檔名（去掉路徑、控制字元）
    const cleanFilename = filename ? String(filename).replace(/[\\/\x00-\x1f]/g, '').slice(0, 200) : '未命名';

    // 上傳系統的日期（存在批次紀錄上，不寫入工單）
    let batchProductionDate = null;
    if (uploadDate) {
      const d = new Date(uploadDate);
      if (!isNaN(d) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100) batchProductionDate = d;
    }

    // 先建立批次紀錄
    const batch = await fastify.prisma.uploadBatch.create({
      data: {
        filename: cleanFilename,
        uploadedBy: request.user.id,
        uploadedByName: request.user.displayName || null,
        rowCount: 0,
        productionDate: batchProductionDate,
        orderNos: [],
      },
    });

    let created = 0, updated = 0, skipped = 0, errors = [];
    const processedOrderNos = [];
    const rawRows = []; // 收集原始資料

    for (const row of rows) {
      const orderNo = String(row.orderNo || '').toUpperCase();
      const rawRow = {
        batchId: batch.id,
        orderNo: orderNo || String(row.orderNo || ''),
        productSpec: clipStr(row.productSpec, 200),
        moldSpec: clipStr(row.moldSpec, 100),
        material: clipStr(row.material, 200),
        machineNo: row.machineNo ? clipStr(row.machineNo, 60) : null,
        dispatchQty: row.dispatchQty ? Math.max(0, Math.min(1e6, Number(row.dispatchQty) || 0)) : null,
        bladeCount: row.bladeCount ? Math.max(0, Math.min(1e6, Number(row.bladeCount) || 0)) : null,
        machineSPM: row.machineSPM ? Math.max(0, Math.min(1e5, Number(row.machineSPM) || 0)) : null,
        unitWeight: row.unitWeight ? Math.max(0, Math.min(1e6, Number(row.unitWeight) || 0)) : null,
        totalWeight: row.totalWeight ? Math.max(0, Math.min(1e9, Number(row.totalWeight) || 0)) : null,
        status: 'error',
        errorMsg: null,
      };

      try {
        if (!validOrderNo(orderNo)) {
          rawRow.errorMsg = '工單號格式錯誤';
          rawRows.push(rawRow);
          errors.push((row.orderNo || '(空)') + '：工單號格式錯誤');
          continue;
        }
        if (row.machineNo && !validMachine(row.machineNo)) {
          rawRow.errorMsg = '不允許的機台號 ' + row.machineNo;
          rawRows.push(rawRow);
          errors.push(orderNo + '：不允許的機台號 ' + row.machineNo);
          continue;
        }

        const data = {
          plannedDate: batchProductionDate, // 計畫日期：可被新上傳覆寫
          productSpec: rawRow.productSpec,
          moldSpec: rawRow.moldSpec,
          material: rawRow.material,
          dispatchQty: rawRow.dispatchQty,
          bladeCount: rawRow.bladeCount,
          machineSPM: rawRow.machineSPM,
          unitWeight: rawRow.unitWeight,
          totalWeight: rawRow.totalWeight,
          machineNo: rawRow.machineNo,
          plannedMachineNo: rawRow.machineNo, // Excel 排定的機台永遠保留
        };

        const existing = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (existing) {
          const specMatch = !existing.productSpec || !data.productSpec || existing.productSpec === data.productSpec;
          if (specMatch) {
            // 唯一鎖定欄位：machineNo（工單一旦有生產活動就鎖，現場為準）
            // plannedDate 不鎖（生管修排程隨時都該被反映）；actualStartDate 跟上傳完全無關
            const hasActivity = await hasAnyActivity(fastify.prisma, existing);
            const lockMachine = hasActivity && existing.machineNo;
            const merged = {};
            for (const key of Object.keys(data)) {
              if (key === 'machineNo' && lockMachine) {
                merged[key] = existing.machineNo;
              } else {
                merged[key] = (data[key] != null && data[key] !== '') ? data[key] : existing[key];
              }
            }
            await fastify.prisma.order.update({ where: { orderNo }, data: merged });
            rawRow.status = 'updated';
            updated++;
          } else {
            rawRow.status = 'skipped';
            rawRow.errorMsg = '規格不同，跳過';
            skipped++;
          }
        } else {
          await fastify.prisma.order.create({ data: { orderNo, ...data } });
          rawRow.status = 'created';
          created++;
        }
        processedOrderNos.push(orderNo);
      } catch (e) {
        rawRow.errorMsg = e.message;
        errors.push((row.orderNo || '?') + ': ' + e.message);
      }
      rawRows.push(rawRow);
    }

    // 批量寫入原始資料
    if (rawRows.length > 0) {
      await fastify.prisma.uploadRow.createMany({ data: rawRows });
    }

    // 更新批次紀錄
    await fastify.prisma.uploadBatch.update({
      where: { id: batch.id },
      data: { rowCount: processedOrderNos.length, orderNos: processedOrderNos },
    });

    return { ok: true, created, updated, skipped, errors, total: rows.length, batchId: batch.id };
  });

  // 批次取消上傳：只動上傳資料，工單本身不刪
  // - 不論工單是否有生產紀錄，一律只清上傳欄位（productSpec、moldSpec、material 等）
  // - 工單本身（productionDate、機台、生產紀錄）一律保留
  // - 上傳資料與實態紀錄獨立，重傳時會自動重新配對
  fastify.post('/bulk-cancel-upload', async (request, reply) => {
    if (!request.user.isAdmin && !request.user.isPlanner) {
      return reply.code(403).send({ error: '需要生管或管理員權限' });
    }
    const { orderNos } = request.body || {};
    if (!Array.isArray(orderNos) || orderNos.length === 0) {
      return reply.code(400).send({ error: '沒有資料' });
    }
    if (orderNos.length > 500) {
      return reply.code(400).send({ error: '單次上限 500 筆' });
    }
    let cleared = 0;
    const errors = [];
    for (const rawNo of orderNos) {
      try {
        const orderNo = String(rawNo || '').trim().toUpperCase();
        if (!orderNo) continue;
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        await fastify.prisma.order.update({
          where: { orderNo },
          data: {
            productSpec: null, moldSpec: null,
            material: null, dispatchQty: null, bladeCount: null,
            machineSPM: null, unitWeight: null, totalWeight: null,
          },
        });
        cleared++;
      } catch (e) {
        errors.push(rawNo + ': ' + e.message);
      }
    }
    return { ok: true, cleared, errors };
  });

  // 刪除工單
  // - 預設：只允許無生產紀錄的工單；有紀錄回 409
  // - ?force=true（admin only）：連同所有 stepEntries / pauseEvents 一起軟刪除（用於清測試單）
  // - 管理員 / 生管 皆可使用（force 限 admin）
  fastify.delete('/:orderNo', async (request, reply) => {
    const isAdmin = request.user.isAdmin;
    const isPlanner = request.user.isPlanner;
    if (!isAdmin && !isPlanner) {
      return reply.code(403).send({ error: '權限不足' });
    }
    const force = request.query.force === 'true' || request.query.force === '1';
    if (force && !isAdmin) {
      return reply.code(403).send({ error: 'force 模式僅限管理員' });
    }
    const rawNo = String(request.params.orderNo || '').trim();
    if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
    let order = await fastify.prisma.order.findUnique({ where: { orderNo: rawNo } });
    if (!order) {
      order = await fastify.prisma.order.findUnique({ where: { orderNo: rawNo.toUpperCase() } });
    }
    if (!order) return reply.code(404).send({ error: '找不到工單' });

    const entryCount = await fastify.prisma.stepEntry.count({ where: { orderId: order.id } });
    const pauseCount = await fastify.prisma.pauseEvent.count({ where: { orderId: order.id } });
    const hasProductionData = hasActivity(order) || entryCount > 0 || pauseCount > 0;

    if (hasProductionData && !force) {
      return reply.code(409).send({
        error: '工單已有生產紀錄，無法直接刪除',
        code: 'HAS_PRODUCTION_DATA',
        canReset: isAdmin,
        entryCount, pauseCount,
      });
    }

    if (force && hasProductionData) {
      // 連紀錄一起軟刪除
      await fastify.prisma.stepEntry.deleteMany({ where: { orderId: order.id } });
      await fastify.prisma.pauseEvent.deleteMany({ where: { orderId: order.id } });
    }
    await fastify.prisma.order.delete({ where: { orderNo: order.orderNo } });
    await audit(fastify.prisma, request, 'delete_order', order.orderNo,
      force ? `admin_force_delete entries=${entryCount} pauses=${pauseCount}` :
      (isAdmin ? 'admin_delete' : 'planner_delete_unscanned'));
    return { ok: true, deleted: true, force, entries: force ? entryCount : 0, pauses: force ? pauseCount : 0 };
  });

  // 重設生產紀錄（清空 stepEntries/pauseEvents 與 stepXAt 欄位，保留上傳資料）
  // - Admin only
  fastify.post('/:orderNo/reset-production', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const rawNo = String(request.params.orderNo || '').trim();
    if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
    let order = await fastify.prisma.order.findUnique({ where: { orderNo: rawNo } });
    if (!order) {
      order = await fastify.prisma.order.findUnique({ where: { orderNo: rawNo.toUpperCase() } });
    }
    if (!order) return reply.code(404).send({ error: '找不到工單' });

    const entryCount = await fastify.prisma.stepEntry.count({ where: { orderId: order.id } });
    const pauseCount = await fastify.prisma.pauseEvent.count({ where: { orderId: order.id } });

    await fastify.prisma.stepEntry.deleteMany({ where: { orderId: order.id } });
    await fastify.prisma.pauseEvent.deleteMany({ where: { orderId: order.id } });
    await fastify.prisma.order.update({
      where: { orderNo: order.orderNo },
      data: {
        step1At: null, step2At: null, step3At: null, step4At: null,
        step5At: null, step6At: null, step7At: null,
        step11At: null, step12At: null, step13At: null,
        step21At: null, step22At: null, step23At: null,
        step12Note: null, step13Note: null,
        step4Note: null, step7Note: null,
        machineNo: null, leaderId: null,
        actualStartDate: null, // reset 後重做時，第一筆新紀錄會重新設定 actualStartDate
      },
    });
    await audit(fastify.prisma, request, 'reset_production', order.orderNo,
      `entries=${entryCount} pauses=${pauseCount}`);
    return { ok: true, reset: true, entryCount, pauseCount };
  });

  // 已刪除工單列表（回收桶）
  // - Admin only
  fastify.get('/trash', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    // 逃生口：where 有 deletedAt 鍵即跳過中間件自動過濾
    const orders = await fastify.prisma.order.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      take: 200,
      select: {
        orderNo: true,
        deletedAt: true,
        productSpec: true,
        moldSpec: true,
        machineNo: true,
        productionDate: true,
        leader: { select: { displayName: true } },
      },
    });
    return { orders };
  });

  // 還原已軟刪除的工單，或單獨還原被 reset 軟刪的子紀錄
  // - Admin only
  // 兩種情境：
  //   1. 整張工單被軟刪除 → 還原工單 + 連帶還原所有軟刪子紀錄
  //   2. 工單仍使用中、但有軟刪除的 stepEntries / pauseEvents（例如 reset-production 後悔了）
  //      → 只還原子紀錄
  fastify.post('/:orderNo/restore', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const rawNo = String(request.params.orderNo || '').trim();
    if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
    // 兩個查詢都顯式指定 deletedAt，完全不依賴 middleware（避免行為不一致）
    // 先查已軟刪除的（最常見的救回情境）；找不到再查使用中的（救回 reset 子紀錄場景）
    const candidates = [rawNo, rawNo.toUpperCase()].filter((v, i, a) => a.indexOf(v) === i);
    let order = null;
    for (const no of candidates) {
      order = await fastify.prisma.order.findFirst({
        where: { orderNo: no, deletedAt: { not: null } },
      });
      if (order) break;
      order = await fastify.prisma.order.findFirst({
        where: { orderNo: no, deletedAt: null },
      });
      if (order) break;
    }
    if (!order) return reply.code(404).send({ error: '找不到工單' });

    // 還原工單本體（如果是軟刪狀態）
    let orderRestored = false;
    if (order.deletedAt) {
      await fastify.prisma.order.update({
        where: { id: order.id },
        data: { deletedAt: null },
      });
      orderRestored = true;
    }
    // 還原所有軟刪除的子紀錄
    const entryRes = await fastify.prisma.stepEntry.updateMany({
      where: { orderId: order.id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    const pauseRes = await fastify.prisma.pauseEvent.updateMany({
      where: { orderId: order.id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    if (!orderRestored && entryRes.count === 0 && pauseRes.count === 0) {
      return reply.code(400).send({ error: '此工單沒有任何已刪除的內容可救回' });
    }

    const action = orderRestored ? 'restore_order' : 'restore_records';
    await audit(fastify.prisma, request, action, order.orderNo,
      `entries=${entryRes.count} pauses=${pauseRes.count}`);
    return {
      ok: true,
      restored: true,
      orderRestored,
      entries: entryRes.count,
      pauses: pauseRes.count,
    };
  });

  // 永久刪除工單（從 DB 抹掉，無法救回）
  // - Admin only
  // - 用 raw SQL 繞過軟刪除中間件，連同所有 stepEntries / pauseEvents 一起 DELETE
  // - 給「清測試資料」場景使用，正常營運請用一般刪除（軟刪）
  fastify.post('/:orderNo/purge', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    try {
      const rawNo = String(request.params.orderNo || '').trim();
      if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
      const candidates = [rawNo, rawNo.toUpperCase()].filter((v, i, a) => a.indexOf(v) === i);
      // 用 raw SQL 找工單（不被軟刪除中間件過濾）
      let orderId = null;
      let foundOrderNo = null;
      for (const no of candidates) {
        const rows = await fastify.prisma.$queryRaw`
          SELECT id, "orderNo" FROM "Order" WHERE "orderNo" = ${no} LIMIT 1
        `;
        if (rows && rows.length > 0) {
          orderId = rows[0].id;
          foundOrderNo = rows[0].orderNo;
          break;
        }
      }
      if (!orderId) return reply.code(404).send({ error: '找不到工單' });

      const entryRows = await fastify.prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt FROM "StepEntry" WHERE "orderId" = ${orderId}
      `;
      const pauseRows = await fastify.prisma.$queryRaw`
        SELECT COUNT(*)::int AS cnt FROM "PauseEvent" WHERE "orderId" = ${orderId}
      `;
      const entryCount = entryRows[0]?.cnt || 0;
      const pauseCount = pauseRows[0]?.cnt || 0;

      // 子紀錄先刪、再刪 Order（onDelete: Cascade 也會處理，但顯式刪比較清楚）
      await fastify.prisma.$executeRaw`DELETE FROM "StepEntry" WHERE "orderId" = ${orderId}`;
      await fastify.prisma.$executeRaw`DELETE FROM "PauseEvent" WHERE "orderId" = ${orderId}`;
      await fastify.prisma.$executeRaw`DELETE FROM "Order" WHERE "id" = ${orderId}`;

      await audit(fastify.prisma, request, 'purge_order', foundOrderNo,
        `entries=${entryCount} pauses=${pauseCount}`);
      return { ok: true, purged: true, orderNo: foundOrderNo, entries: entryCount, pauses: pauseCount };
    } catch (e) {
      request.log.error(e, 'purge failed');
      return reply.code(500).send({ error: '永久刪除失敗：' + (e.message || String(e)) });
    }
  });

  // 取得工單的上傳原始列（多規格）
  fastify.get('/:orderNo/upload-rows', async (request) => {
    const orderNo = String(request.params.orderNo || '').trim().toUpperCase();
    if (!validOrderNo(orderNo)) return { rows: [] };
    // 找該工單最新且未取消的 batch
    const latestRow = await fastify.prisma.uploadRow.findFirst({
      where: {
        orderNo,
        status: { in: ['created', 'updated'] },
        batch: { cancelledAt: null },
      },
      orderBy: { batchId: 'desc' },
      select: { batchId: true },
    });
    if (!latestRow) return { rows: [] };
    const rows = await fastify.prisma.uploadRow.findMany({
      where: { orderNo, batchId: latestRow.batchId },
      orderBy: { id: 'asc' },
    });
    return { rows };
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
