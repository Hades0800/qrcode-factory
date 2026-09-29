// 出貨管理系統(關聯圖右上):出貨單上傳(業務助理)、庫存 QR / 零購 QR 加入出貨單、
// 倉管人員出庫 QR 與 QR 檢核;出貨即從庫存扣帳。
import shipmentRoutes from './routes/shipments.js';

export const meta = { key: 'shipping', name: '出貨管理系統', description: '出貨單、庫存 QR / 零購 QR、出庫 QR 檢核' };

export default async function shippingModule(fastify) {
  await fastify.register(shipmentRoutes, { prefix: '/api/shipping' });
}
