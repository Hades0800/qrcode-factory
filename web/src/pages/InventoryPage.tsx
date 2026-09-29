import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Btn, Card, Field, KIND_NAMES, QrImage, STAGE_NAMES, fmt, grid, input, table, td, th } from '../components/ui'
import type { Label, LabelKind, Stage, Stock } from '../api/types'

type SpecRow = { spec: string; qty: string; weight: string }
type StockRow = Label & { stock: Stock }

const emptyForm = {
  kind: 'finished' as LabelKind, customer: '', poNo: '', manuOrderNo: '', processOrderNo: '',
  location: '', machineNo: '', dueDate: '', remark: '',
}

// 原料管理系統(入出庫):建標籤 → 看 QR;掃標籤入庫 / 出庫;庫存
export default function InventoryPage() {
  const toast = useToast()
  const [form, setForm] = useState(emptyForm)
  const [specs, setSpecs] = useState<SpecRow[]>([{ spec: '', qty: '', weight: '' }])
  const [created, setCreated] = useState<Label | null>(null)

  const [scan, setScan] = useState('')
  const [move, setMove] = useState({ type: 'in' as 'in' | 'out', stage: 'material' as Stage, location: '', qty: '', weight: '', note: '' })
  const [moveResult, setMoveResult] = useState<{ label: Label; stock: Stock | null } | null>(null)

  const [stock, setStock] = useState<StockRow[]>([])

  const loadStock = useCallback(async () => {
    const r = await api<{ stock: StockRow[] }>('/api/inventory/stock')
    if (r.ok) setStock(r.data.stock)
    else toast(r.error, 'error')
  }, [toast])

  useEffect(() => { void loadStock() }, [loadStock])

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function createLabel() {
    const r = await api<{ label: Label }>('/api/labels', {
      method: 'POST',
      body: { ...form, specs: specs.filter(s => s.spec.trim()).map(s => ({ spec: s.spec, qty: s.qty || null, weight: s.weight || null })) },
    })
    if (!r.ok) { toast(r.error, 'error'); return }
    setCreated(r.data.label)
    toast('標籤已建立:' + r.data.label.code, 'success')
    void loadStock()
  }

  async function submitMove() {
    const text = scan.trim()
    if (!text) { toast('請貼上 QR 文字或標籤碼', 'error'); return }
    const body = text.startsWith('LB-') && !text.includes('\n') ? { code: text } : { text }
    const r = await api<{ label: Label; stock: Stock | null }>('/api/inventory/moves', {
      method: 'POST', body: { ...body, ...move, qty: move.qty || null, weight: move.weight || null },
    })
    if (!r.ok) { toast(r.error, 'error'); return }
    setMoveResult({ label: r.data.label, stock: r.data.stock })
    toast((move.type === 'in' ? '入庫' : '出庫') + '已記錄', 'success')
    void loadStock()
  }

  return (
    <div>
      <Card title="建立 QR 標籤(業務助理)">
        <div style={grid}>
          <Field label="標籤種類">
            <select style={input} value={form.kind} onChange={set('kind')}>
              {Object.entries(KIND_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="客戶/廠商"><input style={input} value={form.customer} onChange={set('customer')} placeholder="光輝  (北)" /></Field>
          <Field label="訂單編號"><input style={input} value={form.poNo} onChange={set('poNo')} placeholder="PO-12345" /></Field>
          <Field label="製造單號"><input style={input} value={form.manuOrderNo} onChange={set('manuOrderNo')} placeholder="F1150810001" /></Field>
          <Field label="加工單號"><input style={input} value={form.processOrderNo} onChange={set('processOrderNo')} placeholder="G1150810006" /></Field>
          <Field label="倉庫儲位"><input style={input} value={form.location} onChange={set('location')} placeholder="D-C-F123" /></Field>
          <Field label="機台編號"><input style={input} value={form.machineNo} onChange={set('machineNo')} placeholder="No.3" /></Field>
          <Field label="製造/納期"><input style={input} value={form.dueDate} onChange={set('dueDate')} placeholder="2026.08.12" /></Field>
          <Field label="備註說明" wide><input style={input} value={form.remark} onChange={set('remark')} placeholder="需委外鍍鋅與整平" /></Field>
        </div>
        <div style={{ marginTop: 12, fontSize: 13, color: '#3a3a3c' }}>生產/原料規格(每列一條:規格、數量 pcs、重量 kg)</div>
        {specs.map((s, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 1fr auto', gap: 8, marginTop: 6 }}>
            <input style={input} value={s.spec} placeholder="鋁 SKA20-8*4'*1200mm" onChange={e => setSpecs(rows => rows.map((r, k) => k === i ? { ...r, spec: e.target.value } : r))} />
            <input style={input} value={s.qty} placeholder="100" onChange={e => setSpecs(rows => rows.map((r, k) => k === i ? { ...r, qty: e.target.value } : r))} />
            <input style={input} value={s.weight} placeholder="860" onChange={e => setSpecs(rows => rows.map((r, k) => k === i ? { ...r, weight: e.target.value } : r))} />
            <Btn kind="plain" onClick={() => setSpecs(rows => rows.length > 1 ? rows.filter((_, k) => k !== i) : rows)}>－</Btn>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn kind="plain" onClick={() => setSpecs(rows => [...rows, { spec: '', qty: '', weight: '' }])}>＋ 規格</Btn>
          <Btn onClick={() => void createLabel()}>建立標籤</Btn>
        </div>
        {created && (
          <div style={{ display: 'flex', gap: 16, marginTop: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <QrImage text={created.qrText} />
            <div>
              <div style={{ fontWeight: 600 }}>{created.code} · {KIND_NAMES[created.kind]}</div>
              <pre style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{created.qrText}</pre>
              <div style={{ fontSize: 12, color: '#6e6e73' }}>QR 內容就是這六項文字(範例一~三),掃到後系統會還原欄位並對回這張標籤。</div>
            </div>
          </div>
        )}
      </Card>

      <Card title="入庫 / 出庫(倉管人員)">
        <Field label="掃描結果:貼上 QR 文字(六項)或標籤碼 LB-…" wide>
          <textarea style={{ ...input, minHeight: 96, fontFamily: 'ui-monospace, monospace' }} value={scan} onChange={e => setScan(e.target.value)} />
        </Field>
        <div style={{ ...grid, marginTop: 10 }}>
          <Field label="動作">
            <select style={input} value={move.type} onChange={e => setMove(m => ({ ...m, type: e.target.value as 'in' | 'out' }))}>
              <option value="in">入庫</option><option value="out">出庫</option>
            </select>
          </Field>
          <Field label="階段">
            <select style={input} value={move.stage} onChange={e => setMove(m => ({ ...m, stage: e.target.value as Stage }))}>
              {Object.entries(STAGE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="儲位"><input style={input} value={move.location} onChange={e => setMove(m => ({ ...m, location: e.target.value }))} /></Field>
          <Field label="數量(pcs)"><input style={input} value={move.qty} onChange={e => setMove(m => ({ ...m, qty: e.target.value }))} /></Field>
          <Field label="重量(kg)"><input style={input} value={move.weight} onChange={e => setMove(m => ({ ...m, weight: e.target.value }))} /></Field>
          <Field label="備註"><input style={input} value={move.note} onChange={e => setMove(m => ({ ...m, note: e.target.value }))} /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Btn onClick={() => void submitMove()}>記錄{move.type === 'in' ? '入庫' : '出庫'}</Btn></div>
        {moveResult && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {moveResult.label.code} · {moveResult.label.customer || ''} {moveResult.label.manuOrderNo || ''} → 目前庫存
            <strong> {moveResult.stock?.qty ?? 0} pcs / {moveResult.stock?.weight ?? 0} kg</strong>
          </div>
        )}
      </Card>

      <Card title="庫存(入減出還有東西的標籤)">
        <div style={{ marginBottom: 8 }}><Btn kind="plain" onClick={() => void loadStock()}>重新整理</Btn></div>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead><tr><th style={th}>標籤碼</th><th style={th}>種類</th><th style={th}>客戶</th><th style={th}>製造/加工單</th><th style={th}>儲位</th><th style={th}>規格</th><th style={th}>數量</th><th style={th}>重量</th><th style={th}>最後異動</th></tr></thead>
            <tbody>
              {stock.length === 0 && <tr><td style={td} colSpan={9}>目前沒有庫存紀錄</td></tr>}
              {stock.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.code}</td><td style={td}>{KIND_NAMES[r.kind]}</td><td style={td}>{r.customer}</td>
                  <td style={td}>{[r.manuOrderNo, r.processOrderNo].filter(Boolean).join(' , ')}</td>
                  <td style={td}>{r.location}</td>
                  <td style={td}>{(r.specs || []).map(s => s.spec).join(' / ')}</td>
                  <td style={td}>{r.stock.qty}</td><td style={td}>{r.stock.weight}</td><td style={td}>{fmt(r.stock.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
