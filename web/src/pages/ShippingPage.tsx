import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Btn, Card, Field, fmt, fmtDay, grid, input, table, td, th } from '../components/ui'
import type { Shipment } from '../api/types'

const STATUS_NAME: Record<string, string> = { open: '待檢核', checked: '已檢核', shipped: '已出庫' }
const emptyForm = { shipNo: '', customer: '', shipDate: '', note: '' }

// 出貨管理系統:出貨單 → 掃庫存 QR / 零購 QR 加明細 → 倉管 QR 檢核 → 出庫
export default function ShippingPage() {
  const toast = useToast()
  const [form, setForm] = useState(emptyForm)
  const [list, setList] = useState<Shipment[]>([])
  const [current, setCurrent] = useState<Shipment | null>(null)
  const [item, setItem] = useState({ source: 'stock' as 'stock' | 'retail', scan: '', spec: '', qty: '', weight: '' })
  const [check, setCheck] = useState('')

  const load = useCallback(async () => {
    const r = await api<{ shipments: Shipment[] }>('/api/shipping/shipments')
    if (r.ok) setList(r.data.shipments)
    else toast(r.error, 'error')
  }, [toast])

  useEffect(() => { void load() }, [load])

  const scanBody = (s: string) => (s.trim().startsWith('LB-') && !s.includes('\n') ? { code: s.trim() } : { text: s })

  async function create() {
    const r = await api<{ shipment: Shipment }>('/api/shipping/shipments', { method: 'POST', body: form })
    if (!r.ok) { toast(r.error, 'error'); return }
    setForm(emptyForm); setCurrent(r.data.shipment); void load()
  }

  async function addItem() {
    if (!current) return
    const r = await api<{ shipment: Shipment }>('/api/shipping/shipments/' + encodeURIComponent(current.shipNo) + '/items', {
      method: 'POST', body: { ...scanBody(item.scan), source: item.source, spec: item.spec, qty: item.qty || null, weight: item.weight || null },
    })
    if (!r.ok) { toast(r.error, 'error'); return }
    setItem(i => ({ ...i, scan: '', spec: '', qty: '', weight: '' }))
    setCurrent(r.data.shipment)
  }

  async function removeItem(id: number) {
    if (!current) return
    const r = await api<{ shipment: Shipment }>('/api/shipping/shipments/' + encodeURIComponent(current.shipNo) + '/items/' + id, { method: 'DELETE' })
    if (!r.ok) { toast(r.error, 'error'); return }
    setCurrent(r.data.shipment)
  }

  async function doCheck() {
    if (!current) return
    const r = await api<{ pending: number; shipment: Shipment }>('/api/shipping/shipments/' + encodeURIComponent(current.shipNo) + '/check', { method: 'POST', body: scanBody(check) })
    if (!r.ok) { toast(r.error, 'error'); return }
    setCheck('')
    setCurrent(r.data.shipment)
    toast(r.data.pending ? `還有 ${r.data.pending} 筆待檢核` : '全部檢核完成', 'success')
  }

  async function ship() {
    if (!current) return
    const r = await api<{ shipment: Shipment }>('/api/shipping/shipments/' + encodeURIComponent(current.shipNo) + '/ship', { method: 'POST' })
    if (!r.ok) { toast(r.error, 'error'); return }
    setCurrent(r.data.shipment); toast('已出庫,庫存已扣帳', 'success'); void load()
  }

  return (
    <div>
      <Card title="建立出貨單(業務助理)">
        <div style={grid}>
          <Field label="出貨單號"><input style={input} value={form.shipNo} onChange={e => setForm(f => ({ ...f, shipNo: e.target.value }))} placeholder="S1150826001" /></Field>
          <Field label="客戶"><input style={input} value={form.customer} onChange={e => setForm(f => ({ ...f, customer: e.target.value }))} /></Field>
          <Field label="出貨日"><input style={input} value={form.shipDate} onChange={e => setForm(f => ({ ...f, shipDate: e.target.value }))} placeholder="2026.08.26" /></Field>
          <Field label="備註"><input style={input} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Btn onClick={() => void create()}>建立出貨單</Btn></div>
      </Card>

      <Card title="出貨單">
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead><tr><th style={th}>出貨單</th><th style={th}>客戶</th><th style={th}>出貨日</th><th style={th}>明細</th><th style={th}>狀態</th><th style={th}></th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td style={td} colSpan={6}>沒有資料</td></tr>}
              {list.map(s => (
                <tr key={s.id}>
                  <td style={td}>{s.shipNo}</td><td style={td}>{s.customer}</td><td style={td}>{fmtDay(s.shipDate)}</td>
                  <td style={td}>{s.items.length} 筆</td><td style={td}>{STATUS_NAME[s.status] || s.status}</td>
                  <td style={td}><Btn kind="plain" onClick={() => setCurrent(s)}>開啟</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {current && (
        <Card title={`出貨單 ${current.shipNo} · ${STATUS_NAME[current.status] || current.status}`}>
          {current.status !== 'shipped' && (
            <>
              <div style={grid}>
                <Field label="來源">
                  <select style={input} value={item.source} onChange={e => setItem(i => ({ ...i, source: e.target.value as 'stock' | 'retail' }))}>
                    <option value="stock">庫存 QR(成品標籤)</option><option value="retail">零購 QR</option>
                  </select>
                </Field>
                <Field label="規格(零購用)"><input style={input} value={item.spec} onChange={e => setItem(i => ({ ...i, spec: e.target.value }))} /></Field>
                <Field label="數量"><input style={input} value={item.qty} onChange={e => setItem(i => ({ ...i, qty: e.target.value }))} placeholder="不填 = 標籤庫存量" /></Field>
                <Field label="重量"><input style={input} value={item.weight} onChange={e => setItem(i => ({ ...i, weight: e.target.value }))} /></Field>
                <Field label="掃描結果:QR 文字或標籤碼" wide>
                  <textarea style={{ ...input, minHeight: 72, fontFamily: 'ui-monospace, monospace' }} value={item.scan} onChange={e => setItem(i => ({ ...i, scan: e.target.value }))} />
                </Field>
              </div>
              <div style={{ marginTop: 10 }}><Btn onClick={() => void addItem()}>加入明細</Btn></div>
            </>
          )}
          <table style={{ ...table, marginTop: 12 }}>
            <thead><tr><th style={th}>來源</th><th style={th}>標籤</th><th style={th}>規格</th><th style={th}>數量</th><th style={th}>重量</th><th style={th}>檢核</th><th style={th}></th></tr></thead>
            <tbody>
              {current.items.length === 0 && <tr><td style={td} colSpan={7}>還沒有明細</td></tr>}
              {current.items.map(i => (
                <tr key={i.id}>
                  <td style={td}>{i.source === 'stock' ? '庫存' : '零購'}</td>
                  <td style={td}>{i.label?.code || '—'}{i.label?.manuOrderNo ? ` (${i.label.manuOrderNo})` : ''}</td>
                  <td style={td}>{i.spec}</td><td style={td}>{i.qty}</td><td style={td}>{i.weight}</td>
                  <td style={td}>{i.checkedAt ? `✓ ${fmt(i.checkedAt)} ${i.checkedByName || ''}` : (i.labelId ? '待檢核' : '—')}</td>
                  <td style={td}>{current.status !== 'shipped' && <Btn kind="plain" onClick={() => void removeItem(i.id)}>移除</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {current.status !== 'shipped' && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>倉管 QR 檢核(掃出貨單裡的每一張標籤)</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <textarea style={{ ...input, minHeight: 60, flex: 1, minWidth: 240, fontFamily: 'ui-monospace, monospace' }} value={check} onChange={e => setCheck(e.target.value)} placeholder="QR 文字或標籤碼" />
                <Btn onClick={() => void doCheck()}>檢核</Btn>
                <Btn kind="danger" onClick={() => void ship()}>出庫(扣庫存)</Btn>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
