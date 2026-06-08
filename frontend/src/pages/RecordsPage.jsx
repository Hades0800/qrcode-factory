import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { fmtDate, fmtTime, fmtDuration, twDateKey } from '../lib/format';
import { computeOrderPhasesForDay } from '../lib/orderPhases';

export default function RecordsPage() {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const today = twDateKey(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [filterOrder, setFilterOrder] = useState('');

  const load = async () => {
    setLoading(true);
    const r = await api('/api/orders?limit=500');
    setLoading(false);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); return; }
    setOrders(r.data.orders || []);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  // 依日期區間過濾
  const filtered = useMemo(() => {
    const orderIn = (o) => {
      const d = o.actualStartDate || o.plannedDate || o.productionDate || o.updatedAt;
      const ds = twDateKey(d);
      return ds >= from && ds <= to;
    };
    const matchNo = (o) => !filterOrder || o.orderNo.includes(filterOrder.toUpperCase());
    return orders.filter(o => orderIn(o) && matchNo(o));
  }, [orders, from, to, filterOrder]);

  return (
    <div className="container" style={{ maxWidth: 1100 }}>
      <div className="card">
        <h2>區間 / 工單篩選</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <div><label>從</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label>到</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label>工單號（模糊）</label>
            <input type="text" value={filterOrder} onChange={e => setFilterOrder(e.target.value)} placeholder="例：F115" />
          </div>
          <button className="btn-secondary" onClick={load} disabled={loading}>{loading ? '...' : '重新整理'}</button>
        </div>
      </div>

      <div className="card">
        <h2>{filtered.length} 張工單</h2>
        {filtered.length === 0 ? <div className="muted">區間內無工單</div> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.map(o => <OrderRow key={o.orderNo} order={o} />)}
          </ul>
        )}
        {/* TODO：當日匯總 + CSV 下載 + 軟刪除標記 + 設備參數展開 */}
      </div>
    </div>
  );
}

function OrderRow({ order }) {
  const [expanded, setExpanded] = useState(false);
  const startD = order.actualStartDate || order.step11At;
  const phases = startD ? computeOrderPhasesForDay(order, twDateKey(startD)) : { prepSec: 0, prodSec: 0, abnSec: 0 };

  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <div>
          <strong>{order.orderNo}</strong>{' '}
          <span className="muted" style={{ fontSize: 12 }}>· {order.machineNo || '—'}</span>
        </div>
        {order.step11At ? <span className="success" style={{ fontSize: 12 }}>✓ {fmtDate(order.step11At)}</span> : <span className="brand" style={{ fontSize: 12 }}>未完成</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        準備 {fmtDuration(phases.prepSec)} / 實績 {fmtDuration(phases.prodSec)} / 異常 {fmtDuration(phases.abnSec)}
      </div>
      {expanded && (
        <div style={{ marginTop: 8, padding: 10, background: 'var(--bg)', borderRadius: 8, fontSize: 12 }}>
          <Pair label="計畫日" v={order.plannedDate ? fmtDate(order.plannedDate) : '—'} />
          <Pair label="實際開始" v={order.actualStartDate ? fmtTime(order.actualStartDate) : '—'} />
          <Pair label="完成時間" v={order.step11At ? fmtTime(order.step11At) : '—'} />
          <Pair label="QC 數量" v={order.step11QcActualQty ?? '—'} />
          <Pair label="生產規格" v={order.productSpec || '—'} />
          <Pair label="模具" v={order.moldSpec || '—'} />
          <Pair label="原料" v={order.material || '—'} />
          <Pair label="派工 / 刀數 / SPM" v={`${order.dispatchQty ?? '—'} / ${order.bladeCount ?? '—'} / ${order.machineSPM ?? '—'}`} />
        </div>
      )}
    </li>
  );
}

function Pair({ label, v }) {
  return <div><span className="muted">{label}：</span><strong>{v}</strong></div>;
}
