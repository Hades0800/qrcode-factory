// 工單接續強制：下一張工單第一筆生產時態 = 上一張結束 + 1 分鐘
// 執行：node tests/order-chain.sim.mjs
//
// 三張工單接力場景（同機台）：
//   工單 1：08:00 開始 → 09:38 結束
//   工單 2：09:39 開始（強制）→ 11:03 結束
//   工單 3：11:04 開始（強制）→ 13:46 結束

import Fastify from 'fastify';
import orderRoutes from '../src/routes/orders.js';

function makeMockPrisma() {
  const state = {
    orders: new Map(),
    stepEntries: new Map(),
    pauseEvents: new Map(),
    auditLogs: [],
    _nextStepEntryId: 1,
    _nextPauseEventId: 1,
    _nextOrderId: 1,
  };

  const filterDeleted = (rows, where) => {
    if (!where) return rows;
    return rows.filter(r => {
      for (const [k, v] of Object.entries(where)) {
        if (k === 'deletedAt') {
          if (v === null) { if (r.deletedAt) return false; }
          else if (typeof v === 'object' && v !== null && 'not' in v) {
            if (v.not === null && !r.deletedAt) return false;
          }
        } else if (k === 'OR' || k === 'AND' || k === 'NOT') {
          // ignore
        } else if (typeof v === 'object' && v !== null && 'not' in v) {
          if (v.not === null && (r[k] == null)) return false;
          if (v.not !== null && r[k] === v.not) return false;
        } else if (typeof v === 'object' && v !== null && 'in' in v) {
          if (!v.in.includes(r[k])) return false;
        } else {
          if (r[k] !== v) return false;
        }
      }
      return true;
    });
  };
  const injectSoftDelete = (where) => {
    const w = where ? { ...where } : {};
    if (!('deletedAt' in w)) w.deletedAt = null;
    return w;
  };

  const order = {
    findUnique: async ({ where, include }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      const row = rows[0];
      if (!row) return null;
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) result.pauseEvents = filterDeleted(Array.from(state.pauseEvents.values()), { orderId: row.id, deletedAt: null });
        if (include.stepEntries) result.stepEntries = filterDeleted(Array.from(state.stepEntries.values()), { orderId: row.id, deletedAt: null });
        return result;
      }
      return row;
    },
    findFirst: async ({ where, orderBy, select }) => {
      let rows = filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where));
      if (orderBy) {
        const [k, dir] = Object.entries(orderBy)[0];
        rows.sort((a, b) => {
          const av = a[k]; const bv = b[k];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          const cmp = new Date(av).getTime() - new Date(bv).getTime();
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      const row = rows[0];
      if (!row) return null;
      if (select) {
        const result = {};
        for (const k of Object.keys(select)) result[k] = row[k];
        return result;
      }
      return row;
    },
    findMany: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)),
    count: async ({ where } = {}) => filterDeleted(Array.from(state.orders.values()), injectSoftDelete(where)).length,
    create: async ({ data, include }) => {
      const row = { id: state._nextOrderId++, ...data, deletedAt: null };
      state.orders.set(data.orderNo, row);
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) result.pauseEvents = [];
        if (include.stepEntries) result.stepEntries = [];
        return result;
      }
      return row;
    },
    update: async ({ where, data, include }) => {
      const row = state.orders.get(where.orderNo) || [...state.orders.values()].find(r => r.id === where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      if (include) {
        const result = { ...row };
        if (include.pauseEvents) result.pauseEvents = filterDeleted(Array.from(state.pauseEvents.values()), { orderId: row.id, deletedAt: null });
        if (include.stepEntries) result.stepEntries = filterDeleted(Array.from(state.stepEntries.values()), { orderId: row.id, deletedAt: null });
        return result;
      }
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = filterDeleted(Array.from(state.orders.values()), where);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    delete: async ({ where }) => {
      const row = state.orders.get(where.orderNo);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
  };

  const makeChildModel = (map, nextIdField, defaults = {}) => ({
    findFirst: async ({ where } = {}) => {
      const rows = filterDeleted(Array.from(map.values()), injectSoftDelete(where));
      return rows[0] || null;
    },
    findMany: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)),
    findUnique: async ({ where }) => map.get(where.id) || null,
    count: async ({ where } = {}) => filterDeleted(Array.from(map.values()), injectSoftDelete(where)).length,
    create: async ({ data }) => {
      const id = state[nextIdField]++;
      const row = { ...defaults, id, ...data, deletedAt: null };
      map.set(id, row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }) => {
      const row = map.get(where.id);
      if (!row) throw new Error('Not found');
      row.deletedAt = new Date();
      return row;
    },
    deleteMany: async ({ where }) => {
      const rows = filterDeleted(Array.from(map.values()), { ...where, deletedAt: null });
      const now = new Date();
      for (const r of rows) r.deletedAt = now;
      return { count: rows.length };
    },
    updateMany: async ({ where, data }) => {
      const rows = filterDeleted(Array.from(map.values()), where);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  });

  const prisma = {
    order,
    stepEntry: makeChildModel(state.stepEntries, '_nextStepEntryId'),
    pauseEvent: makeChildModel(state.pauseEvents, '_nextPauseEventId', { startAt: new Date(), endAt: null, duration: null }),
    auditLog: { create: async ({ data }) => { state.auditLogs.push(data); return data; } },
    uploadBatch: { _nextId: 1, create: async function({ data }) { return { id: this._nextId++, ...data }; }, update: async ({ where, data }) => ({ id: where.id, ...data }) },
    uploadRow: { createMany: async ({ data }) => ({ count: data.length }) },
    $executeRawUnsafe: async () => 0,
    $executeRaw: async () => 1,
  };
  return { prisma, state };
}

