import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 3000 對應後端 ALLOWED_ORIGINS（'http://localhost:3000'）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
  },
});
