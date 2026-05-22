// 設備參數：一張工單對應一筆設定（一般人員上傳）
//  - POST /:orderNo  → upsert
//  - GET  /:orderNo  → 讀取（沒有就回 null）
//  - 寫入前驗證：工單必須存在且為「今日有活動」的工單

const ORDER_NO_RE = /^[A-Z]\d{10}$/;
function validOrderNo(s) { return typeof s === 'string' && ORDER_NO_RE.test(s); }
function clipStr(s, max) { return s == null ? null : String(s).slice(0, max); }
function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1e9, Math.round(n))) : null;
}
function floatOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1e9, n)) : null;
}

// 工單是否「今日有實際活動」
async function isTodayActive(prisma, orderId) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const stepCount = await prisma.stepEntry.count({
    where: { orderId, recordedAt: { gte: dayStart, lt: dayEnd } },
  });
  if (stepCount > 0) return true;
  const pauseCount = await prisma.pauseEvent.count({
    where: { orderId, startAt: { gte: dayStart, lt: dayEnd } },
  });
  if (pauseCount > 0) return true;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (order && order.step11At && order.step11At >= dayStart && order.step11At < dayEnd) return true;
  return false;
}

export default async function equipmentParamRoutes(fastify) {
  // 確保表存在（idempotent ALTER）
  fastify.addHook('onReady', async () => {
    try {
      await fastify.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "EquipmentParam" (
          "id" SERIAL PRIMARY KEY,
          "orderId" INTEGER NOT NULL UNIQUE,
          "orderNo" TEXT NOT NULL,
          "operation" TEXT,
          "totalWorkers" INTEGER,
          "paramFileName" TEXT,
          "paramFileAttr" TEXT,
          "productSpecAttr" TEXT,
          "moldSpec" TEXT,
          "machineSPM" DOUBLE PRECISION,
          "bladeCount" INTEGER,
          "feedSetting" TEXT,
          "cutterStroke" TEXT,
          "strokeUpdateFreq" TEXT,
          "createdBy" INTEGER,
          "createdByName" TEXT,
          "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "deletedAt" TIMESTAMP,
          FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
        )
      `);
      // 補上基礎參數欄位（後加的，使用 ALTER 保證舊環境有）
      await fastify.prisma.$executeRawUnsafe(`
        ALTER TABLE "EquipmentParam"
          ADD COLUMN IF NOT EXISTS "baseParamFileName" TEXT,
          ADD COLUMN IF NOT EXISTS "baseParamFileAttr" TEXT,
          ADD COLUMN IF NOT EXISTS "baseMoldSpec" TEXT,
          ADD COLUMN IF NOT EXISTS "baseMachineSPM" DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS "baseBladeCount" INTEGER,
          ADD COLUMN IF NOT EXISTS "baseFeedSetting" TEXT,
          ADD COLUMN IF NOT EXISTS "baseCutterStroke" TEXT,
          ADD COLUMN IF NOT EXISTS "baseStrokeUpdateFreq" TEXT
      `);
      await fastify.prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "EquipmentParam_orderNo_idx" ON "EquipmentParam"("orderNo")'
      );
      await fastify.prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "EquipmentParam_deletedAt_idx" ON "EquipmentParam"("deletedAt")'
      );
    } catch (e) {
      fastify.log.error(e, 'EquipmentParam table init failed');
    }
  });

  // GET 設備參數
  fastify.get('/:orderNo', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '找不到工單' });
    const rows = await fastify.prisma.$queryRaw`
      SELECT * FROM "EquipmentParam" WHERE "orderId" = ${order.id} AND "deletedAt" IS NULL LIMIT 1
    `;
    return { equipmentParam: rows[0] || null };
  });

  // POST 設備參數（upsert）
  fastify.post('/:orderNo', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const orderNo = String(request.params.orderNo || '').toUpperCase();
    if (!validOrderNo(orderNo)) return reply.code(400).send({ error: '工單號格式錯誤' });
    const order = await fastify.prisma.order.findUnique({ where: { orderNo } });
    if (!order) return reply.code(404).send({ error: '工單不存在，無法上傳設備參數' });

    // 驗證：必須是今日有活動的工單（admin 不受限）
    if (!request.user.isAdmin) {
      const ok = await isTodayActive(fastify.prisma, order.id);
      if (!ok) return reply.code(400).send({ error: '此工單號今日無生產活動，無法上傳設備參數' });
    }

    const b = request.body || {};
    const data = {
      // 參數值
      operation:        clipStr(b.operation, 200),
      totalWorkers:     intOrNull(b.totalWorkers),
      paramFileName:    clipStr(b.paramFileName, 200),
      paramFileAttr:    clipStr(b.paramFileAttr, 200),
      productSpecAttr:  clipStr(b.productSpecAttr, 200),
      moldSpec:         clipStr(b.moldSpec, 200),
      machineSPM:       floatOrNull(b.machineSPM),
      bladeCount:       intOrNull(b.bladeCount),
      feedSetting:      clipStr(b.feedSetting, 200),
      cutterStroke:     clipStr(b.cutterStroke, 200),
      strokeUpdateFreq: clipStr(b.strokeUpdateFreq, 200),
      // 基礎參數
      baseParamFileName:    clipStr(b.baseParamFileName, 200),
      baseParamFileAttr:    clipStr(b.baseParamFileAttr, 200),
      baseMoldSpec:         clipStr(b.baseMoldSpec, 200),
      baseMachineSPM:       floatOrNull(b.baseMachineSPM),
      baseBladeCount:       intOrNull(b.baseBladeCount),
      baseFeedSetting:      clipStr(b.baseFeedSetting, 200),
      baseCutterStroke:     clipStr(b.baseCutterStroke, 200),
      baseStrokeUpdateFreq: clipStr(b.baseStrokeUpdateFreq, 200),
    };

    // upsert with raw SQL（避免 Prisma client 沒 regenerate 時拋錯）
    await fastify.prisma.$executeRaw`
      INSERT INTO "EquipmentParam" (
        "orderId", "orderNo", "operation", "totalWorkers", "paramFileName",
        "paramFileAttr", "productSpecAttr", "moldSpec", "machineSPM", "bladeCount",
        "feedSetting", "cutterStroke", "strokeUpdateFreq",
        "baseParamFileName", "baseParamFileAttr", "baseMoldSpec", "baseMachineSPM", "baseBladeCount",
        "baseFeedSetting", "baseCutterStroke", "baseStrokeUpdateFreq",
        "createdBy", "createdByName", "createdAt", "updatedAt"
      ) VALUES (
        ${order.id}, ${orderNo}, ${data.operation}, ${data.totalWorkers}, ${data.paramFileName},
        ${data.paramFileAttr}, ${data.productSpecAttr}, ${data.moldSpec}, ${data.machineSPM}, ${data.bladeCount},
        ${data.feedSetting}, ${data.cutterStroke}, ${data.strokeUpdateFreq},
        ${data.baseParamFileName}, ${data.baseParamFileAttr}, ${data.baseMoldSpec}, ${data.baseMachineSPM}, ${data.baseBladeCount},
        ${data.baseFeedSetting}, ${data.baseCutterStroke}, ${data.baseStrokeUpdateFreq},
        ${request.user.id}, ${request.user.displayName || null}, NOW(), NOW()
      )
      ON CONFLICT ("orderId") DO UPDATE SET
        "operation" = EXCLUDED."operation",
        "totalWorkers" = EXCLUDED."totalWorkers",
        "paramFileName" = EXCLUDED."paramFileName",
        "paramFileAttr" = EXCLUDED."paramFileAttr",
        "productSpecAttr" = EXCLUDED."productSpecAttr",
        "moldSpec" = EXCLUDED."moldSpec",
        "machineSPM" = EXCLUDED."machineSPM",
        "bladeCount" = EXCLUDED."bladeCount",
        "feedSetting" = EXCLUDED."feedSetting",
        "cutterStroke" = EXCLUDED."cutterStroke",
        "strokeUpdateFreq" = EXCLUDED."strokeUpdateFreq",
        "baseParamFileName" = EXCLUDED."baseParamFileName",
        "baseParamFileAttr" = EXCLUDED."baseParamFileAttr",
        "baseMoldSpec" = EXCLUDED."baseMoldSpec",
        "baseMachineSPM" = EXCLUDED."baseMachineSPM",
        "baseBladeCount" = EXCLUDED."baseBladeCount",
        "baseFeedSetting" = EXCLUDED."baseFeedSetting",
        "baseCutterStroke" = EXCLUDED."baseCutterStroke",
        "baseStrokeUpdateFreq" = EXCLUDED."baseStrokeUpdateFreq",
        "updatedAt" = NOW(),
        "deletedAt" = NULL
    `;
    const rows = await fastify.prisma.$queryRaw`
      SELECT * FROM "EquipmentParam" WHERE "orderId" = ${order.id} AND "deletedAt" IS NULL LIMIT 1
    `;
    return { ok: true, equipmentParam: rows[0] };
  });
}
