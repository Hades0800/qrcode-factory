// 原料管理系統(入出庫管理系統,關聯圖中心):標籤由它統一管理,其他三個系統都引用同一張標籤。
// 對照關聯表:QR Code 標籤(業務助理)、入庫 QR / 出庫 QR(倉管人員),四個階段都一樣:
// 原料、生產-半成品、生產/庫存-成品、委外/加工/包裝/整修。
import labelRoutes from './routes/labels.js';
import inventoryRoutes from './routes/inventory.js';

export const meta = { key: 'inventory', name: '原料管理系統(入出庫)', description: 'QR 標籤、儲位、入庫與出庫紀錄、庫存' };

export default async function inventoryModule(fastify) {
  await fastify.register(labelRoutes, { prefix: '/api/labels' });
  await fastify.register(inventoryRoutes, { prefix: '/api/inventory' });
}
