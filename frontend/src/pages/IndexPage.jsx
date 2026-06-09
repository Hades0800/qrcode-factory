import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import { fmtTime, fmtDuration, escapeHtml } from '../lib/format';
import { validOrderNo } from '../lib/orderPhases';
import { canModifyRecords } from '../lib/permissions';
import { MACHINES } from '../lib/machineTargets';

// ====== 步驟定義（對應原 index.html）======
// 作業準備（21/22）已停用；保留空陣列給歷史資料 fallback lookup
const PRE_STEPS = [];

// kind: 'simple' = 直接記錄（fixedNote 為固定備註）
const STEPS = [
  { id: '40', kind: 'simple', title: '01. 生產準備', hint: '含清理、料模刀與試模', fixedNote: '含清理、料模刀與試模' },
  { id: '41', kind: 'simple', title: '02. 生產開始', hint: '生產中斷參數調整／多次任何中斷生產／無論是否連續生產', fixedNote: null },
];

const ACTIONS_FINISH = { id: '11', title: '工單完成與結束', hint: '開始新的製造工單', style: 'act-success', icon: '✓' };

const STEP_FIELD = {
  '21': { time: 'step21At', note: null }, '22': { time: 'step22At', note: null },
  '23': { time: 'step23At', note: null }, '1': { time: 'step1At', note: null },
  '2': { time: 'step2At', note: null }, '3': { time: 'step3At', note: null },
  '4': { time: 'step4At', note: null }, '5': { time: 'step5At', note: null },
  '8': { time: 'step8At', note: null }, '40': { time: 'step40At', note: null },
  '41': { time: 'step41At', note: null }, '6': { time: 'step6At', note: null },
  '7': { time: 'step7At', note: null }, '11': { time: 'step11At', note: null },
  '12': { time: 'step12At', note: 'step12Note' }, '13': { time: 'step13At', note: 'step13Note' },
};

const NEW_SPEC_ASPECT_LABELS = {
  raw: '原料', dim: '長寬', mold: '模具', mat: '材料', swm: 'SWM/LWM',
};
function formatNewSpecAspects(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) return '';
  return aspects.map(k => NEW_SPEC_ASPECT_LABELS[k] || k).join('、');
}
function formatNewSpecLabel(aspects) {
  const s = formatNewSpecAspects(aspects);
  return s ? '新製規格-' + s : '新製規格';
}

