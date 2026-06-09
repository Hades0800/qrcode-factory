import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { isAdminUser } from '../lib/permissions';
import { MACHINES, MACHINE_TARGETS } from '../lib/machineTargets';
import { computeOrderPhasesForDay } from '../lib/orderPhases';
import './RealtimePage.css';

// 機台目標統一從 MACHINE_TARGETS 取
const MACHINE_STANDARDS = MACHINE_TARGETS;

const STEP_LABELS = [
  { key: 'step21At', label: '設備啓動準備' },
  { key: 'step22At', label: '生產準備完成' },
  { key: 'step23At', label: '生產無工令' },
  { key: 'step1At', label: '原料準備與設置' },
  { key: 'step2At', label: '模刀具準備與安裝' },
  { key: 'step3At', label: '試模與規格品質確認' },
  { key: 'step4At', label: '穩定連續生產-無中斷' },
  { key: 'step5At', label: '穩定連續生產-中斷調整' },
  { key: 'step6At', label: '後工程接續生產' },
  { key: 'step7At', label: '其他作業' },
  { key: 'step11At', label: '生產作業完成終止' },
];

// ===== 圖示（inline SVG，對應 utils.js 的 ICON_SVG）=====
const ICON_SVG = {
  play: { paths: '<polygon points="6 4 20 12 6 20 6 4"/>', fill: true },
  pause: { paths: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', fill: true },
  user: { paths: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
  box: { paths: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  sparkles: { paths: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>' },
  layers: { paths: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  alert: { paths: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  gear: { paths: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
  clipboard: { paths: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' },
};

function Icon({ name, size = 16, color }) {
  const def = ICON_SVG[name];
  if (!def) return null;
  const stroke = color || 'currentColor';
  const fill = def.fill ? stroke : 'none';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: '-3px', flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: def.paths }}
    />
  );
}

// ===== 純函式 helper（對應 utils.js）=====
function todayYmd() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + '分' + (s > 0 ? s + '秒' : '');
  return Math.floor(m / 60) + '時' + (m % 60) + '分';
}

function scopeLabel(s) {
  if (s === '@') return '原料更換';
  if (s === '#') return '模具';
  if (s === '@#') return '原料與模具更換';
  if (s === 'same') return '沿用前單';
  return s || '';
}

const AUX_EQUIPMENT_LABELS = {
  flat: '軋平機',
  leveler: '整平機',
  slitter: '分條機',
  wave: '波浪機',
  rewind: '收料機',
  other: '其他設備',
};
function auxEquipmentLabel(codes, custom) {
  let arr = [];
  if (Array.isArray(codes)) arr = codes;
  else if (typeof codes === 'string' && codes) arr = codes.split(',');
  const names = arr.map(c => AUX_EQUIPMENT_LABELS[String(c).trim()]).filter(Boolean);
  if (custom && String(custom).trim()) names.push(String(custom).trim());
  return names.join('、');
}

const NEW_SPEC_ASPECT_LABELS = {
  product: '產品',
  mold: '模具',
  material: '原料',
  param: '參數',
};
function formatNewSpecAspects(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) return '';
  return aspects.map(k => NEW_SPEC_ASPECT_LABELS[k] || k).join('、');
}
function formatNewSpecLabel(aspects) {
  const s = formatNewSpecAspects(aspects);
  return s ? '新製規格-' + s : '新製規格';
}

const ORDER_STATUS_BADGE = {
  finished: { text: '已完成', color: '#2ea043', bg: '#e6f7ea' },
  active: { text: '進行中', color: '#1f6feb', bg: '#e7f0ff' },
  cross_day: { text: '跨日進行', color: '#b8860b', bg: '#fff8e8' },
  prep_only: { text: '準備中', color: '#8e8e93', bg: '#f0f0f3' },
  unknown: { text: '—', color: '#8e8e93', bg: '#f0f0f3' },
};
function OrderStatusBadge({ statusKey }) {
  const s = ORDER_STATUS_BADGE[statusKey] || ORDER_STATUS_BADGE.unknown;
  return (
    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6, background: s.bg, color: s.color, marginLeft: 4 }}>
      {s.text}
    </span>
  );
}

function isCrossDayOrder(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const times = [];
  if (o.actualStartDate) times.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => { if (e.recordedAt) times.push(new Date(e.recordedAt).getTime()); });
  ((o.pause12 && o.pause12.history) || []).forEach(p => { if (p.startAt) times.push(new Date(p.startAt).getTime()); });
  ((o.pause13 && o.pause13.history) || []).forEach(p => { if (p.startAt) times.push(new Date(p.startAt).getTime()); });
  if (times.length === 0) return false;
  return Math.min(...times) < dayStart;
}

function orderIsOnDate(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const candidates = [];
  if (o.actualStartDate) candidates.push(new Date(o.actualStartDate).getTime());
  (o.stepEntries || []).forEach(e => { if (e.recordedAt) candidates.push(new Date(e.recordedAt).getTime()); });
  ((o.pause12 && o.pause12.history) || []).forEach(p => {
    if (p.startAt) candidates.push(new Date(p.startAt).getTime());
    if (p.endAt) candidates.push(new Date(p.endAt).getTime());
  });
  ((o.pause13 && o.pause13.history) || []).forEach(p => {
    if (p.startAt) candidates.push(new Date(p.startAt).getTime());
    if (p.endAt) candidates.push(new Date(p.endAt).getTime());
  });
  if (o.step11At) candidates.push(new Date(o.step11At).getTime());
  if (candidates.length === 0) {
    const d = o.plannedDate || o.productionDate;
    return d ? String(d).slice(0, 10) === ymd : false;
  }
  const start = Math.min(...candidates);
  const end = Math.max(...candidates);
  return start < dayEnd && end >= dayStart;
}

