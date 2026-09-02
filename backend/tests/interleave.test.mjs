// 自動插單（interleave）測試：A 做一半、直接掃 B → A 自動插單暫停；回頭掃 A → 自動恢復
// 走 Fastify inject + 自建 mock prisma（獨立於 routes.test.mjs 的 mock，多支援 findFirst/update）

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import orderRoutes from '../src/routes/orders.js';
import { INTERLEAVE_NOTE } from '../src/domain/orders/helpers.js';

// ────────────────────────────────────────────────────
// Mock prisma
// ────────────────────────────────────────────────────
function makeMockPrisma() {
  const state = {
    orders: [],       // row[]
    stepEntries: [],  // row[]
    pauseEvents: [],  // row[]
    _nextId: 1,
  };

  const matches = (row, where) => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v !== null && typeof v === 'object') {
        if ('not' in v) { if ((row[k] ?? null) === v.not) return false; continue; }
        if ('in' in v) { if (!v.in.includes(row[k])) return false; continue; }
        continue; // 其他複雜條件不支援
      }
      if ((row[k] ?? null) !== v) return false;
    }
    return true;
  };

  const model = (rows) => ({
    findUnique: async ({ where }) => rows.find(r => matches(r, where)) || null,
    findFirst: async ({ where }) => rows.find(r => matches(r, where)) || null,
    findMany: async ({ where } = {}) => rows.filter(r => matches(r, where)),
    count: async ({ where } = {}) => rows.filter(r => matches(r, where)).length,
    create: async ({ data }) => {
      const row = { id: state._nextId++, deletedAt: null, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = rows.find(r => matches(r, where));
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      return row;
    },
  });

  const prisma = {
    order: model(state.orders),
    stepEntry: model(state.stepEntries),
    pauseEvent: model(state.pauseEvents),
    equipmentParam: { findUnique: async () => null },
    auditLog: { create: async ({ data }) => data },
  };
  return { prisma, state };
}

const USER = { id: 1, username: 'leader1', displayName: '小組長', isAdmin: false, isPlanner: false };

async function buildApp() {
  const fastify = Fastify({ logger: false });
  const { prisma, state } = makeMockPrisma();
  fastify.decorate('prisma', prisma);
  fastify.decorate('authenticate', async (request) => { request.user = USER; });
  fastify.decorate('requireAdmin', async () => {});
  await fastify.register(orderRoutes, { prefix: '/api/orders' });
  await fastify.ready();
  return { fastify, prisma, state };
}

// 建一張「已開始生產、未完成」的工單（machineNo 用非 No1-350 等避免製造參數防呆）
async function seedOrder(prisma, orderNo, machineNo, { started = true, done = false } = {}) {
  const order = await prisma.order.create({
    data: {
      orderNo, machineNo,
      step11At: done ? new Date('2026-08-30T02:00:00Z') : null,
      actualStartDate: started ? new Date('2026-08-30T00:00:00Z') : null,
    },
  });
  if (started) {
    await prisma.stepEntry.create({
      data: { orderId: order.id, stepNo: '41', seq: 1, recordedAt: new Date('2026-08-30T00:30:00Z') },
    });
  }
  return order;
}

const activePausesOf = (state, orderId) =>
  state.pauseEvents.filter(p => p.orderId === orderId && !p.endAt);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('✓', name); pass++; }
  catch (e) { console.error('✗', name, '\n    ', e.message); fail++; }
}

// ────────────────────────────────────────────────────
// 測試案例
// ────────────────────────────────────────────────────

await test('掃 B 的生產工序 → 同機台運轉中的 A 自動插單暫停', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12');
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/F1150825006/step-entries',
    payload: { stepNo: '41' },
  });
  assert.equal(res.statusCode, 200);
  const pauses = activePausesOf(state, a.id);
  assert.equal(pauses.length, 1, 'A 應有一筆進行中的插單暫停');
  assert.equal(pauses[0].type, '12');
  assert.equal(pauses[0].note, INTERLEAVE_NOTE);
  assert.equal(pauses[0].interruptedByOrderNo, 'F1150825006');
  const body = JSON.parse(res.body);
  assert.deepEqual(body.interleave.autoPaused, ['F1150821009']);
  await fastify.close();
});

await test('回頭掃 A → A 的插單暫停自動結束，B 換被插單', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  const b = await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '41' } });
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/F1150821009/step-entries', payload: { stepNo: '4' } });
  assert.equal(res.statusCode, 200);
  assert.equal(activePausesOf(state, a.id).length, 0, 'A 的插單暫停應已結束');
  const closed = state.pauseEvents.find(p => p.orderId === a.id && p.endAt);
  assert.ok(closed && typeof closed.duration === 'number', 'A 的暫停應有 endAt 與 duration');
  const bPauses = activePausesOf(state, b.id);
  assert.equal(bPauses.length, 1, 'B 應改為插單暫停');
  assert.equal(bPauses[0].interruptedByOrderNo, 'F1150821009');
  await fastify.close();
});

