// 現場工單畫面的測試。
//
// 分工：後端的 tests/cutting-plan.test.mjs 測規則（鎖定後不給調順序、解鎖要原因…），
// 這裡測後端測不到的事——**畫面在不同狀態下給不給按**。現場按錯的代價是裁錯料，
// 所以「鎖定後不該出現 ↑↓」「等待材料的單不該出現開始生產」這類條件渲染要有測試守著。
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import CuttingPlanPage from './CuttingPlanPage'
import { ToastProvider } from '../components/Toast'

const api = vi.hoisted(() => vi.fn())
vi.mock('../api/client', () => ({ api }))

type O = Record<string, unknown>
const order = (no: string, over: O = {}): O => ({
  processNo: no, workOrderNo: 'E1151015001', manuOrderNo: null,
  customer: '光鈦', spec: '黑鐵 2.0T 裁切', qty: 45, seqNo: 1,
  dueDate: '2026-10-20T00:00:00.000Z', layoutFile: null, waitingMaterial: false,
  startedAt: null, finishedAt: null, totalWorkers: null, storageLocation: null,
  completedQty: null, items: [], ...over,
})

const plan = (over: O = {}): O => ({
  machineNo: '31', date: '2026-10-15', locked: false, lock: null,
  orders: [order('G1151015001'), order('G1151015002', { seqNo: 2, customer: '欣鉅' })],
  currentProcessNo: 'G1151015001',
  progress: { total: 2, done: 0, waiting: 0 },
  ...over,
})

const summary = (over: O = {}): O => ({
  total: 2, done: 0, waiting: 0, plannedQty: 90, completedQty: 0,
  workMinutes: 0, manMinutes: 0, utilization: 0, ...over,
})

// GET /plan 回 planData、GET /plan/summary 回 summaryData，其餘呼叫交給 onCall
function mockApi(planData: O, summaryData: O = summary(), onCall?: (p: string, o?: O) => O | undefined) {
  api.mockImplementation(async (path: string, opts?: O) => {
    if (path.startsWith('/api/cutting/plan/summary')) return { ok: true, data: summaryData }
    if (path.startsWith('/api/cutting/plan?')) return { ok: true, data: planData }
    const r = onCall?.(path, opts)
    return { ok: true, data: r ?? planData }
  })
}

const view = () => render(<ToastProvider><CuttingPlanPage /></ToastProvider>)
const card = (no: string) => screen.getByText(no).closest('div[style]')!.parentElement as HTMLElement

// 注意：不能寫成 beforeEach(() => api.mockReset())——箭頭會隱含回傳 mock 本身，
// Vitest 會把回傳的函式當成 teardown 再呼叫一次，mock 就會收到一次無參數的呼叫。
beforeEach(() => { api.mockReset() })

