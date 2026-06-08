import { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

// 骨架版：簡化的 JSON 上傳（直接貼 array，或之後接 xlsx parser 補上 Excel 解析）
// 原 upload.html 用 xlsx 套件解 Excel + 欄位對應 + 預覽 — 之後可加入 SheetJS（npm i xlsx）
export default function UploadPage() {
  const toast = useToast();
  const [filename, setFilename] = useState('');
  const [uploadDate, setUploadDate] = useState('');
  const [rowsJson, setRowsJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async () => {
    let rows;
    try {
      rows = JSON.parse(rowsJson);
    } catch (e) {
      toast('JSON 格式錯誤', 'error');
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      toast('請提供工單陣列', 'error');
      return;
    }
    setBusy(true);
    const r = await api('/api/orders/bulk-upload', {
      method: 'POST',
      body: { orders: rows, filename: filename || '未命名', uploadDate: uploadDate || null },
    });
    setBusy(false);
    if (!r.ok) { toast(r.error || '上傳失敗', 'error'); return; }
    setResult(r.data);
    toast(`新增 ${r.data.created} / 更新 ${r.data.updated}`, 'success');
  };

  return (
    <div className="container">
      <div className="card">
        <h2>批次上傳工單（骨架版）</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          完整 Excel 解析（SheetJS / xlsx）尚未接入。目前先用 JSON 陣列手動測試。
          每筆需有 <code>orderNo</code>（[A-Z]\d&#123;10&#125;）+ 可選 productSpec / moldSpec / material / machineNo / dispatchQty / bladeCount / machineSPM / unitWeight / totalWeight。
        </p>
        <label>檔名（可選）</label>
        <input type="text" value={filename} onChange={e => setFilename(e.target.value)} placeholder="例：5月計畫.xlsx" />
        <label>上傳日期（可選）</label>
        <input type="date" value={uploadDate} onChange={e => setUploadDate(e.target.value)} />
        <label>工單列（JSON 陣列）</label>
        <textarea
          value={rowsJson}
          onChange={e => setRowsJson(e.target.value)}
          rows={10}
          style={{
            width: '100%', padding: 12, borderRadius: 10,
            border: '1.5px solid var(--border)', fontFamily: 'monospace', fontSize: 12,
          }}
          placeholder={'[\n  { "orderNo": "F1150601001", "productSpec": "...", "dispatchQty": 1000 }\n]'}
        />
        <button className="btn-primary btn-block" style={{ marginTop: 12 }} disabled={busy} onClick={submit}>
          {busy ? '上傳中...' : '上傳'}
        </button>
      </div>

      {result && (
        <div className="card">
          <h2>上傳結果</h2>
          <div>新增：{result.created}</div>
          <div>更新：{result.updated}</div>
          <div>跳過：{result.skipped}</div>
          <div>總計：{result.total}</div>
          {result.errors?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <strong className="brand">錯誤：</strong>
              <ul>{result.errors.map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* TODO：
          - 接入 SheetJS（npm i xlsx）解析 .xlsx
          - 拖放上傳區
          - 欄位自動對應 + 預覽表格 + 錯誤標示
          - 批次取消 / 救回（upload-batches 系列）
      */}
    </div>
  );
}
