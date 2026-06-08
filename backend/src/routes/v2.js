// ─── v2 API（給新 React 前端用）─────────────────────────
// 全部端點先 stub 著（回 501 Not Implemented），URL 結構排好就行
// 註：auth 群組扁平化（/v2/login 而不是 /v2/auth/login）；其餘維持原本的 namespace
//
// 內部實作要做時：把 stub() 換成真正的 handler，邏輯參考對應的 v1 路由檔
//   /v2/login            ← backend/src/routes/auth.js  POST /login
//   /v2/orders/...       ← backend/src/routes/orders.js
//   /v2/admin/...        ← backend/src/routes/admin.js
//   /v2/equipment-params ← backend/src/routes/equipmentParams.js
//   /v2/idle-events      ← server.js 內聯
//   /v2/diag, /v2/fix-dates, /v2/health ← server.js 內聯

const stub = (endpoint, hint) => async (request, reply) => {
  return reply.code(501).send({
    ok: false,
    error: 'Not Implemented (v2 stub)',
    endpoint,
    hint: hint || null,
  });
};

export default async function v2Routes(fastify) {
  // ── 健康 / 診斷 ─────────────────────────────
  fastify.get('/',       stub('GET /v2/',       '系統存活檢查（對應 v1 GET /）'));
  fastify.get('/health', stub('GET /v2/health', '存活檢查（對應 v1 GET /health）'));
  fastify.get('/diag',   stub('GET /v2/diag',   '診斷頁面（admin_tools；對應 v1 GET /diag）'));

  // ── Auth ─────────────────────────────────────
  // 已實作於 backend/src/routes/v2/auth.js（使用 Account 表）
  // 端點：POST /v2/login、GET /v2/me、POST /v2/change-password、POST /v2/logout

  // ── Orders ───────────────────────────────────
  // 靜態路徑必須在 /:orderNo 之前定義，避免被路由吃掉

  // 上傳批次
  fastify.get('/orders/upload-batches',              stub('GET /v2/orders/upload-batches',              '上傳批次列表'));
  fastify.delete('/orders/upload-batches/:id',       stub('DELETE /v2/orders/upload-batches/:id',       '取消上傳批次（upload 權限）'));
  fastify.post('/orders/upload-batches/:id/restore', stub('POST /v2/orders/upload-batches/:id/restore', '救回已取消批次（admin_tools）'));

  // 批次上傳 / 取消
  fastify.post('/orders/bulk-upload',        stub('POST /v2/orders/bulk-upload',        '從 Excel 上傳整批工單（upload）'));
  fastify.post('/orders/bulk-cancel-upload', stub('POST /v2/orders/bulk-cancel-upload', '批次取消上傳（upload）'));

  // 回收桶
  fastify.get('/orders/trash', stub('GET /v2/orders/trash', '已軟刪除工單列表（admin_tools）'));

  // 列表
  fastify.get('/orders', stub('GET /v2/orders', '近期工單（?limit）'));

  // 單張工單
  fastify.get('/orders/:orderNo',                   stub('GET /v2/orders/:orderNo',                   '取工單（不存在自動建立；軟刪除時 409）'));
  fastify.delete('/orders/:orderNo',                stub('DELETE /v2/orders/:orderNo',                '刪工單（delete_order；?force 強刪要 admin_tools）'));
  fastify.get('/orders/:orderNo/upload-rows',       stub('GET /v2/orders/:orderNo/upload-rows',       '取該工單最新批次的上傳原始列'));
  fastify.post('/orders/:orderNo/restore',          stub('POST /v2/orders/:orderNo/restore',          '還原（admin_tools）'));
  fastify.post('/orders/:orderNo/purge',            stub('POST /v2/orders/:orderNo/purge',            '永久刪除（admin_tools）'));
  fastify.post('/orders/:orderNo/reset-production', stub('POST /v2/orders/:orderNo/reset-production', '清掉所有生產紀錄（admin_tools）'));

  // 工單屬性設定
  fastify.post('/orders/:orderNo/machine',         stub('POST /v2/orders/:orderNo/machine',         '設機台號'));
  fastify.post('/orders/:orderNo/spec-type',       stub('POST /v2/orders/:orderNo/spec-type',       '設規格類型（new/mass + aspects）'));
  fastify.post('/orders/:orderNo/change-scope',    stub('POST /v2/orders/:orderNo/change-scope',    '設更換範圍（@ / # / @# / same / null）'));
  fastify.post('/orders/:orderNo/material-type',   stub('POST /v2/orders/:orderNo/material-type',   '設原料類型（coil / plate）'));
  fastify.post('/orders/:orderNo/aux-equipment',   stub('POST /v2/orders/:orderNo/aux-equipment',   '設輔助設備（多選 + 編號 + 自訂名稱）'));
  fastify.post('/orders/:orderNo/operation-info',  stub('POST /v2/orders/:orderNo/operation-info',  '設操作人員 / 全部作業人數'));

  // 工序紀錄（日誌式）
  fastify.post('/orders/:orderNo/step-entries',       stub('POST /v2/orders/:orderNo/step-entries',       '記工序（含 30 更換規格；帶 recordedAt = 補登需 modify_records）'));
  fastify.delete('/orders/:orderNo/step-entries/:id', stub('DELETE /v2/orders/:orderNo/step-entries/:id', '取消工序紀錄（modify_records；超過 5 分鐘需 admin_tools）'));

  // 單欄式工序（stepXAt）
  fastify.post('/orders/:orderNo/steps/:step',   stub('POST /v2/orders/:orderNo/steps/:step',   '記某步驟（11 完成需 QC 數量；帶 recordedAt 為補登）'));
  fastify.delete('/orders/:orderNo/steps/:step', stub('DELETE /v2/orders/:orderNo/steps/:step', '取消某步驟（modify_records）'));

  // 暫停 / 異常
  fastify.post('/orders/:orderNo/pause',          stub('POST /v2/orders/:orderNo/pause',          '開始暫停（type=12 含「下班」需 QC 數量；type=13 異常）'));
  fastify.post('/orders/:orderNo/resume',         stub('POST /v2/orders/:orderNo/resume',         '恢復暫停'));
  fastify.post('/orders/:orderNo/pause-backfill', stub('POST /v2/orders/:orderNo/pause-backfill', '補登已結束的暫停（modify_records）'));

  // ── Equipment Params ────────────────────────
  fastify.get('/equipment-params/:orderNo',  stub('GET /v2/equipment-params/:orderNo',  '取設備參數（含製造/原始兩欄 + 多規格陣列）'));
  fastify.post('/equipment-params/:orderNo', stub('POST /v2/equipment-params/:orderNo', '上傳/更新設備參數（含 specRows / baseSpecRows）'));

  // ── Idle Events ─────────────────────────────
  fastify.get('/idle-events',        stub('GET /v2/idle-events',        '無工令事件列表'));
  fastify.post('/idle-events',       stub('POST /v2/idle-events',       '建無工令事件（rate-limit 10/min）'));
  fastify.delete('/idle-events/:id', stub('DELETE /v2/idle-events/:id', '取消無工令（admin_tools 或建立者本人）'));

  // ── Admin（帳號 + 角色權限 + 回收 / 稽核 / 修補）─
  fastify.get('/admin/leaders',                       stub('GET /v2/admin/leaders',                       '列出所有帳號（manage_accounts）'));
  fastify.post('/admin/leaders',                      stub('POST /v2/admin/leaders',                      '新增帳號（manage_accounts）'));
  fastify.delete('/admin/leaders/:id',                stub('DELETE /v2/admin/leaders/:id',                '刪帳號（manage_accounts）'));
  fastify.post('/admin/leaders/:id/roles',            stub('POST /v2/admin/leaders/:id/roles',            '改帳號角色'));
  fastify.post('/admin/leaders/:id/reset-password',   stub('POST /v2/admin/leaders/:id/reset-password',   '幫使用者重設密碼'));

  fastify.get('/admin/roles-permissions',             stub('GET /v2/admin/roles-permissions',             '取角色 + 權限矩陣（manage_accounts）'));
  fastify.put('/admin/roles/:key/permissions',        stub('PUT /v2/admin/roles/:key/permissions',        '改某角色的權限（admin 不可改）'));

  fastify.get('/admin/find-orderno',                  stub('GET /v2/admin/find-orderno',                  '?q= 模糊查工單號完整歷史'));
  fastify.get('/admin/orders-with-soft-deleted-records', stub('GET /v2/admin/orders-with-soft-deleted-records', '有軟刪子紀錄的工單'));
  fastify.get('/admin/cancelled-upload-batches',      stub('GET /v2/admin/cancelled-upload-batches',      '已取消的上傳批次'));
  fastify.get('/admin/audit-log',                     stub('GET /v2/admin/audit-log',                     '?days= ?action= 稽核日誌'));

  fastify.post('/admin/migrate-dates',                stub('POST /v2/admin/migrate-dates',                '一次性 migration（admin_tools）'));
  fastify.post('/admin/fix-production-dates',         stub('POST /v2/admin/fix-production-dates',         '修正 productionDate（admin_tools）'));

  // ── 其他 server.js 內聯 ──────────────────────
  fastify.post('/fix-dates', stub('POST /v2/fix-dates', '修正工單日期（admin_tools；對應 v1 POST /api/fix-dates）'));
}
