import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { fmtTime, fmtTimeShort } from '../lib/format';
import { computeOrderPhasesForDay } from '../lib/orderPhases';
import { isAdminUser, hasPermission } from '../lib/permissions';
import { MACHINE_TARGETS, AUX_EQUIPMENT_LABELS } from '../lib/machineTargets';
import './RecordsPage.css';

/* ============ 小工具（對應原 utils.js / records.html 區段） ============ */

// SVG icon → React element（替代原 icon() 字串）
const ICON_SVG = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
};
const FILLED_ICONS = new Set(['play', 'pause']);

function Icon({ name, size = 16, color }) {
  const paths = ICON_SVG[name];
  if (!paths) return null;
  const stroke = color || 'currentColor';
  const fill = FILLED_ICONS.has(name) ? stroke : 'none';
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
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}

// fmtDur — 短格式（記錄頁專用，"—" 當無值）
function fmtDur(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return sec + '秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + '分' + (s > 0 ? s + '秒' : '');
  return Math.floor(m / 60) + '時' + (m % 60) + '分';
}

function todayYmd() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

const NEW_SPEC_ASPECT_LABELS = { raw: '原料', dim: '長寬', mold: '模具', mat: '材料', swm: 'SWM/LWM' };
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

function scopeLabel(s) {
  if (s === '@') return '原料更換';
  if (s === '#') return '模具';
  if (s === '@#') return '原料與模具更換';
  if (s === 'same') return '沿用前單';
  return s || '';
}

function auxEquipmentLabel(codes, custom) {
  let arr = [];
  if (Array.isArray(codes)) arr = codes;
  else if (typeof codes === 'string' && codes) arr = codes.split(',');
  const names = arr.map(c => AUX_EQUIPMENT_LABELS[String(c).trim()]).filter(Boolean);
  if (custom && String(custom).trim()) names.push(String(custom).trim());
  return names.join('、');
}

// 計入工序步驟數
function countDone(o) {
  const oldCount = ['step1At', 'step2At', 'step3At', 'step4At', 'step5At', 'step6At', 'step7At'].filter(k => o[k]).length;
  const newCount = (o.stepEntries || []).filter(e => ['1', '2', '3', '4', '5', '6', '7', '8', '40', '41'].includes(e.stepNo)).length;
  return oldCount + newCount;
}

