import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Which commit this build is, shown on staging and returned by /api/health (Netlify sets COMMIT_REF).
  define: { __COMMIT__: JSON.stringify((process.env.COMMIT_REF || 'local').slice(0, 7)) },
  build: {
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], icons: ['lucide-react'] } },
    },
  },
})
