import { defineConfig } from 'vite'
import { one } from 'one/vite'

export default defineConfig({
  build: {
    outDir: 'out',
  },
  plugins: [
    one({
      web: {
        defaultRenderMode: 'ssg',
      },
    }),
  ],
})