const ADMIN = { id: 1, username: 'admin', displayName: '管理員', isAdmin: true, isPlanner: true };
const MACHINE = 'No1-350';

// 用「昨天」當基準，確保 1-3 號工單的時間都在過去（避免被「不能超過現在」擋）
// 工單 4 用今天當基準，驗證跨日新單會被強制為今日 08:00
const baseDate = new Date(); baseDate.setDate(baseDate.getDate() - 1);
const todayBase = new Date();
function timeAt(hh, mm) {
  const d = new Date(baseDate); d.setHours(hh, mm, 0, 0); return d;
}
function fmt(d) { return d ? new Date(d).toLocaleString('zh-TW', { hour12: false }) : '—'; }
function header(t) { console.log('\n' + '═'.repeat(72) + '\n  ' + t + '\n' + '═'.repeat(72)); }

async function run() {
  const fastify = Fastify({ logger: false });
  const { prisma, state } = makeMockPrisma();
  fastify.decorate('prisma', prisma);
  fastify.decorate('authenticate', async (req) => { req.user = ADMIN; });
  fastify.decorate('requireAdmin', async () => {});
  await fastify.register(orderRoutes, { prefix: '/api/orders' });
  await fastify.ready();

  const order1 = 'A0000000001';
  const order2 = 'B0000000002';
  const order3 = 'C0000000003';
  const order4 = 'D0000000004';

  console.log('場景：同機台接力（' + MACHINE + '）');
  console.log('  [昨日] 工單 1：08:00 開始 → 09:38 結束');
  console.log('  [昨日] 工單 2：應強制 09:39 開始（同日上單+1）→ 11:03 結束');
  console.log('  [昨日] 工單 3：應強制 11:04 開始 → 13:46 結束');
  console.log('  [今日] 工單 4：應強制 今日 08:00 開始（每日第一單規則）');

  // ── 工單 1 ──
  header('工單 1: ' + order1);
  await fastify.inject({ method: 'GET', url: '/api/orders/' + order1 });
  await fastify.inject({ method: 'POST', url: '/api/orders/' + order1 + '/machine', payload: { machineNo: MACHINE } });

  let res = await fastify.inject({
    method: 'POST', url: '/api/orders/' + order1 + '/step-entries',
    payload: { stepNo: '41', recordedAt: timeAt(8, 0).toISOString() },
  });
  let body = JSON.parse(res.body);
  console.log('  ▸ 第一筆 step 41 補登 08:00');
  console.log('    forcedFromPrev:', body.forcedFromPrev, '(應為 false — 第一張工單沒有上一張)');
  console.log('    entry.recordedAt:', fmt(body.entry.recordedAt));

  const order1ForcedReason = body.forcedReason;
  // 工單 1 結束 09:38 — 直接寫 step11At 到 mock state（模擬完成）
  state.orders.get(order1).step11At = timeAt(9, 38);
  console.log('  ▸ 工單 1 完成於 09:38 (直接設定 step11At)');

  // ── 工單 2 ──
  header('工單 2: ' + order2);
  res = await fastify.inject({ method: 'GET', url: '/api/orders/' + order2 });
  body = JSON.parse(res.body);
  console.log('  ▸ GET 工單 2');
  console.log('    order.prevMachineEndAt:', body.order.prevMachineEndAt ? fmt(body.order.prevMachineEndAt) : 'null', '(應為 09:38)');

  await fastify.inject({ method: 'POST', url: '/api/orders/' + order2 + '/machine', payload: { machineNo: MACHINE } });

  // 試試補登在 8:00（會被強制覆寫為 09:39）
  res = await fastify.inject({
    method: 'POST', url: '/api/orders/' + order2 + '/step-entries',
    payload: { stepNo: '41', recordedAt: timeAt(8, 0).toISOString() },
  });
  body = JSON.parse(res.body);
  console.log('  ▸ 嘗試補登 step 41 於 08:00（早於上一張結束）');
  console.log('    forcedFromPrev:', body.forcedFromPrev, '(應為 true — 被強制接續)');
  console.log('    entry.recordedAt:', fmt(body.entry.recordedAt), '(應為 09:39)');
  console.log('    forcedPrevEnd:', fmt(body.forcedPrevEnd));

  const order2FirstTime = new Date(body.entry.recordedAt);
  state.orders.get(order2).step11At = timeAt(11, 3);
  console.log('  ▸ 工單 2 完成於 11:03');

  // ── 工單 3 ──
  header('工單 3: ' + order3);
  res = await fastify.inject({ method: 'GET', url: '/api/orders/' + order3 });
  body = JSON.parse(res.body);
  console.log('  ▸ GET 工單 3');
  console.log('    order.prevMachineEndAt:', body.order.prevMachineEndAt ? fmt(body.order.prevMachineEndAt) : 'null', '(應為 11:03)');

  await fastify.inject({ method: 'POST', url: '/api/orders/' + order3 + '/machine', payload: { machineNo: MACHINE } });

  // 補登在昨日 8:00（同日 prev 在 11:03 → 強制 11:04）
  res = await fastify.inject({
    method: 'POST', url: '/api/orders/' + order3 + '/step-entries',
    payload: { stepNo: '40', recordedAt: timeAt(8, 0).toISOString() },
  });
  body = JSON.parse(res.body);
  console.log('  ▸ 補登 step 40 於 昨日 08:00（同日上單 11:03）');
  console.log('    forcedFromPrev:', body.forcedFromPrev, '(應為 true)');
  console.log('    forcedReason:', body.forcedReason, '(應為 prev_same_day)');
  console.log('    entry.recordedAt:', fmt(body.entry.recordedAt), '(應為 11:04)');

  const order3FirstTime = new Date(body.entry.recordedAt);

  // ── 第二筆 40/41 不該被強制 ──
  header('再記錄一筆 step 41（工單 3 已有 stable 紀錄）');
  res = await fastify.inject({
    method: 'POST', url: '/api/orders/' + order3 + '/step-entries',
    payload: { stepNo: '41', recordedAt: timeAt(12, 0).toISOString(), note: '中斷後參數調整' },
  });
  body = JSON.parse(res.body);
  console.log('  ▸ 補登 step 41 於 12:00（第二筆生產時態）');
  console.log('    forcedFromPrev:', body.forcedFromPrev, '(應為 false — 已有 stable 不再強制)');
  console.log('    entry.recordedAt:', fmt(body.entry.recordedAt), '(應為 12:00 — 不變)');

  const secondEntry41 = new Date(body.entry.recordedAt);

  // 工單 3 完成於昨日 13:46
  state.orders.get(order3).step11At = timeAt(13, 46);
  console.log('  ▸ 工單 3 完成於昨日 13:46');

  // ── 工單 4：今日新單，跨日 → 強制今日 08:00 ──
  header('工單 4 (今日新單): ' + order4);
  await fastify.inject({ method: 'GET', url: '/api/orders/' + order4 });
  await fastify.inject({ method: 'POST', url: '/api/orders/' + order4 + '/machine', payload: { machineNo: MACHINE } });

  // 點 已完成（不傳時間，伺服器用 now）— 預期被強制為今日 08:00
  res = await fastify.inject({
    method: 'POST', url: '/api/orders/' + order4 + '/step-entries',
    payload: { stepNo: '41' },
  });
  body = JSON.parse(res.body);
  console.log('  ▸ 點「已完成」紀錄 step 41（不傳時間，伺服器用 now）');
  console.log('    forcedFromPrev:', body.forcedFromPrev, '(應為 true)');
  console.log('    forcedReason:', body.forcedReason, '(應為 day_start — 跨日)');
  console.log('    entry.recordedAt:', fmt(body.entry.recordedAt), '(應為 今日 08:00)');
  const order4FirstTime = new Date(body.entry.recordedAt);
  const order4ForcedReason = body.forcedReason;

  // ── 驗證 ──
  header('驗證結論');
  const isTodayAt8 = order4FirstTime.getFullYear() === todayBase.getFullYear()
    && order4FirstTime.getMonth() === todayBase.getMonth()
    && order4FirstTime.getDate() === todayBase.getDate()
    && order4FirstTime.getHours() === 8
    && order4FirstTime.getMinutes() === 0;
  const checks = [
    ['工單 1 第一筆強制為昨日 08:00（每日第一單規則）', order1ForcedReason === 'day_start'],
    ['工單 2 第一筆強制 = 09:39（同日上單+1）', order2FirstTime.getHours() === 9 && order2FirstTime.getMinutes() === 39],
    ['工單 3 第一筆強制 = 11:04（同日上單+1）', order3FirstTime.getHours() === 11 && order3FirstTime.getMinutes() === 4],
    ['工單 3 第二筆 step41 不強制（保持 12:00）', secondEntry41.getHours() === 12 && secondEntry41.getMinutes() === 0],
    ['工單 4 第一筆強制為今日 08:00（跨日新單）', isTodayAt8],
    ['工單 4 forcedReason = day_start', order4ForcedReason === 'day_start'],
  ];
  checks.forEach(([label, ok]) => console.log((ok ? '  ✓ ' : '  ✗ ') + label));
  const allPass = checks.every(([, ok]) => ok);
  console.log('\n' + (allPass ? '✅ 全部通過 — 工單接續強制邏輯正常' : '❌ 有檢查項失敗'));

  await fastify.close();
  process.exit(allPass ? 0 : 1);
}

run().catch(e => { console.error('Script crashed:', e); process.exit(2); });