// 不計入暫停（中午或隔日）
function isExcludedPause(e) {
  const note = (e.note || '').toLowerCase();
  if (note.includes('中午') || note.includes('午休') || note.includes('午餐')) return true;
  if (e.startAt && e.endAt) {
    const s = new Date(e.startAt), t = new Date(e.endAt);
    if (s.getFullYear() !== t.getFullYear() || s.getMonth() !== t.getMonth() || s.getDate() !== t.getDate()) return true;
  }
  return false;
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

function sortByProductionOrder(list) {
  return list.slice().sort((a, b) => {
    const aFirst = getFirstActivityTime(a);
    const bFirst = getFirstActivityTime(b);
    if (aFirst === null && bFirst === null) return new Date(b.updatedAt) - new Date(a.updatedAt);
    if (aFirst === null) return 1;
    if (bFirst === null) return -1;
    return aFirst - bFirst;
  });
}

// 工單對指定日期而言是否為「隔日生產」
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

// 工單在指定日期當天有活動？
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

// 工單在指定日期的狀態（對應原 computeOrderPhasesForDay 內 status 計算）
function orderStatusForDay(o, ymd) {
  const dayStart = new Date(ymd + 'T00:00:00').getTime();
  const dayEnd = dayStart + 86400000;
  const inToday = t => t != null && t >= dayStart && t < dayEnd;
  const entries = o.stepEntries || [];
  const allStep41Times = entries.filter(e => e.stepNo === '41').map(e => new Date(e.recordedAt).getTime()).sort((a, b) => a - b);
  const firstStep41Any = allStep41Times[0] || null;
  const todayStep41 = allStep41Times.find(t => inToday(t)) || null;
  const step41WasBefore = firstStep41Any != null && firstStep41Any < dayStart;
  const step11Ms = o.step11At ? new Date(o.step11At).getTime() : null;
  const todayStep11 = inToday(step11Ms) ? step11Ms : null;
  const todayEntryTimes = entries.map(e => new Date(e.recordedAt).getTime()).filter(t => inToday(t)).sort((a, b) => a - b);
  const todayFirstEntry = todayEntryTimes[0] || null;
  if (todayStep11 != null) return 'finished';
  if (step41WasBefore) return 'cross_day';
  if (todayStep41 != null) return 'active';
  if (todayFirstEntry != null) return 'prep_only';
  return 'unknown';
}

const STEP_NAMES = [
  { key: 'step1At', label: '原料準備' },
  { key: 'step2At', label: '模刀具' },
  { key: 'step3At', label: '試模確認' },
  { key: 'step4At', label: '穩定生產-無中斷' },
  { key: 'step5At', label: '穩定生產-中斷調整' },
  { key: 'step6At', label: '後工程' },
  { key: 'step7At', label: '其他作業' },
  { key: 'step11At', label: '完成' },
];
const ENTRY_LABELS = { '1': '原料準備', '2': '模刀具', '3': '試模確認', '4': '穩定生產-無中斷', '5': '穩定生產-中斷調整', '8': '穩定生產-中斷多次', '6': '後工程', '7': '其他作業', '21': '設備啓動', '22': '準備完成', '23': '無工令' };

// 設備參數欄位
const EP_FIELDS = [
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

const CACHE_ORDERS = 'cache_orders_v1';
const CACHE_IDLE = 'cache_idle_v1';

/* CSV helper */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(filename, rows) {
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ====================== 主元件 ====================== */

export default function RecordsPage() {
  const { me } = useAuth();
  const toast = useToast();

  const [allOrders, setAllOrders] = useState([]);
  const [allIdleEvents, setAllIdleEvents] = useState([]);

  const [filterText, setFilterText] = useState('');
  const [filterFrom, setFilterFrom] = useState(todayYmd());
  const [filterTo, setFilterTo] = useState(todayYmd());
  const [filterStatus, setFilterStatus] = useState('');

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryRange, setSummaryRange] = useState({ from: '', to: '' });

  const isAdmin = isAdminUser(me);
  const canView = hasPermission(me, 'view_records');

  // 載入快取（首屏立即顯示）
  useEffect(() => {
    if (!canView) return;
    try {
      const ordersStr = localStorage.getItem(CACHE_ORDERS);
      const idleStr = localStorage.getItem(CACHE_IDLE);
      if (ordersStr) setAllOrders(JSON.parse(ordersStr));
      if (idleStr) setAllIdleEvents(JSON.parse(idleStr));
    } catch (e) { /* ignore */ }
    loadOrders();
  }, [canView]); // eslint-disable-line

  async function loadOrders() {
    const [ordersRes, idleRes] = await Promise.all([
      api('/api/orders?limit=200'),
      api('/api/idle-events?limit=200'),
    ]);
    if (!ordersRes.ok) {
      toast(ordersRes.error || '載入失敗', 'error');
      return;
    }
    const orders = ordersRes.data.orders || [];
    const idle = (idleRes.ok ? idleRes.data.events : []) || [];
    setAllOrders(orders);
    setAllIdleEvents(idle);
    try {
      localStorage.setItem(CACHE_ORDERS, JSON.stringify(orders));
      localStorage.setItem(CACHE_IDLE, JSON.stringify(idle));
    } catch (e) { /* ignore */ }
  }

  // 篩選工單
  const applyFilters = (list) => {
    const text = filterText.trim().toLowerCase();
    return list.filter(o => {
      if (text) {
        const hay = ((o.orderNo || '') + ' ' + (o.machineNo || '') + ' ' + (o.leaderName || '')).toLowerCase();
        if (!hay.includes(text)) return false;
      }
      if (filterFrom || filterTo) {
        const times = [];
        if (o.productionDate) times.push(new Date(o.productionDate));
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
        if (times.length === 0) return false;
        const fromDate = filterFrom ? new Date(filterFrom + 'T00:00:00') : null;
        const toDate = filterTo ? new Date(filterTo + 'T23:59:59') : null;
        const inRange = times.some(t => {
          if (fromDate && t < fromDate) return false;
          if (toDate && t > toDate) return false;
          return true;
        });
        if (!inRange) return false;
      }
      if (filterStatus) {
        const c = countDone(o);
        const isDone = !!o.step11At;
        if (filterStatus === 'done' && !isDone) return false;
        if (filterStatus === 'ongoing' && (isDone || c === 0)) return false;
        if (filterStatus === 'empty' && (isDone || c > 0)) return false;
      }
      return true;
    });
  };

  const filtered = useMemo(
    () => sortByProductionOrder(applyFilters(allOrders)),
    [allOrders, filterText, filterFrom, filterTo, filterStatus] // eslint-disable-line
  );

  // 統計
  const total = filtered.length;
  const completed = filtered.filter(o => !!o.step11At).length;
  const ongoing = filtered.filter(o => !o.step11At && countDone(o) > 0).length;

  // 無工令事件（依日期篩）
  const idleEvents = useMemo(() => {
    return allIdleEvents.filter(e => {
      if (!filterFrom && !filterTo) return true;
      const d = new Date(e.createdAt);
      if (filterFrom && d < new Date(filterFrom + 'T00:00:00')) return false;
      if (filterTo && d > new Date(filterTo + 'T23:59:59')) return false;
      return true;
    });
  }, [allIdleEvents, filterFrom, filterTo]);

  async function cancelIdleEvent(id) {
    if (!confirm('確定取消這筆無工令紀錄？')) return;
    const r = await api('/api/idle-events/' + id, { method: 'DELETE' });
    if (!r.ok) { toast(r.error || '取消失敗', 'error'); return; }
    setAllIdleEvents(prev => prev.filter(e => String(e.id) !== String(id)));
    toast('已取消', 'success');
  }

  async function deleteOrder(orderNo) {
    if (!confirm('確定刪除工單「' + orderNo + '」？\n\n會連同所有生產紀錄一起軟刪除，可從 admin 回收桶救回完整狀態。')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '?force=true', { method: 'DELETE' });
    if (!r.ok) { toast(r.error || '刪除失敗', 'error'); return; }
    setAllOrders(prev => prev.filter(o => o.orderNo !== orderNo));
    const detail = (r.data.entries || r.data.pauses)
      ? '（含工序 ' + (r.data.entries || 0) + ' 筆、停機 ' + (r.data.pauses || 0) + ' 筆）'
      : '';
    toast('已刪除 ' + orderNo + detail, 'success');
  }

  // 匯出 CSV
  function exportCsv() {
    const list = applyFilters(allOrders);
    if (list.length === 0) { toast('沒有資料可匯出', 'error'); return; }
    const headers = [
      '工單號', '生產日期', '機台', '生產規格', '模具', '領料', '數量', 'SPM', '單重', '總重量', '刀數',
      '規格類型', '原料類型',
      '小組長',
      '21.設備啓動', '22.準備完成', '23.無工令',
      '01.原料準備', '02.模刀具', '03.試模確認', '04.穩定生產-無中斷', '05.穩定生產-中斷調整', '06.穩定生產-中斷多次', '07.後工程', '08.其他作業', '11.完成',
      '完成數量', '規格切換明細', '下班明細',
      '暫停次數', '暫停秒數', '異常次數', '異常秒數', '最後更新',
    ];
    const getAllStepTimes = (o, stepNo, oldKey) => {
      const entries = (o.stepEntries || []).filter(e => e.stepNo === stepNo);
      if (entries.length > 0) return entries.map(e => fmtTime(e.recordedAt)).join(' / ');
      if (oldKey && o[oldKey]) return fmtTime(o[oldKey]);
      return '';
    };
    const rows = list.map(o => [
      o.orderNo, o.productionDate ? String(o.productionDate).slice(0, 10) : '',
      o.machineNo, o.productSpec || '', o.moldSpec || '', o.material || '',
      o.dispatchQty || '', o.machineSPM || '', o.unitWeight || '', o.totalWeight || '', o.bladeCount || '',
      (o.specType === 'new'
        ? formatNewSpecLabel(o.newSpecAspects)
        : (o.specType === 'mass' ? '量產規格' : '')),
      o.materialType === 'coil' ? '捲料' : (o.materialType === 'plate' ? '板料' : ''),
      o.leaderName,
      getAllStepTimes(o, '21', 'step21At'), getAllStepTimes(o, '22', 'step22At'), getAllStepTimes(o, '23', 'step23At'),
      getAllStepTimes(o, '1', 'step1At'), getAllStepTimes(o, '2', 'step2At'), getAllStepTimes(o, '3', 'step3At'), getAllStepTimes(o, '4', 'step4At'),
      getAllStepTimes(o, '5', 'step5At'), getAllStepTimes(o, '8', null), getAllStepTimes(o, '6', 'step6At'), getAllStepTimes(o, '7', 'step7At'), fmtTime(o.step11At),
      o.step11QcActualQty != null ? o.step11QcActualQty : '',
      (o.stepEntries || []).filter(e => e.stepNo === '30' && e.qcActualQty != null)
        .map(e => `${e.note || ''}=${e.qcActualQty}`).join(' / '),
      ((o.pause12 && o.pause12.history) || []).filter(e => e.qcActualQty != null)
        .map(e => `${fmtTime(e.startAt)}=${e.qcActualQty}`).join(' / '),
      ((o.pause12 && o.pause12.history) || []).filter(e => !isExcludedPause(e)).length,
      ((o.pause12 && o.pause12.history) || []).filter(e => !isExcludedPause(e)).reduce((s, e) => s + (e.duration || 0), 0),
      ((o.pause13 && o.pause13.history) || []).filter(e => !isExcludedPause(e)).length,
      ((o.pause13 && o.pause13.history) || []).filter(e => !isExcludedPause(e)).reduce((s, e) => s + (e.duration || 0), 0),
      fmtTime(o.updatedAt),
    ]);
    let stamp;
    if (filterFrom && filterTo) stamp = `${filterFrom}_至_${filterTo}`;
    else if (filterFrom) stamp = `${filterFrom}_起`;
    else if (filterTo) stamp = `至_${filterTo}`;
    else stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`工單紀錄_${stamp}.csv`, [headers, ...rows]);
    toast('已下載 ' + list.length + ' 筆', 'success');
  }

  // 當日匯總群組
  function buildSummaryGroups(from, to) {
    const fromDate = new Date(from + 'T00:00:00');
    const toDate = new Date(to + 'T00:00:00');
    if (isNaN(fromDate) || isNaN(toDate) || toDate < fromDate) return null;
    const out = [];
    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const dayOrders = (allOrders || []).filter(o => orderIsOnDate(o, ymd));
      if (dayOrders.length === 0) continue;
      const byMachine = {};
      dayOrders.forEach(o => {
        const m = o.machineNo || '—';
        (byMachine[m] = byMachine[m] || []).push(o);
      });
      Object.keys(byMachine).sort().forEach(m => {
        const t = MACHINE_TARGETS[m] || { workMinutes: 0, prepMinutes: 0 };
        const orderRows = byMachine[m].map(o => ({
          orderNo: o.orderNo,
          isCrossDay: isCrossDayOrder(o, ymd),
          status: orderStatusForDay(o, ymd),
          ...computeOrderPhasesForDay(o, ymd),
        }));
        orderRows.sort((a, b) => (a.isCrossDay === b.isCrossDay) ? 0 : (a.isCrossDay ? -1 : 1));
        const sumPrep = orderRows.reduce((s, r) => s + r.prepSec, 0);
        const sumProd = orderRows.reduce((s, r) => s + r.prodSec, 0);
        const sumAbn = orderRows.reduce((s, r) => s + r.abnSec, 0);
        out.push({ ymd, machineId: m, target: t, orderRows, totals: { sumPrep, sumProd, sumAbn } });
      });
    }
    return out;
  }

  function downloadSummaryCsv(from, to) {
    const groups = buildSummaryGroups(from, to);
    if (!groups || groups.length === 0) { toast('區間內沒有資料', 'error'); return; }
    const rows = [['日期', '機台', '工單', '準備(分)', '實績(分)', '生產效益率', '效益率目標', '異常(分)', '準備目標(分)', '實績目標(分)', '準備達成度', '實績達成度']];
    const eff = (p, q) => p > 0 ? (q / p).toFixed(2) : '';
    groups.forEach(g => {
      const t = g.target;
      const targetEff = (t.prepMinutes > 0 && t.workMinutes > 0) ? (t.workMinutes / t.prepMinutes).toFixed(2) : '';
      g.orderRows.forEach(r => {
        const rPrep = Math.round(r.prepSec / 60);
        const rProd = Math.round(r.prodSec / 60);
        rows.push([g.ymd, g.machineId, r.orderNo, rPrep, rProd, eff(rPrep, rProd), targetEff, Math.round(r.abnSec / 60), '', '', '', '']);
      });
      const prepMin = Math.round(g.totals.sumPrep / 60);
      const prodMin = Math.round(g.totals.sumProd / 60);
      const abnMin = Math.round(g.totals.sumAbn / 60);
      rows.push([
        g.ymd, g.machineId, '【合計】',
        prepMin, prodMin, eff(prepMin, prodMin), targetEff, abnMin,
        t.prepMinutes || '', t.workMinutes || '',
        (t.prepMinutes > 0 && prepMin > 0) ? (t.prepMinutes / prepMin * 100).toFixed(1) + '%' : '',
        t.workMinutes > 0 ? (prodMin / t.workMinutes * 100).toFixed(1) + '%' : '',
      ]);
    });
    const stamp = (from === to) ? from : `${from}_至_${to}`;
    downloadCsv(`當日匯總_${stamp}.csv`, rows);
    toast('已下載匯總（' + (rows.length - 1) + ' 列）', 'success');
  }

  function toggleSummary() {
    if (summaryOpen) {
      setSummaryOpen(false);
      return;
    }
    const from = filterFrom || todayYmd();
    const to = filterTo || from;
    setSummaryRange({ from, to });
    setSummaryOpen(true);
  }

  if (!canView) {
    return (
      <div className="records-page">
        <div className="container">
          <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '60px 20px', fontSize: 14 }}>
            沒有「歷史實態紀錄」權限
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="records-page">
      <div className="container">
        <div className="stats">
          <div className="stat-card"><div className="label">總工單數</div><div className="value">{total}</div></div>
          <div className="stat-card"><div className="label">已完成</div><div className="value">{completed}</div></div>
          <div className="stat-card"><div className="label">進行中</div><div className="value">{ongoing}</div></div>
        </div>

        {summaryOpen && (
          <SummaryPanel
            from={summaryRange.from}
            to={summaryRange.to}
            buildSummaryGroups={buildSummaryGroups}
            onDownload={() => downloadSummaryCsv(summaryRange.from, summaryRange.to)}
            onClose={() => setSummaryOpen(false)}
          />
        )}

        <div className="card">
          <div className="toolbar">
            <div className="field">
              <label>關鍵字</label>
              <input type="text" value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="工單號 / 機台 / 小組長" />
            </div>
            <div className="field">
              <label>開始日期</label>
              <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} />
            </div>
            <div className="field">
              <label>結束日期</label>
              <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} />
            </div>
            <div className="field">
              <label>狀態</label>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="">全部</option>
                <option value="done">已完成（按過工單完成）</option>
                <option value="ongoing">進行中</option>
                <option value="empty">尚未開始</option>
              </select>
            </div>
            <button className="btn-secondary" onClick={loadOrders}>🔄 重新整理</button>
            <button className="btn-primary" onClick={exportCsv}>📥 匯出 CSV</button>
            <button className="btn-primary" style={{ background: '#1f6feb' }} onClick={toggleSummary}>📊 當日匯總</button>
          </div>
        </div>

        {idleEvents.length > 0 && (
          <div className="card">
            <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                生產無工令紀錄
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>共 {idleEvents.length} 筆</span>
            </h2>
            <div className="table-wrap">
              <table className="preview-table" style={{ fontSize: 13 }}>
                <thead><tr><th>時間</th><th>機台</th><th>小組長</th><th>備註</th><th>操作</th></tr></thead>
                <tbody>
                  {idleEvents.map(e => (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.createdAt)}</td>
                      <td style={{ color: 'var(--brand)', fontWeight: 600, whiteSpace: 'nowrap' }}>{e.machineNo}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{e.leaderName || ''}</td>
                      <td>{e.note || ''}</td>
                      <td>
                        <button
                          className="btn-secondary"
                          style={{ padding: '5px 10px', fontSize: 12, color: 'var(--brand)', border: '1.5px solid var(--brand)', background: '#fff', borderRadius: 6, cursor: 'pointer' }}
                          onClick={() => cancelIdleEvent(e.id)}
                        >取消</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="order-list">
          {filtered.length === 0
            ? <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 40, fontSize: 15 }}>沒有符合條件的工單</div>
            : filtered.map(o => (
              <OrderCard key={o.orderNo} order={o} isAdmin={isAdmin} onDelete={deleteOrder} />
            ))}
        </div>
      </div>
    </div>
  );
}

