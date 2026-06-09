import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import './QrcodesPage.css';

// 工項清單(順序、標題、提示、QR 內容)——對應原 qrcodes.html 靜態版面
const QR_ITEMS = [
  { num: 1, title: '原料準備與設置', hint: '', data: 'STEP:1' },
  { num: 2, title: '模刀具準備與安裝', hint: '', data: 'STEP:2' },
  { num: 3, title: '試模與規格品質確認', hint: '', data: 'STEP:3' },
  { num: 4, title: '穩定連續生產-無中斷', hint: '連續生產期間沒有任何中斷', data: 'STEP:4' },
  { num: 5, title: '穩定連續生產-中斷調整', hint: '生產過程中有少量調整中斷', data: 'STEP:5' },
  { num: 6, title: '穩定連續生產-中斷多次', hint: '生產過程中多次中斷', data: 'STEP:8' },
  { num: 7, title: '後工程接續生產', hint: '軋平／捲網／波浪網等', data: 'STEP:6' },
  { num: 8, title: '生產異常或註記事項', hint: '設備故障／品質異常等', data: 'STEP:7' },
];

export default function QrcodesPage() {
  // 各工項 QR Code 的 data URL,以 data 字串為 key
  const [qrUrls, setQrUrls] = useState({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      QR_ITEMS.map((item) =>
        QRCode.toDataURL(item.data, { width: 400, margin: 4, errorCorrectionLevel: 'M' })
          .then((url) => [item.data, url])
          .catch(() => [item.data, ''])
      )
    ).then((pairs) => {
      if (cancelled) return;
      const map = {};
      for (const [key, url] of pairs) map[key] = url;
      setQrUrls(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="qrcodes-page">
      <div className="header-row">
        <img src="/logo.jpg" alt="上鎧鋼鐵" />
        <div>
          <h1>廠務工項 QR Code</h1>
          <div className="sub">SHANG KAI STEEL · 廠務工單系統</div>
        </div>
      </div>

      <p className="tip">Cmd/Ctrl+P 列印 A4。剪下後護貝貼於現場機台。</p>

      <div className="print-bar">
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          列印
        </button>
      </div>

      <div className="grid">
        {QR_ITEMS.map((item) => (
          <div className="qr-card" key={item.num}>
            <div className="num">{item.num}</div>
            <div className="title">{item.title}</div>
            {qrUrls[item.data] ? (
              <img src={qrUrls[item.data]} alt={item.data} />
            ) : (
              <div className="qr-placeholder" aria-label={item.data} />
            )}
            <div className="hint">{item.hint || ' '}</div>
            <div className="code">{item.data}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
