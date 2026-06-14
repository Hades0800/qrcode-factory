// 客戶名稱一次性補登：data/customer-backfill.json（工單號→客戶名稱）
// 只補「還沒有客戶名稱」的工單，不覆蓋生管上傳的資料；可重複執行（冪等）
export async function backfillCustomerNames(fastify) {
  const fs = await import('fs');
  const path = await import('path');
  const file = path.join(process.cwd(), 'data', 'customer-backfill.json');
  if (!fs.existsSync(file)) return;
  let map;
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
  const entries = Object.entries(map).filter(([k, v]) => /^[A-Z]\d{10}$/.test(k) && v);
  if (!entries.length) return;
  let filled = 0;
  for (const [orderNo, name] of entries) {
    const n = await fastify.prisma.order.updateMany({
      where: { orderNo, OR: [{ customerName: null }, { customerName: '' }] },
      data: { customerName: String(name).slice(0, 100) },
    });
    filled += n.count;
  }
  if (filled > 0) console.log(`✓ 客戶名稱補登：本次補上 ${filled} 張工單`);
}
