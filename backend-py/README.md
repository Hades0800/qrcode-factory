# Backend (Python)

FastAPI 版本，對應 `../backend/`（Node.js + Fastify）。兩邊共用同一份資料庫。

## 安裝

```bash
cd backend-py
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 第一次：產生 Prisma client + 同步 DB
prisma generate
prisma db push
```

## 設定環境變數

複製 `.env.example` 成 `.env`，填入：

- `DATABASE_URL`（必填，跟 backend/ 同一個 DB 即可）
- `JWT_SECRET`（必填，跟 backend/ 同一個 secret 才能共用既有 token）
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME`（第一次啟動建立管理員用，已有管理員時可省略）

## 啟動（開發）

```bash
python -m app.main
# 或
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

啟動後測試：
- `curl http://localhost:8080/health` → `{"ok":true}`
- `curl http://localhost:8080/` → `{"ok":true,"msg":"工單記錄系統 API 運作中"}`

## 部署到 Zeabur

Build command：
```
pip install -r requirements.txt && prisma generate
```

Start command：
```
prisma db push --accept-data-loss && uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

## 切換前端到此後端

修改前端 `config.js` 的 API base URL 指向 Python 服務的網址即可（兩邊路由完全相同）。