await test('A 已在下班暫停中 → 掃 B 不會對 A 重複建暫停', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await prisma.pauseEvent.create({
    data: { orderId: a.id, type: '12', note: '下班時間', startAt: new Date(), endAt: null, qcActualQty: 100 },
  });
  await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '41' } });
  const pauses = activePausesOf(state, a.id);
  assert.equal(pauses.length, 1, 'A 只應有原本的下班暫停');
  assert.equal(pauses[0].note, '下班時間');
  await fastify.close();
});

await test('未開始的工單與已完成的工單都不會被插單暫停', async () => {
  const { fastify, prisma, state } = await buildApp();
  const waiting = await seedOrder(prisma, 'F1150826001', 'No12', { started: false });
  const done = await seedOrder(prisma, 'F1150820001', 'No12', { done: true });
  await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '41' } });
  assert.equal(activePausesOf(state, waiting.id).length, 0, '等待中的單不應被暫停');
  assert.equal(activePausesOf(state, done.id).length, 0, '已完成的單不應被暫停');
  await fastify.close();
});

await test('不同機台的工單不受影響', async () => {
  const { fastify, prisma, state } = await buildApp();
  const other = await seedOrder(prisma, 'F1150821009', 'No13');
  await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '41' } });
  assert.equal(activePausesOf(state, other.id).length, 0);
  await fastify.close();
});

await test('step 23（生產無工令）不觸發插單', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '23' } });
  assert.equal(activePausesOf(state, a.id).length, 0);
  await fastify.close();
});

await test('手動恢復 A 的下班暫停 → B 自動插單暫停', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await prisma.pauseEvent.create({
    data: { orderId: a.id, type: '12', note: '下班時間', startAt: new Date(Date.now() - 3600e3), endAt: null },
  });
  const b = await seedOrder(prisma, 'F1150825006', 'No12');
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/F1150821009/resume', payload: { type: '12' } });
  assert.equal(res.statusCode, 200);
  assert.equal(activePausesOf(state, a.id).length, 0, 'A 的下班暫停應已結束');
  const bPauses = activePausesOf(state, b.id);
  assert.equal(bPauses.length, 1, 'B 應被插單暫停');
  assert.equal(bPauses[0].interruptedByOrderNo, 'F1150821009');
  await fastify.close();
});

await test('舊制 /steps/:step（工序 4 穩定連續生產）也會觸發插單', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12');
  const res = await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/steps/4', payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(activePausesOf(state, a.id).length, 1);
  await fastify.close();
});

await test('準備工序（40 生產準備）不觸發插單 —— A 生產中可先幫 B 做準備', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12');
  for (const stepNo of ['40', '21', '22', '1', '2', '3']) {
    if (['40', '21', '22'].includes(stepNo)) {
      await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo } });
    } else {
      await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/steps/' + stepNo, payload: {} });
    }
  }
  assert.equal(activePausesOf(state, a.id).length, 0, '準備工序不應把 A 暫停');
  await fastify.close();
});

await test('補登（manualTime）不觸發插單 —— 辦公室補歷史紀錄不代表機台換單', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12');
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/F1150825006/step-entries',
    payload: { stepNo: '4', recordedAt: '2026-08-31T02:00:00Z' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(activePausesOf(state, a.id).length, 0, '補登不應把 A 暫停');
  await fastify.close();
});


await test('插單時 B 的第一筆生產開始用實際掃碼時間（不強制 08:00）', async () => {
  const { fastify, prisma } = await buildApp();
  await seedOrder(prisma, 'F1150821009', 'No12');
  await seedOrder(prisma, 'F1150825006', 'No12', { started: false });
  const res = await fastify.inject({
    method: 'POST', url: '/api/orders/F1150825006/step-entries',
    payload: { stepNo: '41' },
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.forcedFromPrev, false, '插單情境不應強制時間');
  assert.equal(body.forcedReason, null);
  await fastify.close();
});


await test('手動選「插單」後掃 B → A 的插單暫停補上被誰插單', async () => {
  const { fastify, prisma, state } = await buildApp();
  const a = await seedOrder(prisma, 'F1150821009', 'No12');
  // 模擬 index.html 中斷選單選「插單」：手動建立插單暫停（還不知道下一張是誰）
  await prisma.pauseEvent.create({
    data: { orderId: a.id, type: '12', note: INTERLEAVE_NOTE, startAt: new Date(), endAt: null, qcActualQty: 50 },
  });
  await seedOrder(prisma, 'F1150825006', 'No12');
  await fastify.inject({ method: 'POST', url: '/api/orders/F1150825006/step-entries', payload: { stepNo: '41' } });
  const pauses = activePausesOf(state, a.id);
  assert.equal(pauses.length, 1, 'A 仍只有一筆暫停（不重複建）');
  assert.equal(pauses[0].interruptedByOrderNo, 'F1150825006', '應補記被 B 插單');
  assert.equal(pauses[0].qcActualQty, 50, '原本填的數量不應被動到');
  await fastify.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
