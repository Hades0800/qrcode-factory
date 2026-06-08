# 上鎧鋼鐵 — React 前端

把原本的 HTML 前端用 Vite + React 重新搭起來。**原 HTML 完全不動**，這是另一條獨立的前端 stack。

## 啟動（需先裝 Node ≥ 18）

```bash
# 1. 確認後端在跑（本機 docker postgres + node backend）
docker compose up -d                                  # 在 repo 根目錄
cd backend && npm install && npm run dev              # http://localhost:8080

# 2. 跑前端
cd frontend
npm install
cp .env.example .env                                   # 預設指向 http://localhost:8080
npm run dev                                            # http://localhost:3000
```

打開 `http://localhost:3000`，用後端 seed 的 admin 帳號登入（`backend/.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`）。

> ⚠️ Logo：原專案根目錄的 `logo.jpg` 需要複製到 `frontend/public/`（首次設定時做一次）：
> ```bash
> mkdir -p public && cp ../logo.jpg public/
> ```

## 專案結構

```
src/
├── main.jsx                  進入點（掛 Auth / Toast / Router）
├── App.jsx                   路由表 + Layout / ProtectedRoute
├── api/client.js             統一的 API 呼叫（自動帶 token、處理錯誤）
├── context/AuthContext.jsx   登入 / 登出 / me（含 permissions）
├── components/
│   ├── Layout.jsx            共用 header + 漢堡選單（依權限顯示連結）
│   ├── ProtectedRoute.jsx    路由守門（未登入導 /login；缺權限顯示提示）
│   └── Toast.jsx             統一的訊息提示
├── lib/
│   ├── permissions.js        hasPermission / canUpload / canModifyRecords ...
│   ├── format.js             fmtTime / twDateKey / escapeHtml ...（Asia/Taipei 顯示）
│   ├── machineTargets.js     MACHINE_TARGETS / MACHINES / AUX_EQUIPMENT_LABELS
│   └── orderPhases.js        computeOrderPhasesForDay / actualQtyOf
├── pages/
│   ├── LoginPage.jsx         ✅ 完整
│   ├── AdminPage.jsx         ✅ 完整（帳號 CRUD + 角色權限矩陣）
│   ├── PlanStatsPage.jsx     ✅ 完整（計畫達成統計）
│   ├── GoalStatsPage.jsx     ✅ 完整（目標達成統計 + 表格 + 兩張 CSS 圖）
│   ├── IndexPage.jsx         🟡 核心可用（掃單、記步驟、暫停/恢復、完成）
│   ├── RealtimePage.jsx      🟡 機台概覽 + 工單清單
│   ├── RecordsPage.jsx       🟡 區間 + 工單篩選 + 展開
│   └── UploadPage.jsx        🟡 JSON 上傳測試（Excel 解析待接 SheetJS）
└── styles/global.css         brand 變數 + 基礎元件（沿用原 styles.css 色系）
```

## 完成度

| 狀態 | 含意 |
|---|---|
| ✅ 完整 | 所有功能對應原 HTML 完成 |
| 🟡 核心可用 | 主要操作能跑，**進階功能在檔內以 `TODO:` 標示**，可依需求逐步補上 |

### IndexPage 已涵蓋
- 掃描 / 輸入工單號（含格式驗證、自動建立）
- 工單摘要顯示
- 21/22/23 + 工序 01-08 + 40/41 + 30 更換規格 即時記錄
- 暫停（中午/下班/異常）+ 恢復
- 完成工單（含 QC 數量）
- 工序紀錄列表
- tech 角色提示

### IndexPage 還沒搬（TODO 註記在檔尾）
- 規格類型 / 難易係數 / 新製差異項
- 更換範圍 / 原料類型
- 輔助設備（含編號）
- 設備操作人員 / 全部作業人數
- 設備參數面板（多規格 SPM/刀數）
- 補登（pause-backfill / 步驟自訂時間）
- 中斷類型的細分 modal

## 跟原 HTML 的關係

- **完全獨立**：原 `index.html` / `admin.html` 等等繼續正常運作
- **共用後端**：兩邊都打 `localhost:8080` 同個 API
- **共用 DB**：登入後角色／權限 / 工單資料同步
- 想要切換，前端網址改一下而已（GitHub Pages → Vercel/Netlify/任何靜態空間 部署這個 React build）

## 建置 / 部署

```bash
npm run build         # 產出 dist/，可丟任何靜態空間
npm run preview       # 本機預覽 build 結果
```

正式上線時把 `.env` 的 `VITE_API_BASE` 改成 Zeabur 後端網址，後端 `ALLOWED_ORIGINS` 也要加上前端網址。

## 之後拓展建議

1. **接 SheetJS 進 UploadPage** — `npm i xlsx`，把 [upload.html](../upload.html) 的 Excel 解析邏輯搬過來
2. **IndexPage 進階面板** — 把 TODO 區的功能逐項補上（規格類型、輔助設備、設備參數面板）
3. **拆元件** — Layout 內的下拉選單、Toast、Modal 已抽出；可再拆「設備參數編輯器」「中斷選單」等共用元件
4. **TypeScript 化** — 想要型別保護的話可逐步把 .jsx 改 .tsx
