// 模組登錄表:依「簡易關聯圖」切成四個系統 + 一個共用層。
// 每個模組是一個 fastify plugin(index.js),自己註冊路徑;server.js 只負責依序掛上。
// 新增系統就是加一個資料夾、在這裡登錄一行。
import coreModule, { meta as coreMeta } from './core/index.js';
import inventoryModule, { meta as inventoryMeta } from './inventory/index.js';
import productionModule, { meta as productionMeta } from './production/index.js';
import cuttingModule, { meta as cuttingMeta } from './cutting/index.js';
import shippingModule, { meta as shippingMeta } from './shipping/index.js';

export const MODULES = [
  { ...coreMeta, plugin: coreModule },
  { ...inventoryMeta, plugin: inventoryModule },
  { ...productionMeta, plugin: productionModule },
  { ...cuttingMeta, plugin: cuttingModule },
  { ...shippingMeta, plugin: shippingModule },
];

export async function registerModules(fastify) {
  for (const m of MODULES) {
    await fastify.register(m.plugin);
  }
  // 前端導覽用:有哪些系統
  fastify.get('/api/modules', async () => ({
    modules: MODULES.filter(m => m.key !== 'core').map(({ key, name, description }) => ({ key, name, description })),
  }));
}