function countSteps(o) {
  const oldCount = ['step1At', 'step2At', 'step3At', 'step4At', 'step5At', 'step6At', 'step7At'].filter(k => o[k]).length;
  const newCount = (o.stepEntries || []).filter(e => ['1', '2', '3', '4', '5', '6', '7', '8', '40', '41'].includes(e.stepNo)).length;
  return oldCount + newCount;
}
function hasAnyActivity(o) {
  return countSteps(o) > 0 || (o.stepEntries || []).length > 0;
}
function getFirstActivityTime(o) {
  let min = null;
  const consider = t => {
    if (!t) return;
    const v = new Date(t).getTime();
    if (isNaN(v)) return;
    if (min === null || v < min) min = v;
  };
  ['step1At', 'step2At', 'step3At', 'step4At', 'step5At', 'step6At', 'step7At', 'step11At', 'step21At', 'step22At', 'step23At']
    .forEach(k => consider(o[k]));
  (o.stepEntries || []).forEach(e => consider(e.recordedAt));
  ((o.pause12 && o.pause12.history) || []).forEach(e => { consider(e.startAt); consider(e.endAt); });
  ((o.pause13 && o.pause13.history) || []).forEach(e => { consider(e.startAt); consider(e.endAt); });
  return min;
}

// ===== 時間軸建構 — 回傳 item 陣列（含 JSX 標籤）=====
function buildTimelineItems(o, isAdmin, onDelEntry) {
  const items = [];

  STEP_LABELS.forEach(s => {
    if (o[s.key]) {
      const extras = [];
      if (s.key === 'step11At' && o.step11Note) extras.push(<span key="note">（{o.step11Note}）</span>);
      if (s.key === 'step11At' && o.step11QcActualQty != null) {
        extras.push(<span key="qc" style={qcBadgeStyle}>數量：{o.step11QcActualQty}</span>);
      }
      items.push({ time: new Date(o[s.key]), label: <>{s.label}{extras.map((e, i) => <span key={i}> {e}</span>)}</>, type: 'step', entryId: null });
    }
  });

  (o.stepEntries || []).forEach(e => {
    if (e.stepNo === '30') {
      const suffix = e.isManual ? '（補登）' : '';
      const qc = e.qcActualQty != null ? <span style={qcBadgeStyle}> 數量：{e.qcActualQty}</span> : null;
      items.push({
        time: new Date(e.recordedAt),
        label: <><Icon name="clipboard" size={13} /> 更換規格：{e.note || ''}{qc}{suffix}</>,
        type: 'spec-change',
        entryId: e.id,
      });
      return;
    }
    const suffix = e.isManual ? '（補登）' : '';
    if (e.stepNo === '40' || e.stepNo === '41') {
      const stateName = e.stepNo === '40' ? '生產準備' : '生產開始';
      const noteTxt = e.note ? '（' + e.note + '）' : '';
      items.push({ time: new Date(e.recordedAt), label: <>{stateName}{noteTxt}{suffix}</>, type: 'step', entryId: e.id });
      return;
    }
    const labelMap = { '1': '原料準備與設置', '2': '模刀具準備與安裝', '3': '試模與規格品質確認', '4': '穩定連續生產-無中斷', '5': '穩定連續生產-中斷調整', '8': '穩定連續生產-中斷多次', '6': '後工程接續生產', '7': '其他作業', '21': '設備啓動準備', '22': '生產準備完成', '23': '生產無工令' };
    const name = labelMap[e.stepNo] || ('工序 ' + e.stepNo);
    items.push({ time: new Date(e.recordedAt), label: <>{name}{suffix}</>, type: 'step', entryId: e.id });
  });

  const pauseEvents = [
    ...((o.pause12 && o.pause12.history) || []).map(e => ({ ...e, pauseType: '12', pauseLabel: '正常暫停' })),
    ...((o.pause13 && o.pause13.history) || []).map(e => ({ ...e, pauseType: '13', pauseLabel: '異常停止' })),
  ];
  pauseEvents.forEach(e => {
    const note = e.note ? '（' + e.note + '）' : '';
    const qc = e.qcActualQty != null ? <span style={qcBadgeStyle}> 數量：{e.qcActualQty}</span> : null;
    items.push({
      time: new Date(e.startAt),
      label: <><Icon name={e.pauseType === '13' ? 'alert' : 'pause'} size={13} /> {e.pauseLabel}{note}{qc}</>,
      type: e.pauseType === '13' ? 'abnormal' : 'pause',
      entryId: null,
    });
    if (e.endAt) {
      const dur = e.duration ? fmtDur(e.duration) : '';
      items.push({
        time: new Date(e.endAt),
        label: <><Icon name="play" size={13} /> 恢復生產{dur ? '（暫停 ' + dur + '）' : ''}</>,
        type: 'resume',
        entryId: null,
      });
    }
  });

  items.sort((a, b) => a.time - b.time);
  return items;
}

const qcBadgeStyle = { background: '#1f6feb', color: '#fff', fontSize: 10, padding: '1px 6px', borderRadius: 6, fontWeight: 700 };

