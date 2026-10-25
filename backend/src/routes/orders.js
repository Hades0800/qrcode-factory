// ── 共用常數與 helper（已抽出至 lib/ 與 domain/orders/）──
import { validOrderNo, clipStr } from '../lib/validation.js';
import { validMachine } from '../lib/machines.js';
import { toTaiwanDate, taiwanDateAt8 } from '../lib/date.js';
import { audit } from '../lib/audit.js';
import {
  STEP_COLS,
  ORDER_INCLUDE,
  serializeOrder,
  serializeWithPrev,
} from '../domain/orders/serialize.js';
import {
  stripCustomerCode,
  hasActivity,
  setActualStartDate,
  getPrevMachineEndAt,
  hasManufacturingParams,
  getMissingManufacturingParams,
  hasEquipmentParamFile,
  recomputeActualStartDate,
  autoInterleave,
  hasRunningSibling,
} from '../domain/orders/helpers.js';

// 會觸發自動插單的工序（記錄這些工序 = 機台「現在」正在生產這張單）
// 只含實際生產工序：41(生產開始)、4/5/8(穩定連續生產)、6(後工程接續)、30(生產規格完成)
// 排除準備類工序（1/2/3/7/21/22/40）—— A 生產中先幫下一張 B 做準備是常態，不代表機台換單
// 排除 11(完成)、23(無工令)、12/13(暫停與異常走 pause API)
// 另外：補登（帶 manualTime）一律不觸發 —— 補歷史紀錄不代表機台現在換單
const INTERLEAVE_TRIGGER_STEPS = new Set(['4', '5', '6', '8', '30', '41']);

// 生產規格完成／生產完成終止前，設備「製造參數」必須已填（防呆）
// 僅限傳統機台 No1–No6；過濾網／筋網機 No12–No20 不套用此防呆
const NEED_MFG_PARAMS_MSG = '設備「製造參數」未填完整，無法記錄生產規格完成／生產完成終止。缺少'
const MFG_PARAM_REQUIRED_MACHINES = new Set(['No1-350','No2-250','No3-60','No4-90','No5-40','No6-40']);

