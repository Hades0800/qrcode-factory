import { useState, useRef, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { isAdminUser, hasRole } from '../lib/permissions';
import { fmtTime } from '../lib/format';

// 機台號碼自動配對（Excel 可能只寫 "2"、"3"、"No2" 等）
const MACHINE_MAP = {
  '1': 'No1-350', No1: 'No1-350', 'No1-350': 'No1-350',
  '2': 'No2-250', No2: 'No2-250', 'No2-250': 'No2-250',
  '3': 'No3-60', No3: 'No3-60', 'No3-60': 'No3-60',
  '4': 'No4-90', No4: 'No4-90', 'No4-90': 'No4-90',
  '5': 'No5-40', No5: 'No5-40', 'No5-40': 'No5-40',
  '6': 'No6-40', No6: 'No6-40', 'No6-40': 'No6-40',
};
function normalizeMachine(v) {
  if (!v) return '';
  const s = String(v).trim();
  return MACHINE_MAP[s] || s;
}

// 欄位對應（Excel 欄位名 → 系統欄位）— 同義字都對應到同一欄位
const FIELD_MAP = {
  // 製造單號
  製造單號: 'orderNo', 工單號: 'orderNo', 工單編號: 'orderNo',
  // 生產規格 / 品名
  品名規格: 'productSpec', 生產規格: 'productSpec', 品名: 'productSpec',
  // 模具
  模具: 'moldSpec', 模具規格: 'moldSpec',
  // 領料
  領料: 'material', 領用材料: 'material', 材料: 'material',
  領用: 'material', 材質: 'material', 原料: 'material', 物料: 'material',
  // 機台
  機台: 'machineNo', 機台號: 'machineNo', 機台編號: 'machineNo',
  // 生產日期
  生產日期: 'productionDate', 日期: 'productionDate',
  // 數量 / 派工數
  數量: 'dispatchQty', 派工數: 'dispatchQty',
  // 設定數字 / 刀數
  設定數字: 'bladeCount', 刀數: 'bladeCount',
  // 機器 SPM
  機器SPM: 'machineSPM', SPM: 'machineSPM',
  // 單重 / 一片理論重
  單重: 'unitWeight', 一片理論重: 'unitWeight', 單片重: 'unitWeight',
  // 總數 / 總重量
  總數: 'totalWeight', 全部總重量: 'totalWeight', 總重量: 'totalWeight',
};

function todayYmd() {
  const t = new Date();
  return (
    t.getFullYear() +
    '-' +
    String(t.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(t.getDate()).padStart(2, '0')
  );
}

function isToday(productionDate) {
  if (!productionDate) return false;
  const d = new Date(productionDate);
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

const hasActivity = (o) =>
  !!(
    o.step1At ||
    o.step2At ||
    o.step3At ||
    o.step4At ||
    o.step5At ||
    o.step6At ||
    o.step7At ||
    o.step11At
  );

const hasActivityOverview = (o) =>
  !!(
    o.step1At ||
    o.step2At ||
    o.step3At ||
    o.step4At ||
    o.step5At ||
    o.step6At ||
    o.step7At ||
    o.step11At ||
    (o.stepEntries && o.stepEntries.length > 0)
  );

const tabBtnStyle = {
  flex: 1,
  textAlign: 'center',
  padding: 14,
  fontSize: 15,
  fontWeight: 600,
  borderRadius: 8,
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  fontFamily: 'inherit',
  transition: 'all .15s',
  color: 'var(--muted)',
};
const tabBtnActiveStyle = {
  ...tabBtnStyle,
  color: '#fff',
  background: 'var(--brand)',
  boxShadow: '0 2px 6px rgba(210,53,53,.25)',
};
const smallBtn = {
  padding: '6px 12px',
  fontSize: 12,
  background: '#fff',
  color: 'var(--ink)',
  border: '1.5px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
};

export default function UploadPage() {
  const toast = useToast();
  const { me } = useAuth();
  const isAdmin = isAdminUser(me);
  const isPlanner = hasRole(me, 'pm');
  const canManageToday = isAdmin || isPlanner;
  const canManageBatch = isAdmin || isPlanner;

  const [tab, setTab] = useState('upload');

  // 上傳區 state
  const [uploadDate, setUploadDate] = useState(todayYmd());
  const [fileLabel, setFileLabel] = useState('');
  const [uploadedFilename, setUploadedFilename] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { created, updated, errors }
  const fileInputRef = useRef(null);

  // 今日已上傳
  const [todayOrders, setTodayOrders] = useState([]);

  // 製造概覽
  const [overviewOrders, setOverviewOrders] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [openDays, setOpenDays] = useState({});

  // 上傳紀錄（批次）
  const [batches, setBatches] = useState([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [openBatches, setOpenBatches] = useState({});

  // ===== 今日已上傳 =====
  const loadTodayOrders = useCallback(async () => {
    const r = await api('/api/orders?limit=200');
    if (!r.ok) return;
    const rows = (r.data.orders || []).filter((o) => isToday(o.productionDate));
    setTodayOrders(rows);
  }, []);

  useEffect(() => {
    loadTodayOrders();
  }, [loadTodayOrders]);

  // ===== 檔案處理 / 解析 =====
  const parseRows = (json) => {
    if (!json.length) {
      toast('Excel 沒有資料', 'error');
      return;
    }
    const normHeader = (s) =>
      String(s || '')
        .trim()
        .replace(/[\s　()（）\-_－\/／:：]/g, '')
        .toLowerCase();
    const normalizedFieldMap = {};
    Object.entries(FIELD_MAP).forEach(([k, v]) => {
      normalizedFieldMap[normHeader(k)] = v;
    });
    const headers = Object.keys(json[0]);
    const mapping = {};
    const unmatched = [];
    headers.forEach((h) => {
      const key = normHeader(h);
      if (normalizedFieldMap[key]) mapping[h] = normalizedFieldMap[key];
      else if (h.trim()) unmatched.push(h);
    });
    if (!Object.values(mapping).includes('orderNo')) {
      toast('找不到「製造單號」欄位，請確認 Excel 第一列有此欄位名', 'error');
      return;
    }
    if (unmatched.length > 0) {
      console.warn('[上傳] 這些 Excel 欄位沒對應到系統欄位，資料會被忽略：', unmatched);
      toast('未認得 Excel 欄位：' + unmatched.join('、') + '（資料會被忽略）', 'error');
    }

    const selectedDate = uploadDate;
    const todayStr = selectedDate || todayYmd();

    const allRows = json.map((row) => {
      const obj = {};
      Object.keys(mapping).forEach((excelKey) => {
        let val = row[excelKey];
        const field = mapping[excelKey];
        if (field === 'productionDate' && val instanceof Date) {
          val = val.toISOString().slice(0, 10);
        }
        obj[field] = val;
      });
      if (!obj.productionDate) obj.productionDate = todayStr;
      obj.orderNo = String(obj.orderNo || '').trim();
      obj._valid = /^[A-Z]\d{10}$/.test(obj.orderNo.toUpperCase());
      if (obj._valid) obj.orderNo = obj.orderNo.toUpperCase();
      if (obj.machineNo) obj.machineNo = normalizeMachine(obj.machineNo);
      ['dispatchQty', 'bladeCount', 'machineSPM', 'unitWeight', 'totalWeight'].forEach((k) => {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
          const n = Number(obj[k]);
          obj[k] = isNaN(n) || n === 0 ? null : n;
        }
      });
      const otherFields = [
        'productSpec',
        'moldSpec',
        'material',
        'machineNo',
        'dispatchQty',
        'bladeCount',
        'machineSPM',
        'unitWeight',
        'totalWeight',
      ];
      obj._suspicious =
        obj._valid &&
        otherFields.every((k) => obj[k] === undefined || obj[k] === null || obj[k] === '');
      return obj;
    });

    setParsedRows(allRows);
    setResult(null);
    setShowPreview(true);
  };

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('檔案過大（上限 5MB）', 'error');
      return;
    }
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      toast('請選擇 .xlsx 或 .xls 檔', 'error');
      return;
    }
    setUploadedFilename(file.name);
    setFileLabel(file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
        parseRows(json);
      } catch (err) {
        toast('Excel 解析失敗：' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const onFileChange = (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  };

  const cancelPreview = () => {
    setParsedRows([]);
    setShowPreview(false);
    setFileLabel('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const doUpload = async () => {
    const rows = parsedRows.filter((r) => r._valid && !r._suspicious);
    if (rows.length === 0) {
      toast('沒有有效的工單', 'error');
      return;
    }
    const selectedDate = uploadDate;
    const ymd = todayYmd();
    if (selectedDate && selectedDate !== ymd) {
      if (
        !window.confirm(
          '你選的日期是 ' +
            selectedDate +
            '（非今日），確定要用這個日期上傳嗎？\n\n這是補上傳功能，工單的生產日期會標記為該日期。'
        )
      )
        return;
    }
    setBusy(true);
    const clean = rows.map((r) => {
      const o = Object.assign({}, r);
      delete o._valid;
      delete o._suspicious;
      return o;
    });
    const res = await api('/api/orders/bulk-upload', {
      method: 'POST',
      body: { orders: clean, filename: uploadedFilename, uploadDate },
    });
    setBusy(false);
    if (!res.ok) {
      setResult({ fail: res.error || '上傳失敗' });
      return;
    }
    const d = res.data;
    setResult({ created: d.created, updated: d.updated, errors: d.errors || [] });
    setShowPreview(false);
    setFileLabel('');
    setUploadedFilename('');
    setParsedRows([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    toast('上傳完成', 'success');
    loadTodayOrders();
  };

  // ===== 取消工單（今日列表）=====
  const deleteOrder = async (orderNo, isForce) => {
    const msg = isForce
      ? `⚠️ 強制取消工單「${orderNo}」\n\n此工單已開始生產，掃描紀錄會一併刪除！\n\n確定要繼續？`
      : `確定取消工單「${orderNo}」？\n\n可重新上傳新版本。`;
    if (!window.confirm(msg)) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo), { method: 'DELETE' });
    if (!r.ok) {
      toast(r.error || '取消失敗', 'error');
      return;
    }
    toast('已取消 ' + orderNo, 'success');
    loadTodayOrders();
  };

  // ===== 製造概覽 =====
  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError('');
    const r = await api('/api/orders?limit=500');
    setOverviewLoading(false);
    if (!r.ok) {
      setOverviewError(r.error || '載入失敗');
      setOverviewOrders([]);
      return;
    }
    setOverviewOrders(r.data.orders || []);
  }, []);

  const toggleOverviewDay = (day) =>
    setOpenDays((prev) => ({ ...prev, [day]: !prev[day] }));

  // ===== 上傳紀錄（批次）=====
  const loadBatches = useCallback(async () => {
    setBatchLoading(true);
    setBatchError('');
    const r = await api('/api/orders/upload-batches?limit=100');
    setBatchLoading(false);
    if (!r.ok) {
      setBatchError(r.error || '載入失敗');
      setBatches([]);
      return;
    }
    setBatches(r.data.batches || []);
  }, []);

  const toggleBatchDetail = (id) =>
    setOpenBatches((prev) => ({ ...prev, [id]: !prev[id] }));

  const deleteBatch = async (batchId, filename) => {
    if (
      !window.confirm(
        '確定整批刪除「' +
          filename +
          '」？\n\n未開始生產的工單會完全刪除，已開始生產的只清除上傳資訊。'
      )
    )
      return;
    const r = await api('/api/orders/upload-batches/' + batchId, { method: 'DELETE' });
    if (!r.ok) {
      toast(r.error || '刪除失敗', 'error');
      return;
    }
    toast(
      '已刪除批次：' + (r.data.deleted || 0) + ' 筆刪除、' + (r.data.cleared || 0) + ' 筆清除',
      'success'
    );
    loadBatches();
  };

  const deleteSingleOrder = async (orderNo) => {
    if (!window.confirm('確定刪除工單「' + orderNo + '」？')) return;
    const r = await api('/api/orders/' + encodeURIComponent(orderNo), { method: 'DELETE' });
    if (!r.ok) {
      toast(r.error || '刪除失敗', 'error');
      return;
    }
    toast('已刪除 ' + orderNo, 'success');
    loadBatches();
  };

  // tab 切換時載入資料
  const switchTab = (t) => {
    setTab(t);
    if (t === 'overview') loadOverview();
    if (t === 'history') loadBatches();
  };

  // ===== 衍生資料 =====
  const validCount = parsedRows.filter((r) => r._valid && !r._suspicious).length;
  const suspiciousCount = parsedRows.filter((r) => r._suspicious).length;
  const invalidCount = parsedRows.length - validCount - suspiciousCount;

  const todayActive = todayOrders.filter(hasActivity).length;

  // overview 分組
  const overviewGroups = {};
  overviewOrders.forEach((o) => {
    const key = o.productionDate ? String(o.productionDate).slice(0, 10) : '未設定日期';
    if (!overviewGroups[key]) overviewGroups[key] = [];
    overviewGroups[key].push(o);
  });
  const sortedDays = Object.keys(overviewGroups).sort((a, b) => b.localeCompare(a));

  return (
    <div className="container">
      {/* Tabs */}
      <div
        className="page-tabs"
        style={{
          display: 'flex',
          background: '#fff',
          borderRadius: 14,
          padding: 5,
          marginBottom: 20,
          boxShadow: '0 1px 3px rgba(0,0,0,.04)',
        }}
      >
        <button
          style={tab === 'upload' ? tabBtnActiveStyle : tabBtnStyle}
          onClick={() => switchTab('upload')}
        >
          📤 工單上傳
        </button>
        <button
          style={tab === 'overview' ? tabBtnActiveStyle : tabBtnStyle}
          onClick={() => switchTab('overview')}
        >
          📊 製造概覽
        </button>
        <button
          style={tab === 'history' ? tabBtnActiveStyle : tabBtnStyle}
          onClick={() => switchTab('history')}
        >
          📋 上傳紀錄
        </button>
      </div>

      {/* ===== 上傳區 ===== */}
      {tab === 'upload' && (
        <div>
          <div className="card">
            <h2>上傳 Excel 工單檔</h2>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 14,
                flexWrap: 'wrap',
                background: 'var(--bg)',
                padding: '12px 14px',
                borderRadius: 10,
              }}
            >
              <label
                style={{
                  margin: 0,
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--ink)',
                  whiteSpace: 'nowrap',
                }}
              >
                生產日期：
              </label>
              <input
                type="date"
                value={uploadDate}
                onChange={(e) => setUploadDate(e.target.value)}
                style={{
                  padding: '8px 10px',
                  fontSize: 14,
                  border: '1.5px solid var(--border)',
                  borderRadius: 8,
                  background: '#fff',
                }}
              />
              <button
                onClick={() => setUploadDate(todayYmd())}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  background: '#fff',
                  color: 'var(--ink)',
                  border: '1.5px solid var(--border)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                今日
              </button>
              <div style={{ flex: 1, minWidth: 150, fontSize: 11, color: 'var(--muted)' }}>
                📅 補上傳可選過去日期
              </div>
            </div>

            <div
              className={'drop-zone' + (dragOver ? ' drag-over' : '')}
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFile(e.dataTransfer.files[0]);
              }}
              style={{
                border: '2px dashed var(--border)',
                borderRadius: 14,
                padding: '50px 30px',
                textAlign: 'center',
                cursor: 'pointer',
                ...(dragOver ? { borderColor: 'var(--brand)', background: 'var(--brand-soft)' } : {}),
              }}
            >
              <div style={{ fontSize: 48, marginBottom: 12 }}>📄</div>
              <div style={{ fontSize: 15, color: 'var(--text)', fontWeight: 600 }}>
                點擊選擇或拖曳 Excel 檔案
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                支援 .xlsx / .xls 格式
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={onFileChange}
                style={{ display: 'none' }}
              />
            </div>
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>
              {fileLabel}
            </div>
          </div>

          {/* 今日已上傳工單 */}
          {todayOrders.length > 0 && (
            <div className="card">
              <h2>今日已上傳工單</h2>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
                {`今日上傳 ${todayOrders.length} 筆（${todayActive} 筆已開始生產，${
                  todayOrders.length - todayActive
                } 筆可取消）`}
              </div>
              <div className="preview-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>製造單號</th>
                      <th>生產日期</th>
                      <th>品名規格</th>
                      <th>模具</th>
                      <th>數量</th>
                      <th>總數</th>
                      <th>狀態</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {todayOrders.map((o, i) => {
                      const started = hasActivity(o);
                      let actionBtn = '—';
                      if (!started && canManageToday) {
                        actionBtn = (
                          <button
                            style={{
                              padding: '6px 12px',
                              fontSize: 12,
                              background: '#fff',
                              color: 'var(--brand)',
                              border: '1.5px solid var(--brand)',
                              borderRadius: 6,
                              cursor: 'pointer',
                            }}
                            onClick={() => deleteOrder(o.orderNo, false)}
                          >
                            取消
                          </button>
                        );
                      } else if (started && isAdmin) {
                        actionBtn = (
                          <button
                            style={{
                              padding: '6px 12px',
                              fontSize: 12,
                              background: 'var(--brand)',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 6,
                              cursor: 'pointer',
                            }}
                            onClick={() => deleteOrder(o.orderNo, true)}
                          >
                            強制取消
                          </button>
                        );
                      }
                      return (
                        <tr key={o.orderNo}>
                          <td>{i + 1}</td>
                          <td>
                            <strong>{o.orderNo}</strong>
                          </td>
                          <td>{o.productionDate ? String(o.productionDate).slice(0, 10) : ''}</td>
                          <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>
                            {o.productSpec || ''}
                          </td>
                          <td>{o.moldSpec || ''}</td>
                          <td>{o.dispatchQty || ''}</td>
                          <td>{o.totalWeight || ''}</td>
                          <td>
                            {started ? (
                              <span style={{ color: 'var(--success)' }}>已生產</span>
                            ) : (
                              <span style={{ color: 'var(--muted)' }}>未開始</span>
                            )}
                          </td>
                          <td>{actionBtn}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
                ⓘ 可在上方「📋 上傳紀錄」一次取消整批上傳。
              </div>
            </div>
          )}

          {/* 預覽卡片 */}
          {showPreview && (
            <div className="card">
              <h2>預覽（上傳前確認）</h2>
              <div className="stats-row" style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div className="stat-pill">
                  共 <strong>{parsedRows.length}</strong> 筆
                </div>
                <div className="stat-pill">
                  有效 <strong>{validCount}</strong>
                </div>
                {invalidCount > 0 && (
                  <div className="stat-pill" style={{ color: 'var(--brand)' }}>
                    格式錯誤 <strong>{invalidCount}</strong>
                  </div>
                )}
                {suspiciousCount > 0 && (
                  <div className="stat-pill" style={{ color: '#f0ad4e' }}>
                    疑似殘留 <strong>{suspiciousCount}</strong>
                  </div>
                )}
              </div>
              <div className="preview-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>製造單號</th>
                      <th>生產日期</th>
                      <th>生產規格</th>
                      <th>模具規格</th>
                      <th>領用材料</th>
                      <th>機台</th>
                      <th>派工數</th>
                      <th>刀數</th>
                      <th>SPM</th>
                      <th>一片理論重</th>
                      <th>全部總重量</th>
                      <th>狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.map((r, i) => {
                      const statusCell = r._suspicious ? (
                        <span style={{ color: '#f0ad4e' }}>⚠ 疑似殘留</span>
                      ) : r._valid ? (
                        '✓'
                      ) : (
                        <span className="err">✗</span>
                      );
                      const orderCell = r._suspicious ? (
                        <span style={{ color: '#f0ad4e' }}>{r.orderNo} (其他欄位皆空，不上傳)</span>
                      ) : (
                        <span className={r._valid ? '' : 'err'}>
                          {r.orderNo}
                          {r._valid ? '' : ' (格式錯誤)'}
                        </span>
                      );
                      return (
                        <tr key={i} style={r._suspicious ? { background: '#fff3cd' } : undefined}>
                          <td>{i + 1}</td>
                          <td>{orderCell}</td>
                          <td>{r.productionDate || ''}</td>
                          <td>{r.productSpec || ''}</td>
                          <td>{r.moldSpec || ''}</td>
                          <td>{r.material || ''}</td>
                          <td>{r.machineNo || ''}</td>
                          <td>{r.dispatchQty || ''}</td>
                          <td>{r.bladeCount || ''}</td>
                          <td>{r.machineSPM || ''}</td>
                          <td>{r.unitWeight || ''}</td>
                          <td>{r.totalWeight || ''}</td>
                          <td>{statusCell}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                <button
                  className="btn-primary btn-block"
                  disabled={busy}
                  onClick={doUpload}
                >
                  {busy ? '上傳中...' : '📤 確認上傳'}
                </button>
                <button
                  className="btn-block"
                  style={{
                    background: 'var(--bg)',
                    color: 'var(--ink)',
                    border: '1.5px solid var(--border)',
                  }}
                  onClick={cancelPreview}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 上傳結果 */}
          {result && (
            <div className="card">
              {result.fail ? (
                <div className="result fail">{result.fail}</div>
              ) : (
                <>
                  <div className="result ok">
                    上傳完成：新增 {result.created} 筆、更新 {result.updated} 筆
                    <br />
                    可切到「📋 上傳紀錄」查看明細
                  </div>
                  {result.errors && result.errors.length > 0 && (
                    <div className="result fail" style={{ marginTop: 8 }}>
                      錯誤 {result.errors.length} 筆：
                      {result.errors.map((e, i) => (
                        <span key={i}>
                          <br />
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== 製造概覽 ===== */}
      {tab === 'overview' && (
        <div className="card">
          <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>製造概覽</span>
            <button style={smallBtn} onClick={loadOverview}>
              🔄 重新整理
            </button>
          </h2>
          {overviewLoading ? (
            <div style={{ color: 'var(--muted)', padding: 30, textAlign: 'center' }}>載入中...</div>
          ) : overviewError ? (
            <div style={{ color: 'var(--brand)', padding: 30, textAlign: 'center' }}>
              {overviewError}
            </div>
          ) : overviewOrders.length === 0 ? (
            <div style={{ color: 'var(--muted)', padding: 30, textAlign: 'center' }}>
              目前沒有工單
            </div>
          ) : (
            sortedDays.map((day) => {
              const orders = overviewGroups[day];
              const completed = orders.filter((o) => o.step11At).length;
              const active = orders.filter((o) => !o.step11At && hasActivityOverview(o)).length;
              const waiting = orders.length - completed - active;
              const open = !!openDays[day];
              return (
                <div key={day} style={{ marginBottom: 14 }}>
                  <div
                    onClick={() => toggleOverviewDay(day)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '16px 20px',
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 18, color: 'var(--ink)' }}>{day}</strong>
                      <span style={{ fontSize: 14, color: 'var(--muted)' }}>
                        {orders.length} 筆工單
                      </span>
                      <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                        {completed > 0 && (
                          <span style={{ color: 'var(--success)', fontWeight: 600 }}>
                            已完成 {completed}
                          </span>
                        )}
                        {active > 0 && (
                          <span style={{ color: '#1f6feb', fontWeight: 600 }}>生產中 {active}</span>
                        )}
                        {waiting > 0 && (
                          <span style={{ color: '#f0ad4e', fontWeight: 600 }}>待生產 {waiting}</span>
                        )}
                      </div>
                    </div>
                    <span
                      style={{
                        color: 'var(--brand)',
                        fontSize: 14,
                        transition: 'transform .2s',
                        transform: open ? 'rotate(90deg)' : 'none',
                      }}
                    >
                      ▶
                    </span>
                  </div>
                  {open && (
                    <div style={{ marginTop: 6 }}>
                      <div
                        className="preview-wrap"
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          overflow: 'hidden',
                          background: '#fff',
                        }}
                      >
                        <table className="preview-table" style={{ fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>製造單號</th>
                              <th>機台</th>
                              <th>生產規格</th>
                              <th>模具</th>
                              <th>派工數</th>
                              <th>總重量</th>
                              <th>狀態</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orders.map((o, i) => {
                              const started = hasActivityOverview(o);
                              let status;
                              if (o.step11At)
                                status = <span style={{ color: 'var(--success)' }}>已完成</span>;
                              else if (started)
                                status = <span style={{ color: '#1f6feb' }}>生產中</span>;
                              else status = <span style={{ color: '#f0ad4e' }}>待生產</span>;
                              let mismatchTag = null;
                              if (o.actualStartDate && o.plannedDate) {
                                const actDate = String(o.actualStartDate).slice(0, 10);
                                const plDate = String(o.plannedDate).slice(0, 10);
                                if (actDate !== plDate) {
                                  mismatchTag = (
                                    <span
                                      title={'計畫 ' + plDate + ' / 實際 ' + actDate}
                                      style={{
                                        background: '#f0ad4e',
                                        color: '#fff',
                                        fontSize: 9,
                                        padding: '1px 6px',
                                        borderRadius: 6,
                                        marginLeft: 4,
                                      }}
                                    >
                                      計畫 {plDate}
                                    </span>
                                  );
                                }
                              }
                              return (
                                <tr key={o.orderNo}>
                                  <td>{i + 1}</td>
                                  <td>
                                    <strong>{o.orderNo}</strong>
                                    {mismatchTag}
                                  </td>
                                  <td>{o.machineNo || ''}</td>
                                  <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                                    {o.productSpec || ''}
                                  </td>
                                  <td>{o.moldSpec || ''}</td>
                                  <td>{o.dispatchQty || ''}</td>
                                  <td>{o.totalWeight || ''}</td>
                                  <td>{status}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ===== 上傳紀錄（批次）===== */}
      {tab === 'history' && (
        <div className="card">
          <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>上傳紀錄</span>
            <button style={smallBtn} onClick={loadBatches}>
              🔄 重新整理
            </button>
          </h2>
          {batchLoading ? (
            <div style={{ color: 'var(--muted)', padding: 30, textAlign: 'center' }}>載入中...</div>
          ) : batchError ? (
            <div style={{ color: 'var(--brand)', padding: 30, textAlign: 'center' }}>
              {batchError}
            </div>
          ) : batches.length === 0 ? (
            <div style={{ color: 'var(--muted)', padding: 30, textAlign: 'center' }}>
              目前沒有上傳紀錄
            </div>
          ) : (
            batches.map((b) => {
              const isCancelled = !!b.cancelledAt;
              const prodDate = b.productionDate ? String(b.productionDate).slice(0, 10) : '';
              const orderList = b.orderNos || [];
              const open = !!openBatches[b.id];
              return (
                <div
                  key={b.id}
                  style={{
                    marginBottom: 12,
                    padding: '16px 20px',
                    background: isCancelled ? '#f9f9f9' : 'var(--card)',
                    border: '1px solid ' + (isCancelled ? '#e5e5ea' : 'var(--border)'),
                    borderRadius: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                      gap: 10,
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}>
                        <span
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: isCancelled ? 'var(--muted)' : 'var(--ink)',
                            minWidth: 120,
                          }}
                        >
                          {b.filename || '未命名'}
                        </span>
                        {isCancelled && (
                          <span
                            style={{
                              background: 'var(--brand)',
                              color: '#fff',
                              fontSize: 11,
                              padding: '2px 8px',
                              borderRadius: 6,
                              fontWeight: 700,
                              flexShrink: 0,
                            }}
                          >
                            已刪除
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--muted)',
                          marginTop: 4,
                          textAlign: 'left',
                        }}
                      >
                        上傳時間：{fmtTime(b.uploadedAt)}　|　上傳者：{b.uploadedByName || '—'}　|
                        {b.rowCount} 筆工單
                        {prodDate ? '　|　生產日期：' + prodDate : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button style={smallBtn} onClick={() => toggleBatchDetail(b.id)}>
                        <span>{open ? '▼' : '▶'}</span> 明細
                      </button>
                      {canManageBatch && !isCancelled && (
                        <button
                          style={{
                            padding: '6px 12px',
                            fontSize: 12,
                            background: '#fff',
                            color: 'var(--brand)',
                            border: '1.5px solid var(--brand)',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontWeight: 600,
                          }}
                          onClick={() => deleteBatch(b.id, b.filename)}
                        >
                          整批刪除
                        </button>
                      )}
                    </div>
                  </div>
                  {open && (
                    <div style={{ marginTop: 12 }}>
                      <div
                        className="preview-wrap"
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 10,
                          overflow: 'hidden',
                        }}
                      >
                        <table className="preview-table" style={{ fontSize: 12 }}>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>製造單號</th>
                              {canManageBatch && !isCancelled && <th>操作</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {orderList.map((no, i) => (
                              <tr key={no + i}>
                                <td>{i + 1}</td>
                                <td>
                                  <strong>{no}</strong>
                                </td>
                                {canManageBatch && !isCancelled && (
                                  <td>
                                    <button
                                      style={{
                                        padding: '3px 8px',
                                        fontSize: 11,
                                        background: '#fff',
                                        color: 'var(--brand)',
                                        border: '1.5px solid var(--brand)',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                      }}
                                      onClick={() => deleteSingleOrder(no)}
                                    >
                                      刪除
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
