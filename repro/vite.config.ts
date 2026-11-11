import { defineConfig } from 'vite'
import { one } from 'one/vite'

export default defineConfig({
  server: {
    port: Number(process.env.RCT_METRO_PORT) || 8081,
  },
  plugins: [
    one({
      web: {
        defaultRenderMode: 'ssg',
      },
      native: {
        app: {
          name: 'Repro',
          ios: { bundleId: 'dev.onestack.repro' },
          android: { applicationId: 'dev.onestack.repro' },
          notifications: {},
        },
      },
    }),
  ],
})