// 生產完成終止前，設備「參數檔名」必須已上傳（防呆）—— 所有機台皆套用
const NEED_EP_FILE_MSG = '請先上傳設備參數（設備參數檔名）才能記錄生產完成終止';

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
    let cleared = 0, kept = 0;
    for (const orderNo of [...new Set(batch.orderNos || [])]) {
      try {
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        // 之後還有別的有效批次上傳過這張單 → 現在的欄位是那批寫的，不能清掉
        const later = await fastify.prisma.uploadRow.findFirst({
          where: { orderNo, batchId: { gt: id }, status: { in: ['created', 'updated'] }, batch: { cancelledAt: null } },
        });
        if (later) { kept++; continue; }
        await fastify.prisma.order.update({
          where: { orderNo },
          data: {
            productSpec: null, customerName: null, moldSpec: null,
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
      `filename=${batch.filename} cleared=${cleared} kept=${kept}`);
    return { ok: true, cleared, kept };
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

    const fields = ['productSpec', 'customerName', 'moldSpec', 'material', 'dispatchQty', 'bladeCount', 'machineSPM', 'unitWeight', 'totalWeight'];
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
    return { order: await serializeWithPrev(fastify.prisma, order), wasCreated };
  });

  // 記錄工序（可重複，日誌式；支援補登自訂時間）
  // 規格比對用的鍵：去掉所有空白（生管 Excel 的規格常多空白，多一個空白不能算成另一個規格）
  const specKey = s => String(s == null ? '' : s).replace(/\s+/g, '');

  // 已完成的工單不能再記錄生產（工序、暫停、換機台）：要繼續做請管理員「重新開啟」。
  // 例外：補登「完成時間之前」的紀錄（事後補記漏掉的）；管理員不受限（修正資料用）。
  const DONE_LOCK_MSG = '此工單已完成，不能再記錄生產。如需繼續生產，請管理員到「生產實態紀錄」把這張單重新開啟';
  function lockedAfterDone(order, user, eventTime) {
    if (!order.step11At || (user && user.isAdmin)) return false;
    return !eventTime || eventTime > order.step11At;
  }

  // 暫停／異常不可重疊：重疊會讓生產時間被重複扣（2026-10 資料裡有 36 組）
  // [start, end) 跟這張單既有的任何一筆暫停／異常（含進行中）有交集 → 回傳說明文字；沒有 → null
  async function pauseClash(prisma, orderId, start, end) {
    const list = await prisma.pauseEvent.findMany({ where: { orderId, deletedAt: null } });
    const s = start.getTime(), e = end ? end.getTime() : Infinity; // 沒有結束時間＝進行中，往後都算
    const tw = t => new Date(new Date(t).getTime() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
    for (const p of list) {
      const ps = new Date(p.startAt).getTime(), pe = p.endAt ? new Date(p.endAt).getTime() : Infinity;
      if (s < pe && ps < e) {
        const what = String(p.note || (p.type === '13' ? '異常停線' : '暫停')).replace('【補登】', '').split(' - ')[0];
        return `這段時間已經有「${what}」的紀錄（${tw(p.startAt)} ～ ${p.endAt ? tw(p.endAt) : '還沒恢復'}），暫停／異常不能重疊`;
      }
    }
    return null;
  }

  fastify.post('/:orderNo/step-entries', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { stepNo, recordedAt: manualTime, note: rawNote, qcActualQty: rawQc } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const validSteps = ['1','2','3','4','5','6','7','8','21','22','23','12','13','30','40','41'];
    if (!validSteps.includes(stepNo)) {
      return reply.code(400).send({ error: '無效工序編號' });
    }
    // stepNo=30 (更換規格) 必須帶文字描述 + QC 實際生產數量
    const note = typeof rawNote === 'string' ? rawNote.trim().slice(0, 200) : null;
    if (stepNo === '30' && !note) {
      return reply.code(400).send({ error: '更換規格需填入規格描述' });
    }
    let qcActualQty = null;
    if (stepNo === '30') {
      const n = Number(rawQc);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({ error: '請填這次新做了幾個（非負整數）' });
      }
      qcActualQty = n;
    }
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    if (lockedAfterDone(order, request.user, manualTime ? new Date(manualTime) : new Date())) {
      return reply.code(409).send({ error: DONE_LOCK_MSG });
    }
    // 防重複送出：網路慢時現場常按兩次，同規格、同數量 1 分鐘內再送一次 → 擋（重複會讓完成數量多算一份）
    if (stepNo === '30' && !manualTime) {
      const dup = await fastify.prisma.stepEntry.findFirst({
        where: { orderId: order.id, stepNo: '30', note, qcActualQty, deletedAt: null, recordedAt: { gte: new Date(Date.now() - 60 * 1000) } },
      });
      if (dup && dup.note === note && dup.qcActualQty === qcActualQty) {
        return reply.code(409).send({ error: '剛剛已經記錄過同一個規格、同樣的數量了，請確認是不是按了兩次' });
      }
    }
    // 防呆：生產規格完成（更換規格）前，設備「製造參數」必須已填（僅 No1–No6）
    if (stepNo === '30' && MFG_PARAM_REQUIRED_MACHINES.has(order.machineNo)) {
      const missing = await getMissingManufacturingParams(fastify.prisma, order);
      if (missing.length) return reply.code(400).send({ error: NEED_MFG_PARAMS_MSG + '：' + missing.join('；') });
    }
    // 規則：step 41（生產開始）之後不能再按 step 40（生產準備），
    // 除非下列任一介入：
    //   - step 30（切換規格）
    //   - pause 13（異常中斷）開始時間
    //   - pause 12 中的「中午休息／下班時間／原料更換／模裂更換」已結束（取 endAt）
    if (stepNo === '40') {
      const lastStep41 = await fastify.prisma.stepEntry.findFirst({
        where: { orderId: order.id, stepNo: '41' },
        orderBy: { recordedAt: 'desc' },
      });
      if (lastStep41) {
        const lastStep30 = await fastify.prisma.stepEntry.findFirst({
          where: { orderId: order.id, stepNo: '30' },
          orderBy: { recordedAt: 'desc' },
        });
        const lastAbn = await fastify.prisma.pauseEvent.findFirst({
          where: { orderId: order.id, type: '13' },
          orderBy: { startAt: 'desc' },
        });
        // 中午休息／下班（pause 12，note 含「中午」「午休」「午餐」「下班」）已結束
        const lunchCandidates = await fastify.prisma.pauseEvent.findMany({
          where: {
            orderId: order.id,
            type: '12',
            endAt: { not: null },
            OR: [
              { note: { contains: '中午' } },
              { note: { contains: '午休' } },
              { note: { contains: '午餐' } },
              { note: { contains: '下班' } },
              { note: { contains: '原料更換' } },
              { note: { contains: '模裂更換' } },
            ],
          },
          orderBy: { endAt: 'desc' },
          take: 1,
        });
        const lastLunchEnd = lunchCandidates[0] || null;
        const lastStep41Ms = new Date(lastStep41.recordedAt).getTime();
        const lastReleaseMs = Math.max(
          lastStep30 ? new Date(lastStep30.recordedAt).getTime() : 0,
          lastAbn ? new Date(lastAbn.startAt).getTime() : 0,
          lastLunchEnd ? new Date(lastLunchEnd.endAt).getTime() : 0,
        );
        if (lastStep41Ms >= lastReleaseMs) {
          return reply.code(400).send({
            error: '生產開始後不能再按生產準備（需先「切換規格」、「異常中斷」或「中午休息結束後」才能重新準備）',
          });
        }
      }
    }
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
    // 強制：本單第一筆生產時態（40/41）的時間
    //   - 同機台同日有上一張完成 → 上單結束 + 1 分鐘
    //   - 無上單 / 上單在前一日或更早 → 該日台灣時間 08:00
    let forcedFromPrev = false;
    let forcedPrevEnd = null;
    let forcedReason = null; // 'prev_same_day' | 'day_start'
    if ((stepNo === '40' || stepNo === '41') && order.machineNo) {
      const existingStable = await fastify.prisma.stepEntry.findFirst({
        where: { orderId: order.id, stepNo: { in: ['40', '41'] } },
      });
      if (!existingStable) {
        const prevEnd = await getPrevMachineEndAt(fastify.prisma, order);
        const targetDay = toTaiwanDate(time);
        if (prevEnd && toTaiwanDate(prevEnd).getTime() === targetDay.getTime()) {
          time = new Date(new Date(prevEnd).getTime() + 60000);
          forcedReason = 'prev_same_day';
          forcedFromPrev = true;
          forcedPrevEnd = prevEnd;
        } else if (await hasRunningSibling(fastify.prisma, order)) {
          // 插單：同機台還有做到一半的單，今天早已開工 → 用實際掃碼時間，不強制 08:00
        } else {
          time = taiwanDateAt8(time);
          forcedReason = 'day_start';
          forcedFromPrev = true;
          forcedPrevEnd = prevEnd;
        }
      }
    }
    await setActualStartDate(fastify, order, time);
    const entry = await fastify.prisma.stepEntry.create({
      data: {
        orderId: order.id,
        stepNo,
        seq: prevCount + 1,
        recordedAt: time,
        isManual: isManual || forcedFromPrev,
        note,
        qcActualQty,
        leaderId: request.user.id,
        leaderName: request.user.displayName || null,
      },
    });
    let interleave = null;
    if (INTERLEAVE_TRIGGER_STEPS.has(stepNo) && !manualTime) {
      interleave = await autoInterleave(fastify.prisma, order, time);
    }
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { entry, order: await serializeWithPrev(fastify.prisma, updated), forcedFromPrev, forcedPrevEnd, forcedReason, interleave };
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
    await recomputeActualStartDate(fastify.prisma, entry.orderId);
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { ok: true, order: updated ? await serializeWithPrev(fastify.prisma, updated) : null };
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
    if (order.machineNo && order.machineNo !== String(machineNo).trim() && lockedAfterDone(order, request.user, new Date())) {
      return reply.code(409).send({ error: DONE_LOCK_MSG });
    }
    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: { machineNo: clipStr(String(machineNo).trim(), 60), leaderId: request.user.id },
      include: ORDER_INCLUDE,
    });
    return { order: await serializeWithPrev(fastify.prisma, updated) };
  });

  // 設定規格類型（現場技術員選擇）
  // 用 raw SQL 寫入避免 Prisma client 沒 regenerate 時拋錯
  // body: {
  //   specType: 'new' | 'mass',
  //   aspects?: ['raw'|'mold'|'dim',...]   // 新製規格才有意義；存成逗號字串
  // }
  fastify.post('/:orderNo/spec-type', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      const { specType, aspects } = request.body || {};
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
      if (!['new', 'mass'].includes(specType)) {
        return reply.code(400).send({ error: '無效規格類型（需為 new 或 mass）' });
      }
      // 整理 aspects：只對「新製」有效。
      // 舊資料相容：raw / dim 仍可被讀寫；新版單選用：mold / mat / swm
      const ALLOWED_ASPECTS = ['mold', 'mat', 'swm', 'raw', 'dim'];
      let aspectsStr = null;
      if (specType === 'new' && Array.isArray(aspects)) {
        const cleaned = aspects.filter(a => ALLOWED_ASPECTS.includes(a));
        // 保持固定順序便於後續顯示
        aspectsStr = ALLOWED_ASPECTS.filter(a => cleaned.includes(a)).join(',') || null;
      }
      // 確保欄位存在（idempotent）
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "specType" TEXT, ADD COLUMN IF NOT EXISTS "difficultyFactor" DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS "newSpecAspects" TEXT'
      );
      const result = await fastify.prisma.$executeRaw`
        UPDATE "Order"
        SET "specType" = ${specType}, "difficultyFactor" = NULL, "newSpecAspects" = ${aspectsStr}
        WHERE "orderNo" = ${orderNo}
      `;
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      return { ok: true, specType, difficultyFactor: null, newSpecAspects: aspectsStr };
    } catch (e) {
      request.log.error(e, 'spec-type failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
  });

  // 設定更換範圍（@ = 僅換原料 / # = 僅換模刀具 / @# = 兩者都換 / null = 清除）
  // 用 raw SQL，跟 spec-type 同 pattern，不依賴 Prisma client regenerate
  fastify.post('/:orderNo/change-scope', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      const { changeScope } = request.body || {};
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
      if (changeScope !== null && !['@', '#', '@#', 'same'].includes(changeScope)) {
        return reply.code(400).send({ error: '無效的更換範圍（需為 @ / # / @# / same / null）' });
      }
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "changeScope" TEXT'
      );
      const result = await fastify.prisma.$executeRaw`
        UPDATE "Order"
        SET "changeScope" = ${changeScope}
        WHERE "orderNo" = ${orderNo}
      `;
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      return { ok: true, changeScope };
    } catch (e) {
      request.log.error(e, 'change-scope failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
  });

  // 設定原料類型（coil = 捲料 1.0 / plate = 板料 1.2 / null = 清除）
  // 同 change-scope pattern：raw SQL + ALTER TABLE IF NOT EXISTS
  fastify.post('/:orderNo/material-type', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      const { materialType } = request.body || {};
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
      if (materialType !== null && !['coil', 'plate'].includes(materialType)) {
        return reply.code(400).send({ error: '無效的原料類型（需為 coil / plate / null）' });
      }
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "materialType" TEXT'
      );
      const result = await fastify.prisma.$executeRaw`
        UPDATE "Order"
        SET "materialType" = ${materialType}
        WHERE "orderNo" = ${orderNo}
      `;
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      return { ok: true, materialType };
    } catch (e) {
      request.log.error(e, 'material-type failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
  });

  // 設定輔助設備（可多選 + 自訂名稱）
  // body: { auxEquipment: 'flat,leveler' | ['flat','leveler'] | null, auxEquipmentCustom: '...' | null }
  fastify.post('/:orderNo/aux-equipment', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      const body = request.body || {};
      const ALLOWED = ['flat', 'leveler', 'slitter', 'wave', 'rewind', 'other'];
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });

      // 標準化 auxEquipment：array / comma-string / null → 過濾後逗號字串或 null
      let auxEquipment = body.auxEquipment;
      if (auxEquipment !== undefined) {
        let codes = [];
        if (Array.isArray(auxEquipment)) {
          codes = auxEquipment;
        } else if (typeof auxEquipment === 'string') {
          codes = auxEquipment.split(',');
        } else if (auxEquipment !== null) {
          return reply.code(400).send({ error: 'auxEquipment 格式錯誤' });
        }
        codes = codes.map(c => String(c).trim()).filter(Boolean);
        for (const c of codes) {
          if (!ALLOWED.includes(c)) return reply.code(400).send({ error: '無效的輔助設備: ' + c });
        }
        // 去重、依固定順序排序，存成逗號字串
        const uniq = ALLOWED.filter(c => codes.includes(c));
        auxEquipment = uniq.length ? uniq.join(',') : null;
      }

      // 標準化 auxEquipmentCustom：去頭尾空白，最長 100 字，空字串視為 null
      let auxEquipmentCustom = body.auxEquipmentCustom;
      if (auxEquipmentCustom !== undefined) {
        if (auxEquipmentCustom === null || auxEquipmentCustom === '') {
          auxEquipmentCustom = null;
        } else {
          auxEquipmentCustom = String(auxEquipmentCustom).trim().slice(0, 100);
          if (auxEquipmentCustom === '') auxEquipmentCustom = null;
        }
      }

      // 標準化 auxEquipmentNos：物件 { code: '編號' }，只留合法 code、編號最長 20 字、英數
      // 存成 JSON 字串；空物件視為 null
      let auxEquipmentNos = body.auxEquipmentNos;
      if (auxEquipmentNos !== undefined) {
        if (auxEquipmentNos === null) {
          auxEquipmentNos = null;
        } else if (typeof auxEquipmentNos === 'object' && !Array.isArray(auxEquipmentNos)) {
          const clean = {};
          for (const [code, no] of Object.entries(auxEquipmentNos)) {
            if (!ALLOWED.includes(code)) continue;
            const v = String(no == null ? '' : no).trim().slice(0, 20);
            if (v) clean[code] = v;
          }
          auxEquipmentNos = Object.keys(clean).length ? JSON.stringify(clean) : null;
        } else {
          return reply.code(400).send({ error: 'auxEquipmentNos 格式錯誤' });
        }
      }

      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "auxEquipment" TEXT'
      );
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "auxEquipmentCustom" TEXT'
      );
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "auxEquipmentNos" TEXT'
      );

      const sets = [];
      const params = [];
      if (auxEquipment !== undefined) {
        params.push(auxEquipment);
        sets.push(`"auxEquipment" = $${params.length}`);
      }
      if (auxEquipmentCustom !== undefined) {
        params.push(auxEquipmentCustom);
        sets.push(`"auxEquipmentCustom" = $${params.length}`);
      }
      if (auxEquipmentNos !== undefined) {
        params.push(auxEquipmentNos);
        sets.push(`"auxEquipmentNos" = $${params.length}`);
      }
      if (sets.length === 0) return { ok: true };
      params.push(orderNo);
      const sql = `UPDATE "Order" SET ${sets.join(', ')} WHERE "orderNo" = $${params.length}`;
      const result = await fastify.prisma.$executeRawUnsafe(sql, ...params);
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      return { ok: true, auxEquipment, auxEquipmentCustom, auxEquipmentNos };
    } catch (e) {
      request.log.error(e, 'aux-equipment failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
  });

  // 設定設備操作人員 / 全部作業人數（第五步）
  fastify.post('/:orderNo/operation-info', async (request, reply) => {
    try {
      const orderNo = String(request.params.orderNo || '').toUpperCase();
      if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
      const body = request.body || {};
      let operatorName = body.operatorName;
      let totalWorkers = body.totalWorkers;

      if (operatorName !== undefined) {
        if (operatorName === null || operatorName === '') {
          operatorName = null;
        } else {
          operatorName = String(operatorName).trim().slice(0, 50);
          if (operatorName === '') operatorName = null;
        }
      }
      if (totalWorkers !== undefined) {
        if (totalWorkers === null || totalWorkers === '') {
          totalWorkers = null;
        } else {
          const n = Number(totalWorkers);
          if (!Number.isFinite(n) || n < 1 || n > 99 || !Number.isInteger(n)) {
            return reply.code(400).send({ error: '人數須為 1-99 的整數' });
          }
          totalWorkers = n;
        }
      }

      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "operatorName" TEXT'
      );
      await fastify.prisma.$executeRawUnsafe(
        'ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "totalWorkers" INTEGER'
      );

      const sets = [];
      const params = [];
      if (operatorName !== undefined) {
        params.push(operatorName);
        sets.push(`"operatorName" = $${params.length}`);
      }
      if (totalWorkers !== undefined) {
        params.push(totalWorkers);
        sets.push(`"totalWorkers" = $${params.length}`);
      }
      if (sets.length === 0) return { ok: true };
      params.push(orderNo);
      const sql = `UPDATE "Order" SET ${sets.join(', ')} WHERE "orderNo" = $${params.length}`;
      const result = await fastify.prisma.$executeRawUnsafe(sql, ...params);
      if (result === 0) return reply.code(404).send({ error: '找不到工單' });
      return { ok: true, operatorName, totalWorkers };
    } catch (e) {
      request.log.error(e, 'operation-info failed');
      return reply.code(500).send({
        error: '設定失敗：' + (e.message || String(e)),
        code: e.code || null,
      });
    }
  });

  // 紀錄某步驟（recordedAt 可選；填了表示補登）
  fastify.post('/:orderNo/steps/:step', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { step } = request.params;
    const { note, recordedAt: manualTime, qcActualQty: rawQc } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const cols = STEP_COLS[step];
    if (!cols) return reply.code(400).send({ error: '無效步驟' });
    // step 11（生產完成終止）：數量改由「生產規格完成」記錄，這裡數量為選填（相容舊流程）
    let qcActualQty = null;
    if (step === '11' && rawQc !== undefined && rawQc !== null && rawQc !== '') {
      const n = Number(rawQc);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({ error: 'QC 數量必須是非負整數' });
      }
      qcActualQty = n;
    }

    let order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) {
      order = await fastify.prisma.order.create({
        data: { orderNo, leaderId: request.user.id },
      });
    }

    if (step !== '11' && lockedAfterDone(order, request.user, manualTime ? new Date(manualTime) : new Date())) {
      return reply.code(409).send({ error: DONE_LOCK_MSG });
    }
    // 還在暫停／異常中就按完成 → 擋：完成後這筆暫停永遠不會結束，統計會一直把它算到現在
    if (step === '11' && !order.step11At) {
      const open = await fastify.prisma.pauseEvent.findFirst({ where: { orderId: order.id, endAt: null, deletedAt: null } });
      if (open) {
        const what = String(open.note || (open.type === '13' ? '異常停線' : '暫停')).replace('【補登】', '').split(' - ')[0];
        return reply.code(409).send({ error: `這張單還在「${what}」中，請先按「恢復」再按完成` });
      }
    }
    // 防呆：生產完成終止前，設備「製造參數」必須已填（僅 No1–No6）
    if (step === '11' && MFG_PARAM_REQUIRED_MACHINES.has(order.machineNo)) {
      const missing = await getMissingManufacturingParams(fastify.prisma, order);
      if (missing.length) return reply.code(400).send({ error: NEED_MFG_PARAMS_MSG + '：' + missing.join('；') });
    }

    // 防呆：生產完成終止前，設備「參數檔名」必須已上傳（所有機台）
    if (step === '11' && !(await hasEquipmentParamFile(fastify.prisma, order.id))) {
      return reply.code(400).send({ error: NEED_EP_FILE_MSG });
    }

    if (order[cols.time]) {
      const existing = await fastify.prisma.order.findUnique({
        where: { orderNo },
        include: ORDER_INCLUDE,
      });
      return reply.code(409).send({
        error: `此項目已記錄過：${order[cols.time].toISOString()}`,
        order: await serializeWithPrev(fastify.prisma, existing),
      });
    }

    let stepTime = new Date();
    if (manualTime) {
      const parsed = new Date(manualTime);
      if (isNaN(parsed) || parsed.getFullYear() < 2000 || parsed.getFullYear() > 2100) {
        return reply.code(400).send({ error: '補登時間格式錯誤' });
      }
      if (parsed > new Date()) {
        return reply.code(400).send({ error: '補登時間不能超過現在' });
      }
      stepTime = parsed;
    }
    await setActualStartDate(fastify, order, stepTime);

    const updateData = {
      [cols.time]: stepTime,
      leaderId: request.user.id,
    };
    if (cols.note && note) updateData[cols.note] = clipStr(note, 500);
    if (step === '11' && qcActualQty != null) updateData.step11QcActualQty = qcActualQty;

    let interleave = null;
    if (INTERLEAVE_TRIGGER_STEPS.has(step) && !manualTime) {
      interleave = await autoInterleave(fastify.prisma, order, stepTime);
    }
    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: ORDER_INCLUDE,
    });
    return { order: await serializeWithPrev(fastify.prisma, updated), interleave };
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
    // 取消「完成」＝重新開啟工單：只有管理員可以（現場要繼續做，請管理員開）
    if (step === '11') {
      if (!request.user.isAdmin) return reply.code(403).send({ error: '只有管理員可以重新開啟已完成的工單' });
      if (!order.step11At) return reply.code(400).send({ error: '這張單還沒完成，不需要重新開啟' });
      await audit(fastify.prisma, request, 'reopen_order', orderNo, `原完成時間=${order.step11At.toISOString()}`);
    }

    const updateData = { [cols.time]: null };
    if (cols.note) updateData[cols.note] = null;

    const updated = await fastify.prisma.order.update({
      where: { orderNo },
      data: updateData,
      include: ORDER_INCLUDE,
    });
    return { order: await serializeWithPrev(fastify.prisma, updated) };
  });

  // 開始暫停 / 異常
  fastify.post('/:orderNo/pause', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { type, note, activeStep, qcActualQty: rawQc, startAt: rawStart } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!['12', '13'].includes(type)) return reply.code(400).send({ error: '無效類型' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const active = await fastify.prisma.pauseEvent.findFirst({
      where: { orderId: order.id, type, endAt: null },
    });
    if (active) return reply.code(409).send({ error: '已在暫停中，請先恢復' });
    // 生產完成數量：任何中斷原因都可記錄（下班時間／隔日生產為必填）
    let qcActualQty = null;
    if (rawQc !== undefined && rawQc !== null && rawQc !== '') {
      const n = Number(rawQc);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({ error: '這次新做了幾個必須是非負整數' });
      }
      qcActualQty = n;
    }
    const isOffWork = type === '12' && typeof note === 'string' && note.includes('下班');
    if (isOffWork && qcActualQty === null) {
      return reply.code(400).send({ error: '請填這次新做了幾個（非負整數）' });
    }
    // 可指定暫停（生產紀錄）時間；不帶則用現在
    let pauseStart = new Date();
    if (rawStart) {
      const parsed = new Date(rawStart);
      if (isNaN(parsed) || parsed.getFullYear() < 2000 || parsed.getFullYear() > 2100) {
        return reply.code(400).send({ error: '時間格式錯誤' });
      }
      if (parsed > new Date()) return reply.code(400).send({ error: '時間不能超過現在' });
      pauseStart = parsed;
    }
    if (lockedAfterDone(order, request.user, pauseStart)) return reply.code(409).send({ error: DONE_LOCK_MSG });
    const clash = await pauseClash(fastify.prisma, order.id, pauseStart, null);
    if (clash) return reply.code(409).send({ error: clash });
    await setActualStartDate(fastify, order, pauseStart);
    await fastify.prisma.pauseEvent.create({
      data: { orderId: order.id, type, note: clipStr(note, 500), activeStep: clipStr(activeStep, 100), qcActualQty, startAt: pauseStart },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { order: await serializeWithPrev(fastify.prisma, updated) };
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
    // 手動恢復 = 這張單重新開始生產 → 同機台其他運轉中的工單自動插單暫停
    const interleave = await autoInterleave(fastify.prisma, order, now);
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { order: await serializeWithPrev(fastify.prisma, updated), resumed: { type, duration }, interleave };
  });

  // 補登暫停（已結束的暫停事件）
  fastify.post('/:orderNo/pause-backfill', async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    const { type, note, startAt: startStr, endAt: endStr, qcActualQty: rawQc } = request.body || {};
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    if (!['12', '13'].includes(type)) return reply.code(400).send({ error: '無效類型' });
    if (!startStr) return reply.code(400).send({ error: '請填寫開始時間' });
    const startAt = new Date(startStr);
    if (isNaN(startAt)) return reply.code(400).send({ error: '時間格式錯誤' });
    if (startAt > new Date()) return reply.code(400).send({ error: '開始時間不能超過現在' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    // 結束時間選填：有填→已結束暫停（算時長）；不填→進行中暫停（如下班尚未恢復生產）
    let endAt = null, duration = null;
    if (endStr) {
      endAt = new Date(endStr);
      if (isNaN(endAt)) return reply.code(400).send({ error: '時間格式錯誤' });
      if (endAt <= startAt) return reply.code(400).send({ error: '結束時間必須晚於開始時間' });
      if (endAt > new Date()) return reply.code(400).send({ error: '補登時間不能超過現在' });
      duration = Math.round((endAt - startAt) / 1000);
    } else {
      const activeSame = await fastify.prisma.pauseEvent.findFirst({ where: { orderId: order.id, type, endAt: null } });
      if (activeSame) return reply.code(409).send({ error: '已有進行中的暫停，請先恢復或填結束時間' });
    }
    if (lockedAfterDone(order, request.user, endAt || startAt)) return reply.code(409).send({ error: DONE_LOCK_MSG });
    const clash = await pauseClash(fastify.prisma, order.id, startAt, endAt);
    if (clash) return reply.code(409).send({ error: clash });
    const backfillNote = '【補登】' + (note || '');
    // 補登暫停的 QC 實際生產數量：選填（事後補登可能已不知道）
    let qcActualQty = null;
    if (rawQc !== undefined && rawQc !== null && rawQc !== '') {
      const n = Number(rawQc);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'QC 數量必須是非負整數' });
      qcActualQty = n;
    }
    await setActualStartDate(fastify, order, startAt);
    await fastify.prisma.pauseEvent.create({
      data: { orderId: order.id, type, note: clipStr(backfillNote, 500), startAt, endAt, duration, qcActualQty },
    });
    const updated = await fastify.prisma.order.findUnique({ where: { orderNo }, include: ORDER_INCLUDE });
    return { ok: true, order: await serializeWithPrev(fastify.prisma, updated) };
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
    const machineKept = []; // 已開工、Excel 機台不同 → 機台維持現場的（回給生管提醒）
    const doneKept = [];    // 已完成的單又出現在清單上 → 計畫日維持不變（回給生管提醒）
    const rawRows = []; // 收集原始資料

    for (const [rowIndex, row] of rows.entries()) {
      const orderNo = String(row.orderNo || '').toUpperCase();
      const rawRow = {
        batchId: batch.id,
        orderNo: orderNo || String(row.orderNo || ''),
        productSpec: clipStr(row.productSpec, 200),
        manuSpec: clipStr(row.manuSpec, 200),
        customerName: clipStr(stripCustomerCode(row.customerName), 100),
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
          planSeq: rowIndex,                // 計畫序號：Excel 列順序，每次上傳覆寫
          productSpec: rawRow.productSpec,
          manuSpec: rawRow.manuSpec,        // 製造規格（生管 Excel）
          customerName: rawRow.customerName,
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

        // 已軟刪除（被自動取消抽單、或手動刪除）的同號工單：重新上傳＝生管明確要再排這張單 → 從回收桶救回。
        // 不救回的話，下方查詢會略過已刪除的單而走「新建」，撞上單號唯一鍵而上傳失敗；
        // 現場掃碼也會看到「此單已被刪除」。
        const deletedSame = await fastify.prisma.order.findFirst({ where: { orderNo, deletedAt: { not: null } } });
        // 被刪除前已經有生產紀錄的單（管理員強制刪除）：不自動救回——救回會變成「已完成、數量 0」的怪單，
        // 要用請管理員從回收桶「救回」（會連生產紀錄一起回來）
        if (deletedSame && (deletedSame.actualStartDate || deletedSame.step11At ||
            (await fastify.prisma.stepEntry.count({ where: { orderId: deletedSame.id, deletedAt: undefined } })) > 0 ||
            (await fastify.prisma.pauseEvent.count({ where: { orderId: deletedSame.id, deletedAt: undefined } })) > 0)) {
          rawRow.errorMsg = '此單之前被刪除，而且有生產紀錄，請管理員到回收桶救回';
          rawRows.push(rawRow);
          errors.push(orderNo + '：' + rawRow.errorMsg);
          continue;
        }
        if (deletedSame) {
          await fastify.prisma.order.update({ where: { id: deletedSame.id }, data: { deletedAt: null } });
          await audit(fastify.prisma, request, 'bulk_upload_revive_order', orderNo, { batchId: batch.id });
          rawRow.errorMsg = '已從回收桶救回';
        }

        const existing = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (existing) {
          // 剛救回的未開工單＝重新排單，規格以本次上傳為準（不因規格不同而跳過）
          const revivedFresh = !!deletedSame && !existing.actualStartDate && !existing.step11At;
          const specMatch = revivedFresh || !existing.productSpec || !data.productSpec || specKey(existing.productSpec) === specKey(data.productSpec);
          if (specMatch) {
            // 上傳有值就覆蓋；上傳沒值才保留舊值
            const merged = {};
            for (const key of Object.keys(data)) {
              merged[key] = (data[key] != null && data[key] !== '') ? data[key] : existing[key];
            }
            // 已開工的單：機台以現場實際生產的為準，不被 Excel 改走（否則已做的工時會整批算到別台）；
            // 計畫機台 plannedMachineNo 照 Excel 更新，並回報給生管提醒
            const started = existing.machineNo && merged.machineNo && merged.machineNo !== existing.machineNo && (
              existing.actualStartDate || existing.step11At ||
              (await fastify.prisma.stepEntry.count({ where: { orderId: existing.id, deletedAt: null } })) > 0 ||
              (await fastify.prisma.pauseEvent.count({ where: { orderId: existing.id, deletedAt: null } })) > 0);
            if (started) {
              machineKept.push({ orderNo, actual: existing.machineNo, upload: merged.machineNo });
              rawRow.errorMsg = `已在 ${existing.machineNo} 開工，機台維持不變（Excel 為 ${merged.machineNo}）`;
              merged.machineNo = existing.machineNo;
            }
            // 已完成的單：計畫日不跟著重新上傳改。生管清單上常留著做完的單，改了會變成
            // 「做完那天沒計畫、隔天有計畫沒生產」（例：F1150930001 10/5 做完，10/6 上傳被改成 10/6）。
            // 還沒做完的單（含隔日生產、跳著生產）照舊跟著最新上傳走。
            if (existing.step11At && existing.plannedDate && batchProductionDate &&
                existing.plannedDate.getTime() !== batchProductionDate.getTime()) {
              merged.plannedDate = existing.plannedDate;
              merged.planSeq = existing.planSeq;
              doneKept.push(orderNo);
              rawRow.errorMsg = (rawRow.errorMsg ? rawRow.errorMsg + '；' : '') + '已完成，計畫日維持不變';
            }
            await fastify.prisma.order.update({ where: { orderNo }, data: merged });
            rawRow.status = 'updated';
            updated++;
          } else {
            // 規格不同跳過，但客戶名稱跟著工單號走：工單還沒填客戶時照樣配對補上
            if (data.customerName && !existing.customerName) {
              await fastify.prisma.order.update({
                where: { orderNo },
                data: { customerName: data.customerName },
              });
            }
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

    // 自動取消被抽掉的計畫單（軟刪除，回收桶可救回）：
    // 臨時調整計畫時生管重傳當日清單，「同計畫日、同機台、完全未開工、且不在本次清單」
    // 的單視為被抽單。範圍限定「本次檔案有出現的機台」——只補傳某一台的計畫時，
    // 其他機台的單絕不受牽連；已開工（有任何掃碼/暫停）的單永遠不動。
    let autoCancelled = [];
    const uploadMachines = [...new Set(rawRows.map(r => r.machineNo).filter(Boolean))];
    if (batchProductionDate && uploadMachines.length > 0 && processedOrderNos.length > 0) {
      const stale = await fastify.prisma.order.findMany({
        where: {
          plannedDate: batchProductionDate,
          machineNo: { in: uploadMachines },
          orderNo: { notIn: processedOrderNos },
          actualStartDate: null,
          step11At: null,
          stepEntries: { none: {} },
          pauseEvents: { none: {} },
        },
        select: { id: true, orderNo: true },
      });
      if (stale.length > 0) {
        await fastify.prisma.order.deleteMany({ where: { id: { in: stale.map(o => o.id) } } }); // middleware 轉軟刪除
        autoCancelled = stale.map(o => o.orderNo);
        await audit(fastify.prisma, request, 'bulk_upload_auto_cancel', String(batch.id), {
          orderNos: autoCancelled,
        });
      }
    }

    return { ok: true, created, updated, skipped, errors, total: rows.length, batchId: batch.id, autoCancelled, machineKept, doneKept };
  });

  // 客戶名稱補登（管理員）：簡表（工單號＋客戶名稱）一次補齊
  // 只更新 customerName，依工單號配對；計畫日期、規格、生產紀錄一律不碰
  fastify.post('/bulk-fill-customer', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const { rows } = request.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: '沒有資料' });
    }
    if (rows.length > 1000) {
      return reply.code(400).send({ error: '單次上限 1000 筆' });
    }
    let filled = 0, overwritten = 0, unchanged = 0;
    const notFound = [], errors = [];
    for (const row of rows) {
      try {
        const orderNo = String(row.orderNo || '').trim().toUpperCase();
        const customerName = clipStr(stripCustomerCode(row.customerName) || '', 100);
        if (!validOrderNo(orderNo)) { errors.push((row.orderNo || '(空)') + '：工單號格式錯誤'); continue; }
        if (!customerName) { errors.push(orderNo + '：客戶名稱空白'); continue; }
        const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
        if (!order) { notFound.push(orderNo); continue; }
        if (order.customerName === customerName) { unchanged++; continue; }
        await fastify.prisma.order.update({ where: { orderNo }, data: { customerName } });
        if (order.customerName) overwritten++; else filled++;
      } catch (e) {
        errors.push((row.orderNo || '?') + ': ' + e.message);
      }
    }
    await audit(fastify.prisma, request, 'bulk_fill_customer', null,
      `filled=${filled} overwritten=${overwritten} unchanged=${unchanged} notFound=${notFound.length} errors=${errors.length}`);
    return { ok: true, filled, overwritten, unchanged, notFound, errors, total: rows.length };
  });

  // 更正工單號（管理員）：把 from 改成 to，所有生產紀錄保留
  // 工單號散落於 Order / EquipmentParam / UploadRow / UploadBatch.orderNos，需一併更新
  // （StepEntry / PauseEvent 以 orderId 關聯，會自動跟著）
  fastify.post('/rename', async (request, reply) => {
    if (!request.user.isAdmin) {
      return reply.code(403).send({ error: '需要管理員權限' });
    }
    const from = String((request.body || {}).fromOrderNo || '').trim().toUpperCase();
    const to = String((request.body || {}).toOrderNo || '').trim().toUpperCase();
    if (!validOrderNo(from) || !validOrderNo(to)) {
      return reply.code(400).send({ error: '工單號格式錯誤（需 1 個英文字母 + 10 個數字）' });
    }
    if (from === to) return reply.code(400).send({ error: '新舊工單號相同' });

    const src = await fastify.prisma.order.findUnique({ where: { orderNo: from } });
    if (!src) return reply.code(404).send({ error: '找不到原工單 ' + from });

    // 目標工單號不可已存在（含回收桶內的軟刪除工單；deletedAt 鍵繞過軟刪除過濾）
    const dup = await fastify.prisma.order.findFirst({ where: { orderNo: to, deletedAt: undefined } });
    if (dup) {
      return reply.code(409).send({
        error: '目標工單號 ' + to + ' 已存在' + (dup.deletedAt ? '（在回收桶，請先清除）' : '') + '，無法更正',
      });
    }

    // 同步更新冗餘 orderNo 欄位（StepEntry / PauseEvent 走 orderId 不需動）
    await fastify.prisma.$transaction([
      fastify.prisma.order.update({ where: { orderNo: from }, data: { orderNo: to } }),
      fastify.prisma.equipmentParam.updateMany({ where: { orderNo: from }, data: { orderNo: to } }),
      fastify.prisma.uploadRow.updateMany({ where: { orderNo: from }, data: { orderNo: to } }),
    ]);
    // UploadBatch.orderNos 是字串陣列，逐批把 from 換成 to
    const batches = await fastify.prisma.uploadBatch.findMany({ where: { orderNos: { has: from } } });
    for (const b of batches) {
      await fastify.prisma.uploadBatch.update({
        where: { id: b.id },
        data: { orderNos: (b.orderNos || []).map(n => (n === from ? to : n)) },
      });
    }

    await audit(fastify.prisma, request, 'rename_order', from, 'to=' + to);
    return { ok: true, from, to, batchesUpdated: batches.length };
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
            productSpec: null, customerName: null, moldSpec: null,
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
    // 只還原「跟工單一起被刪」（強制刪除）或「最後一次整批清掉」（重設生產紀錄）的子紀錄。
    // 之前個別撤銷的（現場 5 分鐘內取消、管理員刪掉的重複數量）不救回，否則完成數量會多算。
    // 同一批刪除的時間都在幾秒內；以工單刪除時間（工單沒刪則用最後一次刪除時間）為準，前後 10 秒內算同一批
    const [delEntries, delPauses] = await Promise.all([
      fastify.prisma.stepEntry.findMany({ where: { orderId: order.id, deletedAt: { not: null } } }),
      fastify.prisma.pauseEvent.findMany({ where: { orderId: order.id, deletedAt: { not: null } } }),
    ]);
    const lastDel = [...delEntries, ...delPauses].reduce((m, r) => Math.max(m, new Date(r.deletedAt).getTime()), 0);
    const ref = order.deletedAt ? new Date(order.deletedAt).getTime() : lastDel;
    const sameBatch = r => Math.abs(new Date(r.deletedAt).getTime() - ref) <= 10 * 1000;
    const entryIds = delEntries.filter(sameBatch).map(r => r.id);
    const pauseIds = delPauses.filter(sameBatch).map(r => r.id);
    const entryRes = entryIds.length ? await fastify.prisma.stepEntry.updateMany({
      where: { id: { in: entryIds }, deletedAt: { not: null } },
      data: { deletedAt: null },
    }) : { count: 0 };
    const pauseRes = pauseIds.length ? await fastify.prisma.pauseEvent.updateMany({
      where: { id: { in: pauseIds }, deletedAt: { not: null } },
      data: { deletedAt: null },
    }) : { count: 0 };

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
  // 過濾網多機台（@N）：規格配對用「@ 之前的基礎單號」，@1/@2 不參與配對 → 各機台共用同一份規格
  fastify.get('/:orderNo/upload-rows', async (request) => {
    const orderNo = String(request.params.orderNo || '').trim().toUpperCase();
    if (!validOrderNo(orderNo)) return { rows: [] };
    const baseNo = orderNo.split('@')[0];
    // 跨批次「合併」規格：一張工單的規格可能分散在多次上傳
    //   （一單多規格、跨天改版都會這樣；同號不同規格的列會被上傳邏輯標成 skipped，但仍是有效規格）。
    //   只排除 error 與已取消批次；依 productSpec 去重，較新批次的值覆蓋較舊的。
    //   → QC 看得到這張工單「所有」規格，避免像 1890 那筆選不到而漏做／改用備註硬記。
    const allRows = await fastify.prisma.uploadRow.findMany({
      where: {
        orderNo: baseNo,
        status: { not: 'error' },
        batch: { cancelledAt: null },
      },
      orderBy: [{ batchId: 'asc' }, { id: 'asc' }], // 舊→新，讓較新批次覆蓋
    });
    // 依 productSpec 去重：Map.set 會更新值但保留首次出現的排列位置 → 舊規格在前、新規格接續在後
    const bySpec = new Map();
    for (const r of allRows) {
      bySpec.set(specKey(r.productSpec), r);
    }
    const rows = [...bySpec.values()];
    return { rows };
  });

  // 製造參數 → [{ spec, spm, blades }]：多規格陣列（baseSpecRows）優先，舊資料退用單值欄位組一列
  // （與即時頁 rtParseSpecRows 同規則）；SPM、刀數都沒填的列略過
  function parseMfgSpecRows(ep) {
    const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0) ? Number(v) : null;
    let arr = [];
    if (ep.baseSpecRows) { try { arr = JSON.parse(ep.baseSpecRows) || []; } catch (e) { arr = []; } }
    if (!Array.isArray(arr)) arr = [];
    if (arr.length === 0) arr = [{ spec: ep.baseProductSpecAttr, spm: ep.baseMachineSPM, blades: ep.baseBladeCount }];
    return arr
      .map(r => ({ spec: r && r.spec ? String(r.spec) : '', spm: num(r && r.spm), blades: num(r && r.blades) }))
      .filter(r => r.spm != null || r.blades != null);
  }

  // 多規格單的派工總數：Order.dispatchQty 只存第一列規格的量（上傳規則：不同規格的列
  // 不覆寫工單欄位），整張單的派工要用上傳明細加總——同規格取最新批次，仿 upload-rows 去重。
  // 回傳序列化後附上 dispatchQtyTotal 的清單（所有 GET / 分支共用）。
  async function serializeWithDispatchTotals(prisma, orders) {
    const baseNos = [...new Set(orders.map(o => o.orderNo.split('@')[0]))];
    const uploadRows = baseNos.length === 0 ? [] : await prisma.uploadRow.findMany({
      where: { orderNo: { in: baseNos }, status: { not: 'error' }, batch: { cancelledAt: null } },
      orderBy: [{ batchId: 'asc' }, { id: 'asc' }], // 舊→新，讓較新批次覆蓋
      select: { orderNo: true, productSpec: true, dispatchQty: true, bladeCount: true, machineSPM: true },
    });
    const specQtyByOrder = new Map(); // orderNo → Map(productSpec → dispatchQty)
    const specParamsByOrder = new Map(); // orderNo → Map(productSpec → { blades, spm })：多規格單各規格自己的刀數／SPM
    for (const r of uploadRows) {
      const spec = (r.productSpec || '').trim();
      const key = specKey(spec);
      let m = specQtyByOrder.get(r.orderNo);
      if (!m) specQtyByOrder.set(r.orderNo, (m = new Map()));
      m.set(key, r.dispatchQty);
      if (key && (r.bladeCount || r.machineSPM)) {
        let pm = specParamsByOrder.get(r.orderNo);
        if (!pm) specParamsByOrder.set(r.orderNo, (pm = new Map()));
        pm.set(key, { spec, blades: r.bladeCount || null, spm: r.machineSPM || null });
      }
    }
    const dispatchTotals = {};
    const uploadSpecs = {};  // 母單號 → 上傳明細第一列的規格（主檔規格缺漏時前端退用）
    for (const [no, m] of specQtyByOrder) {
      let sum = 0, has = false;
      for (const qv of m.values()) { if (qv != null) { sum += qv; has = true; } }
      if (has) dispatchTotals[no] = sum;
      const firstSpec = [...m.keys()].find(k => k);
      if (firstSpec) uploadSpecs[no] = firstSpec;
    }
    // 現場填的「製造參數」SPM／刀數（多規格各一列）：生管上傳沒填刀數／SPM 時，
    // 目標達成統計的標準工時改用這裡補（兩邊都有填以生管為準，由前端決定）
    const eps = orders.length === 0 ? [] : await prisma.equipmentParam.findMany({
      where: { orderId: { in: orders.map(o => o.id) }, deletedAt: null },
      select: { orderId: true, baseSpecRows: true, baseProductSpecAttr: true, baseMachineSPM: true, baseBladeCount: true },
    });
    const mfgRowsByOrder = new Map();
    for (const ep of eps) {
      const rows = parseMfgSpecRows(ep);
      if (rows.length) mfgRowsByOrder.set(ep.orderId, rows);
    }
    return orders.map(o => {
      const s = serializeOrder(o);
      const base = o.orderNo.split('@')[0];
      const total = dispatchTotals[base];
      if (total != null) s.dispatchQtyTotal = total;
      const mfg = mfgRowsByOrder.get(o.id);
      if (mfg) s.mfgSpecRows = mfg;
      const ups = specParamsByOrder.get(base);
      if (ups) s.uploadSpecRows = [...ups.values()];
      // 主檔規格缺漏時附上上傳明細的規格：bulk-upload 對「規格不一致的列」
      // 會整列跳過（防蓋錯單），副作用是主檔規格可能一直是空的，
      // 看板只讀主檔就會顯示「生產規格尚未上傳」，但規格卡（讀明細）有資料。
      if (!s.productSpec && !s.manuSpec && uploadSpecs[base]) s.uploadProductSpec = uploadSpecs[base];
      return s;
    });
  }

  // 列出近期工單（所有登入者都能看全部）
  fastify.get('/', async (request) => {
    // q=關鍵字：直接查資料庫（工單號/機台/客戶/小組長），不受「最近 200 筆」限制——舊單也找得到
    const q = String(request.query.q || '').trim().slice(0, 50);
    if (q) {
      const orders = await fastify.prisma.order.findMany({
        where: {
          OR: [
            { orderNo: { contains: q.toUpperCase() } },
            { machineNo: { contains: q, mode: 'insensitive' } },
            { customerName: { contains: q } },
            { leader: { displayName: { contains: q } } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: ORDER_INCLUDE,
      });
      return { orders: await serializeWithDispatchTotals(fastify.prisma, orders) };
    }
    // scope=active：給即時生產頁用——未完成的單全部＋36 小時內完成的單。
    // 原本的「最近更新前 200 筆」在總單量成長後，任何其他活動（上傳、別台掃碼）
    // 都會把久未掃碼但仍在生產/暫停中的單擠出清單，造成看板與分頁資料時有時無地跳動。
    if (request.query.scope === 'active') {
      const orders = await fastify.prisma.order.findMany({
        where: {
          OR: [
            { step11At: null },
            { step11At: { gte: new Date(Date.now() - 36 * 3600 * 1000) } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
        include: ORDER_INCLUDE,
      });
      return { orders: await serializeWithDispatchTotals(fastify.prisma, orders) };
    }
    // from/to（台灣日期 YYYY-MM-DD）：統計／紀錄頁依期間查——回傳該期間「有生產紀錄或計畫」的全部工單。
    // 不能用下方「最近更新前 200 筆」：舊月份的單早被新單擠出前 200 筆，回頭看上個月會少算。
    const from = String(request.query.from || ''), to = String(request.query.to || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const DAY = 86400000;
      const lo = Date.parse(from + 'T00:00:00+08:00'), hi = Date.parse(to + 'T23:59:59.999+08:00');
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi && hi - lo <= 400 * DAY) {
        // 前後各放寬一天（計畫日等日期欄存 UTC 午夜）；精確到台灣日期的篩選由前端做
        const range = { gte: new Date(lo - DAY), lte: new Date(hi + DAY) };
        const orders = await fastify.prisma.order.findMany({
          where: {
            OR: [
              { plannedDate: range },
              { productionDate: range },
              { actualStartDate: range },
              { step11At: range },
              { stepEntries: { some: { deletedAt: null, recordedAt: range } } },
              { pauseEvents: { some: { deletedAt: null, OR: [{ startAt: range }, { endAt: range }] } } },
              // 期間前開工、期間後才完工（或還沒完工）：期間內可能沒有任何紀錄，但前端算它「當天在線上」
              { AND: [{ actualStartDate: { lt: range.gte } }, { OR: [{ step11At: null }, { step11At: { gt: range.lte } }] }] },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 3000,
          include: ORDER_INCLUDE,
        });
        return { orders: await serializeWithDispatchTotals(fastify.prisma, orders) };
      }
    }
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const orders = await fastify.prisma.order.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: ORDER_INCLUDE,
    });
    return { orders: await serializeWithDispatchTotals(fastify.prisma, orders) };
  });
}