function Timeline({ order, isAdmin, onDelEntry }) {
  const items = buildTimelineItems(order, isAdmin, onDelEntry);
  if (items.length === 0) {
    return (
      <ul className="timeline">
        <li><div className="tl-dot" /><div className="tl-label" style={{ color: 'var(--muted)' }}>尚未開始</div></li>
      </ul>
    );
  }
  const lastIdx = order.step11At ? -1 : items.length - 1;
  const pad = n => String(n).padStart(2, '0');

  const out = [];
  items.forEach((it, i) => {
    const isCurrent = i === lastIdx && it.type === 'step';
    let cls = 'done';
    if (isCurrent) cls = 'current';
    else if (it.type === 'pause') cls = 'done pause-event';
    else if (it.type === 'abnormal') cls = 'done abnormal-event';
    else if (it.type === 'resume') cls = 'done resume-event';
    else if (it.type === 'spec-change') cls = 'spec-change';

    const d = it.time;
    const dateStr = pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    let diffStr = '';
    if (i > 0) {
      const diffSec = Math.round((it.time - items[i - 1].time) / 1000);
      if (diffSec >= 0) {
        const dm = Math.floor(diffSec / 60);
        const dh = Math.floor(dm / 60);
        if (dh > 0) diffStr = `（+${dh}時${dm % 60}分）`;
        else if (dm > 0) diffStr = `（+${dm}分）`;
        else diffStr = `（+${diffSec}秒）`;
      }
    }

    let isNextDay = false;
    if (i > 0) {
      const prev = items[i - 1].time;
      if (d.getFullYear() !== prev.getFullYear() || d.getMonth() !== prev.getMonth() || d.getDate() !== prev.getDate()) {
        isNextDay = true;
        out.push(
          <li key={`div-${i}`} className="day-divider">
            <span>── 隔日生產 {pad(d.getMonth() + 1)}/{pad(d.getDate())} ──</span>
          </li>
        );
      }
    }
    let displayLabel = it.label;
    if (isNextDay) {
      diffStr = '';
      if (it.type === 'resume') displayLabel = '隔日恢復生產';
    }

    const delBtn = isAdmin && it.entryId ? (
      <button
        onClick={() => onDelEntry(it.entryId, order.orderNo)}
        style={{ background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 700, cursor: 'pointer', marginLeft: 6 }}
      >✕</button>
    ) : null;

    out.push(
      <li key={`it-${i}`} className={cls}>
        <div className="tl-dot" />
        <div className="tl-time">{dateStr}<span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>{diffStr}</span></div>
        <div className="tl-label">{displayLabel}{delBtn}</div>
      </li>
    );
  });

  return <ul className="timeline">{out}</ul>;
}

