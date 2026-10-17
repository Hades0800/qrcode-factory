# 後端容器

`Dockerfile` 把後端包成容器映像，給 Cloud Run 等容器平台用。Zeabur 目前仍用 Node 原生建置，不讀這個檔案。

## 建置與本機執行

在 `backend/` 目錄：

```
docker build -f deploy/Dockerfile -t qrcode-backend .
docker run -p 8080:8080 \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="..." \
  qrcode-backend
```

Mac（Apple 晶片）建出來的是 arm64 映像；雲端主機多為 amd64，部署前改用雲端建置，或加 `--platform linux/amd64`。

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 連線字串 |
| `JWT_SECRET` | 是 | 登入 token 簽章金鑰，長隨機字串 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 首次 | 資料庫沒有任何管理員時用來建立第一位管理員 |
| `PORT` | 否 | 預設 8080 |

## 注意

- 容器啟動時不會同步資料庫結構，結構有修改要先手動執行 `npm run db:push`（見 `ZEABUR_SETUP.md` 第六節）。
- 容器以非 root 的 `node` 使用者執行；收到 SIGTERM 會先收完進行中的請求再結束。
