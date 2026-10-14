# 測試

分三層，各測各的，不重複。

| 層 | 位置 | 測什麼 | 怎麼跑 |
|----|------|--------|--------|
| 單元 | `backend/tests/*.test.mjs` | 純函式：QRP 解析、Excel 匯入、標籤規則 | `node tests/qrp.test.mjs` |
| 端對端（API） | `backend/tests/cutting-plan.test.mjs` | 規則與權限：鎖定後不給調順序、解鎖限生管、完成跳下一張 | 需測試庫與後端（見下） |
| 元件 | `web/src/**/*.test.tsx` | 畫面在不同狀態給不給按 | `cd web && npm test` |

## 為什麼要分這三層

後端測得到「規則對不對」，測不到「按鈕有沒有出現」。現場按錯的代價是裁錯料，
所以「鎖定後不該出現 ↑↓」「等待材料的單不該出現開始生產」這類**條件渲染**要有測試守著。
反過來，元件測試不該重測權限規則——那是後端的事，在前端 mock 出來測只是測假的。

## 跑法

```bash
# 單元測試（不需資料庫）
cd backend
node tests/qrp.test.mjs
node tests/schedule-import.test.mjs
node tests/labels.test.mjs
node tests/modules.test.mjs

# 端對端：要先起測試庫與後端
npm run db:test:reset     # 砍掉重建 + 灌種子
npm run dev:test          # 後端跑在 :8081（另開一個終端機）
node tests/cutting-plan.test.mjs

# 前端元件測試（不需資料庫、不需後端，api 被 mock 掉）
cd web && npm test
cd web && npm run test:watch    # 改程式自動重跑
```

## 前端測試怎麼寫

`web/src/pages/CuttingPlanPage.test.tsx` 可當範本。要點：

**mock 掉 api**，不要真的打後端：

```ts
const api = vi.hoisted(() => vi.fn())
vi.mock('../api/client', () => ({ api }))
```

**用使用者看得到的東西來找元素**，不要用 class 或 test-id：

```ts
screen.getByRole('button', { name: '開始生產' })   // 好：使用者就是這樣認的
screen.getByLabelText('當班人數 *')
```

這樣改樣式不會弄壞測試，但改掉按鈕文字會——那本來就該重新確認。

**一個陷阱**：`beforeEach` 的箭頭函式不能隱含回傳函式。

```ts
beforeEach(() => api.mockReset())     // ✗ 回傳 mock 本身，Vitest 當成 teardown 又呼叫一次
beforeEach(() => { api.mockReset() }) // ✓ 加大括號
```

這個錯會讓 mock 收到一次無參數的呼叫，錯誤訊息完全看不出原因（實際踩過）。

## 還沒做的

- **真機測試**：現場用平板、戴手套、有油污與反光。觸控目標已設 44px 以上，
  但實際好不好按只有在產線上才知道——這部分無法自動化
- 其他頁面（原料、生產、出貨）還沒有元件測試
