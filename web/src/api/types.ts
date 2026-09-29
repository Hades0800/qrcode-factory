// 後端 serializer（backend/src/modules/production/domain/serialize.js）回傳的工單結構，挑常用欄位入型。
// 不求窮盡，新功能用到哪些再補。

export interface Me {
  id: number
  username?: string
  displayName: string
  isAdmin?: boolean
  isPlanner?: boolean
}

export interface StepEntry {
  id: number
  stepNo: string
  seq?: number
  recordedAt: string
  isManual?: boolean
  note?: string | null
  qcActualQty?: number | null
}

export interface PauseHistoryItem {
  startAt: string
  endAt?: string | null
  duration?: number | null
  note?: string | null
  qcActualQty?: number | null
}

export interface PauseSummary {
  count: number
  totalSec: number
  active?: { startAt: string; note?: string | null } | null
  history?: PauseHistoryItem[]
}

export interface Order {
  orderNo: string
  machineNo?: string | null
  plannedMachineNo?: string | null
  customerName?: string
  productSpec?: string
  moldSpec?: string
  material?: string
  dispatchQty?: number | null
  bladeCount?: number | null
  machineSPM?: number | null
  unitWeight?: number | null
  totalWeight?: number | null
  plannedDate?: string | null
  productionDate?: string | null
  actualStartDate?: string | null
  step11At?: string | null
  step11Note?: string | null
  step11QcActualQty?: number | null
  stepEntries?: StepEntry[]
  pause12?: PauseSummary
  pause13?: PauseSummary
  [key: string]: unknown
}

// ───────── 模組化(docs/MODULES.md)新增的型別 ─────────

export interface ModuleInfo { key: string; name: string; description: string }

export type LabelKind = 'material' | 'semi' | 'finished' | 'outsourced'
export type Stage = 'material' | 'semi' | 'finished' | 'outsourced'

export interface LabelSpec { id?: number; seq?: number; spec: string; qty?: number | null; weight?: number | null }

export interface Label {
  id: number
  code: string
  kind: LabelKind
  customer?: string | null
  poNo?: string | null
  manuOrderNo?: string | null
  processOrderNo?: string | null
  location?: string | null
  machineNo?: string | null
  dueDate?: string | null
  remark?: string | null
  qrText: string
  status: string
  createdAt?: string
  specs?: LabelSpec[]
}

export interface Stock { qty: number; weight: number; lastAt?: string | null }

export interface StockMove {
  id: number
  type: 'in' | 'out'
  stage: Stage
  location?: string | null
  qty?: number | null
  weight?: number | null
  refType?: string | null
  refNo?: string | null
  note?: string | null
  actorName?: string | null
  at: string
  label?: Partial<Label> | null
}

export interface ProcessEntry { id: number; stepNo: string; note?: string | null; recordedAt: string; leaderName?: string | null }

export interface ProcessOrder {
  id: number
  processNo: string
  manuOrderNo?: string | null
  customer?: string | null
  spec?: string | null
  qty?: number | null
  weight?: number | null
  machineNo?: string | null
  plannedDate?: string | null
  dueDate?: string | null
  remark?: string | null
  status: 'open' | 'done'
  completedAt?: string | null
  completedQty?: number | null
  completedWeight?: number | null
  label?: Partial<Label> | null
  entries?: ProcessEntry[]
}

export interface ShipmentItem {
  id: number
  labelId?: number | null
  source: 'stock' | 'retail'
  spec?: string | null
  qty?: number | null
  weight?: number | null
  checkedAt?: string | null
  checkedByName?: string | null
  label?: Partial<Label> | null
}

export interface Shipment {
  id: number
  shipNo: string
  customer?: string | null
  shipDate?: string | null
  status: 'open' | 'checked' | 'shipped'
  note?: string | null
  items: ShipmentItem[]
}
