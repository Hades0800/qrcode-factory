import Fastify from 'fastify';

import { prisma } from './plugins/prisma.js';
import { registerSecurity } from './plugins/security.js';
import { registerAuth } from './plugins/auth.js';
import { registerPermissions } from './plugins/permissions.js';

import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import equipmentParamRoutes from './routes/equipmentParams.js';
import maintenanceRoutes from './routes/maintenance.js';
import idleEventRoutes from './routes/idleEvents.js';
import v2Routes from './routes/v2.js';
import v2AuthRoutes from './routes/v2/auth.js';

import { runDbPush } from './startup/runDbPush.js';
import { ensureRolesColumn } from './startup/ensureRolesColumn.js';
import { ensureAdmin } from './startup/ensureAdmin.js';
import { backfillCustomerNames } from './startup/backfillCustomerNames.js';

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024, // 2MB 限制避免 DoS
  trustProxy: true,
});

// 全域注入 prisma（含軟刪除中間件，見 plugins/prisma.js）
fastify.decorate('prisma', prisma);

// 外掛：壓縮 / 安全 headers / CORS / 速率限制
await registerSecurity(fastify);
// JWT + authenticate 裝飾器（須在路由註冊前）
await registerAuth(fastify);
// 角色／權限：requireAdmin、requirePermission、resolvePermissions… （須在路由註冊前）
await registerPermissions(fastify);

// 路由
await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(orderRoutes, { prefix: '/api/orders' });
await fastify.register(adminRoutes, { prefix: '/api/admin' });
await fastify.register(equipmentParamRoutes, { prefix: '/api/equipment-params' });
await fastify.register(maintenanceRoutes); // /、/health、/diag、/api/fix-dates
await fastify.register(idleEventRoutes);   // /api/idle-events
// v2 API：給新 React 前端用，目前多為 stub（501），不影響 v1
await fastify.register(v2AuthRoutes, { prefix: '/v2' });
await fastify.register(v2Routes, { prefix: '/v2' });

const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

// 啟動時自動同步資料表
runDbPush();

// 舊資料遷移：isAdmin/isPlanner → Leader.roles（冪等；須在 ensureAdmin 之前跑）
try {
  await ensureRolesColumn();
} catch (err) {
  console.error('⚠️ roles 遷移失敗（不影響啟動）：', err.message);
}

// 建立權限目錄與角色，並載入記憶體快取（冪等；不覆蓋後台已調整過的設定）
try {
  await fastify.seedRolesAndPermissions();
  await fastify.reloadRolePerms();
} catch (err) {
  console.error('⚠️ 權限 seed/載入失敗（不影響啟動）：', err.message);
}

// 不讓 ensureAdmin 失敗導致 server 不啟動 — 改成警告，server 仍要啟動方便除錯
try {
  await ensureAdmin(fastify);
} catch (err) {
  console.error('⚠️ ensureAdmin 失敗，但 server 仍會啟動，可訪問 /diag 看狀態：');
  console.error(err);
}

// 客戶名稱一次性補登（冪等；無檔案則略過）
try {
  await backfillCustomerNames(fastify);
} catch (err) {
  console.error('⚠️ 客戶名稱補登失敗（不影響啟動）：', err.message);
}

try {
  await fastify.listen({ port, host });
  console.log(`✓ Listening on ${host}:${port}`);
  console.log(`✓ 測試: GET https://你的網址/diag 可看 DB 連線狀態`);
} catch (err) {
  console.error('❌ 無法啟動 server:');
  console.error(err);
  process.exit(1);
}
