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

// 取得台灣時間的今天日期（UTC+8）
function getTaiwanToday() {
  const now = new Date();
  // 轉換為台灣時間 (UTC+8)
  const twTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = twTime.getUTCFullYear();
  const m = twTime.getUTCMonth();
  const d = twTime.getUTCDate();
  // 回傳 UTC 午夜的日期（僅作為日期標記）
  return new Date(Date.UTC(y, m, d));
}

// 設定 productionDate 為實際生產開始日期
// 工單一旦有過任何活動（含已軟刪除的紀錄），就永遠不再覆寫 productionDate
// 這是為了避免：工單 reset-production 後重做時，日期被當成「第一次活動」重設成今天
// （deletedAt: undefined 是逃生口，繞過軟刪除中間件的自動過濾）
async function updateProductionDateToday(fastify, order) {
  const entryCount = await fastify.prisma.stepEntry.count({ where: { orderId: order.id, deletedAt: undefined } });
  const pauseCount = await fastify.prisma.pauseEvent.count({ where: { orderId: order.id, deletedAt: undefined } });
  const hasOldSteps = !!(order.step1At || order.step2At || order.step3At || order.step4At || order.step5At || order.step6At || order.step7At || order.step11At || order.step21At || order.step22At || order.step23At);
  if (entryCount > 0 || pauseCount > 0 || hasOldSteps) return; // 曾經有過活動，保留現有日期
  // 真正第一次活動（DB 連歷史紀錄都沒有）：設為今天（台灣時間）
  const today = getTaiwanToday();
  await fastify.prisma.order.update({
    where: { orderNo: order.orderNo },
    data: { productionDate: today },
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
    productionDate: o.productionDate, productSpec: o.productSpec || '',
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

    let deleted = 0, cleared = 0;
    for (const orderNo of (batch.orderNos || [])) {
      try {
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        if (await hasAnyActivity(fastify.prisma, order)) {
          // 只清除上傳欄位，保留 productionDate（由實際活動設定）
          await fastify.prisma.order.update({
            where: { orderNo },
            data: {
              productSpec: null, moldSpec: null,
              material: null, dispatchQty: null, bladeCount: null,
              machineSPM: null, unitWeight: null, totalWeight: null,
            },
          });
          cleared++;
        } else {
          await fastify.prisma.order.delete({ where: { orderNo } });
          deleted++;
        }
      } catch (e) { /* ignore */ }
    }
    await fastify.prisma.uploadBatch.update({
      where: { id },
      data: { cancelledAt: new Date() },
    });
    await audit(fastify.prisma, request, 'cancel_batch', batch.id,
      `filename=${batch.filename} deleted=${deleted} cleared=${cleared}`);
    return { ok: true, deleted, cleared };
  });

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
    await updateProductionDateToday(fastify, order);
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

    await updateProductionDateToday(fastify, order);

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
    // 更新 productionDate 為今天
    await updateProductionDateToday(fastify, order);
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
    // 更新 productionDate 為今天
    await updateProductionDateToday(fastify, order);
    const now = new Date();
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
          productionDate: batchProductionDate,
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
            // 若工單已有生產活動，現場性欄位（機台、生產日期）以現場記錄為準，上傳不得覆蓋
            const hasActivity = await hasAnyActivity(fastify.prisma, existing);
            const lockMachine = hasActivity && existing.machineNo;
            const lockDate = hasActivity && existing.productionDate;
            const merged = {};
            for (const key of Object.keys(data)) {
              if (key === 'machineNo' && lockMachine) {
                merged[key] = existing.machineNo;
              } else if (key === 'productionDate' && lockDate) {
                merged[key] = existing.productionDate;
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

  // 批次取消上傳（保留掃描紀錄）
  // - 沒有掃描紀錄的工單：完全刪除
  // - 有掃描紀錄的工單：只清除上傳欄位，保留 step 時間
  // 上傳資料與實態紀錄獨立，重傳時會自動重新配對
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
    let deleted = 0, cleared = 0;
    const errors = [];
    for (const rawNo of orderNos) {
      try {
        const orderNo = String(rawNo || '').trim().toUpperCase();
        if (!orderNo) continue;
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        if (await hasAnyActivity(fastify.prisma, order)) {
          // 清除上傳欄位
          await fastify.prisma.order.update({
            where: { orderNo },
            data: {
              productionDate: null, productSpec: null, moldSpec: null,
              material: null, dispatchQty: null, bladeCount: null,
              machineSPM: null, unitWeight: null, totalWeight: null,
            },
          });
          cleared++;
        } else {
          await fastify.prisma.order.delete({ where: { orderNo } });
          deleted++;
        }
      } catch (e) {
        errors.push(rawNo + ': ' + e.message);
      }
    }
    return { ok: true, deleted, cleared, errors };
  });

  // 刪除工單（只允許無生產紀錄的工單；有紀錄回 409，請改用 reset-production）
  // - 管理員 / 生管 皆可使用
  fastify.delete('/:orderNo', async (request, reply) => {
    const isAdmin = request.user.isAdmin;
    const isPlanner = request.user.isPlanner;
    if (!isAdmin && !isPlanner) {
      return reply.code(403).send({ error: '權限不足' });
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

    if (hasProductionData) {
      return reply.code(409).send({
        error: '工單已有生產紀錄，無法直接刪除',
        code: 'HAS_PRODUCTION_DATA',
        canReset: isAdmin,
        entryCount, pauseCount,
      });
    }

    await fastify.prisma.order.delete({ where: { orderNo: order.orderNo } });
    await audit(fastify.prisma, request, 'delete_order', order.orderNo,
      isAdmin ? 'admin_delete' : 'planner_delete_unscanned');
    return { ok: true, deleted: true };
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

  // 還原已軟刪除的工單（連同其 stepEntries / pauseEvents）
  // - Admin only
  fastify.post('/:orderNo/restore', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const rawNo = String(request.params.orderNo || '').trim();
    if (!rawNo) return reply.code(400).send({ error: '缺少工單號' });
    // 逃生口：明示 deletedAt 鍵繞過中間件自動過濾，才能查到已軟刪除的工單
    let order = await fastify.prisma.order.findFirst({
      where: { orderNo: rawNo, deletedAt: undefined },
    });
    if (!order) {
      order = await fastify.prisma.order.findFirst({
        where: { orderNo: rawNo.toUpperCase(), deletedAt: undefined },
      });
    }
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    if (!order.deletedAt) {
      return reply.code(400).send({ error: '此工單並未被刪除' });
    }
    await fastify.prisma.order.update({
      where: { id: order.id },
      data: { deletedAt: null },
    });
    // 子紀錄（stepEntries / pauseEvents）通常隨工單一起被軟刪除，也一併還原
    const entryRes = await fastify.prisma.stepEntry.updateMany({
      where: { orderId: order.id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    const pauseRes = await fastify.prisma.pauseEvent.updateMany({
      where: { orderId: order.id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    await audit(fastify.prisma, request, 'restore_order', order.orderNo,
      `entries=${entryRes.count} pauses=${pauseRes.count}`);
    return { ok: true, restored: true, entries: entryRes.count, pauses: pauseRes.count };
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
