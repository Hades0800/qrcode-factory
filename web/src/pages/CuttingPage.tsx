import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Btn, Card, Field, fmt, fmtDay, grid, input, table, td, th } from '../components/ui'
import type { ProcessOrder } from '../api/types'

const STEPS: [string, string][] = [['1', '領料'], ['2', '裁切開始'], ['3', '裁切完成'], ['4', '包裝'], ['9', '其他']]
const emptyForm = { processNo: '', manuOrderNo: '', customer: '', spec: '', qty: '', weight: '', machineNo: '', plannedDate: '', dueDate: '', remark: '', labelCode: '' }

// 裁切 MES 系統:加工單(G 號)綁定製造單(F 號);裁切工序;結案 = QR Code 結案 + 成品入庫
export default function CuttingPage() {
  const toast = useToast()
  const [form, setForm] = useState(emptyForm)
  const [status, setStatus] = useState<'open' | 'done' | ''>('open')
  const [list, setList] = useState<ProcessOrder[]>([])
  const [current, setCurrent] = useState<ProcessOrder | null>(null)
  const [done, setDone] = useState({ qty: '', weight: '', location: '' })
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const r = await api<{ processOrders: ProcessOrder[] }>('/api/cutting/process-orders' + (status ? `?status=${status}` : ''))
    if (r.ok) setList(r.data.processOrders)
    else toast(r.error, 'error')
  }, [status, toast])

  useEffect(() => { void load() }, [load])

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function create() {
    const r = await api<{ processOrder: ProcessOrder }>('/api/cutting/process-orders', { method: 'POST', body: { ...form, qty: form.qty || null, weight: form.weight || null } })
    if (!r.ok) { toast(r.error, 'error'); return }
    toast('加工單已建立:' + r.data.processOrder.processNo, 'success')
    setForm(emptyForm)
    void load()
  }

  async function open(po: ProcessOrder) {
    const r = await api<{ processOrder: ProcessOrder }>('/api/cutting/process-orders/' + encodeURIComponent(po.processNo))
    if (r.ok) setCurrent(r.data.processOrder)
    else toast(r.error, 'error')
  }

  async function entry(stepNo: string) {
    if (!current) return
    const r = await api('/api/cutting/process-orders/' + encodeURIComponent(current.processNo) + '/entries', { method: 'POST', body: { stepNo, note } })
    if (!r.ok) { toast(r.error, 'error'); return }
    setNote('')
    void open(current)
  }

  async function complete() {
    if (!current) return
    const r = await api<{ processOrder: ProcessOrder }>('/api/cutting/process-orders/' + encodeURIComponent(current.processNo) + '/complete', {
      method: 'POST', body: { qty: done.qty || null, weight: done.weight || null, location: done.location || null },
    })
    if (!r.ok) { toast(r.error, 'error'); return }
    toast('已結案' + (r.data.processOrder.label ? ',成品已入庫、標籤已結案' : '(沒有綁定標籤,未入庫)'), 'success')
    setCurrent(r.data.processOrder)
    void load()
  }

  return (
    <div>
      <Card title="建立加工單(業務助理 / 生管)">
        <div style={grid}>
          <Field label="加工單號"><input style={input} value={form.processNo} onChange={set('processNo')} placeholder="G1150810006" /></Field>
          <Field label="綁定製造單號"><input style={input} value={form.manuOrderNo} onChange={set('manuOrderNo')} placeholder="F1150810001" /></Field>
          <Field label="客戶"><input style={input} value={form.customer} onChange={set('customer')} /></Field>
          <Field label="機台"><input style={input} value={form.machineNo} onChange={set('machineNo')} /></Field>
          <Field label="數量(pcs)"><input style={input} value={form.qty} onChange={set('qty')} /></Field>
          <Field label="重量(kg)"><input style={input} value={form.weight} onChange={set('weight')} /></Field>
          <Field label="排定日"><input style={input} value={form.plannedDate} onChange={set('plannedDate')} placeholder="2026.08.18" /></Field>
          <Field label="納期"><input style={input} value={form.dueDate} onChange={set('dueDate')} placeholder="2026.08.25" /></Field>
          <Field label="標籤碼(不填就用製造單最新的標籤)"><input style={input} value={form.labelCode} onChange={set('labelCode')} placeholder="LB-…" /></Field>
          <Field label="裁切規格(每行一條)" wide><textarea style={{ ...input, minHeight: 60 }} value={form.spec} onChange={set('spec')} /></Field>
          <Field label="備註" wide><input style={input} value={form.remark} onChange={set('remark')} /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Btn onClick={() => void create()}>建立加工單</Btn></div>
      </Card>

      <Card title="加工單">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {(['open', 'done', ''] as const).map(s => (
            <Btn key={s} kind={status === s ? 'primary' : 'plain'} onClick={() => setStatus(s)}>{s === 'open' ? '進行中' : s === 'done' ? '已結案' : '全部'}</Btn>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead><tr><th style={th}>加工單</th><th style={th}>製造單</th><th style={th}>客戶</th><th style={th}>排定</th><th style={th}>納期</th><th style={th}>數量</th><th style={th}>標籤</th><th style={th}>狀態</th><th style={th}></th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td style={td} colSpan={9}>沒有資料</td></tr>}
              {list.map(po => (
                <tr key={po.id}>
                  <td style={td}>{po.processNo}</td><td style={td}>{po.manuOrderNo}</td><td style={td}>{po.customer}</td>
                  <td style={td}>{fmtDay(po.plannedDate)}</td><td style={td}>{fmtDay(po.dueDate)}</td><td style={td}>{po.qty}</td>
                  <td style={td}>{po.label?.code || '—'}</td><td style={td}>{po.status === 'done' ? '已結案' : '進行中'}</td>
                  <td style={td}><Btn kind="plain" onClick={() => void open(po)}>開啟</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {current && (
        <Card title={`加工單 ${current.processNo}(加工人員)`}>
          <div style={{ fontSize: 14, color: '#3a3a3c' }}>
            綁定製造單 {current.manuOrderNo || '—'} · 標籤 {current.label?.code || '—'} · {current.status === 'done' ? `已結案 ${fmt(current.completedAt)}` : '進行中'}
          </div>
          {current.spec && <pre style={{ fontSize: 13, whiteSpace: 'pre-wrap', margin: '8px 0' }}>{current.spec}</pre>}
          {current.status !== 'done' && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {STEPS.map(([no, name]) => <Btn key={no} kind="plain" onClick={() => void entry(no)}>{no}. {name}</Btn>)}
                <input style={{ ...input, flex: 1, minWidth: 160 }} value={note} onChange={e => setNote(e.target.value)} placeholder="工序備註(可留空)" />
              </div>
              <div style={{ ...grid, marginTop: 12 }}>
                <Field label="結案數量(pcs)"><input style={input} value={done.qty} onChange={e => setDone(d => ({ ...d, qty: e.target.value }))} /></Field>
                <Field label="結案重量(kg)"><input style={input} value={done.weight} onChange={e => setDone(d => ({ ...d, weight: e.target.value }))} /></Field>
                <Field label="成品入庫儲位"><input style={input} value={done.location} onChange={e => setDone(d => ({ ...d, location: e.target.value }))} /></Field>
              </div>
              <div style={{ marginTop: 12 }}><Btn kind="danger" onClick={() => void complete()}>QR Code 結案(成品入庫)</Btn></div>
            </>
          )}
          <table style={{ ...table, marginTop: 12 }}>
            <thead><tr><th style={th}>時間</th><th style={th}>工序</th><th style={th}>備註</th><th style={th}>人員</th></tr></thead>
            <tbody>
              {(current.entries || []).map(e => (
                <tr key={e.id}><td style={td}>{fmt(e.recordedAt)}</td><td style={td}>{STEPS.find(s => s[0] === e.stepNo)?.[1] || e.stepNo}</td><td style={td}>{e.note}</td><td style={td}>{e.leaderName}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
