import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { MACHINES } from '../lib/machineTargets';
import { twDateKey } from '../lib/format';

const ymd = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return twDateKey(dt);
};
const getPlanned = (o) => ymd(o.plannedDate) || ymd(o.productionDate);
const getCompletion = (o) => ymd(o.step11At);
const matchMachine = (o, m) => o.machineNo === m || o.plannedMachineNo === m;

export default function PlanStatsPage() {
  const toast = useToast();
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const [month, setMonth] = useState(ym);
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

  const stats = useMemo(() => {
    const rows = orders.filter(o => matchMachine(o, machine)).filter(o => {
      const p = getPlanned(o);
      return p && p.startsWith(month);
    });
    const monthPlanned = rows.length;
    const monthDone = rows.filter(o => !!o.step11At).length;
    const monthRate = monthPlanned > 0 ? (monthDone / monthPlanned * 100).toFixed(1) : null;

    const todayYmd = twDateKey(new Date());
    const todayInThisMonth = todayYmd.startsWith(month);
    const [yy, mm] = month.split('-').map(n => parseInt(n, 10));
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const refYmd = todayInThisMonth ? todayYmd : (month + '-' + String(daysInMonth).padStart(2, '0'));

    const todayDone = rows.filter(o => getCompletion(o) === refYmd).length;
    const todayDelayed = rows.filter(o => {
      const c = getCompletion(o); const p = getPlanned(o);
      return c === refYmd && p && p < refYmd;
    }).length;
    const dueSoFar = rows.filter(o => getPlanned(o) <= refYmd);
    const doneSoFar = dueSoFar.filter(o => { const c = getCompletion(o); return c && c <= refYmd; });
    const dayRate = dueSoFar.length > 0 ? (doneSoFar.length / dueSoFar.length * 100).toFixed(1) : null;

    return { rows, monthPlanned, monthDone, monthRate, todayDone, todayDelayed, dayRate, yy, mm };
  }, [orders, machine, month]);

  return (
    <div className="container" style={{ maxWidth: 1100 }}>
      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <div>
            <label>月份</label>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
          </div>
          <div>
            <label>機台</label>
            <select value={machine} onChange={e => setMachine(e.target.value)}>
              {MACHINES.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </div>
          <button className="btn-secondary" onClick={load} disabled={loading}>
            {loading ? '載入中...' : '🔄 重新整理'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 18, color: 'var(--ink)' }}>
          {stats.yy}年{stats.mm}月份生產計劃達成度統計（{machine}）
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
          <Line label="月應完成件數：" value={stats.monthPlanned} />
          <Line label="月已完成件數：" value={stats.monthDone} valueColor="var(--success)" />
          <Line label="月計畫達成度：" value={stats.monthRate != null ? stats.monthRate + '%' : '—'} valueColor="var(--brand)" />
          <Line label="當日完成件數：" value={stats.todayDone} />
          <Line label="當日延誤完成：" value={stats.todayDelayed} valueColor="var(--brand)" />
          <Line label="日計畫達成度：" value={stats.dayRate != null ? stats.dayRate + '%' : '—'} valueColor="var(--brand)" />
        </div>
      </div>

      <div className="card">
        <h2>工單明細（{stats.rows.length} 張）</h2>
        {stats.rows.length === 0 ? <div className="muted">此機台本月份沒有計畫工單</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th>工單號</th><th>計畫日</th><th>實際開始</th><th>完成日</th><th>狀態</th>
              </tr></thead>
              <tbody>
                {stats.rows.slice().sort((a, b) => (getPlanned(a) || '').localeCompare(getPlanned(b) || '')).map(o => (
                  <tr key={o.orderNo}>
                    <td><strong>{o.orderNo}</strong></td>
                    <td>{getPlanned(o) || '—'}</td>
                    <td>{ymd(o.actualStartDate) || '—'}</td>
                    <td>{getCompletion(o) || '—'}</td>
                    <td>{o.step11At ? <span className="success">已完成</span> : <span className="brand">未完成</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ label, value, valueColor }) {
  return (
    <div style={{ fontSize: 14 }}>
      <span className="muted" style={{ marginRight: 6 }}>{label}</span>
      <span style={{ fontWeight: 700, color: valueColor || 'var(--ink)' }}>{value}</span>
    </div>
  );
}
