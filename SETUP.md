# 廠務工單進度系統 - 部署使用說明

## 系統組成

| 檔案 | 用途 |
|---|---|
| `Code.gs` | Google Apps Script 後端，寫入 Google Sheets |
| `index.html` | 手機掃描網頁（廠務小組長使用） |
| `qrcodes.html` | 印 7 張工項 QR Code 用 |

---

## 一、建立 Google Sheets + Apps Script 後端

1. 開啟 https://sheets.google.com → 建立**新試算表**，命名例如「廠務工單進度」
2. 上方選單 **擴充功能 → Apps Script**
3. 把預設的 `function myFunction() {}` 全部刪掉
4. 打開本專案的 `Code.gs`，把全部內容複製貼上到 Apps Script 編輯器
5. 按 💾 儲存（專案名稱可命名「工單記錄 API」）
6. 右上角點 **部署 → 新增部署作業**
   - 齒輪 → 選 **網頁應用程式**
   - 說明：v1
   - 執行身分：**我自己**
   - 誰可以存取：**任何人**（廠務手機才連得上）
   - 點 **部署**
7. 第一次會要求授權 → 選你的 Google 帳號 → 點「進階」→「前往（不安全）」→ 允許
8. 部署完成後會出現一段網址，類似：
   ```
   https://script.google.com/macros/s/AKfycbx........../exec
   ```
   **複製這段網址**（這就是 API_URL）

> 💡 之後如果改動 Code.gs，要再次「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選新版本 → 部署」，URL 不變。

---

## 二、設定前端網頁

打開 `index.html`，找到這一行（約第 220 行）：

```js
const API_URL = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```

把單引號之間的內容換成你剛剛複製的網址，例如：

```js
const API_URL = 'https://script.google.com/macros/s/AKfycbx........../exec';
```

存檔。

---

## 三、把網頁讓手機可以開啟

選一種：

### 方案 A：GitHub Pages（推薦，免費）
1. 在 GitHub 建一個 repo，把 `index.html` 和 `qrcodes.html` 上傳
2. Settings → Pages → Deploy from branch → main → /(root) → Save
3. 等 1 分鐘，會給你一個 `https://你的帳號.github.io/repo名/` 的網址
4. 用手機開：`https://你的帳號.github.io/repo名/index.html`

### 方案 B：Netlify Drop（最快，拖曳即用）
1. 開 https://app.netlify.com/drop
2. 把整個 `qrcode_project` 資料夾拖進去
3. 馬上得到一個 `https://xxx.netlify.app` 網址

### 方案 C：Cloudflare Pages（也免費）
類似 GitHub Pages。

> ⚠️ **必須是 HTTPS** 網址，手機瀏覽器才會開放相機。直接打開檔案 (`file://`) 在手機上掃不到。

---

## 四、列印 QR Code 貼紙

1. 電腦瀏覽器打開 `qrcodes.html`（線上網址或本機雙擊都可）
2. Ctrl/⌘ + P 列印 → A4
3. 7 張剪下、護貝、貼在對應的機台或工作站旁

---

## 五、廠務使用流程

1. 手機開網頁（建議加到主畫面當 App 用：Safari「加入主畫面」/ Chrome「加到主畫面」）
2. **第一次**輸入小組長姓名 → 儲存（會自動記住）
3. 開始作業時，點「掃描工單條碼」→ 對準工單上的條碼
4. 完成某項工作 → 點該項目的「掃描完成此項」→ 對準現場那張 QR
5. **項目 4、7** 會跳出輸入框要求備註
6. **如果掃錯了** → 點該項目的「取消此項紀錄」即可重來
7. 同一個項目只能掃一次，重複掃會被擋下

---

## 六、查看記錄

回到 Google Sheets，會看到一個叫「工單進度」的工作表，每筆工單一列：

| 工單號 | 小組長 | 1.原料準備 | 2.模刀具 | 3.試模確認 | 4.斷續試稼 | 4-備註 | 5.穩定生產 | 6.後工程 | 7.異常註記 | 7-備註 | 最後更新 |

需要 Excel 檔：**檔案 → 下載 → Microsoft Excel (.xlsx)**

---

## 常見問題

**Q：手機點掃描沒反應？**
A：確認網址是 https 開頭，並允許瀏覽器使用相機。

**Q：寫不進 Sheets？**
A：檢查 `index.html` 的 API_URL 是否正確；Apps Script 部署時「誰可以存取」要設成「任何人」。

**Q：要新增小組長帳號管理嗎？**
A：目前是手機本機記住一個名字。要做帳號管理告訴我再加。

**Q：要看每天 / 每週統計？**
A：可以加報表頁，告訴我需要的維度。
