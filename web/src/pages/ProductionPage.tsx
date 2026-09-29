import { Card } from '../components/ui'

// 生產 MES 系統:現場操作仍在既有的 HTML 頁(legacy/),這裡是入口與說明。
const LEGACY = '../'
const LINKS: [string, string, string][] = [
  ['index.html', '現場紀錄(掃工項 QR)', '設備啟動、生產準備、工序 1~8、暫停/異常、完成'],
  ['realtime.html', '即時看板', '各機台目前工單與狀態'],
  ['upload.html', '每周生產計畫上傳(生管)', '排程 Excel → 製造單'],
  ['records.html', '紀錄查詢', '工單歷程、設備參數'],
  ['plan-stats.html', '計畫達成', '計畫 vs 實際'],
  ['goal-stats.html', '目標統計', ''],
  ['machines.html', '機台', '機台清單與無工令'],
  ['qrcodes.html', '工項 QR 列印', 'STEP:1~8 的 QR 看板'],
  ['admin.html', '管理', '帳號、角色、稽核紀錄'],
]

export default function ProductionPage() {
  return (
    <div>
      <Card title="生產 MES 系統">
        <p style={{ margin: 0, fontSize: 14, color: '#3a3a3c' }}>
          製造單(F 號)、每周生產計畫、工序與暫停紀錄、設備參數都在這個模組;現場操作沿用既有頁面。
          在「原料管理」建立標籤時填製造單號,標籤會自動掛到該工單,並補上工單原本沒有的訂單編號、納期、備註。
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 12 }}>
          <tbody>
            {LINKS.map(([href, name, desc]) => (
              <tr key={href}>
                <td style={{ padding: '8px 8px 8px 0', borderBottom: '1px solid #f2f2f7', whiteSpace: 'nowrap' }}>
                  <a href={LEGACY + href} style={{ color: '#1d4ed8', textDecoration: 'none', fontWeight: 600 }}>{name}</a>
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid #f2f2f7', color: '#6e6e73' }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="與其他系統的接點">
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: '#3a3a3c', lineHeight: 1.7 }}>
          <li>原料:倉管在「原料管理」出庫(階段:原料)給生產,對應領料。</li>
          <li>裁切:業務助理在「裁切 MES」建加工單(G 號)時填製造單號,即完成綁定。</li>
          <li>再製 QR:工單完成後,用完成數量在「原料管理」建一張半成品/成品標籤(下一步做成完成步驟自動產生)。</li>
        </ul>
      </Card>
    </div>
  )
}
