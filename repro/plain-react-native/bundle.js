// Bundles index.js for Android through Metro's runBuild, with the config in metro.config.js.
const Metro = require('metro')

async function main() {
  const config = await Metro.loadConfig({ resetCache: true })
  await Metro.runBuild(config, {
    entry: 'index.js',
    platform: 'android',
    dev: false,
    minify: false,
    out: 'out/index.android.js',
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