// ===== 規格卡片（多規格）=====
function SpecCards({ order }) {
  const [specs, setSpecs] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api('/api/orders/' + encodeURIComponent(order.orderNo) + '/upload-rows');
      const rows = r.ok && r.data.rows ? r.data.rows : [];
      const result = rows.length > 0 ? rows : [{
        productSpec: order.productSpec, moldSpec: order.moldSpec, material: order.material,
        dispatchQty: order.dispatchQty, bladeCount: order.bladeCount, machineSPM: order.machineSPM,
        unitWeight: order.unitWeight, totalWeight: order.totalWeight,
      }];
      if (alive) setSpecs(result);
    })();
    return () => { alive = false; };
  }, [order.orderNo]); // eslint-disable-line

  if (!specs) return <div className="rt-spec-area" />;

  if (specs.length === 1) {
    const s = specs[0];
    return (
      <div className="rt-spec-area">
        <div className="spec-cards-wrap"><div className="spec-cards">
          <div className="spec-card wide"><div className="sc-label">🔧 生產規格</div><div className="sc-value">{s.productSpec || '—'}</div></div>
          <div className="spec-card"><div className="sc-label">⚙ 模具</div><div className="sc-value">{s.moldSpec || '—'}</div></div>
          <div className="spec-card"><div className="sc-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="box" size={12} />領料</div><div className="sc-value">{s.material || '—'}</div></div>
        </div></div>
        <div className="spec-cards-wrap"><div className="spec-stats">
          <div className="spec-stat"><div className="ss-label">派工數</div><div className="ss-value">{s.dispatchQty || '—'}{s.dispatchQty ? <span className="ss-unit">片</span> : ''}</div></div>
          <div className="spec-stat"><div className="ss-label">刀數</div><div className="ss-value">{s.bladeCount || '—'}</div></div>
          <div className="spec-stat"><div className="ss-label">機器SPM</div><div className="ss-value">{s.machineSPM || '—'}</div></div>
          <div className="spec-stat"><div className="ss-label">一片理論重</div><div className="ss-value">{s.unitWeight || '—'}{s.unitWeight ? <span className="ss-unit">kg</span> : ''}</div></div>
          <div className="spec-stat"><div className="ss-label">全部總重量</div><div className="ss-value">{s.totalWeight || '—'}{s.totalWeight ? <span className="ss-unit">kg</span> : ''}</div></div>
        </div></div>
      </div>
    );
  }

  const cols = Math.min(specs.length, 4);
  return (
    <div className="rt-spec-area">
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{specs.length} 種規格</div>
      <div className="spec-cards-wrap"><div className="spec-cards spec-multi-grid" style={{ '--ms-cols': cols }}>
        {specs.map((s, i) => {
          const fields = [
            { label: '生產規格', value: s.productSpec, bold: true },
            { label: '模具', value: s.moldSpec },
            { label: '領料', value: s.material, alwaysShow: true },
            { label: '派工數', value: s.dispatchQty, unit: '片' },
            { label: '刀數', value: s.bladeCount },
            { label: 'SPM', value: s.machineSPM },
            { label: '單重', value: s.unitWeight, unit: 'kg' },
            { label: '總重', value: s.totalWeight, unit: 'kg' },
          ];
          const visible = fields.filter(f => f.value || f.alwaysShow);
          return (
            <div key={i} style={{ flex: '0 0 auto', minWidth: 240, maxWidth: 320, background: 'var(--bg)', borderRadius: 12, padding: 14, borderLeft: '3px solid var(--brand)' }}>
              <div style={{ fontSize: 11, color: 'var(--brand)', fontWeight: 700, marginBottom: 8 }}>規格 {i + 1}</div>
              {visible.map((f, j) => {
                const hasVal = f.value !== null && f.value !== undefined && f.value !== '';
                return (
                  <div key={j} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13, marginBottom: f.bold ? 4 : undefined }}>
                    <span style={{ color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap', minWidth: 50 }}>{f.label}：</span>
                    <span style={{ color: hasVal ? 'var(--ink)' : 'var(--muted)', fontWeight: f.bold ? 700 : 600, wordBreak: 'break-all', fontSize: f.bold ? 14 : undefined }}>
                      {hasVal ? String(f.value) : '—'}
                      {hasVal && f.unit ? <span style={{ color: 'var(--muted)', fontSize: 11 }}> {f.unit}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div></div>
    </div>
  );
}

// ===== 設備參數面板 =====
const RT_EP_FIELDS = [
  ['productSpecAttr', '生產規格'],
  ['paramFileName', '設備參數檔名'],
  ['paramFileAttr', '參數檔案屬性'],
  ['moldSpec', '模具規格'],
  ['machineSPM', '機器SPM'],
  ['bladeCount', '生產刀數'],
  ['feedSetting', '送料設定'],
  ['cutterStroke', '大刀座位置'],
  ['strokeUpdateFreq', '位置更新頻度'],
];

function fieldKeyFor(k, prefix) {
  return prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k;
}

function EquipmentColumn({ ep, prefix, values, onChange }) {
  return (
    <>
      {RT_EP_FIELDS.map(([k, label]) => {
        const fieldKey = fieldKeyFor(k, prefix);
        const isNum = (k === 'machineSPM' || k === 'bladeCount');
        return (
          <div key={fieldKey} style={{ display: 'grid', gridTemplateColumns: '88px 1fr', alignItems: 'center', gap: 6, padding: '3px 0' }}>
            <label style={{ color: 'var(--muted)', fontSize: 11 }}>{label}</label>
            <input
              type={isNum ? 'number' : 'text'}
              step={k === 'machineSPM' ? '0.1' : undefined}
              min={isNum ? '0' : undefined}
              value={values[fieldKey] ?? ''}
              maxLength={200}
              onChange={e => onChange(fieldKey, e.target.value)}
              style={{ padding: '6px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, width: '100%', background: '#fff' }}
            />
          </div>
        );
      })}
    </>
  );
}

function EquipmentPanel({ orderNo }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [hadEp, setHadEp] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [values, setValues] = useState({});
  const [baseOpen, setBaseOpen] = useState(true);
  const [origOpen, setOrigOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { color, text }

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api('/api/equipment-params/' + encodeURIComponent(orderNo));
      if (!alive) return;
      if (!r.ok) { setErrMsg(r.error || '載入失敗'); setLoaded(true); return; }
      const ep = r.data.equipmentParam;
      setHadEp(!!ep);
      const v = {};
      RT_EP_FIELDS.forEach(([k]) => {
        ['', 'base'].forEach(prefix => {
          const fk = fieldKeyFor(k, prefix);
          v[fk] = ep && ep[fk] != null ? ep[fk] : '';
        });
      });
      setValues(v);
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [orderNo]);

  const onChange = useCallback((k, val) => {
    setValues(prev => ({ ...prev, [k]: val }));
  }, []);

  const save = async () => {
    const body = {};
    Object.keys(values).forEach(k => {
      let v = String(values[k] || '').trim();
      if (v === '') { body[k] = null; return; }
      if (k === 'machineSPM' || k === 'bladeCount') {
        const n = Number(v);
        body[k] = Number.isFinite(n) ? n : null;
      } else {
        body[k] = v;
      }
    });
    setSaving(true);
    const r = await api('/api/equipment-params/' + encodeURIComponent(orderNo), { method: 'POST', body });
    setSaving(false);
    if (!r.ok) {
      setResult({ color: 'var(--brand)', text: '✗ ' + (r.error || '儲存失敗') });
      return;
    }
    setHadEp(true);
    setResult({ color: 'var(--success)', text: '✓ 已儲存' });
    toast('已儲存設備參數', 'success');
  };

  if (!loaded) return <div style={{ color: 'var(--muted)', fontSize: 12 }}>載入中...</div>;
  if (errMsg) return <div style={{ color: 'var(--brand)', fontSize: 12 }}>{errMsg}</div>;

  return (
    <div>
      {!hadEp && (
        <div style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center', padding: '4px 0 6px' }}>尚未上傳，請填寫後儲存</div>
      )}
      <div className="ep-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className={`ep-collapsible${baseOpen ? '' : ' ep-closed'}`}>
          <div className="ep-header" style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand)', marginBottom: 6, borderBottom: '1.5px solid var(--brand-soft)', paddingBottom: 3 }} onClick={() => setBaseOpen(o => !o)}>
            <span className="ep-chev">▼</span>製造參數
          </div>
          <div className="ep-body"><EquipmentColumn ep prefix="base" values={values} onChange={onChange} /></div>
        </div>
        <div className={`ep-collapsible${origOpen ? '' : ' ep-closed'}`}>
          <div className="ep-header" style={{ fontSize: 11, fontWeight: 700, color: '#1f6feb', marginBottom: 6, borderBottom: '1.5px solid #e7f0ff', paddingBottom: 3 }} onClick={() => setOrigOpen(o => !o)}>
            <span className="ep-chev">▼</span>原始參數
          </div>
          <div className="ep-body"><EquipmentColumn ep prefix="" values={values} onChange={onChange} /></div>
        </div>
      </div>
      <button onClick={save} disabled={saving} style={{ marginTop: 10, padding: '8px 12px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', width: '100%' }}>
        儲存設備參數
      </button>
      <div className="ep-result" style={{ fontSize: 11, textAlign: 'center', marginTop: 4, minHeight: 14, color: result ? result.color : undefined }}>
        {result ? result.text : ''}
      </div>
    </div>
  );
}

// ===== 本日匯總卡片 =====
function DailySummaryCard({ machineId, machineOrders }) {
  const ymd = todayYmd();
  const todayOrders = (machineOrders || []).filter(o => orderIsOnDate(o, ymd));
  if (todayOrders.length === 0) return null;
  const t = MACHINE_TARGETS[machineId] || { workMinutes: 0, prepMinutes: 0 };
  const rows = todayOrders.map(o => {
    const p = computeOrderPhasesForDay(o, ymd);
    return { orderNo: o.orderNo, isCrossDay: isCrossDayOrder(o, ymd), ...p };
  });
  rows.sort((a, b) => (a.isCrossDay === b.isCrossDay) ? 0 : (a.isCrossDay ? -1 : 1));
  const sumPrep = rows.reduce((s, r) => s + r.prepSec, 0);
  const sumProd = rows.reduce((s, r) => s + r.prodSec, 0);
  const sumAbn = rows.reduce((s, r) => s + r.abnSec, 0);
  const prepMin = Math.round(sumPrep / 60);
  const prodMin = Math.round(sumProd / 60);
  const abnMin = Math.round(sumAbn / 60);
  const prepRate = (t.prepMinutes > 0 && prepMin > 0) ? (t.prepMinutes / prepMin * 100).toFixed(1) : '—';
  const prodRate = t.workMinutes > 0 ? (prodMin / t.workMinutes * 100).toFixed(1) : '—';

  const effRate = (pMin, prMin) => pMin > 0 ? (prMin / pMin).toFixed(2) : '—';
  const targetEff = (t.prepMinutes > 0 && t.workMinutes > 0) ? (t.workMinutes / t.prepMinutes).toFixed(2) : null;
  const effColor = (pMin, prMin) => {
    if (pMin <= 0) return 'var(--muted)';
    if (!targetEff) return '#1f6feb';
    return (prMin / pMin) < parseFloat(targetEff) ? 'var(--brand)' : '#1f6feb';
  };

  const totalEff = effRate(prepMin, prodMin);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: '0 0 4px' }}>本日匯總 · {machineId}</h3>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
        目標 — 生產準備 {t.prepMinutes} 分／生產實績 {t.workMinutes} 分{targetEff ? '／生產效益率 ' + targetEff : ''}
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 500 }}>
          <thead style={{ background: '#f5f5f7' }}>
            <tr>
              <th style={{ padding: 8, textAlign: 'left', fontWeight: 700 }}>工單</th>
              <th style={{ padding: 8, textAlign: 'center', fontWeight: 700, color: '#1f6feb' }}>生產準備(分)</th>
              <th style={{ padding: 8, textAlign: 'center', fontWeight: 700, color: '#1f6feb' }}>生產實績(分)</th>
              <th style={{ padding: 8, textAlign: 'center', fontWeight: 700, color: '#1f6feb' }}>生產效益率</th>
              <th style={{ padding: 8, textAlign: 'center', fontWeight: 700, color: 'var(--brand)' }}>異常停線(分)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const rPrep = Math.round(r.prepSec / 60);
              const rProd = Math.round(r.prodSec / 60);
              return (
                <tr key={i}>
                  <td style={{ padding: '6px 8px', fontWeight: 700, fontSize: 12 }}>
                    {r.orderNo}
                    {r.isCrossDay ? <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6, background: '#fff8e8', color: '#b8860b', marginLeft: 4 }}>隔日</span> : null}
                    <OrderStatusBadge statusKey={r.status} />
                  </td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>{rPrep}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>{rProd}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 13, textAlign: 'center', fontWeight: 600, color: effColor(rPrep, rProd) }}>{effRate(rPrep, rProd)}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>{Math.round(r.abnSec / 60)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot style={{ background: '#fafafb' }}>
            <tr style={{ borderTop: '1.5px solid var(--border)' }}>
              <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--muted)', fontSize: 12 }}>合計（分）</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: 'var(--brand)' }}>{prepMin}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: 'var(--brand)' }}>{prodMin}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: (targetEff && totalEff !== '—' && parseFloat(totalEff) >= parseFloat(targetEff)) ? 'var(--success)' : 'var(--brand)' }}>
                {totalEff}{targetEff ? ' / ' + targetEff : ''}
              </td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: 'var(--brand)' }}>{abnMin}</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--muted)', fontSize: 12 }}>達成度</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: (prepRate !== '—' && parseFloat(prepRate) >= 100) ? 'var(--success)' : undefined }}>{prepRate}{prepRate !== '—' ? '%' : ''}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: (prodRate !== '—' && parseFloat(prodRate) >= 100) ? 'var(--success)' : undefined }}>{prodRate}{prodRate !== '—' ? '%' : ''}</td>
              <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--muted)' }}>—</td>
              <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--muted)' }}>—</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ===== 單張工單卡片 =====
