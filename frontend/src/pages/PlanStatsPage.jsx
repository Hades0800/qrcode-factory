import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { MACHINES } from '../lib/machineTargets';
import { twDateKey } from '../lib/format';
import './PlanStatsPage.css';

// 取台灣本地日期 yyyy-mm-dd（從 ISO 字串或 Date）
const ymd = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return twDateKey(dt);
};

// 工單的計畫日期（優先 plannedDate，fallback productionDate）
const getPlannedYmd = (o) => ymd(o.plannedDate) || ymd(o.productionDate);
// 工單的完成日期
const getCompletionYmd = (o) => ymd(o.step11At);

// 工單的實際開始日期（用 actualStartDate；若無，掃所有活動取最早）
function getActualStartYmd(o) {
  if (o.actualStartDate) return ymd(o.actualStartDate);
  let min = null;
  const consider = (t) => {
    if (!t) return;
    const v = new Date(t).getTime();
    if (isNaN(v)) return;
    if (min === null || v < min) min = v;
  };
  ['step1At', 'step2At', 'step3At', 'step4At', 'step5At', 'step6At', 'step7At', 'step11At', 'step21At', 'step22At', 'step23At']
    .forEach((k) => consider(o[k]));
  (o.stepEntries || []).forEach((e) => consider(e.recordedAt));
  ((o.pause12 && o.pause12.history) || []).forEach((e) => { consider(e.startAt); consider(e.endAt); });
  ((o.pause13 && o.pause13.history) || []).forEach((e) => { consider(e.startAt); consider(e.endAt); });
  return min === null ? null : ymd(new Date(min));
}

// 該工單是否屬於指定機台（machineNo 為現場記錄；plannedMachineNo 為原計畫）
function orderMatchesMachine(o, machine) {
  return o.machineNo === machine || o.plannedMachineNo === machine;
}

