import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { MACHINES, MACHINE_TARGETS, AUX_EQUIPMENT_LABELS } from '../lib/machineTargets';
import { fmtTime, fmtTimeShort, twDateKey } from '../lib/format';
import { actualQtyOf, computeOrderPhasesForDay } from '../lib/orderPhases';

function isToday(iso) {
  if (!iso) return false;
  return twDateKey(iso) === twDateKey(new Date());
}

export default function RealtimePage() {
  const toast = useToast();
  const [activeMachine, setActiveMachine] = useState(MACHINES[0].id);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = async () => {
    setLoading(true);
    const r = await api('/api/orders?limit=200');
    setLoading(false);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); return; }
    setOrders(r.data.orders || []);
  };

  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line
  // 30 秒自動更新
  useEffect(() => {
    const t = setInterval(() => setRefreshKey(k => k + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const machineOrders = useMemo(() => {
    return orders
      .filter(o => o.machineNo === activeMachine)
      .filter(o => isToday(o.actualStartDate) || isToday(o.step11At) || isToday(o.updatedAt));
  }, [orders, activeMachine]);

  const stats = useMemo(() => {
    const todayY = twDateKey(new Date());
    const std = MACHINE_TARGETS[activeMachine] || { capacityKg: 0, workMinutes: 0 };
    let prep = 0, prod = 0, abn = 0, weight = 0, stdMin = 0;
    machineOrders.forEach(o => {
      const ph = computeOrderPhasesForDay(o, todayY);
      prep += ph.prepSec; prod += ph.prodSec; abn += ph.abnSec;
      const qty = actualQtyOf(o);
      const unitW = Number(o.unitWeight) || 0;
      weight += unitW * qty;
      const blades = Number(o.bladeCount) || 0;
      const spm = Number(o.machineSPM) || 0;
      if (blades > 0 && spm > 0 && qty > 0) stdMin += blades / spm * qty;
    });
    return {
      std,
      prepMin: Math.round(prep / 60),
      prodMin: Math.round(prod / 60),
      abnMin: Math.round(abn / 60),
      doneWeight: Math.round(weight),
      stdMin: Math.round(stdMin),
      done: machineOrders.filter(o => o.step11At).length,
      total: machineOrders.length,
    };
  }, [machineOrders, activeMachine]);

  return (
    <div className="container" style={{ maxWidth: 1100 }}>
      {/* 機台切換 */}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {MACHINES.map(m => (
            <button
              key={m.id}
              className={m.id === activeMachine ? 'btn-primary' : 'btn-secondary'}
              style={{ padding: '8px 14px', fontSize: 13 }}
              onClick={() => setActiveMachine(m.id)}
            >
              {m.id}
            </button>
          ))}
          <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '8px 14px' }} onClick={() => setRefreshKey(k => k + 1)}>
            🔄 重新整理
          </button>
        </div>
      </div>

      <div className="card">
        <h2>{activeMachine} 機台概覽（今日）</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          <Stat label="今日工單數" value={stats.total} />
          <Stat label="已完成" value={`${stats.done} / ${stats.total}`} />
          <Stat label="生產產能 (kg)" value={`${stats.doneWeight}${stats.std.capacityKg ? ' / ' + stats.std.capacityKg : ''}`} />
          <Stat label="生產達成度" value={stats.std.capacityKg ? (stats.doneWeight / stats.std.capacityKg * 100).toFixed(1) + '%' : '—'} />
          <Stat label="生產效率 (分)" value={`${stats.stdMin}${stats.std.workMinutes ? ' / ' + stats.std.workMinutes : ''}`} />
          <Stat label="效率達成度" value={stats.std.workMinutes ? (stats.stdMin / stats.std.workMinutes * 100).toFixed(1) + '%' : '—'} />
          <Stat label="生產準備 (分)" value={stats.prepMin} />
          <Stat label="異常停線 (分)" value={stats.abnMin} valueColor="var(--brand)" />
        </div>
      </div>

      <div className="card">
        <h2>工單清單（{machineOrders.length}）</h2>
        {loading ? <div className="muted">載入中...</div> : machineOrders.length === 0 ? <div className="muted">今日此機台無工單</div> : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {machineOrders.map(o => (
              <li key={o.orderNo} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{o.orderNo}</strong>
                  {o.step11At ? <span className="success">✓ 已完成 {fmtTimeShort(o.step11At)}</span> : <span className="brand">進行中</span>}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {o.productSpec || '—'} / {o.material || '—'} / 派工 {o.dispatchQty ?? '—'} / 刀數 {o.bladeCount ?? '—'} / SPM {o.machineSPM ?? '—'}
                </div>
                {o.auxEquipment && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    輔助設備：{o.auxEquipment.split(',').map(k => AUX_EQUIPMENT_LABELS[k] || k).join('、')}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  最後更新：{fmtTime(o.updatedAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
        {/* TODO：每張工單下展開「設備參數編輯面板」（製造/原始 兩欄、多規格 SPM/刀數、自動存檔），以及時間軸與每筆 stepEntry 詳情 */}
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 12px' }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: valueColor }}>{value}</div>
    </div>
  );
}
