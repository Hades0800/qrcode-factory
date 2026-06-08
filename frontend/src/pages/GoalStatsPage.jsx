import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { MACHINES, MACHINE_TARGETS } from '../lib/machineTargets';
import { twDateKey } from '../lib/format';
import { computeOrderPhasesForDay, actualQtyOf } from '../lib/orderPhases';

const ymd = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? null : twDateKey(dt);
};
const matchMachine = (o, m) => o.machineNo === m || o.plannedMachineNo === m;
const orderIsOnDate = (o, ds) => {
  const dayStart = new Date(ds + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const cands = [];
  if (o.actualStartDate) cands.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => e.recordedAt && cands.push(new Date(e.recordedAt).getTime()));
  ((o.pause12 && o.pause12.history) || []).forEach(p => {
    if (p.startAt) cands.push(new Date(p.startAt).getTime());
    if (p.endAt) cands.push(new Date(p.endAt).getTime());
  });
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (p.startAt) cands.push(new Date(p.startAt).getTime());
    if (p.endAt) cands.push(new Date(p.endAt).getTime());
  });
  if (o.step11At) cands.push(new Date(o.step11At).getTime());
  if (!cands.length) return false;
  return Math.min(...cands) < dayEnd && Math.max(...cands) >= dayStart;
};

// 跨日工單依「該天 prodSec 比例」分攤標準工時
function buildStdByDay(orders, machine) {
  const map = {};
  orders.filter(o => matchMachine(o, machine)).forEach(o => {
    const blades = Number(o.bladeCount) || 0;
    const spm = Number(o.machineSPM) || 0;
    const qty = actualQtyOf(o);
    const tStdMin = (blades > 0 && spm > 0 && qty > 0) ? (blades / spm * qty) : 0;
    if (tStdMin <= 0) return;
    // 工單活動期間
    const times = [];
    if (o.actualStartDate) times.push(new Date(o.actualStartDate).getTime());
    (o.stepEntries || []).forEach(e => e.recordedAt && times.push(new Date(e.recordedAt).getTime()));
    ((o.pause12 && o.pause12.history) || []).forEach(p => {
      if (p.startAt) times.push(new Date(p.startAt).getTime());
      if (p.endAt) times.push(new Date(p.endAt).getTime());
    });
    ((o.pause13 && o.pause13.history) || []).forEach(p => {
      if (p.startAt) times.push(new Date(p.startAt).getTime());
      if (p.endAt) times.push(new Date(p.endAt).getTime());
    });
    if (o.step11At) times.push(new Date(o.step11At).getTime());
    if (!times.length) return;
    const start = new Date(Math.min(...times)); start.setHours(0, 0, 0, 0);
    const end = new Date(Math.max(...times)); end.setHours(0, 0, 0, 0);
    const prodByDate = {}; let total = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = twDateKey(d);
      const ps = computeOrderPhasesForDay(o, ds).prodSec;
      if (ps > 0) { prodByDate[ds] = ps; total += ps; }
    }
    if (total > 0) {
      Object.entries(prodByDate).forEach(([ds, ps]) => {
        map[ds] = (map[ds] || 0) + tStdMin * (ps / total);
      });
    } else if (o.step11At) {
      const cd = ymd(o.step11At);
      if (cd) map[cd] = (map[cd] || 0) + tStdMin;
    }
  });
  return map;
}

