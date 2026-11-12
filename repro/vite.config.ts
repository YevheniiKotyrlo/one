import { defineConfig } from 'vite'
import { one } from 'one/vite'

export default defineConfig({
  plugins: [
    one({
      web: {
        defaultRenderMode: 'ssg',
      },
      native: {
        app: {
          name: 'Repro',
          ios: { bundleId: 'dev.onestack.repro' },
        },
      },
    }),
  ],
})
