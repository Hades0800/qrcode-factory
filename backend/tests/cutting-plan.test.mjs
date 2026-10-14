// 現場工單（裁切加工計畫表）七步流程。需要測試庫與後端：
//   npm run db:test:reset && npm run dev:test    然後 node tests/cutting-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_API || 'http://localhost:8081';
const DAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const NOS = ['G1151015001', 'G1151015002', 'G1151015003'];

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const login = async u => (await call('/api/auth/login', { method: 'POST', body: { username: u, password: 'test1234' } })).body.token;

let shop, planner;
test('準備：登入與當日三張工單', async () => {
  shop = await login('proc1');
  planner = await login('planner1');
  assert.ok(shop && planner, '測試帳號登入失敗——請先 npm run db:test:reset');

  for (const [i, no] of NOS.entries()) {
    await call(`/api/cutting/process-orders/${no}`, { method: 'DELETE', token: planner });
    const r = await call('/api/cutting/process-orders', {
      method: 'POST', token: planner,
      body: { processNo: no, customer: ['光鈦', '欣鉅', '台鳴'][i], qty: [45, 12, 200][i], machineNo: '31', plannedDate: DAY.replace(/-/g, '.') },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

test('① 接收當天計畫', async () => {
  const { body } = await call(`/api/cutting/plan?machineNo=31&date=${DAY}`, { token: shop });
  assert.equal(body.machineNo, '31');
  assert.equal(body.date, DAY);          // 日期跨時區不可以偏掉
  assert.equal(body.locked, false);
  assert.equal(body.orders.length, 3);
});

test('② 調整順序與標記等待材料', async () => {
  const r = await call('/api/cutting/plan/reorder', {
    method: 'PATCH', token: shop, body: { machineNo: '31', date: DAY, order: [NOS[2], NOS[0], NOS[1]] },
  });
  assert.deepEqual(r.body.orders.map(o => o.processNo), [NOS[2], NOS[0], NOS[1]]);
  assert.deepEqual(r.body.orders.map(o => o.seqNo), [1, 2, 3]);

  const w = await call('/api/cutting/plan/waiting', {
    method: 'PATCH', token: shop, body: { processNo: NOS[1], waiting: true, reason: '原料未到' },
  });
  assert.deepEqual(w.body.orders.filter(o => o.waitingMaterial).map(o => o.processNo), [NOS[1]]);
});

test('鎖定前不能開工', async () => {
  const r = await call(`/api/cutting/plan/${NOS[2]}/start`, { method: 'POST', token: shop });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /確認計畫/);
});

test('③ 確認計畫後鎖定，順序不能再動', async () => {
  const r = await call('/api/cutting/plan/lock', { method: 'POST', token: shop, body: { machineNo: '31', date: DAY } });
  assert.equal(r.body.locked, true);
  assert.equal(r.body.currentProcessNo, NOS[2]);   // 第一張該做的

  const re = await call('/api/cutting/plan/reorder', {
    method: 'PATCH', token: shop, body: { machineNo: '31', date: DAY, order: [NOS[0], NOS[2], NOS[1]] },
  });
  assert.equal(re.status, 409);
});

test('④⑤ 開工、回報完成、自動跳下一張', async () => {
  await call(`/api/cutting/plan/${NOS[2]}/start`, { method: 'POST', token: shop });
  const f = await call(`/api/cutting/plan/${NOS[2]}/finish`, {
    method: 'POST', token: shop,
    body: { qty: 198, totalWorkers: 3, storageLocation: 'C-01', note: '兩片不良' },
  });
  assert.equal(f.status, 200);
  assert.equal(f.body.next, NOS[0], '完成後要指向下一張');

  await call(`/api/cutting/plan/${NOS[0]}/start`, { method: 'POST', token: shop });
  const f2 = await call(`/api/cutting/plan/${NOS[0]}/finish`, {
    method: 'POST', token: shop, body: { qty: 45, totalWorkers: 2, storageLocation: 'C-02' },
  });
  // 剩下那張標記等待材料，不該被指派
  assert.equal(f2.body.next, null);
});

test('回報完成要填當班人數，重複回報要擋', async () => {
  const again = await call(`/api/cutting/plan/${NOS[0]}/finish`, { method: 'POST', token: shop, body: { qty: 1, totalWorkers: 1 } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /已經回報/);
});

test('解鎖：限生管，且要填原因', async () => {
  const byShop = await call('/api/cutting/plan/unlock', { method: 'POST', token: shop, body: { machineNo: '31', date: DAY, reason: '測試' } });
  assert.equal(byShop.status, 403, '加工人員不該能解鎖');

  const noReason = await call('/api/cutting/plan/unlock', { method: 'POST', token: planner, body: { machineNo: '31', date: DAY } });
  assert.equal(noReason.status, 400);

  const ok = await call('/api/cutting/plan/unlock', { method: 'POST', token: planner, body: { machineNo: '31', date: DAY, reason: '插單' } });
  assert.equal(ok.body.locked, false);
});

test('⑦ 當日績效：工時以當班人數加權', async () => {
  const { body } = await call(`/api/cutting/plan/summary?machineNo=31&date=${DAY}`, { token: shop });
  assert.equal(body.total, 3);
  assert.equal(body.done, 2);
  assert.equal(body.waiting, 1);
  assert.equal(body.plannedQty, 257);
  assert.equal(body.completedQty, 243);        // 198 + 45
  assert.ok(body.manMinutes >= body.workMinutes, '人時應不小於工時');
  assert.equal(typeof body.utilization, 'number');
});
