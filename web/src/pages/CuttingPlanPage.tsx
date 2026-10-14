import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useToast } from '../components/Toast'
import { Btn, Card } from '../components/ui'

// 現場工單（裁切加工計畫表）。對照「系統運作工作項目摘要表」生產人員的七步：
//   1 接收當天計畫 → 2 確認原料、調整順位 → 3 確認後鎖住計畫
//   → 4 依序開工、記開始與完成時間 → 5 完成跳下一張 → 6 做完當日 → 7 績效
// 鎖定前可調順序、標等待材料；鎖定後只能開工與回報。

const MACHINES = ['31', '32', '33']
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })

type Item = { seq: string; spec: string; qty: number | null; unit: string | null }
type Order = {
  processNo: string; workOrderNo: string | null; manuOrderNo: string | null
  customer: string | null; spec: string | null; qty: number | null
  seqNo: number | null; dueDate: string | null
  layoutFile: string | null; waitingMaterial: boolean
  startedAt: string | null; finishedAt: string | null
  totalWorkers: number | null; storageLocation: string | null
  completedQty: number | null; items: Item[]
}
type Plan = {
  machineNo: string; date: string; locked: boolean
  lock: { lockedAt: string; lockedByName: string | null } | null
  orders: Order[]; currentProcessNo: string | null
  progress: { total: number; done: number; waiting: number }
}
type Summary = {
  total: number; done: number; waiting: number; plannedQty: number; completedQty: number
  workMinutes: number; manMinutes: number; utilization: number
}

const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('zh-TW'))
const hhmm = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'

