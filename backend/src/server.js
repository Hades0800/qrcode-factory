import Fastify from 'fastify';

import { prisma } from './plugins/prisma.js';
import { registerSecurity } from './plugins/security.js';
import { registerAuth } from './plugins/auth.js';

import { registerModules } from './modules/index.js';

import { runDbPush } from './startup/runDbPush.js';
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
// JWT + authenticate / requireAdmin 裝飾器（須在路由註冊前）
await registerAuth(fastify);

// 路由:依「簡易關聯圖」切成四個系統模組(見 src/modules/index.js),各模組自己掛路徑
await registerModules(fastify);

const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';

// 啟動時自動同步資料表
runDbPush();

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