describe('鎖定前：可以調整，不能開工', () => {
  beforeEach(() => { mockApi(plan({ locked: false })) })

  test('顯示調整工具與「確認計畫」，不顯示開始生產', async () => {
    view()
    expect(await screen.findByText('G1151015001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '確認計畫（鎖定）' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '↑' }).length).toBe(2)
    expect(screen.queryByRole('button', { name: '開始生產' })).not.toBeInTheDocument()
  })

  test('第一張的↑與最後一張的↓要停用，避免按了沒反應', async () => {
    view()
    await screen.findByText('G1151015001')
    const ups = screen.getAllByRole('button', { name: '↑' })
    const downs = screen.getAllByRole('button', { name: '↓' })
    expect(ups[0]).toBeDisabled()
    expect(downs[downs.length - 1]).toBeDisabled()
  })

  test('按↓會送出交換後的順序', async () => {
    const sent: O[] = []
    mockApi(plan(), summary(), (p, o) => { if (p.includes('reorder')) sent.push(o!.body as O); return undefined })
    view()
    await screen.findByText('G1151015001')
    await userEvent.click(screen.getAllByRole('button', { name: '↓' })[0])
    expect(sent[0].order).toEqual(['G1151015002', 'G1151015001'])
  })
})

describe('鎖定後：只能開工與回報', () => {
  beforeEach(() => { mockApi(plan({ locked: true, lock: { lockedAt: '', lockedByName: '張三' } })) })

  test('不顯示調整工具，顯示開始生產', async () => {
    view()
    expect(await screen.findByText('G1151015001')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '↑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '標記等待材料' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '開始生產' }).length).toBe(2)
    expect(screen.getByText(/已確認鎖定/)).toBeInTheDocument()
  })

  test('已開工的那張改顯示「回報完成」', async () => {
    mockApi(plan({
      locked: true, lock: { lockedAt: '', lockedByName: '張三' },
      orders: [order('G1151015001', { startedAt: '2026-10-15T01:00:00.000Z' }), order('G1151015002', { seqNo: 2 })],
    }))
    view()
    await screen.findByText('G1151015001')
    const c = card('G1151015001')
    expect(within(c).getByRole('button', { name: '回報完成' })).toBeInTheDocument()
    expect(within(c).queryByRole('button', { name: '開始生產' })).not.toBeInTheDocument()
  })
})

describe('等待材料與已完成的單', () => {
  test('等待材料的單不給開工——料沒到就按下去會做錯', async () => {
    mockApi(plan({
      locked: true, lock: { lockedAt: '', lockedByName: '張三' },
      orders: [order('G1151015001', { waitingMaterial: true }), order('G1151015002', { seqNo: 2 })],
    }))
    view()
    await screen.findByText('G1151015001')
    const c = card('G1151015001')
    expect(within(c).getByText('等待材料')).toBeInTheDocument()
    expect(within(c).queryByRole('button', { name: '開始生產' })).not.toBeInTheDocument()
    // 另一張不受影響
    expect(within(card('G1151015002')).getByRole('button', { name: '開始生產' })).toBeInTheDocument()
  })

  test('已完成的單不再顯示任何操作按鈕', async () => {
    mockApi(plan({
      locked: true, lock: { lockedAt: '', lockedByName: '張三' },
      orders: [order('G1151015001', { startedAt: '2026-10-15T01:00:00.000Z', finishedAt: '2026-10-15T03:00:00.000Z', completedQty: 44 })],
    }))
    view()
    await screen.findByText('G1151015001')
    const c = card('G1151015001')
    expect(within(c).getByText(/已完成/)).toBeInTheDocument()
    expect(within(c).queryByRole('button', { name: '開始生產' })).not.toBeInTheDocument()
    expect(within(c).queryByRole('button', { name: '回報完成' })).not.toBeInTheDocument()
  })
})

describe('回報完成', () => {
  const started = plan({
    locked: true, lock: { lockedAt: '', lockedByName: '張三' },
    orders: [order('G1151015001', { startedAt: '2026-10-15T01:00:00.000Z' })],
    currentProcessNo: 'G1151015001',
  })

  test('沒填當班人數就送出要擋下來，不打後端', async () => {
    const calls: string[] = []
    mockApi(started, summary(), p => { calls.push(p); return undefined })
    view()
    await screen.findByText('G1151015001')
    await userEvent.click(screen.getByRole('button', { name: '回報完成' }))
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(calls.some(p => p.includes('/finish'))).toBe(false)
    expect(screen.getByText(/請填當班人數/)).toBeInTheDocument()
  })

  test('填了人數就送出，並帶上數量與儲位', async () => {
    let body: O | undefined
    mockApi(started, summary(), (p, o) => {
      if (p.includes('/finish')) { body = o!.body as O; return { ...started, next: 'G1151015002' } }
      return undefined
    })
    view()
    await screen.findByText('G1151015001')
    await userEvent.click(screen.getByRole('button', { name: '回報完成' }))
    await userEvent.type(screen.getByLabelText('當班人數 *'), '3')
    await userEvent.type(screen.getByLabelText('入庫儲位'), 'C-01')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))

    expect(body).toMatchObject({ totalWorkers: '3', storageLocation: 'C-01', qty: '45' })
    // 完成後要提示下一張，現場才知道接著做什麼
    expect(await screen.findByText(/下一張：G1151015002/)).toBeInTheDocument()
  })

  test('最後一張完成後提示當日做完', async () => {
    mockApi(started, summary(), p => (p.includes('/finish') ? { ...started, next: null } : undefined))
    view()
    await screen.findByText('G1151015001')
    await userEvent.click(screen.getByRole('button', { name: '回報完成' }))
    await userEvent.type(screen.getByLabelText('當班人數 *'), '2')
    await userEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(await screen.findByText(/當日計畫全部完成/)).toBeInTheDocument()
  })
})

describe('其他', () => {
  test('沒有工單時要講清楚，不是空白畫面', async () => {
    mockApi(plan({ orders: [], currentProcessNo: null }), summary({ total: 0, plannedQty: 0 }))
    view()
    expect(await screen.findByText('這天這台機台沒有工單。')).toBeInTheDocument()
  })

  test('切換機台會重新載入該機台的計畫', async () => {
    const paths: string[] = []
    api.mockImplementation(async (path: string) => {
      paths.push(path)
      if (path.includes('summary')) return { ok: true, data: summary() }
      return { ok: true, data: plan() }
    })
    view()
    await screen.findByText('G1151015001')
    await userEvent.click(screen.getByRole('button', { name: '33' }))
    expect(paths.some(p => p.includes('machineNo=33'))).toBe(true)
  })

  test('當日績效要顯示工時與稼動率', async () => {
    mockApi(plan(), summary({ done: 1, completedQty: 44, manMinutes: 270, utilization: 60 }))
    view()
    expect(await screen.findByText(/270/)).toBeInTheDocument()
    expect(screen.getByText(/60%/)).toBeInTheDocument()
  })
})