// ====== 圖示（Lucide-style，inline SVG 以 React 呈現）======
const ICON_SVG = {
  check: { paths: '<polyline points="20 6 9 17 4 12"/>' },
  play: { paths: '<polygon points="6 4 20 12 6 20 6 4"/>', fill: true },
  pause: { paths: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', fill: true },
  box: { paths: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  sparkles: { paths: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z"/>' },
  alert: { paths: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  clock: { paths: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
  coffee: { paths: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>' },
  gear: { paths: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
  ban: { paths: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>' },
  edit: { paths: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>' },
  clipboard: { paths: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' },
  camera: { paths: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>' },
  octagon: { paths: '<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>' },
};
function Icon({ name, size = 16, color }) {
  const def = ICON_SVG[name];
  if (!def) return null;
  const stroke = color || 'currentColor';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
      fill={def.fill ? stroke : 'none'} stroke={stroke} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: -3, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: def.paths }}
    />
  );
}

const pad = n => String(n).padStart(2, '0');
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseAuxList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v) return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

const STATE_KEY = 'scan_state';

export default function IndexPage() {
  const { me } = useAuth();
  const toast = useToast();

  const [selectedMachine, setSelectedMachine] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [order, setOrder] = useState(null);
  const [orderInput, setOrderInput] = useState('');
  const [idleMachinesToday, setIdleMachinesToday] = useState(new Set());

  // 規格類型 modal
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [specPick, setSpecPick] = useState({ type: null, aspects: [] });
  const [specSaving, setSpecSaving] = useState(false);

  // 操作人員 / 輔助設備自訂 — 本地受控輸入
  const [operatorName, setOperatorName] = useState('');
  const [totalWorkers, setTotalWorkers] = useState('');
  const [auxCustom, setAuxCustom] = useState('');

  // 中斷 / 完成 modal
  const [interruptModal, setInterruptModal] = useState(null); // null | { stage:'list' } | { stage:'note', opt }
  const [intNote, setIntNote] = useState('');
  const [completeModal, setCompleteModal] = useState(null); // null | { backfillOpen }
  const [cmpIndep, setCmpIndep] = useState('可分開獨立運作');
  const [cmpQc, setCmpQc] = useState('');
  const [cmpBackfillTime, setCmpBackfillTime] = useState('');

  // 中斷補登（04 區塊內）
  const [intBfOpen, setIntBfOpen] = useState(false);
  const [intBfReason, setIntBfReason] = useState('');
  const [intBfNote, setIntBfNote] = useState('');
  const [intBfStart, setIntBfStart] = useState('');
  const [intBfEnd, setIntBfEnd] = useState('');

  // 更換規格輸入
  const [specChangeText, setSpecChangeText] = useState('');
  const [specChangeQc, setSpecChangeQc] = useState('');

  // 步驟補登展開狀態 + 暫存值
  const [backfillOpen, setBackfillOpen] = useState({}); // { [stepId]: bool }
  const [bfVals, setBfVals] = useState({}); // { [stepId]: { date, time, opt } }

  // 即時計時 tick
  const [, setTick] = useState(0);

  // 掃描器
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTitle, setScannerTitle] = useState('請掃描 QR Code');
  const [cameraError, setCameraError] = useState('');
  const scannerRef = useRef(null);
  const scanModeRef = useRef(null);

  const canEdit = canModifyRecords(me);

  // ── 狀態保存 ──
  const saveState = useCallback((machine, no) => {
    if (!me || !me.id) return;
    localStorage.setItem(STATE_KEY, JSON.stringify({ leaderId: me.id, selectedMachine: machine, orderNo: no }));
  }, [me]);
  const clearState = useCallback(() => localStorage.removeItem(STATE_KEY), []);

  // ── 即時計時器：有暫停中才每秒 tick ──
  const isPaused = !!((order?.pause12?.active) || (order?.pause13?.active));
  useEffect(() => {
    if (!isPaused) return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [isPaused]);

  // ── 無工令機台（今日）──
  const loadIdleMachines = useCallback(async () => {
    const r = await api('/api/idle-events?limit=50');
    if (!r.ok) return;
    const now = new Date();
    const set = new Set((r.data.events || []).filter(e => {
      const d = new Date(e.createdAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    }).map(e => e.machineNo));
    setIdleMachinesToday(set);
  }, []);

  // ── 工單載入 ──
  const setOrderByNo = useCallback(async (rawNo) => {
    let no = String(rawNo || '').trim().toUpperCase();
    if (!no) { toast('工單號不可空白', 'error'); return; }
    if (!validOrderNo(no)) { toast('工單號格式錯誤：需 1 個英文字母 + 10 個數字（例：F1150407024）', 'error'); return; }
    if (!selectedMachine) { toast('請先選擇機台', 'error'); return; }
    const r = await api('/api/orders/' + encodeURIComponent(no));
    if (!r.ok) {
      if (r.status === 409 && r.data && r.data.code === 'SOFT_DELETED') {
        alert('工單「' + no + '」之前已被刪除。\n\n請聯絡管理員到 admin 頁面的「回收桶 → 已刪除工單」救回，或改用其他工單號。');
        return;
      }
      toast(r.error, 'error');
      return;
    }
    if (r.data.wasCreated) {
      const ok = confirm('系統中還沒有「' + no + '」這張工單的上傳資料。\n\n請再次確認單號是否輸入正確。\n\n如確定要建立並記錄，按「確定」；\n若可能打錯了，按「取消」回上一步。');
      if (!ok) return;
    }
    let o = r.data.order;
    const mr = await api('/api/orders/' + encodeURIComponent(no) + '/machine', {
      method: 'POST', body: { machineNo: selectedMachine },
    });
    if (mr.ok) o = mr.data.order;
    setOrderNo(no);
    setOrder(o);
    setOperatorName(o.operatorName || '');
    setTotalWorkers(o.totalWorkers != null && o.totalWorkers !== '' ? String(o.totalWorkers) : '');
    setAuxCustom(o.auxEquipmentCustom || '');
    saveState(selectedMachine, no);
  }, [selectedMachine, saveState, toast]);

  // ── 啟動：載入無工令機台 + 恢復上次進度 ──
  const restoredRef = useRef(false);
  const pendingRestoreOrderRef = useRef(null);
  useEffect(() => {
    if (!me) return;
    loadIdleMachines();
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (s && s.leaderId === me.id && s.selectedMachine) {
        setSelectedMachine(s.selectedMachine);
        if (s.orderNo) {
          setOrderInput(s.orderNo);
          // 恢復工單需 selectedMachine 已就緒 → 下一輪 effect 觸發
          pendingRestoreOrderRef.current = s.orderNo;
        }
        toast('已恢復上次進度', 'success');
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  useEffect(() => {
    if (selectedMachine && pendingRestoreOrderRef.current) {
      const no = pendingRestoreOrderRef.current;
      pendingRestoreOrderRef.current = null;
      setOrderByNo(no);
    }
  }, [selectedMachine, setOrderByNo]);

  // ── 機台選擇（第一步）──
  function selectMachine(no) {
    if (idleMachinesToday.has(no)) {
      toast('此機台今日已記錄無工令，請到紀錄頁取消後再選擇', 'error');
      return;
    }
    setSelectedMachine(no);
    saveState(no, orderNo);
  }
  function changeMachine() {
    clearState();
    setSelectedMachine('');
    setOrderNo(''); setOrder(null); setOrderInput('');
  }

  async function recordIdle() {
    if (!selectedMachine) { toast('請先選擇機台', 'error'); return; }
    if (!confirm('確定記錄「生產無工令」？\n\n機台：' + selectedMachine + '\n（記錄後會跳回選機台）')) return;
    const note = prompt('備註（可留白）：', '') || '';
    const r = await api('/api/idle-events', { method: 'POST', body: { machineNo: selectedMachine, note } });
    if (!r.ok) { toast(r.error || '失敗', 'error'); return; }
    toast('已記錄無工令：' + selectedMachine, 'success');
    setSelectedMachine(''); setOrderInput('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadIdleMachines();
  }

  function changeOrder() {
    setOrderNo(''); setOrder(null); setOrderInput('');
    saveState(selectedMachine, '');
  }

  // ── 規格類型 modal ──
  function openSpecModal() {
    if (!order) { toast('請先載入工單', 'error'); return; }
    setSpecPick({
      type: order.specType || null,
      aspects: Array.isArray(order.newSpecAspects) ? [...order.newSpecAspects] : [],
    });
    setSpecModalOpen(true);
  }
  async function confirmSpecType() {
    if (!specPick.type) return;
    setSpecSaving(true);
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/spec-type', {
      method: 'POST', body: { specType: specPick.type, aspects: specPick.aspects },
    });
    setSpecSaving(false);
    if (!r.ok) {
      const hint = r.data && r.data.hint ? '\n' + r.data.hint : '';
      alert('設定失敗（' + (r.status || '?') + '）：' + (r.error || '未知錯誤') + hint);
      return;
    }
    setOrder(o => o ? {
      ...o,
      specType: r.data.specType,
      difficultyFactor: null,
      newSpecAspects: r.data.newSpecAspects ? String(r.data.newSpecAspects).split(',').filter(Boolean) : [],
    } : o);
    saveState(selectedMachine, orderNo);
    setSpecModalOpen(false);
    toast('已設定規格類型', 'success');
  }

  // ── 第三步：更換範圍 ──
  async function setChangeScope(val) {
    if (!order || !orderNo) { toast('請先載入工單', 'error'); return; }
    const next = val || null;
    const old = order.changeScope || null;
    if (next === old) return;
    setOrder(o => ({ ...o, changeScope: next }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/change-scope', {
      method: 'POST', body: { changeScope: next },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, changeScope: old }));
      toast(r.error || '設定失敗，已還原', 'error');
    }
  }

  // ── 第四步：原料類型 ──
  async function setMaterialType(val) {
    if (!order || !orderNo) { toast('請先載入工單', 'error'); return; }
    const next = val || null;
    const old = order.materialType || null;
    if (next === old) return;
    setOrder(o => ({ ...o, materialType: next }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/material-type', {
      method: 'POST', body: { materialType: next },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, materialType: old }));
      toast(r.error || '設定失敗，已還原', 'error');
    }
  }

  // ── 輔助設備（複選 + 自訂）──
  async function toggleAux(val) {
    if (!order || !orderNo) { toast('請先載入工單', 'error'); return; }
    if (!val) return;
    const oldList = parseAuxList(order.auxEquipment);
    const newList = oldList.includes(val) ? oldList.filter(x => x !== val) : [...oldList, val];
    const oldStr = order.auxEquipment || null;
    setOrder(o => ({ ...o, auxEquipment: newList.length ? newList.join(',') : null }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/aux-equipment', {
      method: 'POST', body: { auxEquipment: newList },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, auxEquipment: oldStr }));
      toast(r.error || '設定失敗，已還原', 'error');
    }
  }
  async function commitAuxCustom() {
    if (!order || !orderNo) return;
    const val = (auxCustom || '').trim();
    const next = val === '' ? null : val;
    const old = order.auxEquipmentCustom || null;
    if (next === old) return;
    setOrder(o => ({ ...o, auxEquipmentCustom: next }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/aux-equipment', {
      method: 'POST', body: { auxEquipmentCustom: next },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, auxEquipmentCustom: old }));
      setAuxCustom(old || '');
      toast(r.error || '儲存失敗，已還原', 'error');
    }
  }
  async function clearAux() {
    if (!order || !orderNo) return;
    const oldStr = order.auxEquipment || null;
    const oldCustom = order.auxEquipmentCustom || null;
    if (oldStr == null && oldCustom == null) return;
    setOrder(o => ({ ...o, auxEquipment: null, auxEquipmentCustom: null }));
    setAuxCustom('');
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/aux-equipment', {
      method: 'POST', body: { auxEquipment: null, auxEquipmentCustom: null },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, auxEquipment: oldStr, auxEquipmentCustom: oldCustom }));
      setAuxCustom(oldCustom || '');
      toast(r.error || '清除失敗', 'error');
    }
  }

  // ── 作業人員 ──
  async function commitOperatorName() {
    if (!order || !orderNo) return;
    const val = (operatorName || '').trim();
    const next = val === '' ? null : val;
    const old = order.operatorName || null;
    if (next === old) return;
    setOrder(o => ({ ...o, operatorName: next }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/operation-info', {
      method: 'POST', body: { operatorName: next },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, operatorName: old }));
      setOperatorName(old || '');
      toast(r.error || '儲存失敗，已還原', 'error');
    }
  }
  async function commitTotalWorkers(raw) {
    if (!order || !orderNo) return;
    const next = raw === '' ? null : Number(raw);
    const old = (order.totalWorkers == null) ? null : Number(order.totalWorkers);
    if (next === old) return;
    setOrder(o => ({ ...o, totalWorkers: next }));
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/operation-info', {
      method: 'POST', body: { totalWorkers: next },
    });
    if (!r.ok) {
      setOrder(o => ({ ...o, totalWorkers: old }));
      setTotalWorkers(old == null ? '' : String(old));
      toast(r.error || '儲存失敗，已還原', 'error');
    }
  }

  // ── 步驟記錄 / 補登 / 取消 ──
  const getCurrentStep = useCallback(() => {
    if (!order) return '尚未開始';
    let latest = null, latestTime = 0;
    (order.stepEntries || []).forEach(e => {
      const t = new Date(e.recordedAt).getTime();
      if (t > latestTime) {
        const stepDef = STEPS.find(s => s.id === e.stepNo) || PRE_STEPS.find(s => s.id === e.stepNo);
        if (stepDef) { latestTime = t; latest = stepDef; }
      }
    });
    STEPS.forEach(s => {
      const f = STEP_FIELD[s.id];
      if (!f || !f.time) return;
      const t = order[f.time];
      if (t && new Date(t).getTime() > latestTime) { latestTime = new Date(t).getTime(); latest = s; }
    });
    return latest ? latest.title : '尚未開始';
  }, [order]);

  async function recordStepEntry(stepNo) {
    if (!orderNo) return;
    let note = null;
    if (confirm('要加文字備註嗎？')) {
      const text = prompt('請輸入備註：', '');
      if (text === null) return;
      if (text.trim()) note = text.trim();
    }
    const stepDef = STEPS.find(s => s.id === stepNo) || PRE_STEPS.find(s => s.id === stepNo);
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries', {
      method: 'POST', body: { stepNo, note },
    });
    if (!r.ok) { toast(r.error, 'error'); return; }
    setOrder(r.data.order);
    if (r.data.forcedFromPrev && r.data.entry) {
      const msg = r.data.forcedReason === 'day_start'
        ? '📅 每日第一單，自動設為 ' + fmtTime(r.data.entry.recordedAt)
        : '⚓ 已自動銜接上一張工單時間：' + fmtTime(r.data.entry.recordedAt);
      toast(msg, 'success');
    } else {
      toast('✓ ' + (stepDef ? stepDef.title : '工序 ' + stepNo), 'success');
    }
  }

  async function backfillStepEntry(stepNo, forcedYmd, forcedHM) {
    const v = bfVals[stepNo] || {};
    const dateVal = forcedYmd || v.date || todayYmd();
    const timeVal = forcedHM || v.time || '';
    if (!dateVal || !timeVal) { toast('請填寫日期和時間', 'error'); return; }
    const dt = new Date(dateVal + 'T' + timeVal);
    if (isNaN(dt)) { toast('日期時間格式錯誤', 'error'); return; }
    let note = null;
    if (confirm('要加文字備註嗎？')) {
      const text = prompt('請輸入備註：', '');
      if (text === null) return;
      if (text.trim()) note = text.trim();
    }
    if (!confirm('確認補登？\n時間：' + fmtTime(dt.toISOString()) + (note ? '\n備註：' + note : '') + '\n將標記為「補登」')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries', {
      method: 'POST', body: { stepNo, recordedAt: dt.toISOString(), note },
    });
    if (!r.ok) { toast(r.error, 'error'); return; }
    setOrder(r.data.order);
    setBackfillOpen(b => ({ ...b, [stepNo]: false }));
    if (r.data.forcedFromPrev && r.data.entry) {
      const msg = r.data.forcedReason === 'day_start'
        ? '📅 每日第一單，自動設為 ' + fmtTime(r.data.entry.recordedAt)
        : '⚓ 已自動銜接上一張工單時間：' + fmtTime(r.data.entry.recordedAt);
      toast(msg, 'success');
    } else {
      toast('✓ 已補登（標記為補登）', 'success');
    }
  }

  async function cancelStepEntry(entryId) {
    if (!confirm('確定取消此筆紀錄？（5 分鐘內可取消）')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries/' + entryId, { method: 'DELETE' });
    if (!r.ok) { toast(r.error, 'error'); return; }
    setOrder(r.data.order);
    toast('已取消', 'success');
  }

  // ── 更換規格（30）──
  async function recordSpecChange() {
    const text = (specChangeText || '').trim();
    if (!text) { toast('請填入規格描述', 'error'); return; }
    const qc = Number(specChangeQc);
    if (!Number.isInteger(qc) || qc < 0) { toast('請填入前一規格實際生產數量（非負整數）', 'error'); return; }
    if (!confirm('確定記錄更換規格為「' + text + '」？\n前一規格數量：' + qc)) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/step-entries', {
      method: 'POST', body: { stepNo: '30', note: text, qcActualQty: qc },
    });
    if (!r.ok) { toast(r.error, 'error'); return; }
    setOrder(r.data.order);
    setSpecChangeText(''); setSpecChangeQc('');
    toast('📋 已記錄更換：' + text, 'success');
  }

  // ── 暫停 / 恢復 ──
  async function executePause(type, title, note, qcActualQty) {
    if (!orderNo) return;
    const body = { type, note, activeStep: getCurrentStep() };
    if (qcActualQty !== undefined && qcActualQty !== null) body.qcActualQty = qcActualQty;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/pause', { method: 'POST', body });
    if (!r.ok) { toast(r.error, 'error'); return; }
    setOrder(r.data.order);
    toast(title + ' — 開始計時', 'success');
  }
  async function resumePause(type) {
    if (!orderNo) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/resume', { method: 'POST', body: { type } });
    if (!r.ok) { toast(r.error, 'error'); return; }
    const dur = r.data.resumed ? r.data.resumed.duration : 0;
    setOrder(r.data.order);
    toast('已恢復生產（暫停 ' + fmtDuration(dur) + '）', 'success');
  }

  async function submitInterruptBackfill() {
    if (!orderNo) return;
    if (!intBfReason) { toast('請選擇中斷原因', 'error'); return; }
    const [reason, type] = intBfReason.split('|');
    const detail = (intBfNote || '').trim();
    const note = detail ? reason + ' - ' + detail : reason;
    if (!intBfStart || !intBfEnd) { toast('請填寫開始和結束時間', 'error'); return; }
    if (!confirm('確認補登？\n原因：' + note + '\n開始：' + intBfStart + '\n結束：' + intBfEnd)) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/pause-backfill', {
      method: 'POST',
      body: { type, note, startAt: new Date(intBfStart).toISOString(), endAt: new Date(intBfEnd).toISOString() },
    });
    if (!r.ok) { toast(r.error || '補登失敗', 'error'); return; }
    setOrder(r.data.order);
    setIntBfOpen(false); setIntBfReason(''); setIntBfNote(''); setIntBfStart(''); setIntBfEnd('');
    toast('✓ 已補登中斷', 'success');
  }

  // ── 完成工單 ──
  function resetAfterFinish() {
    clearState();
    setOrderNo(''); setOrder(null); setSelectedMachine(''); setOrderInput('');
    toast('已完成，請選擇機台開始下一張工單', 'success');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function submitComplete(auxNote) {
    const note = auxNote + '｜' + cmpIndep;
    const qc = Number(cmpQc);
    if (!Number.isInteger(qc) || qc < 0) { toast('請填入實際生產數量（非負整數）', 'error'); return; }
    let recordedAt = null;
    if (cmpBackfillTime) {
      const dt = new Date(cmpBackfillTime);
      if (isNaN(dt)) { toast('補登時間格式錯誤', 'error'); return; }
      if (dt > new Date()) { toast('補登時間不能超過現在', 'error'); return; }
      recordedAt = dt.toISOString();
    }
    const summary = (recordedAt ? `「${note}」\n補登時間：${cmpBackfillTime.replace('T', ' ')}` : `「${note}」`) + `\n數量：${qc}`;
    if (!confirm('確定完成此工單？\n' + summary)) return;
    setCompleteModal(null);
    const r = await api('/api/orders/' + encodeURIComponent(orderNo) + '/steps/11', {
      method: 'POST', body: { note, recordedAt, qcActualQty: qc },
    });
    if (!r.ok) {
      toast(r.error, 'error');
      if (r.data && r.data.order) setOrder(r.data.order);
      return;
    }
    const stepDef = ACTIONS_FINISH;
    toast('✓ 已記錄 ' + stepDef.title, 'success');
    resetAfterFinish();
  }

  // ============= 掃描器 =============
  function loadHtml5Qrcode() {
    return new Promise((resolve, reject) => {
      if (window.Html5Qrcode) return resolve(window.Html5Qrcode);
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      s.onload = () => window.Html5Qrcode ? resolve(window.Html5Qrcode) : reject(new Error('載入失敗'));
      s.onerror = () => reject(new Error('無法載入掃描器'));
      document.head.appendChild(s);
    });
  }
  function onScanSuccess(decodedText) {
    if (scanModeRef.current === 'order') {
      closeScanner();
      const raw = String(decodedText || '').trim();
      let extracted = raw;
      try {
        if (/^https?:\/\//i.test(raw)) {
          const u = new URL(raw);
          const q = u.searchParams;
          extracted = q.get('order') || q.get('orderNo') || q.get('no') || q.get('id') ||
            u.pathname.split('/').filter(Boolean).pop() || raw;
        }
      } catch { /* ignore */ }
      setOrderInput(extracted);
      toast('掃到：' + raw.slice(0, 40) + (raw.length > 40 ? '…' : '') + '，請確認後按確定', 'success');
    }
  }
  async function openScanner(mode) {
    scanModeRef.current = mode;
    setScannerTitle(mode === 'order' ? '請對準工單條碼' : '請掃描 QR Code');
    setCameraError('');
    setScannerOpen(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('此瀏覽器不支援相機（需 HTTPS + 現代瀏覽器）'); return;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      setCameraError('需在 HTTPS 網站才能使用相機'); return;
    }
    let Html5Qrcode;
    try { Html5Qrcode = await loadHtml5Qrcode(); }
    catch (e) { setCameraError(e.message || '掃描器載入失敗'); return; }
    try {
      if (!scannerRef.current) scannerRef.current = new Html5Qrcode('qr-reader');
    } catch (e) { setCameraError('掃描器初始化失敗：' + e.message); return; }
    scannerRef.current.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 260 } },
      onScanSuccess, () => {},
    ).catch(err => {
      const errStr = String((err && err.message) || err);
      let friendly = errStr;
      if (/Permission|NotAllowed|denied/i.test(errStr)) friendly = '相機權限被拒絕。請到瀏覽器設定中開啟相機權限後重新整理。';
      else if (/NotFound|no.*camera/i.test(errStr)) friendly = '找不到相機裝置。';
      else if (/NotReadable|in use|busy/i.test(errStr)) friendly = '相機被其他 App 佔用，請關閉其他相機 App 後再試。';
      else if (/Overconstrained/i.test(errStr)) {
        scannerRef.current.start({ facingMode: 'user' }, { fps: 10, qrbox: { width: 260, height: 260 } }, onScanSuccess, () => {})
          .catch(() => setCameraError('相機規格不支援：' + errStr));
        return;
      }
      setCameraError(friendly);
    });
  }
  async function closeScanner() {
    setScannerOpen(false);
    if (scannerRef.current) { try { await scannerRef.current.stop(); } catch { /* ignore */ } }
  }
  useEffect(() => () => { if (scannerRef.current) { try { scannerRef.current.stop(); } catch { /* ignore */ } } }, []);

  // ============= 衍生狀態 =============
  const ok2 = !!(order && order.specType);
  const ok3 = ok2 && !!(order && order.changeScope);
  const ok4 = ok3 && !!(order && order.materialType);
  const opNameVal = (order?.operatorName || '').toString().trim();
  const opCount = order?.totalWorkers;
  const ok5 = ok4 && opNameVal !== '' && opCount != null && Number(opCount) >= 1;

  // ============= 渲染 =============
  return (
    <div className="container">
      {/* 第一步：機台 */}
      <div className="card">
        <h2>選擇機台 <span className="required">第一步</span></h2>
        {!selectedMachine ? (
          <div className="machine-grid">
            {MACHINES.map(m => {
              const idle = idleMachinesToday.has(m.id);
              return (
                <button
                  key={m.id}
                  className={'machine-btn' + (idle ? ' disabled' : '')}
                  onClick={() => selectMachine(m.id)}
                >
                  <span className="m-num">{m.num}</span>
                  <span className="m-spec">{m.spec}</span>
                  {idle && <div className="m-tag">今日無工令</div>}
                </button>
              );
            })}
          </div>
        ) : (
          <div>
            <div className="order-display">
              <div className="label">機台</div>
              <div className="num" style={{ fontSize: 24, color: 'var(--brand)' }}>{selectedMachine}</div>
            </div>
            <button className="btn-secondary btn-block" style={{ marginTop: 14 }} onClick={changeMachine}>更換機台</button>
          </div>
        )}
      </div>

      {/* 第二步：工單號 */}
      {selectedMachine && (
        <div className="card">
          <h2>工單號 <span className="required">第二步</span></h2>
          {!order ? (
            <div>
              <button className="btn-primary btn-block" onClick={() => openScanner('order')}>
                <Icon name="camera" size={18} /> 掃描工單條碼
              </button>
              <div className="or-divider">或</div>
              <div className="row">
                <input
                  type="text" value={orderInput}
                  onChange={e => setOrderInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') setOrderByNo(orderInput); }}
                  placeholder="手動輸入工單號"
                />
                <button className="btn-secondary" style={{ flex: '0 0 90px' }} onClick={() => setOrderByNo(orderInput)}>確定</button>
              </div>
              <div className="or-divider">或</div>
              <button className="btn-block" style={{ background: '#6e6e73', color: '#fff', boxShadow: '0 2px 6px rgba(110,110,115,.25)' }} onClick={recordIdle}>
                <Icon name="octagon" size={18} /> 生產無工令
                <div style={{ fontSize: 11, fontWeight: 500, marginTop: 2, opacity: 0.85 }}>設備無稼動</div>
              </button>
            </div>
          ) : (
            <div>
              <div className="order-display">
                <div className="label">目前工單</div>
                <div className="num">{orderNo}</div>
                <div className="updated">{order.updatedAt ? '最後更新：' + fmtTime(order.updatedAt) : '尚未開始'}</div>
              </div>
              {/* 規格類型 */}
              <div style={{ marginTop: 14, padding: '12px 14px', background: '#f8f8fa', borderRadius: 10, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, fontWeight: 600, letterSpacing: 0.5 }}>規格類型</div>
                <SpecTypeDisplay order={order} />
                <button className="btn-secondary btn-block" style={{ marginTop: 8, fontSize: 13, padding: 10 }} onClick={openSpecModal}>＋ 設定 / 修改規格類型</button>
              </div>
              <button className="btn-secondary btn-block" style={{ marginTop: 14 }} onClick={changeOrder}>更換工單</button>
            </div>
          )}
        </div>
      )}

      {/* 第三步：設置準備（更換範圍）*/}
      {ok2 && (
        <div className="card">
          <h2>設置準備 <span className="required">第三步</span></h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ScopeBtn val="same" label="沿用前單" cur={order.changeScope} onClick={setChangeScope} />
            <ScopeBtn val="@" label="原料更換" cur={order.changeScope} onClick={setChangeScope} />
            <ScopeBtn val="#" label="模具" cur={order.changeScope} onClick={setChangeScope} />
            <ScopeBtn val="@#" label="原料與模具更換" cur={order.changeScope} onClick={setChangeScope} />
            <button
              onClick={() => setChangeScope('')}
              style={{ padding: 10, border: '1.5px solid var(--border)', borderRadius: 10, background: '#f8f8fa', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}
            >清除</button>
          </div>
        </div>
      )}

      {/* 輔助設備（第三步完成後顯示）*/}
      {ok3 && (
        <div className="card">
          <h2>輔助設備 <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>可複選</span></h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[['flat', '軋平機'], ['leveler', '整平機'], ['slitter', '分條機'], ['wave', '波浪機'], ['rewind', '收料機'], ['other', '其他設備']].map(([v, label]) => {
              const sel = parseAuxList(order.auxEquipment).includes(v);
              return (
                <button key={v} onClick={() => toggleAux(v)}
                  style={{ padding: 14, border: `2px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10, background: sel ? 'var(--brand)' : '#fff', color: sel ? '#fff' : 'var(--ink)', cursor: 'pointer', textAlign: 'center', fontWeight: 700, fontSize: 14 }}>
                  {label}
                </button>
              );
            })}
          </div>
          <input
            type="text" maxLength={100} placeholder="其他設備（可自填名稱）" autoComplete="off"
            value={auxCustom}
            onChange={e => setAuxCustom(e.target.value)}
            onBlur={commitAuxCustom}
            style={{ marginTop: 10, width: '100%', padding: '12px 14px', border: '2px solid var(--border)', borderRadius: 10, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}
          />
          <button onClick={clearAux} style={{ marginTop: 8, width: '100%', padding: 10, border: '1.5px solid var(--border)', borderRadius: 10, background: '#f8f8fa', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>清除全部</button>
        </div>
      )}

      {/* 第四步：原料 */}
      {ok3 && (
        <div className="card">
          <h2>原料 <span className="required">第四步</span></h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <MatBtn val="coil" label="捲料" cur={order.materialType} onClick={setMaterialType} />
            <MatBtn val="plate" label="板料" cur={order.materialType} onClick={setMaterialType} />
            <button onClick={() => setMaterialType('')} style={{ flex: '0 0 auto', padding: 14, border: '2px solid var(--border)', borderRadius: 10, background: '#f8f8fa', cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--muted)' }}>清除</button>
          </div>
        </div>
      )}

      {/* 第五步：作業人員 */}
      {ok4 && (
        <div className="card">
          <h2>作業人員 <span className="required">第五步</span></h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', color: 'var(--muted)', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>設備操作</label>
              <input
                type="text" maxLength={50} placeholder="請輸入姓名" autoComplete="off"
                value={operatorName}
                onChange={e => setOperatorName(e.target.value)}
                onBlur={commitOperatorName}
                style={{ width: '100%', padding: '12px 14px', border: '2px solid var(--border)', borderRadius: 10, fontSize: 15, background: '#fff', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: 'var(--muted)', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>全部作業人數</label>
              <select
                value={totalWorkers}
                onChange={e => { setTotalWorkers(e.target.value); commitTotalWorkers(e.target.value); }}
                style={{ width: '100%', padding: '12px 14px', border: '2px solid var(--border)', borderRadius: 10, fontSize: 15, background: '#fff', boxSizing: 'border-box', fontWeight: 700 }}
              >
                <option value="">請選擇</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 步驟區 */}
      {ok5 && (
        <StepsArea
          order={order} orderNo={orderNo} isPaused={isPaused} canEdit={canEdit}
          backfillOpen={backfillOpen} setBackfillOpen={setBackfillOpen}
          bfVals={bfVals} setBfVals={setBfVals}
          specChangeText={specChangeText} setSpecChangeText={setSpecChangeText}
          specChangeQc={specChangeQc} setSpecChangeQc={setSpecChangeQc}
          intBfOpen={intBfOpen} setIntBfOpen={setIntBfOpen}
          intBfReason={intBfReason} setIntBfReason={setIntBfReason}
          intBfNote={intBfNote} setIntBfNote={setIntBfNote}
          intBfStart={intBfStart} setIntBfStart={setIntBfStart}
          intBfEnd={intBfEnd} setIntBfEnd={setIntBfEnd}
          onRecordStep={recordStepEntry} onBackfillStep={backfillStepEntry}
          onCancelEntry={cancelStepEntry} onRecordSpecChange={recordSpecChange}
          onShowInterrupt={() => { setIntNote(''); setInterruptModal({ stage: 'list' }); }}
          onSubmitInterruptBackfill={submitInterruptBackfill}
          onShowComplete={(bf) => { setCmpIndep('可分開獨立運作'); setCmpQc(''); setCmpBackfillTime(''); setCompleteModal({ backfillOpen: !!bf }); }}
          onResume={resumePause}
        />
      )}

      {!canEdit && order && (
        <div className="card" style={{ background: 'var(--brand-soft)', border: '1px solid var(--brand)' }}>
          <div style={{ fontSize: 12, color: 'var(--brand)' }}>
            ⚠ 你目前的角色為「只能即時記錄」，無法補登/取消/修改既有紀錄
          </div>
        </div>
      )}

      {/* ===== 規格類型 modal ===== */}
      {specModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, maxWidth: 420, width: '100%', padding: 20, boxShadow: '0 12px 32px rgba(0,0,0,.25)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14, color: 'var(--ink)' }}>設定規格類型</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['new', '新製規格'], ['mass', '量產規格']].map(([v, label]) => {
                  const sel = specPick.type === v;
                  return (
                    <button key={v} onClick={() => setSpecPick(p => ({ type: v, aspects: v === 'new' ? p.aspects : [] }))}
                      style={{ flex: 1, padding: 14, border: `2px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10, background: sel ? 'var(--brand-soft)' : '#fff', color: sel ? 'var(--brand)' : 'var(--ink)', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {specPick.type === 'new' && (
              <div style={{ marginBottom: 16, padding: 12, background: '#fdf2f2', border: '1.5px dashed #d23535', borderRadius: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', marginBottom: 8 }}>差異項目（請選一個）</div>
                {[['mold', '模具'], ['mat', '材料'], ['swm', 'SWM/LWM']].map(([v, label]) => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer', fontSize: 14 }}>
                    <input type="radio" name="specAspect" checked={specPick.aspects.includes(v)}
                      onChange={() => setSpecPick(p => ({ ...p, aspects: [v] }))}
                      style={{ width: 18, height: 18, accentColor: '#d23535' }} />
                    {label}
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1, padding: 12 }} onClick={() => setSpecModalOpen(false)}>取消</button>
              <button className="btn-primary" style={{ flex: 1, padding: 12, opacity: specPick.type ? 1 : 0.4 }} disabled={!specPick.type || specSaving} onClick={confirmSpecType}>確定</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 生產中斷 modal ===== */}
      {interruptModal && (
        <div onClick={e => { if (e.target === e.currentTarget) setInterruptModal(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, boxShadow: '0 10px 40px rgba(0,0,0,.2)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, color: 'var(--ink)' }}>生產中斷</h3>
            {interruptModal.stage === 'list' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button className="btn-secondary" style={intOptStyle} onClick={() => setInterruptModal({ stage: 'note', opt: 'abnormal' })}><Icon name="alert" size={18} /><span>設備異常停機</span></button>
                <button className="btn-secondary" style={intOptStyle} onClick={() => setInterruptModal({ stage: 'note', opt: 'long' })}><Icon name="clock" size={18} /><span>超過1小時以上的停機</span></button>
                <button className="btn-secondary" style={intOptStyle} onClick={() => { setInterruptModal(null); executePause('12', '中午休息', '中午休息'); }}><Icon name="coffee" size={18} /><span>中午休息</span></button>
                <button className="btn-secondary" style={intOptStyle} onClick={() => setInterruptModal({ stage: 'note', opt: 'offwork' })}><Icon name="coffee" size={18} /><span>下班時間／隔日生產</span></button>
              </div>
            ) : (
              <div>
                <input
                  type={interruptModal.opt === 'offwork' ? 'number' : 'text'}
                  min={interruptModal.opt === 'offwork' ? '0' : undefined}
                  step={interruptModal.opt === 'offwork' ? '1' : undefined}
                  value={intNote}
                  onChange={e => setIntNote(e.target.value)}
                  placeholder={
                    interruptModal.opt === 'offwork' ? '實際生產數量（必填，整數）'
                      : interruptModal.opt === 'abnormal' ? '異常說明（必填，例：模具頓刀）'
                        : '補充說明（選填，例：模具維修）'
                  }
                  autoFocus
                  style={{ width: '100%', padding: 12, border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 15, boxSizing: 'border-box' }}
                />
                <button className="btn-primary" style={{ width: '100%', marginTop: 8, padding: 12, fontSize: 15 }}
                  onClick={() => {
                    const opt = interruptModal.opt;
                    if (opt === 'offwork') {
                      const qc = Number(intNote);
                      if (!Number.isInteger(qc) || qc < 0) { toast('請輸入此規格實際生產數量（非負整數）', 'error'); return; }
                      setInterruptModal(null);
                      executePause('12', '下班時間／隔日生產', '下班時間／隔日生產', qc);
                    } else if (opt === 'abnormal') {
                      const val = intNote.trim();
                      if (!val) { toast('請輸入異常說明', 'error'); return; }
                      setInterruptModal(null);
                      executePause('13', '設備異常停機', val);
                    } else {
                      const val = intNote.trim();
                      const note = val ? '超過1小時以上的停機 - ' + val : '超過1小時以上的停機';
                      setInterruptModal(null);
                      executePause('12', '超過1小時以上的停機', note);
                    }
                  }}>確認中斷</button>
              </div>
            )}
            <button onClick={() => setInterruptModal(null)} style={{ width: '100%', marginTop: 12, padding: 12, fontSize: 14, background: 'none', border: '1.5px solid var(--border)', borderRadius: 10, color: 'var(--muted)', cursor: 'pointer' }}>取消</button>
          </div>
        </div>
      )}

      {/* ===== 工單完成 modal ===== */}
      {completeModal && (
        <div onClick={e => { if (e.target === e.currentTarget) setCompleteModal(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, boxShadow: '0 10px 40px rgba(0,0,0,.2)', margin: 'auto' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--ink)' }}>本工單完成生產</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>① 請選擇是否含附屬設備：</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn-secondary" style={cmpOptStyle} onClick={() => submitComplete('含附屬設備')}><Icon name="gear" size={18} /><span>含附屬設備</span></button>
              <button className="btn-secondary" style={cmpOptStyle} onClick={() => submitComplete('不含附屬設備')}><Icon name="ban" size={18} /><span>不含附屬設備</span></button>
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>② 主設備與附屬設備：</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {['可分開獨立運作', '無法分開獨立運作'].map(v => (
                <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1.5px solid var(--border)', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}>
                  <input type="radio" name="cmpIndep" value={v} checked={cmpIndep === v} onChange={() => setCmpIndep(v)} style={{ width: 16, height: 16, accentColor: '#d23535' }} />
                  {v === '可分開獨立運作' ? '可以分開獨立運作' : '無法分開獨立運作'}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>③ 實際生產數量（必填）：</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.4 }}>單一規格工單：本工單完成的總數量。<br />多規格工單：最後一段規格的生產數量。</div>
            <input type="number" min="0" step="1" value={cmpQc} onChange={e => setCmpQc(e.target.value)} placeholder="輸入整數"
              style={{ width: '100%', padding: 12, border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 15, boxSizing: 'border-box' }} />
            <button onClick={() => setCompleteModal(m => ({ ...m, backfillOpen: !m.backfillOpen }))}
              style={{ width: '100%', marginTop: 14, padding: 10, background: 'none', border: '1.5px dashed var(--border)', borderRadius: 10, color: '#b8860b', fontSize: 13, cursor: 'pointer' }}>
              <Icon name="edit" size={14} /> 補登時間（不填用現在）
            </button>
            {completeModal.backfillOpen && (
              <div style={{ marginTop: 8 }}>
                <input type="datetime-local" value={cmpBackfillTime} onChange={e => setCmpBackfillTime(e.target.value)}
                  style={{ width: '100%', padding: 10, border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 14, boxSizing: 'border-box' }} />
              </div>
            )}
            <button onClick={() => setCompleteModal(null)} style={{ width: '100%', marginTop: 12, padding: 12, fontSize: 14, background: 'none', border: '1.5px solid var(--border)', borderRadius: 10, color: 'var(--muted)', cursor: 'pointer' }}>取消</button>
          </div>
        </div>
      )}

      {/* ===== 掃描 Modal ===== */}
      {scannerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.95)', zIndex: 100, display: 'flex', flexDirection: 'column', padding: 20 }}>
          <div style={{ color: '#fff', fontSize: 17, marginBottom: 14, textAlign: 'center', fontWeight: 600 }}>{scannerTitle}</div>
          <div id="qr-reader" style={{ width: '100%', maxWidth: 480, margin: '0 auto', background: '#000', borderRadius: 12, overflow: 'hidden', display: cameraError ? 'none' : 'block' }} />
          {cameraError && (
            <div style={{ color: '#fff', textAlign: 'center', padding: 20, background: 'rgba(255,255,255,.08)', borderRadius: 12, maxWidth: 480, margin: '0 auto' }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>無法開啟相機</div>
              <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 14, lineHeight: 1.5 }}>{cameraError}</div>
              <div style={{ fontSize: 12, opacity: 0.7, textAlign: 'left', background: 'rgba(0,0,0,.3)', padding: 12, borderRadius: 8, lineHeight: 1.6 }}>
                <strong>請檢查：</strong><br />
                1. 瀏覽器是否允許使用相機<br />
                2. iPhone：設定 → Safari → 相機 → 允許<br />
                3. Android：設定 → 應用程式 → 瀏覽器 → 權限 → 相機<br />
                4. 沒有其他 App 正在用相機<br />
                5. 改用「手動輸入」也可以
              </div>
            </div>
          )}
          <button className="btn-danger" style={{ marginTop: 16, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto', width: '100%' }} onClick={closeScanner}>關閉，改用手動輸入</button>
        </div>
      )}
    </div>
  );
}

const intOptStyle = { padding: 14, fontSize: 15, textAlign: 'left', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 };
const cmpOptStyle = { padding: 12, fontSize: 14, textAlign: 'left', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 };

// ── 規格類型顯示 ──
function SpecTypeDisplay({ order }) {
  if (!order || !order.specType) return <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>尚未設定</div>;
  if (order.specType === 'new') {
    return <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}><Icon name="sparkles" size={16} /> {formatNewSpecLabel(order.newSpecAspects)}</div>;
  }
  if (order.specType === 'mass') {
    return <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}><Icon name="box" size={16} /> 量產規格</div>;
  }
  return <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{order.specType}</div>;
}

function ScopeBtn({ val, label, cur, onClick }) {
  const sel = val === cur;
  return (
    <button onClick={() => onClick(val)}
      style={{ padding: 14, border: `2px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10, background: sel ? 'var(--brand)' : '#fff', color: sel ? '#fff' : 'var(--ink)', cursor: 'pointer', textAlign: 'center', fontWeight: 700, fontSize: 15 }}>
      {label}
    </button>
  );
}
function MatBtn({ val, label, cur, onClick }) {
  const sel = val === cur;
  return (
    <button onClick={() => onClick(val)}
      style={{ flex: 1, padding: 14, border: `2px solid ${sel ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 10, background: sel ? 'var(--brand)' : '#fff', color: sel ? '#fff' : 'var(--ink)', cursor: 'pointer', fontWeight: 700, fontSize: 15 }}>
      {label}
    </button>
  );
}

// 即時計時器（暫停中）
function LiveTimer({ start }) {
  const sec = Math.round((Date.now() - new Date(start).getTime()) / 1000);
  return <span className="live-timer">{fmtDuration(sec)}</span>;
}

// ============= 步驟區 =============
function StepsArea(props) {
  const {
    order, orderNo, isPaused, canEdit,
    backfillOpen, setBackfillOpen, bfVals, setBfVals,
    specChangeText, setSpecChangeText, specChangeQc, setSpecChangeQc,
    intBfOpen, setIntBfOpen, intBfReason, setIntBfReason, intBfNote, setIntBfNote,
    intBfStart, setIntBfStart, intBfEnd, setIntBfEnd,
    onRecordStep, onBackfillStep, onCancelEntry, onRecordSpecChange,
    onShowInterrupt, onSubmitInterruptBackfill, onShowComplete, onResume,
  } = props;

  const now = Date.now();

  // stepEntries 分組
  const entriesByStep = {};
  (order.stepEntries || []).forEach(e => {
    if (!entriesByStep[e.stepNo]) entriesByStep[e.stepNo] = [];
    entriesByStep[e.stepNo].push(e);
  });

  // 生產準備（40）可否再按
  const allEntries = order.stepEntries || [];
  const lastStep41Ms = allEntries.filter(e => e.stepNo === '41').map(e => new Date(e.recordedAt).getTime()).sort((a, b) => b - a)[0] || 0;
  const lastStep30Ms = allEntries.filter(e => e.stepNo === '30').map(e => new Date(e.recordedAt).getTime()).sort((a, b) => b - a)[0] || 0;
  const lastPause13Ms = ((order.pause13 && order.pause13.history) || []).map(p => new Date(p.startAt).getTime()).sort((a, b) => b - a)[0] || 0;
  const isLunchOrOffPause = p => {
    const n = (p.note || '').toLowerCase();
    return n.includes('中午') || n.includes('午休') || n.includes('午餐') || n.includes('下班');
  };
  const lastLunchPause12EndMs = ((order.pause12 && order.pause12.history) || [])
    .filter(isLunchOrOffPause).filter(p => !!p.endAt)
    .map(p => new Date(p.endAt).getTime()).sort((a, b) => b - a)[0] || 0;
  const lastReleaseMs = Math.max(lastStep30Ms, lastPause13Ms, lastLunchPause12EndMs);
  const prepAllowed = lastStep41Ms === 0 || lastReleaseMs > lastStep41Ms;

  // 鎖定的第一筆 40/41 時間（銜接上一張 / 每日 08:00）
  const hasStableEntry = !!(entriesByStep['40']?.length || entriesByStep['41']?.length);
  const prevEnd = order.prevMachineEndAt ? new Date(order.prevMachineEndAt) : null;
  const lockStableTime = !hasStableEntry;
  const today = new Date();
  const prevSameDay = prevEnd && !isNaN(prevEnd)
    && prevEnd.getFullYear() === today.getFullYear()
    && prevEnd.getMonth() === today.getMonth()
    && prevEnd.getDate() === today.getDate();
  const forcedTime = !lockStableTime ? null
    : (prevSameDay ? new Date(prevEnd.getTime() + 60000)
      : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 0, 0));
  const forcedYmd = forcedTime ? `${forcedTime.getFullYear()}-${pad(forcedTime.getMonth() + 1)}-${pad(forcedTime.getDate())}` : '';
  const forcedHM = forcedTime ? `${pad(forcedTime.getHours())}:${pad(forcedTime.getMinutes())}` : '';
  const forcedDisplay = forcedTime ? `${pad(forcedTime.getMonth() + 1)}/${pad(forcedTime.getDate())} ${pad(forcedTime.getHours())}:${pad(forcedTime.getMinutes())}` : '';
  const prevEndDisplay = prevEnd ? `${pad(prevEnd.getMonth() + 1)}/${pad(prevEnd.getDate())} ${pad(prevEnd.getHours())}:${pad(prevEnd.getMinutes())}` : '';

  const specChangeEntries = (order.stepEntries || []).filter(e => e.stepNo === '30');

  const isFinished = !!order.step11At;
  const p12 = order.pause12 || {};
  const p13 = order.pause13 || {};
  const activePause = p12.active ? { type: '12', info: p12 } : (p13.active ? { type: '13', info: p13 } : null);
  const totalCount = (p12.count || 0) + (p13.count || 0);
  const totalSec = (p12.totalSec || 0) + (p13.totalSec || 0);

  function toggleBackfill(id) { setBackfillOpen(b => ({ ...b, [id]: !b[id] })); }
  function setBf(id, patch) { setBfVals(v => ({ ...v, [id]: { ...(v[id] || {}), ...patch } })); }

  function renderEntry(e, titleText, opts = {}) {
    const elapsed = now - new Date(e.recordedAt).getTime();
    const canCancel = elapsed < 5 * 60 * 1000;
    const manualTag = e.isManual ? <span className="manual-tag">補登</span> : null;
    const noteTxt = e.note ? `（${e.note}）` : '';
    return (
      <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: e.isManual ? '#fffbe6' : (canCancel ? 'var(--success-soft)' : '#f5f5f7'), borderRadius: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--success)', fontWeight: 600, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <Icon name="check" size={14} />{titleText}{noteTxt} — {fmtTime(e.recordedAt)}{manualTag}
        </span>
        {canCancel && !isPaused && canEdit && opts.cancellable !== false && (
          <button className="btn-danger" onClick={() => onCancelEntry(e.id)} style={{ padding: '4px 10px', fontSize: 11, minHeight: 28 }}>取消</button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={isPaused ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
        {isPaused && (
          <div style={{ background: 'var(--brand)', color: '#fff', padding: '10px 14px', borderRadius: 10, textAlign: 'center', fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
            <Icon name="pause" size={14} /> 暫停中 — 請先恢復生產才能繼續操作
          </div>
        )}
        <h2 style={{ marginTop: 16 }}>工序進度</h2>

        {STEPS.map(s => {
          const entries = entriesByStep[s.id] || [];
          const hasEntries = entries.length > 0;
          const titleText = s.title.replace(/^\d+\.\s*/, '');
          const isPrepBlocked = s.id === '40' && !prepAllowed;
          const isLockedStable = (s.id === '40' || s.id === '41') && lockStableTime;
          const open = !!backfillOpen[s.id];
          const v = bfVals[s.id] || {};
          return (
            <div key={s.id} className={'step' + (hasEntries ? ' done' : '')}>
              <div className="step-body">
                <div className="title">{titleText}{hasEntries && <span className="badge ok">×{entries.length}</span>}</div>
                {s.hint && <div className="hint">{s.hint}</div>}
                {entries.map(e => renderEntry(e, titleText))}

                {isPaused ? (
                  <button className="btn-success btn-block" disabled><Icon name="check" size={16} /> 已完成</button>
                ) : isPrepBlocked ? (
                  <div style={{ background: '#f5f5f7', border: '1.5px dashed var(--border)', borderRadius: 8, padding: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, textAlign: 'center' }}>
                    🔒 已按生產開始<br />須先「切換規格」、「異常中斷」或「中午休息結束後」才能再按生產準備
                  </div>
                ) : (
                  <>
                    {isLockedStable && (
                      <div style={{ background: '#fff8e8', border: '1.5px dashed #f0ad4e', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#8a6d3b', marginBottom: 8, lineHeight: 1.5 }}
                        dangerouslySetInnerHTML={{
                          __html: prevSameDay
                            ? `📌 與上一張工單時間銜接<br>上一張結束於 <b>${escapeHtml(prevEndDisplay)}</b>，本單第一筆「${escapeHtml(titleText)}」自動鎖定為 <b>${escapeHtml(forcedDisplay)}</b>`
                            : `📌 每日第一單<br>本單第一筆「${escapeHtml(titleText)}」自動鎖定為 <b>${escapeHtml(forcedDisplay)}</b>（每日從 08:00 起算）`,
                        }} />
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn-success" style={{ flex: 1 }} onClick={() => onRecordStep(s.id)}><Icon name="check" size={16} /> 已完成</button>
                      {canEdit && (
                        <button className="btn-secondary" style={{ flex: '0 0 auto', padding: '10px 14px', fontSize: 13, color: '#b8860b' }} onClick={() => toggleBackfill(s.id)}><Icon name="edit" size={14} /> 補登</button>
                      )}
                    </div>
                    {open && canEdit && (
                      <div className="backfill-form" style={{ display: 'flex' }}>
                        {isLockedStable ? (
                          <>
                            <input type="date" value={forcedYmd} disabled style={{ background: '#f5f5f7', color: '#8a6d3b' }} />
                            <input type="time" step="60" value={forcedHM} disabled style={{ background: '#f5f5f7', color: '#8a6d3b' }} />
                            <div style={{ fontSize: 11, color: '#8a6d3b' }}>⚓ 時間已鎖定（銜接上一張工單）</div>
                          </>
                        ) : (
                          <>
                            <input type="date" value={v.date ?? todayYmd()} onChange={e => setBf(s.id, { date: e.target.value })} />
                            <input type="time" step="60" value={v.time ?? ''} onChange={e => setBf(s.id, { time: e.target.value })} />
                          </>
                        )}
                        <button className="btn-primary" onClick={() => onBackfillStep(s.id, isLockedStable ? forcedYmd : undefined, isLockedStable ? forcedHM : undefined)}>確認補登</button>
                        <button className="btn-secondary" onClick={() => toggleBackfill(s.id)}>取消</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* 03 生產結束 */}
        <div className={'step' + (isFinished ? ' done' : '')}>
          <div className="step-body">
            <div className="title">生產結束{isFinished && <span className="badge ok">×1</span>}</div>
            <div className="hint">工單完成與結束（含 / 不含附屬設備）</div>
            {isFinished ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: 'var(--success-soft)', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--success)', fontWeight: 600, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <Icon name="check" size={14} />已完成{order.step11Note ? `（${order.step11Note}）` : ''}
                    {order.step11QcActualQty != null && <span style={{ background: '#1f6feb', color: '#fff', fontSize: 10, padding: '1px 6px', borderRadius: 6, fontWeight: 700 }}>數量：{order.step11QcActualQty}</span>}
                    {' '}— {fmtTime(order.step11At)}
                  </span>
                </div>
                <button className="btn-success btn-block" disabled><Icon name="check" size={16} /> 已完成</button>
              </>
            ) : isPaused ? (
              <button className="btn-success btn-block" disabled><Icon name="check" size={16} /> 暫停中，請先恢復</button>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-success" style={{ flex: 1 }} onClick={() => { if (isPaused) { return; } onShowComplete(false); }}><Icon name="check" size={16} /> 已完成</button>
                {canEdit && (
                  <button className="btn-secondary" style={{ flex: '0 0 auto', padding: '10px 14px', fontSize: 13, color: '#b8860b' }} onClick={() => onShowComplete(true)}><Icon name="edit" size={14} /> 補登</button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 04 生產中斷 */}
        <div className={'step' + (totalCount > 0 ? ' done' : '')} style={{ borderLeft: '4px solid #f0ad4e' }}>
          <div className="step-body">
            <div className="title">生產中斷{totalCount > 0 && <span className="badge ok" style={{ background: '#f0ad4e' }}>×{totalCount}</span>}</div>
            <div className="hint">設備異常停機 ／ 超過1小時以上的停機 ／ 中午休息 ／ 下班時間（隔日生產）</div>
            {activePause ? (
              <>
                <div style={{ marginBottom: 8, padding: '8px 10px', background: '#fff3cd', borderLeft: '3px solid #f0ad4e', borderRadius: 6, fontSize: 13, color: '#8a6d3b', fontWeight: 600 }}>
                  中斷中{activePause.info.active.note ? `（${activePause.info.active.note}）` : ''} <LiveTimer start={activePause.info.active.startAt} />
                </div>
                <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', padding: 8, background: '#f5f5f7', borderRadius: 6 }}>↓ 請按下方「恢復生產」按鈕</div>
              </>
            ) : (
              <>
                {totalCount > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>累計 {totalCount} 次，共 {fmtDuration(totalSec)}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={onShowInterrupt} style={{ flex: 1, background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 8, padding: 14, fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Icon name="pause" size={16} />生產中斷</button>
                  {canEdit && (
                    <button className="btn-secondary" style={{ flex: '0 0 auto', padding: '10px 14px', fontSize: 13, color: '#b8860b' }} onClick={() => setIntBfOpen(o => !o)}><Icon name="edit" size={14} /> 補登</button>
                  )}
                </div>
                {intBfOpen && canEdit && (
                  <div className="backfill-form" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <select value={intBfReason} onChange={e => setIntBfReason(e.target.value)} style={{ width: '100%', padding: 10, border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 14 }}>
                      <option value="">-- 選擇中斷原因 --</option>
                      <option value="設備異常停機|13">設備異常停機</option>
                      <option value="超過1小時以上的停機|12">超過1小時以上的停機</option>
                      <option value="中午休息|12">中午休息</option>
                      <option value="下班時間／隔日生產|12">下班時間／隔日生產</option>
                    </select>
                    <input type="text" placeholder="補充說明（選填）" value={intBfNote} onChange={e => setIntBfNote(e.target.value)} style={{ width: '100%', padding: 10, border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: 'var(--muted)' }}>開始時間</label><input type="datetime-local" value={intBfStart} onChange={e => setIntBfStart(e.target.value)} style={{ width: '100%', padding: 8, border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} /></div>
                      <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: 'var(--muted)' }}>結束時間</label><input type="datetime-local" value={intBfEnd} onChange={e => setIntBfEnd(e.target.value)} style={{ width: '100%', padding: 8, border: '1.5px solid var(--border)', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} /></div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-primary" style={{ flex: 1 }} onClick={onSubmitInterruptBackfill}>確認補登</button>
                      <button className="btn-secondary" style={{ flex: '0 0 auto' }} onClick={() => setIntBfOpen(false)}>取消</button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 更換規格 */}
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1.5px dashed #f0ad4e' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#b8860b', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="clipboard" size={14} /> 更換規格
                {specChangeEntries.length > 0 && <span className="badge ok" style={{ background: '#f0ad4e' }}>×{specChangeEntries.length}</span>}
              </div>
              <div className="hint" style={{ marginTop: 2 }}>多規格工單切換規格時填入（例：規格 2、規格 3）</div>
              {specChangeEntries.map(e => {
                const elapsed = now - new Date(e.recordedAt).getTime();
                const canCancel = elapsed < 5 * 60 * 1000;
                return (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '6px 10px', background: canCancel ? '#fff4d6' : '#fff8e8', borderRadius: 8, borderLeft: '3px solid #f0ad4e' }}>
                    <span style={{ fontSize: 12, color: '#b8860b', fontWeight: 600, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <Icon name="clipboard" size={14} />{e.note || ''} — {fmtTime(e.recordedAt)}
                      {e.qcActualQty != null && <span style={{ background: '#1f6feb', color: '#fff', fontSize: 10, padding: '1px 6px', borderRadius: 6, fontWeight: 700 }}>數量：{e.qcActualQty}</span>}
                      {e.isManual && <span className="manual-tag">補登</span>}
                    </span>
                    {canCancel && !isPaused && canEdit && (
                      <button className="btn-danger" onClick={() => onCancelEntry(e.id)} style={{ padding: '4px 10px', fontSize: 11, minHeight: 28 }}>取消</button>
                    )}
                  </div>
                );
              })}
              {isPaused ? (
                <button className="btn-success btn-block" disabled style={{ background: '#f0ad4e', marginTop: 8 }}><Icon name="clipboard" size={16} /> 記錄更換</button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  <input type="text" placeholder="新規格描述（例：規格 2）" maxLength={200} value={specChangeText} onChange={e => setSpecChangeText(e.target.value)} style={{ padding: 10, border: '1.5px solid #f0ad4e', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                  <input type="number" min="0" step="1" placeholder="前一規格實際生產數量（必填）" value={specChangeQc} onChange={e => setSpecChangeQc(e.target.value)} style={{ padding: 10, border: '1.5px solid #f0ad4e', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
                  <button onClick={onRecordSpecChange} style={{ padding: '10px 18px', background: '#f0ad4e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' }}><Icon name="clipboard" size={14} /> 記錄</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 恢復生產卡（暫停中，不被灰幕鎖住）*/}
      {activePause && (
        <div className="card" style={{ border: '2px solid #f0ad4e', background: '#fff8e8' }}>
          <div style={{ textAlign: 'center', padding: '6px 0 4px' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#b8860b', marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="pause" size={18} />生產中斷中{activePause.info.active.note ? `（${activePause.info.active.note}）` : ''}
            </div>
            <div style={{ fontSize: 13, color: '#8a6d3b', marginBottom: 14 }}>已中斷 <LiveTimer start={activePause.info.active.startAt} /> · 請先恢復生產才能繼續操作</div>
            <button onClick={() => onResume(activePause.type)}
              style={{ width: '100%', background: activePause.type === '13' ? 'var(--brand)' : '#f0ad4e', color: '#fff', border: 'none', borderRadius: 10, padding: 18, fontWeight: 700, fontSize: 18, cursor: 'pointer', animation: 'pulse 1.5s infinite', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Icon name="play" size={22} />恢復生產
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
