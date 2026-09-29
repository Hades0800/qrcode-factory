# 模組化規劃：依「簡易關聯圖」切成四個系統

來源：`QR Code MES關聯表.xlsx`（工作表「簡易關連圖」「系統關聯表」「範例一～三」）。
原則：**同一個資料庫、同一個後端**，切成四個模組加一個共用層；四個系統之間只靠「QR 標籤」串接，
各模組只寫自己的表。現有的生產 MES 整個歸入生產模組，**API 路徑一個都不變**。

## 一、關聯圖與模組對照

```
 [QR 標籤範例]   [原料捲料照片]              出貨管理系統      → modules/shipping
        ↓                          ↗
      原料管理系統（入出庫管理系統）             → modules/inventory（標籤在這裡，四個系統共用）
     ↙                         ↖
 生產 MES 系統  ────→  裁切 MES 系統            → modules/production（現有系統）/ modules/cutting
 [每周排程表截圖]        [製造單截圖]
                                               共用層（登入、帳號角色、稽核）→ modules/core
```

流程（系統關聯表第 1 點）：訂單 → 庫存 → 原料 → 製造 → 裁切 → 委外 → 出貨。
資料流：原料貼標入庫 → 出庫給生產 → 生產完成再製標籤 → 裁切結案入庫（成品）→ 出貨檢核出庫。

## 二、目錄

```
backend/src/
  server.js                  只做一件事：registerModules()
  modules/index.js           模組登錄表（新增系統 = 加一個資料夾、登錄一行）；GET /api/modules
  modules/core/              共用層：auth / admin / maintenance
  modules/inventory/         原料管理（入出庫）：labels / inventory；domain/label.js 是標籤規則
  modules/production/        生產 MES：orders / equipmentParams / idleEvents；domain/ 是原本的 domain/orders
  modules/cutting/           裁切 MES：processOrders
  modules/shipping/          出貨管理：shipments
  lib/                       共用工具（validation、audit、date、machines、roles）
  plugins/                   prisma（軟刪除）、security、auth（authenticate / requireAdmin / requireRole）
web/src/pages/               Inventory / Production / Cutting / Shipping 四頁，App.tsx 用 #/inventory 這種 hash 切換
legacy/                      現有 8 個 HTML 頁（生產 MES 的現場操作仍在這裡）
```

## 三、資料模型（prisma/schema.prisma）

| 模組 | 表 | 說明 |
|---|---|---|
| 共用層 | Leader、AuditLog | Leader 新增 `roles`（逗號字串） |
| 入出庫 | **Label**、LabelSpec、Location、StockMove | 標籤 = 一個 QR；StockMove 用 `type`(in/out) + `stage`(material/semi/finished/outsourced) 對應關聯表四個欄 |
| 生產 MES | Order、EquipmentParam、StepEntry、PauseEvent、UploadBatch、UploadRow、IdleEvent | Order 新增 `labelId`、`poNo`、`dueDate`、`remark`（標籤有、工單原本沒有的欄位） |
| 裁切 MES | ProcessOrder、ProcessEntry | 加工單 G 號，`manuOrderNo` 綁定製造單 F 號，`labelId` 綁標籤 |
| 出貨 | Shipment、ShipmentItem | 明細 `source` = stock（庫存 QR）/ retail（零購 QR），`checkedAt` = 倉管檢核 |

新表全部是新增，`prisma db push` 只會建表加欄，不動現有資料；軟刪除清單已加入新表（plugins/prisma.js）。

## 四、QR 標籤規則（modules/inventory/domain/label.js）

QR 內容不是 ID，是範例一～三定義的六項文字、每項一行，多規格就多行：

```
光輝  (北)                      ← 1 客戶/廠商
PO-12345                        ← 2 訂單編號
F1150810001 , G1150810006       ← 3 製造單號 , 加工單號
D-C-F123 , No.3                 ← 4 倉庫儲位 , 機台編號
2026.08.12 , 需委外鍍鋅與整平    ← 5 製造/納期 , 備註
鋁 SKA20-8*4'*1200mm , 100 , 860 ← 6.. 規格 , 數量 , 重量
```

沒有的項目填 `-`（原料標籤）。`buildQrText` 由欄位組出這段，`parseQrText` 反向還原；掃描端先比整段文字，
比不到再用製造單號／加工單號找最新的一張（`findLabelByScan`）。標籤碼 `LB-日期-6碼` 印在角落當備援，不進 QR。
QR 圖沿用舊頁的做法，用 api.qrserver.com 由 qrText 產生（尺寸 160px 對應範例的「QR碼尺寸」）。

## 五、各系統的動作（對照「系統關聯表」）

| 系統 | 擔當 | 動作 | API |
|---|---|---|---|
| 原料管理 | 業務助理 | QR Code 標籤 | `POST /api/labels` |
| | 倉管 | 入庫 QR / 出庫 QR（四個階段） | `POST /api/inventory/moves` {type, stage} |
| | | 庫存、儲位 | `GET /api/inventory/stock`、`/locations` |
| 生產 MES | 業務助理 | 製造單上傳、QR 標籤 | 現有 `POST /api/orders/bulk-upload`；標籤同上 |
| | 生管 | 每周生產計畫上傳 | 現有 bulk-upload |
| | 生產人員 | 生產工單完成 → 再製 QR | 現有工序 API；再製 = 用完成數量再建一張 `semi/finished` 標籤 |
| 裁切 MES | 業務助理 | 製造加工單（綁定 F 號） | `POST /api/cutting/process-orders` |
| | 加工人員 | 裁切工單完成 → QR 結案 | `POST /api/cutting/process-orders/:no/complete`（加工單 done、標籤 closed、成品入庫） |
| 出貨管理 | 業務助理 | 出貨單上傳、庫存 QR、零購 QR | `POST /api/shipping/shipments`、`/:no/items` |
| | 倉管 | 出庫 QR、QR 檢核 | `POST /api/shipping/shipments/:no/check`、`/:no/ship` |

角色代碼（lib/roles.js）：sales 業務助理、warehouse 倉管、planner 生管、production 生產、processing 加工。
管理員在 `PATCH /api/admin/leaders/:id/roles` 指定；**過渡期規則**：管理員一律通過、還沒指定角色的帳號也通過，
指定之後才開始限制（現況所有登入者都能做所有事，不會一上線就被擋）。

## 六、現況與下一步

已完成（這一輪）：
- 後端切成五個模組並登錄；現有 API 路徑與測試不變（routes 33、插單 14、軟刪除 17 全過）。
- 新 schema、標籤規則與單元測試、入出庫／裁切／出貨的 API。
- React 端四個模組頁（`/app/#/inventory` 等）：建標籤看 QR、入出庫、庫存、加工單結案、出貨單檢核出庫。

還沒做（依序建議）：
1. 手機掃描：React 頁目前用貼上 QR 文字或標籤碼；下一步接 html5-qrcode（舊頁已在用）。
2. 標籤列印版面：範例「單一規格A4」一頁四張的版面。
3. 裁切 MES 的每周計畫 Excel 上傳（沿用生產 MES 的 bulk-upload 作法）。
4. 生產完成「再製 QR」自動化：完成步驟 11 時用 QC 數量直接建成品標籤。
5. 管理頁的角色指定 UI（API 已有）。
6. `tests/cross-day-pause.sim.mjs` 在改動前就已壞（第 308 行 endAt undefined），與模組化無關，另外處理。

不做的事：不拆成多個服務或多個資料庫。四個系統靠同一張標籤串接，拆開只會多出同步問題。
