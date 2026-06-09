import { useState, useCallback } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime } from '../lib/format';
import { validOrderNo } from '../lib/orderPhases';
import { canModifyRecords } from '../lib/permissions';

// 主要步驟（按下即記錄 — 對應 stepEntries 日誌式）
const STEP_BUTTONS = [
  { stepNo: '21', label: '21 設備啟動' },
  { stepNo: '22', label: '22 準備完成' },
  { stepNo: '23', label: '23 無工令' },
  { stepNo: '40', label: '40 生產準備' },
  { stepNo: '41', label: '41 生產開始' },
  { stepNo: '1', label: '01 原料準備' },
  { stepNo: '2', label: '02 模刀具' },
  { stepNo: '3', label: '03 試模確認' },
  { stepNo: '4', label: '04 穩定無中斷' },
  { stepNo: '5', label: '05 穩定中斷調整' },
  { stepNo: '6', label: '06 穩定多次中斷' },
  { stepNo: '7', label: '07 後工程' },
  { stepNo: '8', label: '08 其他作業' },
];

export default function IndexPage() {
  const { me } = useAuth();
  const toast = useToast();
  const [orderNo, setOrderNo] = useState('');
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const canEdit = canModifyRecords(me);

  const loadOrder = useCallback(async (no) => {
    const target = (no || orderNo).trim().toUpperCase();
    if (!validOrderNo(target)) { toast('工單號格式錯誤（1 英文 + 10 數字）', 'error'); return; }
    setLoading(true);
    const r = await api('/api/orders/' + encodeURIComponent(target));
    setLoading(false);
    if (!r.ok) { toast(r.error || '載入失敗', 'error'); return; }
    setOrder(r.data.order);
    setOrderNo(target);
    if (r.data.wasCreated) toast(`已自動建立工單 ${target}`, 'success');
  }, [orderNo, toast]);

  const recordStep = async (stepNo) => {
    if (!order) { toast('請先載入工單', 'error'); return; }
    let qcActualQty;
    if (stepNo === '30') {
      const note = prompt('規格描述：');
      if (!note) return;
      const qc = prompt('前一規格 QC 實際生產數量：');
      if (qc == null) return;
      const n = Number(qc);
      if (!Number.isInteger(n) || n < 0) { toast('需為非負整數', 'error'); return; }
      const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries', {
        method: 'POST', body: { stepNo, note, qcActualQty: n },
      });
      if (!r.ok) { toast(r.error || '記錄失敗', 'error'); return; }
      setOrder(r.data.order);
      toast('已記錄更換規格', 'success');
      return;
    }
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries', {
      method: 'POST', body: { stepNo, qcActualQty },
    });
    if (!r.ok) { toast(r.error || '記錄失敗', 'error'); return; }
    setOrder(r.data.order);
    toast(`已記錄 ${stepNo}`, 'success');
  };

  const finishOrder = async () => {
    if (!order) return;
    const qc = prompt('完成 QC 實際生產數量（非負整數）：');
    if (qc == null) return;
    const n = Number(qc);
    if (!Number.isInteger(n) || n < 0) { toast('需為非負整數', 'error'); return; }
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/steps/11', {
      method: 'POST', body: { qcActualQty: n },
    });
    if (!r.ok) { toast(r.error || '完成失敗', 'error'); return; }
    setOrder(r.data.order);
    toast('已完成', 'success');
  };

  const startPause = async (type, label) => {
    let note = label;
    if (type === '12') {
      const opt = prompt('暫停類型：1=中午休息  2=下班/隔日生產  3=其他', '1');
      if (opt == null) return;
      if (opt === '2') {
        const qc = prompt('下班 QC 實際生產數量（必填，非負整數）：');
        if (qc == null) return;
        const n = Number(qc);
        if (!Number.isInteger(n) || n < 0) { toast('需為非負整數', 'error'); return; }
        const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/pause', {
          method: 'POST', body: { type, note: '下班時間／隔日生產', qcActualQty: n },
        });
        if (!r.ok) { toast(r.error || '失敗', 'error'); return; }
        setOrder(r.data.order); toast('已開始暫停', 'success'); return;
      }
      note = opt === '1' ? '中午休息' : (prompt('暫停原因：') || '其他');
    } else if (type === '13') {
      note = prompt('異常說明：');
      if (!note) return;
    }
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/pause', {
      method: 'POST', body: { type, note },
    });
    if (!r.ok) { toast(r.error || '失敗', 'error'); return; }
    setOrder(r.data.order); toast('已開始暫停', 'success');
  };

  const resume = async (type) => {
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/resume', {
      method: 'POST', body: { type },
    });
    if (!r.ok) { toast(r.error || '失敗', 'error'); return; }
    setOrder(r.data.order); toast('已恢復', 'success');
  };

  return (
    <div className="container">
      <div className="card">
        <h2>掃描 / 輸入工單</h2>
        <input
          type="text"
          value={orderNo}
          onChange={e => setOrderNo(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && loadOrder()}
          placeholder="例：F1150526014"
          autoFocus
        />
        <button className="btn-primary btn-block" disabled={loading} onClick={() => loadOrder()} style={{ marginTop: 12 }}>
          {loading ? '載入中...' : '載入工單'}
        </button>
      </div>

      {order && (
        <>
          <div className="card">
            <h2>工單 {order.orderNo}</h2>
            <Info label="機台" value={order.machineNo || '—'} />
            <Info label="生產規格" value={order.productSpec || '—'} />
            <Info label="模具規格" value={order.moldSpec || '—'} />
            <Info label="派工數" value={order.dispatchQty ?? '—'} />
            <Info label="刀數 / SPM" value={`${order.bladeCount ?? '—'} / ${order.machineSPM ?? '—'}`} />
            <Info label="班長" value={order.leaderName || '—'} />
            <Info label="最後更新" value={fmtTime(order.updatedAt)} />
            {order.step11At && <Info label="完成時間" value={fmtTime(order.step11At)} valueColor="var(--success)" />}
            {order.step11QcActualQty != null && <Info label="QC 數量" value={order.step11QcActualQty} valueColor="var(--success)" />}
          </div>

          <div className="card">
            <h2>記錄工序</h2>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
              按下即時記錄（日誌式，可多次）
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {STEP_BUTTONS.map(b => (
                <button key={b.stepNo} className="btn-secondary" style={{ padding: 14, fontSize: 13 }} onClick={() => recordStep(b.stepNo)}>
                  {b.label}
                </button>
              ))}
              <button className="btn-secondary" style={{ padding: 14, fontSize: 13, color: '#f0ad4e', borderColor: '#f0ad4e' }} onClick={() => recordStep('30')}>
                30 更換規格
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => startPause('12')}>⏸ 正常暫停</button>
              <button className="btn-secondary" style={{ flex: 1, color: 'var(--brand)' }} onClick={() => startPause('13')}>⚠ 異常停止</button>
              {order.pause12?.active && <button className="btn-primary" onClick={() => resume('12')}>▶ 恢復（中斷）</button>}
              {order.pause13?.active && <button className="btn-primary" onClick={() => resume('13')}>▶ 恢復（異常）</button>}
            </div>
            {!order.step11At && (
              <button className="btn-primary btn-block" style={{ marginTop: 14 }} onClick={finishOrder}>
                ✓ 完成工單
              </button>
            )}
          </div>

          <div className="card">
            <h2>工序紀錄 ({(order.stepEntries || []).length} 筆)</h2>
            {(order.stepEntries || []).length === 0 ? (
              <div className="muted">尚無紀錄</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {(order.stepEntries || []).slice().reverse().map(e => (
                  <li key={e.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <strong>{e.stepNo}</strong>{' '}
                    {e.note && <span className="muted">— {e.note}</span>}{' '}
                    {e.qcActualQty != null && <span className="badge" style={{ background: '#1f6feb' }}>數量：{e.qcActualQty}</span>}{' '}
                    {e.isManual && <span className="badge" style={{ background: '#f0ad4e' }}>補登</span>}
                    <br />
                    <span className="muted" style={{ fontSize: 11 }}>{fmtTime(e.recordedAt)} · {e.leaderName || '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* TODO（之後逐步搬過來）：
              - 規格類型（new/mass）+ 難易係數 / 新製差異項
              - 更換範圍（@/#/@#）+ 原料類型（coil/plate）
              - 輔助設備（多選 + 編號 + 自訂名稱）
              - 設備操作人員 / 全部作業人數（第五步）
              - 設備參數面板（製造參數 / 原始參數 + 多規格 SPM/刀數）
              - 補登（pause-backfill, 步驟補登時間）— 需要 canModifyRecords
              - 中斷類型細分 modal（中午/下班/異常/超過1小時）
          */}
          {!canEdit && (
            <div className="card" style={{ background: 'var(--brand-soft)', border: '1px solid var(--brand)' }}>
              <div style={{ fontSize: 12, color: 'var(--brand)' }}>
                ⚠ 你目前的角色為「只能即時記錄」，無法補登/取消/修改既有紀錄
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Info({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: valueColor }}>{value}</span>
    </div>
  );
}
