// 後端 serializer（backend/src/domain/orders/serialize.js）回傳的工單結構，挑常用欄位入型。
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
