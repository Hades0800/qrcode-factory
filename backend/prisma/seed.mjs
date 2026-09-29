// 測試資料庫種子資料。
// 執行：npm run seed:test（會先確認連的是測試庫，不會誤灌到正式庫）
//
// 內容刻意用真實樣本，不用假資料——這樣一開畫面就看得到實際單據長什麼樣：
//   帳號：五種角色各一個 + admin
//   儲位：原料區 / 半成品區 / 成品區
//   加工單：由 tests/fixtures 的四份 QRP 解析後建立，含同工令的兩張道次單
//   標籤：每張加工單的領用材料各一張原料標籤，並做一筆入庫異動
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseQrp } from '../src/lib/qrp.js';
import { buildQrText, makeLabelCode } from '../src/modules/inventory/domain/label.js';

const prisma = new PrismaClient();
const fixture = n => fileURLToPath(new URL(`../tests/fixtures/${n}`, import.meta.url));

// ── 安全閘：只准灌測試庫 ────────────────────────────────────────────────────
const url = process.env.DATABASE_URL || '';
if (!/test/i.test(url)) {
  console.error('✗ DATABASE_URL 看起來不是測試庫：', url.replace(/:[^:@]*@/, ':***@'));
  console.error('  種子資料只灌名稱含 test 的資料庫。要跑請用：npm run seed:test');
  process.exit(1);
}

const USERS = [
  { username: 'admin', displayName: '管理員', isAdmin: true, roles: 'sales,warehouse,planner,production,processing' },
  { username: 'sales1', displayName: '簡玉惠（業務助理）', roles: 'sales' },
  { username: 'planner1', displayName: '張季淳（生管）', roles: 'planner', isPlanner: true },
  { username: 'prod1', displayName: '生產人員 A', roles: 'production' },
  { username: 'proc1', displayName: '加工人員 A', roles: 'processing' },
  { username: 'wh1', displayName: '倉管人員 A', roles: 'warehouse' },
];

const LOCATIONS = [
  { code: 'A-01', name: '原料區 A 排', zone: '原料' },
  { code: 'A-02', name: '原料區 B 排', zone: '原料' },
  { code: 'B-01', name: '半成品區', zone: '半成品' },
  { code: 'C-01', name: '成品區', zone: '成品' },
  { code: 'D-01', name: '待出貨區', zone: '成品' },
];

// 四份樣本：同工令的兩張道次單放前面，方便一開畫面就看到關聯
const FIXTURES = [
  'workorder-pair-g1.qrp',        // G1150911001  工令 E1150911001  4' → 635
  'workorder-pair-g2.qrp',        // G1150911002  工令 E1150911001  635 → 142
  'process-order-sample.qrp',     // G1150929002  工令 E1150929002  鋁捲 → 鋁板
  'manufacture-order-sample.qrp', // F1150924004  製造單（只建標籤，不建加工單）
];

async function main() {
  console.log('→ 資料庫：', url.replace(/:[^:@]*@/, ':***@'));

  // 帳號（密碼一律 test1234，僅測試庫）
  const passwordHash = await bcrypt.hash('test1234', 10);
  for (const u of USERS) {
    await prisma.leader.upsert({
      where: { username: u.username },
      update: { displayName: u.displayName, roles: u.roles, isAdmin: !!u.isAdmin, isPlanner: !!u.isPlanner },
      create: { ...u, passwordHash, isAdmin: !!u.isAdmin, isPlanner: !!u.isPlanner },
    });
  }
  console.log(`✓ 帳號 ${USERS.length} 個（密碼都是 test1234）`);

  for (const l of LOCATIONS) {
    await prisma.location.upsert({ where: { code: l.code }, update: l, create: l });
  }
  console.log(`✓ 儲位 ${LOCATIONS.length} 個`);

  const sales = await prisma.leader.findUnique({ where: { username: 'sales1' } });
  const wh = await prisma.leader.findUnique({ where: { username: 'wh1' } });

  let orders = 0, labels = 0, moves = 0, skipped = 0;
  for (const f of FIXTURES) {
    const path = fixture(f);
    if (!existsSync(path)) { console.warn(`  · 找不到樣本 ${f}，略過`); skipped++; continue; }
    const r = parseQrp(readFileSync(path));
    if (!r.fields?.docNo) { console.warn(`  · ${f} 解析不出單號，略過`); skipped++; continue; }

    const { docNo, workOrderNo, customer, plannedDate, dueDate } = r.fields;

    // 領用材料 → 原料標籤 + 入庫異動
    let label = null;
    if (r.materials.length) {
      const specs = r.materials.map((m, i) => ({
        seq: i + 1,
        spec: String(m.spec ?? m.orderSpec ?? '').split('\n')[0],
        qty: m.qty ?? null,
        weight: m.total ?? null,
      }));
      const fields = {
        customer, poNo: r.fields.poNo,
        manuOrderNo: r.docType === 'manufacture' ? docNo : null,
        processOrderNo: r.docType === 'process' ? docNo : null,
        location: 'A-01', machineNo: null, dueDate, remark: workOrderNo ? `工令 ${workOrderNo}` : null,
        specs,
      };
      label = await prisma.label.create({
        data: {
          code: makeLabelCode(), kind: 'material',
          customer: fields.customer, poNo: fields.poNo,
          manuOrderNo: fields.manuOrderNo, processOrderNo: fields.processOrderNo,
          location: fields.location, dueDate: fields.dueDate, remark: fields.remark,
          qrText: buildQrText(fields),
          createdBy: sales?.id ?? null, createdByName: sales?.displayName ?? null,
          specs: { create: specs },
        },
      });
      labels++;
      await prisma.stockMove.create({
        data: {
          labelId: label.id, type: 'in', stage: 'material', location: 'A-01',
          qty: specs[0].qty ?? null, weight: specs[0].weight ?? null,
          refType: 'manual', refNo: docNo, note: '種子資料：原料入庫',
          actorId: wh?.id ?? null, actorName: wh?.displayName ?? null,
        },
      });
      moves++;
    }

    // 加工單（製造單先不建，等生產模組的匯入做好）
    if (r.docType !== 'process') continue;
    const spec = r.items.map(i => (i.qty == null ? i.spec : `${i.spec} , ${i.qty}`)).join('\n') || null;
    await prisma.processOrder.upsert({
      where: { processNo: docNo },
      update: {},
      create: {
        processNo: docNo,
        manuOrderNo: workOrderNo,        // 工令 E：同工令的加工單靠它成組
        labelId: label?.id ?? null,
        customer,
        spec,
        qty: r.items.reduce((s, i) => s + (i.qty || 0), 0) || null,
        plannedDate, dueDate,
        remark: r.notes.join('；').slice(0, 120) || null,
        createdBy: sales?.id ?? null, createdByName: sales?.displayName ?? null,
      },
    });
    orders++;
  }
  console.log(`✓ 加工單 ${orders} 張、標籤 ${labels} 張、入庫異動 ${moves} 筆${skipped ? `（略過 ${skipped} 份樣本）` : ''}`);

  const byWorkOrder = await prisma.processOrder.groupBy({ by: ['manuOrderNo'], _count: true });
  for (const g of byWorkOrder) {
    if (g._count > 1) console.log(`  · 工令 ${g.manuOrderNo} 底下有 ${g._count} 張加工單（道次）`);
  }
}

main()
  .then(() => console.log('\n完成。登入：admin / test1234'))
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