/* ====================== 工單卡片 ====================== */

function OrderCard({ order: o, isAdmin, onDelete }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [equipOpen, setEquipOpen] = useState(false);

  const isComplete = !!o.step11At;

  let badge;
  if (isComplete) badge = <span className="rc-badge done">已完成</span>;
  else if (countDone(o) > 0) badge = <span className="rc-badge active">生產中</span>;
  else badge = <span className="rc-badge">待生產</span>;

  // 合併時間軸
  const allItems = [];
  STEP_NAMES.forEach(s => {
    if (o[s.key]) {
      const labelParts = [{ kind: 'text', text: s.label }];
      if (s.key === 'step11At' && o.step11Note) labelParts.push({ kind: 'text', text: '（' + o.step11Note + '）' });
      if (s.key === 'step11At' && o.step11QcActualQty != null) labelParts.push({ kind: 'qty', qty: o.step11QcActualQty });
      allItems.push({ time: new Date(o[s.key]), parts: labelParts, style: 'done' });
    }
  });
  (o.stepEntries || []).forEach(e => {
    const manual = !!e.isManual;
    if (e.stepNo === '30') {
      const parts = [{ kind: 'icon', name: 'clipboard' }, { kind: 'text', text: ' 更換規格：' + (e.note || '') }];
      if (e.qcActualQty != null) parts.push({ kind: 'qty', qty: e.qcActualQty });
      if (manual) parts.push({ kind: 'manual' });
      allItems.push({ time: new Date(e.recordedAt), parts, style: 'spec-change' });
      return;
    }
    if (e.stepNo === '40' || e.stepNo === '41') {
      const stateName = e.stepNo === '40' ? '生產準備' : '生產開始';
      const parts = [{ kind: 'text', text: stateName + (e.note ? `（${e.note}）` : '') }];
      if (manual) parts.push({ kind: 'manual' });
      allItems.push({ time: new Date(e.recordedAt), parts, style: 'done' });
      return;
    }
    const name = ENTRY_LABELS[e.stepNo] || ('工序' + e.stepNo);
    const parts = [{ kind: 'text', text: name }];
    if (manual) parts.push({ kind: 'manual' });
    allItems.push({ time: new Date(e.recordedAt), parts, style: 'done' });
  });
  ((o.pause12 && o.pause12.history) || []).forEach(e => {
    const isLunch = (e.note || '').includes('中午') || (e.note || '').includes('午休') || (e.note || '').includes('午餐');
    const parts = [{ kind: 'icon', name: 'pause' }, { kind: 'text', text: ' 暫停' + (e.note ? '（' + e.note + '）' : '') }];
    if (e.qcActualQty != null) parts.push({ kind: 'qty', qty: e.qcActualQty });
    allItems.push({ time: new Date(e.startAt), parts, style: 'pause' });
    if (e.endAt) {
      const dur = e.duration ? fmtDur(e.duration) : '';
      const resumeParts = isLunch
        ? [{ kind: 'icon', name: 'play' }, { kind: 'text', text: ' 午後恢復生產' }]
        : [{ kind: 'icon', name: 'play' }, { kind: 'text', text: ' 恢復生產' + (dur ? '（暫停 ' + dur + '）' : '') }];
      allItems.push({ time: new Date(e.endAt), parts: resumeParts, style: 'resume' });
    }
  });
  ((o.pause13 && o.pause13.history) || []).forEach(e => {
    allItems.push({ time: new Date(e.startAt), parts: [{ kind: 'icon', name: 'alert' }, { kind: 'text', text: ' 異常' + (e.note ? '（' + e.note + '）' : '') }], style: 'abnormal' });
    if (e.endAt) {
      const dur = e.duration ? fmtDur(e.duration) : '';
      allItems.push({ time: new Date(e.endAt), parts: [{ kind: 'icon', name: 'play' }, { kind: 'text', text: ' 恢復生產' + (dur ? '（異常 ' + dur + '）' : '') }], style: 'resume' });
    }
  });
  allItems.sort((a, b) => a.time - b.time);

  const pad = n => String(n).padStart(2, '0');
  const timelineNodes = allItems.length === 0
    ? [<li key="empty"><div className="tl-dot" /><div className="tl-label" style={{ color: 'var(--muted)' }}>尚未開始</div></li>]
    : allItems.map((it, i) => {
      let cls = 'done';
      if (it.style === 'pause') cls = 'done pause-event';
      else if (it.style === 'abnormal') cls = 'done abnormal-event';
      else if (it.style === 'resume') cls = 'done resume-event';
      else if (it.style === 'spec-change') cls = 'spec-change';

      const d = it.time;
      const dateStr = pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      let diffStr = '';
      if (i > 0) {
        const diffSec = Math.round((it.time - allItems[i - 1].time) / 1000);
        if (diffSec >= 0) {
          const dm = Math.floor(diffSec / 60);
          const dh = Math.floor(dm / 60);
          if (dh > 0) diffStr = `（+${dh}時${dm % 60}分）`;
          else if (dm > 0) diffStr = `（+${dm}分）`;
          else diffStr = `（+${diffSec}秒）`;
        }
      }

      let dayDivider = null;
      let isNextDay = false;
      if (i > 0) {
        const prev = allItems[i - 1].time;
        if (d.getFullYear() !== prev.getFullYear() || d.getMonth() !== prev.getMonth() || d.getDate() !== prev.getDate()) {
          isNextDay = true;
          dayDivider = (
            <li key={`div-${i}`} className="day-divider"><span>── 隔日生產 {pad(d.getMonth() + 1)}/{pad(d.getDate())} ──</span></li>
          );
        }
      }

      let parts = it.parts;
      if (isNextDay) {
        diffStr = '';
        if (it.style === 'resume') parts = [{ kind: 'icon', name: 'play' }, { kind: 'text', text: ' 隔日恢復生產' }];
      }

      const li = (
        <li key={`it-${i}`} className={cls}>
          <div className="tl-dot" />
          <div className="tl-time">{dateStr}<span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>{diffStr}</span></div>
          <div className="tl-label"><LabelParts parts={parts} /></div>
        </li>
      );
      return dayDivider ? [dayDivider, li] : li;
    });

  // 暫停 / 異常明細
  const allEvents = [
    ...((o.pause12 && o.pause12.history) || []).map(e => ({ ...e, _label: '正常暫停' })),
    ...((o.pause13 && o.pause13.history) || []).map(e => ({ ...e, _label: '異常停止' })),
  ].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  return (
    <div className={'rec-card' + (isComplete ? ' has-complete' : '')}>
      <div className="rc-header">
        <div className="rc-title">
          <span className="rc-no">{o.orderNo}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {badge}
            {isAdmin && (
              <button
                className="btn-danger"
                style={{ padding: '4px 10px', fontSize: 11, minHeight: 24 }}
                onClick={(ev) => { ev.stopPropagation(); onDelete(o.orderNo); }}
              >刪除</button>
            )}
          </div>
        </div>
        {o.changeScope && (
          <div className="rc-tags"><span className="rc-pill scope">{scopeLabel(o.changeScope)}</span></div>
        )}
      </div>
      <div className="rc-meta" style={{ marginTop: 10 }}>
        <span>機台 <strong>{o.machineNo || '—'}</strong>
          {o.plannedMachineNo && o.plannedMachineNo !== o.machineNo && (
            <span style={{ color: '#a98e44', fontSize: 11, marginLeft: 4 }}>（計畫 {o.plannedMachineNo}）</span>
          )}
        </span>
        <span>組長 <strong>{o.leaderName || '—'}</strong></span>
        <span>日期 {o.productionDate ? String(o.productionDate).slice(0, 10) : '—'}
          {o.actualStartDate && o.plannedDate && String(o.actualStartDate).slice(0, 10) !== String(o.plannedDate).slice(0, 10) && (
            <span style={{ color: '#a98e44', fontSize: 11, marginLeft: 4 }}>（計畫 {String(o.plannedDate).slice(0, 10)}）</span>
          )}
        </span>
        {o.specType && (
          <span>規格 <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name={o.specType === 'new' ? 'sparkles' : 'box'} size={13} />
            {o.specType === 'new' ? formatNewSpecLabel(o.newSpecAspects) : '量產規格'}
          </strong></span>
        )}
        {o.materialType && (
          <span>原料 <strong>{o.materialType === 'coil' ? '捲料' : '板料'}</strong></span>
        )}
        {(o.auxEquipment || o.auxEquipmentCustom) && (
          <span>輔助設備 <strong>{auxEquipmentLabel(o.auxEquipment, o.auxEquipmentCustom)}</strong></span>
        )}
      </div>

      <div
        className="rc-expand"
        style={{ marginTop: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, width: 'fit-content' }}
        onClick={() => setDetailOpen(v => !v)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        展開工單明細
      </div>
      <div className={'rc-detail' + (detailOpen ? ' show' : '')}>
        {detailOpen && (
          <>
            <div className="info-card">
              <div className="info-section-title">工單資訊</div>
              <SpecArea order={o} />
            </div>
            {allEvents.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="info-section-title">暫停 / 異常明細</div>
                {allEvents.map((e, i) => {
                  const excluded = isExcludedPause(e);
                  const isAbn = e._label === '異常停止';
                  return (
                    <div key={i} style={{ background: isAbn ? 'var(--brand-soft)' : '#fffbe6', marginBottom: 4, padding: '6px 10px', borderRadius: 8, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, flex: 1, color: isAbn ? 'var(--brand)' : '#b8860b' }}>
                        {e._label}{e.note ? '（' + e.note + '）' : ''}
                        {excluded && <span style={{ fontSize: 10, color: 'var(--muted)' }}>（不計入）</span>}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {fmtTimeShort(e.startAt)} → {e.endAt ? fmtTimeShort(e.endAt) : '進行中'} {!excluded && e.duration ? fmtDur(e.duration) : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div
        className="rc-expand"
        style={{ marginTop: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, width: 'fit-content' }}
        onClick={() => setEquipOpen(v => !v)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        展開設備參數
      </div>
      <div className={'rc-detail' + (equipOpen ? ' show' : '')}>
        {equipOpen && <EquipmentArea orderNo={o.orderNo} />}
      </div>

      <ul className="rc-timeline">{timelineNodes}</ul>
    </div>
  );
}

// 時間軸 label 拼接（取代原字串 HTML）
function LabelParts({ parts }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'icon') return <Icon key={i} name={p.name} size={13} />;
        if (p.kind === 'qty') return (
          <span key={i} style={{ background: '#1f6feb', color: '#fff', fontSize: 10, padding: '1px 6px', borderRadius: 6, fontWeight: 700 }}>數量：{p.qty}</span>
        );
        if (p.kind === 'manual') return (
          <span key={i} style={{ background: '#f0ad4e', color: '#fff', fontSize: 9, padding: '1px 5px', borderRadius: 6 }}> 補登</span>
        );
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

/* 工單明細 — 多規格卡片（GET upload-rows） */
function SpecArea({ order: o }) {
  const [rows, setRows] = useState(null); // null = 載入中

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api('/api/orders/' + encodeURIComponent(o.orderNo) + '/upload-rows');
      const data = (r.ok && r.data.rows) ? r.data.rows : [];
      if (alive) setRows(data);
    })();
    return () => { alive = false; };
  }, [o.orderNo]);

  if (rows === null) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>載入規格中...</div>;

  const specs = rows.length > 0 ? rows : [{
    productSpec: o.productSpec, moldSpec: o.moldSpec, material: o.material,
    dispatchQty: o.dispatchQty, bladeCount: o.bladeCount, machineSPM: o.machineSPM,
    unitWeight: o.unitWeight, totalWeight: o.totalWeight,
  }];

  const empty = <span className="info-empty">—</span>;
  const dateCard = (
    <div className="spec-card">
      <div className="sc-label">📅 生產日期</div>
      <div className="sc-value">{o.productionDate ? String(o.productionDate).slice(0, 10) : empty}</div>
    </div>
  );

  if (specs.length === 1) {
    const s = specs[0];
    return (
      <>
        <div className="spec-cards-wrap"><div className="spec-cards">
          {dateCard}
          <div className="spec-card wide"><div className="sc-label">🔧 生產規格</div><div className="sc-value">{s.productSpec || empty}</div></div>
          <div className="spec-card"><div className="sc-label">⚙ 模具</div><div className="sc-value">{s.moldSpec || empty}</div></div>
          <div className="spec-card"><div className="sc-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="box" size={12} />領料</div><div className="sc-value">{s.material || empty}</div></div>
        </div></div>
        <div className="spec-cards-wrap"><div className="spec-stats">
          <SpecStat label="派工數" value={s.dispatchQty} unit="片" />
          <SpecStat label="刀數" value={s.bladeCount} />
          <SpecStat label="機器SPM" value={s.machineSPM} />
          <SpecStat label="一片理論重" value={s.unitWeight} unit="kg" />
          <SpecStat label="全部總重量" value={s.totalWeight} unit="kg" />
        </div></div>
      </>
    );
  }

  const cols = Math.min(specs.length, 4);
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{specs.length} 種規格（左右滑動查看）</div>
      <div className="spec-cards-wrap">
        <div className="spec-cards spec-multi-grid" style={{ '--ms-cols': cols }}>
          {specs.map((s, i) => <MultiSpecCard key={i} s={s} i={i} />)}
        </div>
      </div>
    </>
  );
}

function SpecStat({ label, value, unit }) {
  return (
    <div className="spec-stat">
      <div className="ss-label">{label}</div>
      <div className="ss-value">{value || '—'}{value && unit ? <span className="ss-unit">{unit}</span> : null}</div>
    </div>
  );
}

function MultiSpecCard({ s, i }) {
  const fields = [
    { label: '生產規格', value: s.productSpec, bold: true },
    { label: '模具', value: s.moldSpec },
    { label: '領料', value: s.material },
    { label: '派工數', value: s.dispatchQty, unit: '片' },
    { label: '刀數', value: s.bladeCount },
    { label: 'SPM', value: s.machineSPM },
    { label: '單重', value: s.unitWeight, unit: 'kg' },
    { label: '總重', value: s.totalWeight, unit: 'kg' },
  ];
  const shown = fields.filter(f => f.value);
  return (
    <div style={{ flex: '0 0 auto', minWidth: 260, maxWidth: 340, background: 'var(--bg)', borderRadius: 12, padding: 14, borderLeft: '3px solid var(--brand)' }}>
      <div style={{ fontSize: 11, color: 'var(--brand)', fontWeight: 700, marginBottom: 8 }}>規格 {i + 1}</div>
      {shown.length === 0
        ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>—</div>
        : shown.map((f, k) => (
          <div key={k} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13, ...(f.bold ? { marginBottom: 4 } : {}) }}>
            <span style={{ color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap', minWidth: 55 }}>{f.label}：</span>
            <span style={{ color: 'var(--ink)', fontWeight: f.bold ? 700 : 600, wordBreak: 'break-all', ...(f.bold ? { fontSize: 14 } : {}) }}>
              {String(f.value)}{f.unit ? <span style={{ color: 'var(--muted)', fontSize: 11 }}> {f.unit}</span> : null}
            </span>
          </div>
        ))}
    </div>
  );
}

/* 設備參數 — GET equipment-params */
function EquipmentArea({ orderNo }) {
  const [state, setState] = useState({ loading: true, error: '', ep: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await api('/api/equipment-params/' + encodeURIComponent(orderNo));
      if (!alive) return;
      if (!r.ok) { setState({ loading: false, error: r.error || '載入失敗', ep: null }); return; }
      setState({ loading: false, error: '', ep: r.data.equipmentParam });
    })();
    return () => { alive = false; };
  }, [orderNo]);

  if (state.loading) return <div style={{ padding: 10, color: 'var(--muted)', fontSize: 12 }}>載入中...</div>;
  if (state.error) return <div style={{ padding: 10, color: 'var(--brand)', fontSize: 13 }}>{state.error}</div>;
  if (!state.ep) return <div style={{ padding: 10, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>尚未上傳設備參數</div>;

  const ep = state.ep;
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <tbody>
        {EP_FIELDS.map(([k, label]) => {
          const v = ep[k];
          const empty = (v == null || v === '');
          return (
            <tr key={k}>
              <td style={{ padding: '4px 8px', color: 'var(--muted)', fontSize: 11, width: '35%' }}>{label}</td>
              <td style={{ padding: '4px 8px', fontSize: 13, fontWeight: 600 }}>
                {empty ? <span style={{ color: 'var(--muted)' }}>—</span> : String(v)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ====================== 當日匯總 panel ====================== */

function SummaryPanel({ from, to, buildSummaryGroups, onDownload, onClose }) {
  const groups = buildSummaryGroups(from, to);
  const dateLabel = from === to ? from : `${from} 至 ${to}`;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>當日匯總 · {dateLabel}</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={onDownload}>📥 下載 CSV</button>
          <button className="btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={onClose}>收合</button>
        </div>
      </div>
      {(!groups || groups.length === 0)
        ? <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>區間內沒有資料</div>
        : groups.map((g, gi) => <SummaryGroup key={gi} g={g} />)}
    </div>
  );
}

function SummaryGroup({ g }) {
  const t = g.target;
  const prepMin = Math.round(g.totals.sumPrep / 60);
  const prodMin = Math.round(g.totals.sumProd / 60);
  const abnMin = Math.round(g.totals.sumAbn / 60);
  const prepRate = (t.prepMinutes > 0 && prepMin > 0) ? (t.prepMinutes / prepMin * 100).toFixed(1) : '—';
  const prodRate = t.workMinutes > 0 ? (prodMin / t.workMinutes * 100).toFixed(1) : '—';
  const effRate = (pPrep, pProd) => pPrep > 0 ? (pProd / pPrep).toFixed(2) : '—';
  const targetEff = (t.prepMinutes > 0 && t.workMinutes > 0) ? (t.workMinutes / t.prepMinutes).toFixed(2) : null;
  const effColor = (pPrep, pProd) => {
    if (pPrep <= 0) return 'var(--muted)';
    if (!targetEff) return '#1f6feb';
    return (pProd / pPrep) < parseFloat(targetEff) ? 'var(--brand)' : '#1f6feb';
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{g.ymd} · {g.machineId}</strong>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          目標 — 準備 {t.prepMinutes || '—'} / 實績 {t.workMinutes || '—'} 分{targetEff ? ' / 效益率 ' + targetEff : ''}
        </span>
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
            {g.orderRows.map((r, ri) => {
              const rPrep = Math.round(r.prepSec / 60);
              const rProd = Math.round(r.prodSec / 60);
              return (
                <tr key={ri}>
                  <td style={{ padding: '6px 8px', fontWeight: 700, fontSize: 12 }}>
                    {r.orderNo}
                    {r.isCrossDay && <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6, background: '#fff8e8', color: '#b8860b', marginLeft: 4 }}>隔日</span>}
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
              <td style={{
                padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center',
                color: (targetEff && effRate(prepMin, prodMin) !== '—' && parseFloat(effRate(prepMin, prodMin)) >= parseFloat(targetEff)) ? 'var(--success)' : 'var(--brand)',
              }}>{effRate(prepMin, prodMin)}{targetEff ? ' / ' + targetEff : ''}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', color: 'var(--brand)' }}>{abnMin}</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--muted)', fontSize: 12 }}>達成度</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', ...(prepRate !== '—' && parseFloat(prepRate) >= 100 ? { color: 'var(--success)' } : {}) }}>{prepRate}{prepRate !== '—' ? '%' : ''}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontWeight: 800, textAlign: 'center', ...(prodRate !== '—' && parseFloat(prodRate) >= 100 ? { color: 'var(--success)' } : {}) }}>{prodRate}{prodRate !== '—' ? '%' : ''}</td>
              <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--muted)' }}>—</td>
              <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--muted)' }}>—</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
