import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 新的 React App 掛在站台的 /app/ 子路徑，與現有 HTML 頁共存、互不影響。
// base 用相對路徑：站台在 hades0800.github.io/qrcode-factory/ 或公司網域根目錄都能載入資源。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