export default function GoalStatsPage() {
  const toast = useToast();
  const now = new Date();
  const [month, setMonth] = useState(now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'));
  const [machine, setMachine] = useState(MACHINES[0].id);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const r = await api('/api/orders?limit=500');
    setLoading(false);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); return; }
    setOrders(r.data.orders || []);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const data = useMemo(() => {
    const [yy, mm] = month.split('-').map(n => parseInt(n, 10));
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const todayY = twDateKey(new Date());
    const todayInMonth = todayY.startsWith(month);
    const lastDay = todayInMonth ? parseInt(todayY.split('-')[2], 10) : daysInMonth;
    const target = MACHINE_TARGETS[machine] || { workMinutes: 0, prepMinutes: 0 };
    const stdByDay = buildStdByDay(orders, machine);

    const days = [];
    for (let d = 1; d <= lastDay; d++) {
      const ds = month + '-' + String(d).padStart(2, '0');
      const dayOrders = orders.filter(o => matchMachine(o, machine) && orderIsOnDate(o, ds));
      let prep = 0, prod = 0, abn = 0;
      dayOrders.forEach(o => {
        const ph = computeOrderPhasesForDay(o, ds);
        prep += ph.prepSec; prod += ph.prodSec; abn += ph.abnSec;
      });
      const prepMin = Math.round(prep / 60);
      const prodMin = Math.round(prod / 60);
      const abnMin = Math.round(abn / 60);
      const stdMin = Math.round(stdByDay[ds] || 0);
      const loss = prodMin - stdMin;
      const eff = target.workMinutes > 0 ? (prodMin / target.workMinutes * 100) : null;
      const hasActivity = dayOrders.length > 0 || stdMin > 0;
      days.push({ d, ds, prepMin, prodMin, abnMin, stdMin, loss, eff, hasActivity });
    }
    const active = days.filter(x => x.hasActivity);
    const n = active.length;
    const avgI = arr => n > 0 ? Math.round(arr.reduce((s, x) => s + x, 0) / n) : 0;
    const avg = {
      abn: avgI(active.map(x => x.abnMin)),
      prep: avgI(active.map(x => x.prepMin)),
      prod: avgI(active.map(x => x.prodMin)),
      std: avgI(active.map(x => x.stdMin)),
      loss: avgI(active.map(x => x.loss)),
      eff: n > 0 ? (active.reduce((s, x) => s + (x.eff || 0), 0) / n).toFixed(1) : null,
    };
    return { days, active, avg, target, yy, mm };
  }, [orders, machine, month]);

  const chartDays = data.active.length ? data.active : data.days;
  const effMax = Math.max(120, ...chartDays.map(x => x.eff || 0));
  const stackMax = Math.max(1, ...chartDays.map(x => x.prepMin + x.prodMin + x.stdMin));

  return (
    <div className="container" style={{ maxWidth: '100%' }}>
      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <div><label>月份</label><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></div>
          <div>
            <label>機台</label>
            <select value={machine} onChange={e => setMachine(e.target.value)}>
              {MACHINES.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </div>
          <button className="btn-secondary" onClick={load} disabled={loading}>🔄 重新整理</button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 18, color: 'var(--ink)' }}>
          {data.yy}年{data.mm}月份生產效率達成度統計（{machine}）
        </h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          生產損失 = 生產實績 − 標準工時；效率達成度 = 生產實績 ÷ 生產目標（{data.target.workMinutes} 分）
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: 13, whiteSpace: 'nowrap', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ background: '#fafafc', position: 'sticky', left: 0 }}>{machine}</th>
              <th>生產目標</th>
              {data.days.map(x => <th key={x.d}>{data.mm}/{x.d}</th>)}
              <th style={{ background: '#fffdf3' }}>月平均</th>
            </tr></thead>
            <tbody>
              <Row label="異常停線" target="0 分鐘" cells={data.days.map(x => x.abnMin)} avg={data.avg.abn} color="#b8860b" />
              <Row label="生產準備" target={(data.target.prepMinutes || 0) + ' 分鐘'} cells={data.days.map(x => x.prepMin)} avg={data.avg.prep} />
              <Row label="生產實績" target={(data.target.workMinutes || 0) + ' 分鐘'} cells={data.days.map(x => x.prodMin)} avg={data.avg.prod} />
              <Row label="標準工時" target="依照計畫" cells={data.days.map(x => x.stdMin)} avg={data.avg.std} />
              <Row label="生產損失" target="0 分鐘" cells={data.days.map(x => x.loss)} avg={data.avg.loss} color="var(--brand)" />
              <Row label="效率達成度" target="100 %" cells={data.days.map(x => x.eff == null ? '—' : x.eff.toFixed(0) + '%')} avg={data.avg.eff == null ? '—' : data.avg.eff + '%'} bold />
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', marginBottom: 12 }}>
              {machine} 生產效率達成度統計
            </div>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 240, padding: '18px 4px 0', minWidth: 'max-content' }}>
                {chartDays.map(x => {
                  const pct = x.eff == null ? 0 : (x.eff / effMax * 100);
                  return (
                    <div key={x.d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 26, height: '100%', justifyContent: 'flex-end' }}>
                      <div style={{ fontSize: 9, fontWeight: 700 }}>{x.eff == null ? '' : x.eff.toFixed(0) + '%'}</div>
                      <div style={{ width: 22, background: '#2f6fe0', borderRadius: '3px 3px 0 0', height: pct.toFixed(1) + '%' }} />
                      <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4 }}>{data.mm}/{x.d}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', marginBottom: 12 }}>
              {machine} 生產準備與實績統計
            </div>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 240, padding: '18px 4px 0', minWidth: 'max-content' }}>
                {chartDays.map(x => {
                  const total = x.prepMin + x.prodMin + x.stdMin;
                  return (
                    <div key={x.d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 26, height: '100%', justifyContent: 'flex-end' }}>
                      <div style={{ fontSize: 9, fontWeight: 700 }}>{total || ''}</div>
                      <div style={{ width: 24, display: 'flex', flexDirection: 'column-reverse', borderRadius: '3px 3px 0 0', overflow: 'hidden', height: (total / stackMax * 100).toFixed(1) + '%' }}>
                        <div style={{ background: '#e8833a', height: total ? (x.prepMin / total * 100).toFixed(1) + '%' : 0 }} />
                        <div style={{ background: '#2f6fe0', height: total ? (x.prodMin / total * 100).toFixed(1) + '%' : 0 }} />
                        <div style={{ background: '#b9bcc2', height: total ? (x.stdMin / total * 100).toFixed(1) + '%' : 0 }} />
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4 }}>{data.mm}/{x.d}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 10, fontSize: 12, flexWrap: 'wrap' }}>
              <Legend color="#e8833a" label="生產準備" />
              <Legend color="#2f6fe0" label="生產實績" />
              <Legend color="#b9bcc2" label="標準工時" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, target, cells, avg, color, bold }) {
  return (
    <tr>
      <td style={{ background: '#fafafc', fontWeight: 700, position: 'sticky', left: 0 }}>{label}</td>
      <td style={{ background: '#fffdf3', color: 'var(--muted)', fontWeight: 600 }}>{target}</td>
      {cells.map((v, i) => <td key={i} style={{ color, textAlign: 'center', fontWeight: bold ? 700 : undefined }}>{v || v === 0 ? v : ''}</td>)}
      <td style={{ background: '#fffdf3', fontWeight: 700 }}>{avg}</td>
    </tr>
  );
}

function Legend({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <i style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}
