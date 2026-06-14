import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 專案站台路徑：https://hades0800.github.io/qrcode-factory/
// 新的 React App 掛在 /app/ 子路徑，與現有 8 個 HTML 頁共存、互不影響。
export default defineConfig({
  plugins: [react()],
  base: '/qrcode-factory/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
