import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { MACHINES } from '../lib/machineTargets';
import './MachinesPage.css';

// 機台 QR Code 列印（A4 列印版面）— 從 machines.html 移植。
// 原 HTML 用 api.qrserver.com 線上產生 QR Code；改用 npm "qrcode" 套件在前端產生 data URL。
export default function MachinesPage() {
  // 以機台 id 為 key 存放各自的 QR Code data URL
  const [qrMap, setQrMap] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        MACHINES.map(async (m) => {
          try {
            // 原 HTML 的 QR 內容即機台 id（例：No1-350）
            const url = await QRCode.toDataURL(m.id, { margin: 2, width: 400 });
            return [m.id, url];
          } catch {
            return [m.id, ''];
          }
        })
      );
      if (cancelled) return;
      setQrMap(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="machines-print">
      <div className="header-row">
        <img
          src="/logo.jpg"
          alt="上鎧鋼鐵"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div>
          <h1>機台 QR Code</h1>
          <div className="sub">SHANG KAI STEEL · 廠務工單系統</div>
        </div>
      </div>

      <p className="tip">Cmd/Ctrl+P 列印 A4。剪下後護貝貼於對應機台明顯處。</p>

      <div className="print-bar">
        <button className="btn-primary" onClick={() => window.print()}>列印</button>
      </div>

      <div className="grid">
        {MACHINES.map((m) => (
          <div className="qr-card" key={m.id}>
            <div className="machine-name">{m.num}</div>
            <div className="label">{m.spec}</div>
            {qrMap[m.id]
              ? <img src={qrMap[m.id]} alt={m.id} />
              : <img alt={m.id} />}
            <div className="code">{m.id}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