function OrderCard({ order: o, isActive, isAdmin, onDelEntry, onMovePlanned }) {
  const [equipOpen, setEquipOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(true);

  const started = hasAnyActivity(o);
  const isCarryOver = o.productionDate && !isToday(o.productionDate);
  const hasTags = !!(isCarryOver || o.changeScope);

  return (
    <div className={`order-card${isActive ? ' active' : ''}`}>
      <div className="oc-header">
        <div className="oc-title">
          <span className="oc-no">{o.orderNo}</span>
          <div className="oc-badge">{o.step11At ? '已完成' : (started ? '生產中' : '等待中')}</div>
        </div>
        {hasTags && (
          <div className="oc-tags">
            {o.changeScope ? <span className="oc-pill scope">{scopeLabel(o.changeScope)}</span> : null}
            {isCarryOver ? <span className="oc-pill carryover">隔日生產</span> : null}
          </div>
        )}
      </div>

      <SpecCards order={o} />

      {o.plannedMachineNo && o.plannedMachineNo !== o.machineNo && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: '#fff3cd', borderLeft: '3px solid #f0ad4e', borderRadius: 4, fontSize: 12, color: '#8a6d3b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <span><strong>原計劃生產機台：</strong>{o.plannedMachineNo}</span>
          <button onClick={() => onMovePlanned(o.orderNo, o.plannedMachineNo)} style={{ padding: '4px 10px', fontSize: 11, background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' }}>
            移到 {o.plannedMachineNo}
          </button>
        </div>
      )}

      {o.actualStartDate && o.plannedDate && String(o.actualStartDate).slice(0, 10) !== String(o.plannedDate).slice(0, 10) && (
        <div style={{ marginBottom: 8, padding: '6px 10px', background: '#fff3cd', borderLeft: '3px solid #f0ad4e', borderRadius: 4, fontSize: 12, color: '#8a6d3b' }}>
          <strong>計畫日期：</strong>{String(o.plannedDate).slice(0, 10)} <span style={{ color: '#a98e44' }}>（實際開始 {String(o.actualStartDate).slice(0, 10)}）</span>
        </div>
      )}

      <div className="order-info">
        <span className="oi-item"><span className="oi-icon"><Icon name="user" size={14} /></span><span className="oi-label">小組長</span><span className="oi-value">{o.leaderName || '—'}</span></span>
        {o.specType ? (
          <span className="oi-item">
            <span className="oi-icon"><Icon name={o.specType === 'new' ? 'sparkles' : 'box'} size={14} /></span>
            <span className="oi-label">規格</span>
            <span className="oi-value">{o.specType === 'new' ? formatNewSpecLabel(o.newSpecAspects) : '量產規格'}</span>
          </span>
        ) : null}
        {o.materialType ? (
          <span className="oi-item"><span className="oi-icon"><Icon name="layers" size={14} /></span><span className="oi-label">原料</span><span className="oi-value">{o.materialType === 'coil' ? '捲料' : '板料'}</span></span>
        ) : null}
        {(o.auxEquipment || o.auxEquipmentCustom) ? (
          <span className="oi-item"><span className="oi-icon"><Icon name="gear" size={14} /></span><span className="oi-label">輔助設備</span><span className="oi-value">{auxEquipmentLabel(o.auxEquipment, o.auxEquipmentCustom)}</span></span>
        ) : null}
      </div>

      <div className={`rt-ep-section${equipOpen ? '' : ' ep-closed'}`} style={{ marginTop: 14, background: 'var(--bg)', borderRadius: 8, padding: 10 }}>
        <h3 className="ep-header" style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px' }} onClick={() => setEquipOpen(o => !o)}>
          <span className="ep-chev">▼</span>設備參數
        </h3>
        <div className="ep-body">
          {equipOpen ? <EquipmentPanel orderNo={o.orderNo} /> : null}
        </div>
      </div>

      <div className={`ep-collapsible${timelineOpen ? '' : ' ep-closed'}`} style={{ marginTop: 14 }}>
        <h3 className="ep-header" style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px' }} onClick={() => setTimelineOpen(o => !o)}>
          <span className="ep-chev">▼</span>生產實態
        </h3>
        <div className="ep-body">
          <Timeline order={o} isAdmin={isAdmin} onDelEntry={onDelEntry} />
        </div>
      </div>
    </div>
  );
}

// ===== 主頁 =====
const CACHE_RT = 'cache_rt_v1';

export default function RealtimePage() {
  const toast = useToast();
  const { me } = useAuth();
  const isAdmin = isAdminUser(me);

  const [activeMachine, setActiveMachine] = useState(MACHINES[0].id);
  const [allOrders, setAllOrders] = useState([]);
  const [idleMachines, setIdleMachines] = useState(() => new Set());
  const [overviewCollapsed, setOverviewCollapsed] = useState(false);
  const contentRef = useRef(null);
  const scrollRef = useRef(0);

  const loadOrders = useCallback(async () => {
    const [ordersRes, idleRes] = await Promise.all([
      api('/api/orders?limit=200'),
      api('/api/idle-events?limit=50'),
    ]);
    let orders = [];
    let idle = new Set();
    if (ordersRes.ok) orders = ordersRes.data.orders || [];
    if (idleRes.ok) {
      const now = new Date();
      idle = new Set((idleRes.data.events || []).filter(e => {
        const d = new Date(e.createdAt);
        return d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() &&
          d.getDate() === now.getDate();
      }).map(e => e.machineNo));
    }
    if (ordersRes.ok) {
      setAllOrders(orders);
      setIdleMachines(idle);
      try {
        localStorage.setItem(CACHE_RT, JSON.stringify({
          orders, idleMachines: Array.from(idle), savedAt: Date.now(),
        }));
      } catch (e) { /* ignore */ }
    }
  }, []);

  // 開頁先用快取立即顯示，再打 API；30 秒自動更新
  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_RT) || 'null');
      if (cached && cached.orders) {
        setAllOrders(cached.orders);
        setIdleMachines(new Set(cached.idleMachines || []));
      }
    } catch (e) { /* ignore */ }
    loadOrders();
    const t = setInterval(loadOrders, 30000);
    return () => clearInterval(t);
  }, [loadOrders]);

  const moveToPlannedMachine = useCallback(async (orderNo, target) => {
    if (!window.confirm('確定將工單「' + orderNo + '」改到原計劃機台「' + target + '」？\n\n此操作會把目前機台改為 ' + target + '，並把此單從現在這個分頁移走。')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/machine', { method: 'POST', body: { machineNo: target } });
    if (!r.ok) { toast(r.error || '改機台失敗', 'error'); return; }
    toast('已將 ' + orderNo + ' 改到 ' + target, 'success');
    loadOrders();
  }, [toast, loadOrders]);

  const deleteEntry = useCallback(async (entryId, orderNo) => {
    if (!window.confirm('確定刪除這筆實態紀錄？')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries/' + entryId, { method: 'DELETE' });
    if (!r.ok) { toast(r.error || '刪除失敗', 'error'); return; }
    if (r.data && r.data.order) {
      setAllOrders(prev => {
        const idx = prev.findIndex(o => o.orderNo === orderNo);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = r.data.order;
        return next;
      });
    }
    toast('已刪除', 'success');
  }, [toast]);

  // 保留捲動位置：自動 refresh 後資料變動時，停在原本看的位置
  useEffect(() => {
    if (contentRef.current && scrollRef.current) {
      contentRef.current.scrollTop = scrollRef.current;
    }
  });
  const rememberScroll = () => { if (contentRef.current) scrollRef.current = contentRef.current.scrollTop; };

  // 當前機台的工單清單
  const machineOrders = useMemo(() => {
    if (activeMachine === '__all') return [];
    function hasTodayActivity(o) {
      const times = [];
      ['step1At', 'step2At', 'step3At', 'step4At', 'step5At', 'step6At', 'step7At', 'step11At', 'step21At', 'step22At', 'step23At'].forEach(k => {
        if (o[k]) times.push(new Date(o[k]));
      });
      (o.stepEntries || []).forEach(e => { if (e.recordedAt) times.push(new Date(e.recordedAt)); });
      ((o.pause12 && o.pause12.history) || []).forEach(e => {
        if (e.startAt) times.push(new Date(e.startAt));
        if (e.endAt) times.push(new Date(e.endAt));
      });
      ((o.pause13 && o.pause13.history) || []).forEach(e => {
        if (e.startAt) times.push(new Date(e.startAt));
        if (e.endAt) times.push(new Date(e.endAt));
      });
      return times.some(t => isToday(t.toISOString()));
    }
    return allOrders
      .filter(o => o.machineNo === activeMachine)
      .filter(o => {
        if (isToday(o.productionDate)) return true;
        if (hasTodayActivity(o)) return true;
        if (!o.step11At && ((o.pause12 && o.pause12.active) || (o.pause13 && o.pause13.active))) return true;
        return false;
      })
      .sort((a, b) => {
        const aFirst = getFirstActivityTime(a);
        const bFirst = getFirstActivityTime(b);
        if (aFirst === null && bFirst === null) return new Date(b.updatedAt) - new Date(a.updatedAt);
        if (aFirst === null) return 1;
        if (bFirst === null) return -1;
        return aFirst - bFirst;
      });
  }, [allOrders, activeMachine]);

  const m = MACHINES.find(x => x.id === activeMachine);

  // 機台概覽統計
  const overview = useMemo(() => {
    if (activeMachine === '__all' || !m) return null;
    const today = new Date();
    const dateStr = today.getFullYear() + '/' + String(today.getMonth() + 1).padStart(2, '0') + '/' + String(today.getDate()).padStart(2, '0');
    const totalOrders = machineOrders.length;
    const completedOrders = machineOrders.filter(o => o.step11At).length;
    const std = MACHINE_STANDARDS[activeMachine] || { capacityKg: 0, workMinutes: 0 };
    const doneWeight = machineOrders.filter(o => o.step11At).reduce((s, o) => s + (Number(o.totalWeight) || 0), 0);
    const capacityRate = std.capacityKg > 0 ? (doneWeight / std.capacityKg * 100).toFixed(1) : null;
    const stdMinutes = machineOrders.reduce((s, o) => {
      const blades = Number(o.bladeCount) || 0;
      const spm = Number(o.machineSPM) || 0;
      const qty = Number(o.dispatchQty) || 0;
      if (blades > 0 && spm > 0 && qty > 0) return s + (blades / spm * qty);
      return s;
    }, 0);
    const efficiencyRate = std.workMinutes > 0 ? (stdMinutes / std.workMinutes * 100).toFixed(1) : null;
    return { dateStr, totalOrders, completedOrders, std, doneWeight, capacityRate, stdMinutes, efficiencyRate };
  }, [machineOrders, activeMachine, m]);

  const fmtNum = n => n > 0 ? n.toLocaleString('zh-TW', { maximumFractionDigits: 1 }) : '—';
  const fmtKg = kg => kg > 0 ? kg.toLocaleString('zh-TW', { maximumFractionDigits: 1 }) : '—';

  const activeOrder = useMemo(() => machineOrders.find(o => !o.step11At && hasAnyActivity(o)), [machineOrders]);

  // 全機台本日匯總
  const allSummary = useMemo(() => {
    if (activeMachine !== '__all') return null;
    const ymd = todayYmd();
    return MACHINES.map(mm => {
      const list = (allOrders || []).filter(o => o.machineNo === mm.id && orderIsOnDate(o, ymd));
      return { machine: mm, list };
    });
  }, [allOrders, activeMachine]);

  return (
    <div>
      {/* 機台分頁 */}
      <div className="machine-tabs">
        {MACHINES.map(mm => {
          const isIdle = idleMachines.has(mm.id);
          return (
            <button
              key={mm.id}
              className={`machine-tab${activeMachine === mm.id ? ' active' : ''}${isIdle ? ' idle' : ''}`}
              onClick={() => { setActiveMachine(mm.id); scrollRef.current = 0; }}
            >
              <div className="mt-num">{mm.num}</div>
              <div className="mt-spec">{mm.spec}</div>
            </button>
          );
        })}
        <button
          className={`machine-tab tab-all${activeMachine === '__all' ? ' active' : ''}`}
          onClick={() => { setActiveMachine('__all'); scrollRef.current = 0; }}
        >
          <div className="mt-num">全機台</div>
          <div className="mt-spec">本日匯總</div>
        </button>
      </div>

      <div className="content" ref={contentRef} onScroll={rememberScroll}>
        {activeMachine === '__all' ? (
          // 全機台本日匯總
          allSummary.map(({ machine: mm, list }) => (
            list.length === 0 ? (
              <div key={mm.id} className="card" style={{ marginBottom: 12, opacity: 0.6 }}>
                <h3 style={{ margin: '0 0 4px' }}>{mm.id}</h3>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>今天無工單</div>
              </div>
            ) : (
              <DailySummaryCard key={mm.id} machineId={mm.id} machineOrders={list} />
            )
          ))
        ) : (
          <>
            {/* 機台概覽 */}
            {overview && (
              <div className={`card overview-card${overviewCollapsed ? ' collapsed' : ''}`}>
                <div className="overview-toggle" onClick={() => setOverviewCollapsed(c => !c)}>
                  <h3 style={{ marginBottom: 0 }}>機台概覽</h3>
                  <span className="toggle-icon">▲</span>
                </div>
                <div className="overview-body">
                  <div className="stats-grid" style={{ marginTop: 12 }}>
                    <div className="stat">
                      <div className="s-label">生產日期</div>
                      <div className="s-value" style={{ fontSize: 16 }}>{overview.dateStr}</div>
                    </div>
                    <div className={`stat ${idleMachines.has(activeMachine) ? '' : 'highlight'}`}>
                      <div className="s-label">機台編號</div>
                      <div className="s-value" style={{ fontSize: 18 }}>
                        {m.num}-{m.spec}
                        {idleMachines.has(activeMachine) ? <span style={{ fontSize: 12, color: 'var(--muted)', background: '#e5e5ea', padding: '2px 8px', borderRadius: 10, marginLeft: 4 }}>今日無工令</span> : null}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="s-label">今日工單數</div>
                      <div className="s-value">{overview.totalOrders}</div>
                    </div>
                    <div className={`stat ${overview.completedOrders > 0 ? 'good' : ''}`}>
                      <div className="s-label">已完成</div>
                      <div className="s-value">{overview.completedOrders}</div>
                      <div className="s-sub">/ {overview.totalOrders} 張</div>
                    </div>
                    <div className="stat">
                      <div className="s-label">生產產能(kg)</div>
                      <div className="s-value" style={{ fontSize: 18 }}>
                        {fmtKg(overview.doneWeight)}
                        {overview.std.capacityKg > 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}> / {fmtKg(overview.std.capacityKg)}</span> : null}
                      </div>
                    </div>
                    <div className={`stat ${overview.capacityRate && parseFloat(overview.capacityRate) >= 100 ? 'good' : ''}`}>
                      <div className="s-label">生產達成度</div>
                      <div className="s-value">{overview.capacityRate !== null ? overview.capacityRate + '%' : '—'}</div>
                    </div>
                    <div className="stat">
                      <div className="s-label">生產效率(分)</div>
                      <div className="s-value" style={{ fontSize: 18 }}>
                        {fmtNum(overview.stdMinutes)}
                        {overview.std.workMinutes > 0 ? <span style={{ fontSize: 13, color: 'var(--muted)' }}> / {overview.std.workMinutes}</span> : null}
                      </div>
                    </div>
                    <div className={`stat ${overview.efficiencyRate && parseFloat(overview.efficiencyRate) >= 100 ? 'good' : ''}`}>
                      <div className="s-label">效率達成度</div>
                      <div className="s-value">{overview.efficiencyRate !== null ? overview.efficiencyRate + '%' : '—'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 本日匯總（當前機台）*/}
            <DailySummaryCard machineId={activeMachine} machineOrders={machineOrders} />

            {/* 工單卡片 */}
            {machineOrders.length === 0 ? (
              <div className="empty-msg">今天此機台尚無工單</div>
            ) : (
              machineOrders.map(o => (
                <OrderCard
                  key={o.orderNo}
                  order={o}
                  isActive={!!(activeOrder && o.orderNo === activeOrder.orderNo)}
                  isAdmin={isAdmin}
                  onDelEntry={deleteEntry}
                  onMovePlanned={moveToPlannedMachine}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
