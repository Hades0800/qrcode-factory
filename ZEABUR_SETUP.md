# Zeabur 部署指南（v2 - Node 後端版）

## 系統架構

```
┌─────────────────────┐         ┌──────────────────────┐         ┌──────────────┐
│  GitHub Pages       │  HTTPS  │  Zeabur (Node 後端)   │  TCP    │  PostgreSQL  │
│  index.html (掃描)  │ ──────► │  Fastify + Prisma    │ ──────► │  (Zeabur)    │
│  admin.html (管理)  │         │  JWT Auth            │         │              │
└─────────────────────┘         └──────────────────────┘         └──────────────┘
```

- **前端**：仍放在 GitHub Pages（已部署完）
- **後端**：Node + Fastify，部署到 Zeabur
- **資料庫**：Zeabur PostgreSQL

---

## 一、註冊 Zeabur

1. 開 https://zeabur.com
2. 點右上「**Sign up**」→ 用 **GitHub 帳號**登入（直接授權，省事）
3. 完成註冊

> 💡 Zeabur 免費額度：每月 USD $5。這個系統大約用 $1~2/月，建議綁信用卡（不會自動扣超過你設的上限）。

## 二、建立專案

1. Dashboard 點 **「Create Project」**
2. 取名：例如 `qrcode-factory`
3. 選地區：**Tokyo** 或 **Hong Kong**（離台灣最近）

## 三、加 PostgreSQL 服務

1. 在專案內點 **「Add Service」** → **「Marketplace」**
2. 找 **PostgreSQL** → 點 **「Deploy」**
3. 等 30 秒部署完成
4. 點該 PostgreSQL 服務 → **「Connect」** 標籤
5. 看到 `DATABASE_URL` 那一行（會自動產生），**先別複製，等下會自動注入**

## 四、部署後端

1. 同一個專案內 **「Add Service」** → **「Git」**
2. 選你的 GitHub repo：**Hades0800/qrcode-factory**
3. Zeabur 會掃描 repo，找到 `backend/` 目錄
4. 重要：**Root Directory** 設為 **`backend`**
   - 如果沒自動設定，到該 service 的 **Settings** 找 **Root Directory** 改成 `backend`
5. 點 **「Deploy」**
6. 第一次會 build node_modules，約 1~2 分鐘

## 五、設定環境變數

在後端 service 點 **「Variables」** 標籤，加入這幾個：

| 變數名 | 值 |
|---|---|
| `DATABASE_URL` | 點右邊 + 鈕，選 PostgreSQL 服務的 `DATABASE_URL` 自動連結 |
| `JWT_SECRET` | 一段隨機字串，例如 `kf7Xz9vQ2pL8mNwR3tYbA5cE6dG1hJ4` |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | 你自己決定，例如 `Shangkai2026!` |
| `ADMIN_NAME` | `管理員` |

⚠️ `DATABASE_URL` 必須用「服務間引用」的方式設定（按 + 號選 PostgreSQL），不能手填，否則內網連不到。

## 六、初始化資料庫

第一次部署後資料表還沒建立。在後端 service 點 **「Settings」** → **Build Command** 改成：

```
npm install && npx prisma db push
```

或者更簡單：在 `backend/package.json` 已經有 `postinstall: prisma generate`，你可以在 Zeabur 的 **Pre-deploy Command** 加：

```
npx prisma db push
```

讓它每次部署前先把 schema 推到資料庫。

✅ 設定完點 **「Redeploy」** 重新部署一次。

## 七、產生公開網址

1. 後端 service → **「Networking」** 標籤
2. 點 **「Generate Domain」**
3. Zeabur 會給你一個網址，例如：
   ```
   https://qrcode-factory-backend.zeabur.app
   ```
4. **複製這個網址**

## 八、確認後端正常

電腦瀏覽器開：
```
https://你的後端網址.zeabur.app/
```

應該看到：
```json
{"ok":true,"msg":"工單記錄系統 API 運作中"}
```

也可以試試 health check：
```
https://你的後端網址.zeabur.app/health
```

## 九、把後端網址告訴我

把網址貼給我，我幫你：
1. 更新 `index.html` 和 `admin.html` 的 `API_URL`
2. 推上 GitHub
3. 你就可以開始用了

---

## 第一次使用步驟

1. 開 https://hades0800.github.io/qrcode-factory/admin.html
2. 用步驟五設定的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登入
   - 系統會自動跳到 index.html → 跳出登入框
   - 輸入後會自動跳回 admin.html
3. 在管理頁建立小組長帳號
4. 把帳號密碼發給廠務
5. 廠務從 https://hades0800.github.io/qrcode-factory/index.html 登入使用

---

## 注意事項

- **舊的 Apps Script 可以保留**，反正不用了，刪不刪都可以
- **Google Sheets** 的舊資料可以下載備份成 .xlsx 留底，新系統不會用
- **Zeabur 免費額度**：每月 $5 美金。系統流量小應該用不到 $2，建議去 Settings 設個上限（例如 $5）避免意外
- **密碼別忘了**：管理員密碼忘記要重設只能去 Zeabur 改 `ADMIN_PASSWORD` 環境變數，然後手動 SQL 改 `passwordHash`，蠻麻煩

---

## 常見問題

**Q：Zeabur 部署失敗，log 顯示 prisma error**
A：確認 PostgreSQL 服務已啟動，DATABASE_URL 是用「+」按鈕引用，不是手填。

**Q：登入返回 401**
A：確認後端有跑起來、CORS 沒擋到（程式碼預設允許所有 origin）。

**Q：手機無法連線到後端**
A：Zeabur 給的網址必須是 https。如果 GitHub Pages (https) 連 zeabur (https) 應該沒問題。

**Q：要新增功能（報表、LINE 通知）**
A：直接跟我說，後端結構已經可以擴充了。