export default function PlanStatsPage() {
  const toast = useToast();

  // 預設：本月 + 第一台機
  const now = new Date();
  const defaultYm = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const [month, setMonth] = useState(defaultYm);
  const [machine, setMachine] = useState(MACHINES[0].id);
  const [allOrders, setAllOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function loadOrders() {
    setLoading(true);
    setLoadError('');
    const r = await api('/api/orders?limit=500');
    setLoading(false);
    if (!r.ok) {
      setLoadError(r.error || '載入失敗');
      setAllOrders([]);
      toast(r.error || '載入失敗', 'error');
      return;
    }
    setAllOrders(r.data.orders || []);
  }

  useEffect(() => { loadOrders(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => {
    if (!month || !machine) return null;

    const [yy, mm] = month.split('-').map((n) => parseInt(n, 10));
    const daysInMonth = new Date(yy, mm, 0).getDate(); // mm 是 1-12，Date(yy,mm,0) = 該月最後一天
    const todayYmd = ymd(new Date());
    const todayInThisMonth = todayYmd.startsWith(month);

    // 篩選：計畫日期落在此月份 + 機台
    const rows = allOrders.filter((o) => {
      if (!orderMatchesMachine(o, machine)) return false;
      const p = getPlannedYmd(o);
      if (!p) return false;
      return p.startsWith(month);
    });

    // 統計
    const monthPlanned = rows.length;
    const monthDone = rows.filter((o) => !!o.step11At).length;
    const monthRate = monthPlanned > 0 ? (monthDone / monthPlanned * 100).toFixed(1) : null;

    // 當日（若今天屬於本月，用今天；否則用該月最後一天）
    const refYmd = todayInThisMonth ? todayYmd : (month + '-' + String(daysInMonth).padStart(2, '0'));

    // 當日完成 = 完成日 = refYmd
    const todayDone = rows.filter((o) => getCompletionYmd(o) === refYmd).length;
    // 當日延誤完成 = 完成日 = refYmd 且 計畫日 < refYmd
    const todayDelayed = rows.filter((o) => {
      const c = getCompletionYmd(o);
      const p = getPlannedYmd(o);
      return c === refYmd && p && p < refYmd;
    }).length;
    // 日計畫達成度 = (計畫日 ≤ refYmd 且 完成日 ≤ refYmd) / (計畫日 ≤ refYmd)
    const dueSoFar = rows.filter((o) => getPlannedYmd(o) <= refYmd);
    const doneSoFar = dueSoFar.filter((o) => {
      const c = getCompletionYmd(o);
      return c && c <= refYmd;
    });
    const dayRate = dueSoFar.length > 0 ? (doneSoFar.length / dueSoFar.length * 100).toFixed(1) : null;

    // 依計畫日期 → 工單號 排序
    const sortedRows = rows.slice().sort((a, b) => {
      const pa = getPlannedYmd(a) || '';
      const pb = getPlannedYmd(b) || '';
      if (pa !== pb) return pa < pb ? -1 : 1;
      return (a.orderNo || '').localeCompare(b.orderNo || '');
    });

    return {
      yy, mm, daysInMonth, todayYmd,
      rows: sortedRows,
      monthPlanned, monthDone, monthRate,
      todayDone, todayDelayed, dayRate,
    };
  }, [allOrders, month, machine]);

  return (
    <div className="container">
      <div className="card">
        <div className="toolbar">
          <div className="field">
            <label>月份</label>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="field">
            <label>機台</label>
            <select value={machine} onChange={(e) => setMachine(e.target.value)}>
              {MACHINES.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </div>
          <button className="btn-secondary" onClick={loadOrders} disabled={loading}>🔄 重新整理</button>
        </div>
      </div>

      <div className="card" id="summaryCard">
        <h2 className="ps-title">
          {model ? `${model.yy}年${model.mm}月份生產計劃達成度統計` : '—'}
        </h2>
        <div className="ps-summary">
          <div className="ps-line"><span className="lbl">機台編號：</span><span className="val">{machine}</span></div>
          <div className="ps-line"></div>
          <div className="ps-line"><span className="lbl">月應完成件數：</span><span className="val">{model ? model.monthPlanned : 0}</span></div>
          <div className="ps-line"><span className="lbl">月已完成件數：</span><span className="val success">{model ? model.monthDone : 0}</span></div>
          <div className="ps-line"><span className="lbl">月計畫達成度：</span><span className="val brand">{model && model.monthRate !== null ? model.monthRate + '%' : '—'}</span></div>
          <div className="ps-line"><span className="lbl">當日完成件數：</span><span className="val">{model ? model.todayDone : 0}</span></div>
          <div className="ps-line"><span className="lbl">當日延誤完成：</span><span className="val brand">{model ? model.todayDelayed : 0}</span></div>
          <div className="ps-line"><span className="lbl">日計畫達成度：</span><span className="val brand">{model && model.dayRate !== null ? model.dayRate + '%' : '—'}</span></div>
        </div>
        <div className="ps-legend">
          <span className="lg"><span className="ps-dot red"></span>未完成</span>
          <span className="lg"><span className="ps-dot yellow"></span>進行中</span>
          <span className="lg"><span className="ps-dot green"></span>已完成</span>
        </div>
      </div>

      <div className="card">
        <div className="ps-grid-wrap">
          {loading && (!model || model.rows.length === 0) ? (
            <div className="empty">載入中...</div>
          ) : loadError ? (
            <div className="empty">{loadError}</div>
          ) : !model || model.rows.length === 0 ? (
            <div className="empty">此機台本月份沒有計畫工單</div>
          ) : (
            <PlanGrid model={model} month={month} />
          )}
        </div>
      </div>
    </div>
  );
}

function PlanGrid({ model, month }) {
  const { daysInMonth, todayYmd, mm, rows } = model;
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) days.push(d);

  return (
    <table className="ps-grid">
      <thead>
        <tr>
          <th className="ps-order-col">工號</th>
          {days.map((d) => {
            const dYmd = month + '-' + String(d).padStart(2, '0');
            const isToday = dYmd === todayYmd;
            return <th key={d} className={isToday ? 'today' : ''}>{mm}/{d}</th>;
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const plan = getPlannedYmd(o);
          const start = getActualStartYmd(o);
          const done = getCompletionYmd(o);
          // 顯示範圍：plan 到 (done 或 今天)
          const upperBound = done || todayYmd;

          return (
            <tr key={o.orderNo}>
              <td className="ps-order-col">{o.orderNo}</td>
              {days.map((d) => {
                const dYmd = month + '-' + String(d).padStart(2, '0');
                const isToday = dYmd === todayYmd;
                let dot = null;
                if (plan && dYmd >= plan && dYmd <= upperBound) {
                  if (done && dYmd === done) {
                    dot = <span className="ps-dot green" title="已完成"></span>;
                  } else if (start && dYmd >= start) {
                    dot = <span className="ps-dot yellow" title="進行中"></span>;
                  } else {
                    dot = <span className="ps-dot red" title="未完成"></span>;
                  }
                }
                return <td key={d} className={`ps-cell ${isToday ? 'today' : ''}`}>{dot}</td>;
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