export default function CuttingPlanPage() {
  const toast = useToast()
  const [machineNo, setMachineNo] = useState(MACHINES[0])
  const [date, setDate] = useState(todayStr)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [finishing, setFinishing] = useState<Order | null>(null)
  const [form, setForm] = useState({ qty: '', weight: '', totalWorkers: '', storageLocation: '', note: '', oddCutting: false })

  const load = useCallback(async () => {
    const q = `?machineNo=${machineNo}&date=${date}`
    const [p, s] = await Promise.all([api<Plan>('/api/cutting/plan' + q), api<Summary>('/api/cutting/plan/summary' + q)])
    if (p.ok) setPlan(p.data); else toast(p.error, 'error')
    if (s.ok) setSummary(s.data)
  }, [machineNo, date, toast])

  useEffect(() => { void load() }, [load])

  // 現場畫面長時間開著，每 60 秒同步一次（生管改了計畫要看得到）
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void load() }, 60000)
    return () => clearInterval(t)
  }, [load])

  async function call(path: string, body?: unknown, method: 'POST' | 'PATCH' = 'POST') {
    setBusy(true)
    const r = await api<Plan>(path, { method, body })
    setBusy(false)
    if (!r.ok) { toast(r.error, 'error'); return false }
    setPlan(r.data)
    void load()
    return true
  }

  const move = async (i: number, dir: -1 | 1) => {
    if (!plan) return
    const list = plan.orders.map(o => o.processNo)
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    await call('/api/cutting/plan/reorder', { machineNo, date, order: list }, 'PATCH')
  }

  const lock = async () => {
    if (!confirm('確認後計畫就鎖定，順序不能再調。要繼續嗎？')) return
    if (await call('/api/cutting/plan/lock', { machineNo, date })) toast('計畫已確認，可以開工', 'success')
  }

  const start = async (o: Order) => {
    if (await call(`/api/cutting/plan/${o.processNo}/start`)) toast(`${o.processNo} 開始生產`, 'success')
  }

  const openFinish = (o: Order) => {
    setFinishing(o)
    setForm({ qty: String(o.qty ?? ''), weight: '', totalWorkers: '', storageLocation: '', note: '', oddCutting: false })
  }

  const submitFinish = async () => {
    if (!finishing) return
    if (!form.totalWorkers) { toast('請填當班人數', 'error'); return }
    setBusy(true)
    const r = await api<Plan & { next: string | null }>(`/api/cutting/plan/${finishing.processNo}/finish`, { method: 'POST', body: form })
    setBusy(false)
    if (!r.ok) { toast(r.error, 'error'); return }
    setFinishing(null)
    setPlan(r.data)
    void load()
    toast(r.data.next ? `完成，下一張：${r.data.next}` : '當日計畫全部完成', 'success')
  }

  const orders = plan?.orders ?? []
  const current = plan?.currentProcessNo

  return (
    <div style={{ marginTop: 16 }}>
      {/* 選機台與日期 */}
      <Card title="裁切加工計畫表">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {MACHINES.map(m => (
              <button key={m} onClick={() => setMachineNo(m)} style={{
                width: 56, height: 44, borderRadius: 10, fontSize: 18, fontWeight: 700, cursor: 'pointer',
                border: m === machineNo ? '2px solid #1d4ed8' : '1px solid #d1d1d6',
                background: m === machineNo ? '#1d4ed8' : '#fff', color: m === machineNo ? '#fff' : '#1c1c1e',
              }}>{m}</button>
            ))}
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ height: 44, padding: '0 10px', fontSize: 16, borderRadius: 10, border: '1px solid #d1d1d6' }} />
          <Btn kind="plain" onClick={() => void load()}>重新整理</Btn>
          {plan && (plan.locked
            ? <span style={{ padding: '6px 12px', borderRadius: 999, background: '#e8f5e9', color: '#1b5e20', fontSize: 14 }}>
                已確認鎖定{plan.lock?.lockedByName ? `（${plan.lock.lockedByName}）` : ''}
              </span>
            : <Btn kind="primary" onClick={lock} disabled={busy || !orders.length}>確認計畫（鎖定）</Btn>)}
        </div>

        {summary && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, fontSize: 14, color: '#3a3a3c' }}>
            <span>進度 <b>{summary.done}/{summary.total}</b></span>
            <span>數量 <b>{num(summary.completedQty)}</b> / {num(summary.plannedQty)}</span>
            {summary.waiting > 0 && <span style={{ color: '#b45309' }}>等待材料 {summary.waiting}</span>}
            <span>工時 <b>{summary.manMinutes}</b> 人分</span>
            <span>稼動 <b>{summary.utilization}%</b>（對 450 分）</span>
          </div>
        )}
      </Card>

      {!orders.length && <Card><div style={{ color: '#6e6e73' }}>這天這台機台沒有工單。</div></Card>}

      {/* 工單列表 */}
      {orders.map((o, i) => {
        const isCurrent = o.processNo === current
        const doneRow = !!o.finishedAt
        return (
          <div key={o.processNo} style={{
            border: isCurrent ? '2px solid #1d4ed8' : '1px solid #e5e5ea',
            borderRadius: 12, padding: 12, marginTop: 10,
            background: doneRow ? '#f6f7f9' : o.waitingMaterial ? '#fffbeb' : '#fff',
            opacity: doneRow ? 0.72 : 1,
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22, fontWeight: 700, minWidth: 34 }}>{o.seqNo ?? i + 1}</span>
              <span style={{ fontSize: 17, fontWeight: 600 }}>{o.customer || '—'}</span>
              <code style={{ fontSize: 15 }}>{o.processNo}</code>
              <span style={{ fontSize: 13, color: '#6e6e73' }}>製造單 {o.manuOrderNo || '------'}</span>
              {o.dueDate && <span style={{ fontSize: 13, color: '#6e6e73' }}>交期 {o.dueDate.slice(0, 10)}</span>}
              {o.waitingMaterial && <span style={{ fontSize: 13, color: '#b45309', fontWeight: 600 }}>等待材料</span>}
              <span style={{ marginLeft: 'auto', fontSize: 14, color: '#3a3a3c' }}>
                {hhmm(o.startedAt)} → {hhmm(o.finishedAt)}
                {o.totalWorkers ? `　${o.totalWorkers} 人` : ''}
                {o.storageLocation ? `　${o.storageLocation}` : ''}
              </span>
            </div>

            <div style={{ marginTop: 6, fontSize: 14, whiteSpace: 'pre-wrap' }}>
              {o.items.length
                ? o.items.map(it => <div key={it.seq}>{it.spec}{it.qty != null ? ` ， ${num(it.qty)}${it.unit || ''}` : ''}</div>)
                : o.spec}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {o.layoutFile && <Btn kind="plain" onClick={() => window.open(o.layoutFile!, '_blank')}>加工配置圖</Btn>}

              {!plan?.locked && !doneRow && (
                <>
                  <Btn kind="plain" onClick={() => void move(i, -1)} disabled={busy || i === 0}>↑</Btn>
                  <Btn kind="plain" onClick={() => void move(i, 1)} disabled={busy || i === orders.length - 1}>↓</Btn>
                  <Btn kind="plain" onClick={() => void call('/api/cutting/plan/waiting',
                    { processNo: o.processNo, waiting: !o.waitingMaterial }, 'PATCH')} disabled={busy}>
                    {o.waitingMaterial ? '解除等待' : '標記等待材料'}
                  </Btn>
                </>
              )}

              {plan?.locked && !doneRow && !o.waitingMaterial && (
                o.startedAt
                  ? <Btn kind="primary" onClick={() => openFinish(o)} disabled={busy}>回報完成</Btn>
                  : <Btn kind="primary" onClick={() => void start(o)} disabled={busy}>開始生產</Btn>
              )}

              {doneRow && <span style={{ fontSize: 14, color: '#1b5e20' }}>
                已完成{o.completedQty != null ? ` ${num(o.completedQty)}` : ''}
              </span>}
            </div>
          </div>
        )
      })}

      {/* 完成回報 */}
      {finishing && (
        <div onClick={e => { if (e.target === e.currentTarget) setFinishing(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 16, width: 'min(420px, 100%)' }}>
            <h3 style={{ margin: '0 0 4px' }}>回報完成</h3>
            <div style={{ fontSize: 14, color: '#6e6e73', marginBottom: 12 }}>
              {finishing.processNo}　{finishing.customer}
            </div>
            {([
              ['qty', '完成數量'], ['weight', '重量 (kg)'],
              ['totalWorkers', '當班人數 *'], ['storageLocation', '入庫儲位'], ['note', '備註'],
            ] as const).map(([k, label]) => (
              <label key={k} style={{ display: 'block', marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: '#3a3a3c' }}>{label}</span>
                <input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                  inputMode={k === 'storageLocation' || k === 'note' ? 'text' : 'decimal'}
                  style={{ width: '100%', height: 44, fontSize: 16, padding: '0 10px', borderRadius: 10, border: '1px solid #d1d1d6', boxSizing: 'border-box' }} />
              </label>
            ))}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 15 }}>
              <input type="checkbox" checked={form.oddCutting}
                onChange={e => setForm(f => ({ ...f, oddCutting: e.target.checked }))}
                style={{ width: 20, height: 20 }} />
              零星裁剪
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn kind="primary" onClick={() => void submitFinish()} disabled={busy}>送出</Btn>
              <Btn kind="plain" onClick={() => setFinishing(null)}>取消</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
