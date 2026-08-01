# 前端 React 遷移（web/）

漸進式把前端改成 React + TypeScript。新功能先用 React 寫，與現有 8 個 HTML 頁
（`index.html`、`realtime.html`…）**共存**，之後再一頁一頁遷移。

- 技術棧：Vite 6 + React 18 + TypeScript
- 部署路徑：`https://hades0800.github.io/qrcode-factory/app/`
- 登入狀態與舊頁面共用同一份 `localStorage`（key：`token` / `me`），不需重複登入
- 後端 API 不變（Zeabur），由 `src/lib/config.ts` 的 `API_URL` 指定

## 本機開發

```bash
cd web
npm install
npm run dev        # 本機開發伺服器（會連線到正式站後端 API）
npm run build      # 型別檢查 + 打包到 web/dist
npm run typecheck  # 只做型別檢查
```

## 目錄

```
web/
  src/
    lib/
      config.ts   # API_URL、登入頁路徑
      api.ts      # 帶型別的 api() — 對應舊版 utils.js
      auth.ts     # 登入狀態（與舊頁共用 localStorage）
      types.ts    # 工單等 API 回傳型別
    components/
      Toast.tsx   # 提示訊息
    pages/
      NewFeaturePage.tsx  # 新功能頁（目前是占位 + 技術棧煙霧測試）
    App.tsx       # 登入守衛 + 路由（目前單頁）
    main.tsx      # 進入點
```

## 部署（GitHub Action）

`.github/workflows/deploy.yml` 會在 push 到 `main` 時：

1. 進 `web/` 跑 `npm ci && npm run build`
2. 把站台根目錄的現有 HTML 頁 + `web/dist`（掛到 `/app/`）組成同一份 Pages 產物
3. 用官方 Pages Action 發佈

### ⚠️ 首次上線需手動切換一次 Pages 來源

目前 GitHub Pages 是「Deploy from a branch」。這個 Action 改用「GitHub Actions」部署，
所以第一次要到 **GitHub repo → Settings → Pages → Build and deployment → Source**
改成 **GitHub Actions**。

切換後整個站台都由 Action 部署。Action 已把現有 8 頁一起包進產物，現有頁面照常運作；
建議切換後先逐頁點過確認無誤。
