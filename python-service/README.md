# Python Flask 服務

跟 `/backend`（Node + Fastify）並存的 Python 端服務。預留給：

- 報表 / CSV / Excel 匯出（pandas、openpyxl）
- PDF 產生（reportlab、weasyprint）
- 機器學習 / 預測分析
- 第三方系統整合（ERP、Webhook）

## 本地啟動

```bash
cd python-service
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py
# → http://localhost:5001/health
```

## 正式環境

```bash
gunicorn -w 4 -b 0.0.0.0:5001 app:app
```

## 端點

| Method | Path        | 說明                         |
|--------|-------------|------------------------------|
| GET    | /health     | 健康檢查                     |
| GET    | /api/hello  | 範例 — `?name=foo`          |

## 部署到 Zeabur（之後要時參考）

- Service type: Python
- Start command: `gunicorn -b 0.0.0.0:$PORT app:app`
- 環境變數：照 `.env.example` 設
