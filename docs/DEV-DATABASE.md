# 開發 / 測試資料庫

**兩個資料庫並存，不要混用。**

| | 開發庫 | 測試庫 |
|---|---|---|
| 容器 | `qrcode-pg` | `qrcode_factory_testdb` |
| 埠 | 5432 | **5433** |
| 資料庫名 | `qrcode_factory` | `qrcode_factory_test` |
| 資料位置 | bind mount `./pgdata`（repo 內，已 gitignore） | docker volume `qrcode-factory-test_testdb` |
| 設定檔 | `backend/.env` | `backend/.env.test` |
| 可以砍掉重來嗎 | **不行**，裡面是你手動輸入的開發資料 | 可以，`npm run db:test:reset` |

## 測試庫指令（都在 `backend/` 下跑）

```bash
npm run db:test:up      # 起動容器
npm run db:test:push    # 依 prisma/schema.prisma 建表
npm run seed:test       # 灌種子資料
npm run db:test:reset   # 砍掉重來：down -v → up → push → seed
npm run dev:test        # 用測試庫跑後端（埠 8081）
npm run db:test:down    # 關掉容器（資料保留）
```

## 種子資料內容

帳號六個，密碼都是 `test1234`：`admin`、`sales1`（業務助理）、`planner1`（生管）、
`prod1`（生產）、`proc1`（加工）、`wh1`（倉管）。

儲位五個（A-01/A-02 原料、B-01 半成品、C-01 成品、D-01 待出貨）。

加工單三張，**由 `tests/fixtures/` 的真實 QRP 樣本解析建立**，不是假資料：

| 加工單 | 工令 | 客戶 | 說明 |
|---|---|---|---|
| G1150911001 | E1150911001 | 上碩 | 4' 分條成 635 |
| G1150911002 | E1150911001 | 上碩 | 635 再分條成 142（同工令的第二道） |
| G1150929002 | E1150929002 | 凱詮 | 鋁捲裁成鋁板 |

每張加工單的領用材料各建一張原料標籤並做一筆入庫異動。製造單樣本只建標籤，
不建工單——等生產模組的匯入做好再處理。

## 為什麼測試庫要用獨立的 compose 專案名稱

`docker-compose.test.yml` 第一行是 `name: qrcode-factory-test`。

compose 用「專案名稱 + 服務名稱」認容器，預設專案名稱是資料夾名（`qrcode-factory`）。
開發庫的容器如果也掛在同一個專案名下，在這個資料夾跑 `docker compose up` 會把它
**當成同一個服務重建掉**（改名、改埠）。指定不同的 name 就不會互相影響。

（這件事實際發生過一次：開發庫容器被重建成測試庫，靠 `./pgdata` 是 bind mount
才沒掉資料。若當初用的是 docker volume，資料就得從 volume 撈回來。）

## 開發庫萬一被動到怎麼救

資料在 `./pgdata`，容器只是殼，重建一個接回去就好：

```bash
docker run -d --name qrcode-pg \
  -e POSTGRES_USER=qrcode -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=qrcode_factory \
  -v "$PWD/pgdata:/var/lib/postgresql/data" -p 5432:5432 --restart unless-stopped \
  postgres:16-alpine
```
