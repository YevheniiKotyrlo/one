// React Native's default Metro config, watching the workspace's root, where Bun's isolated linker keeps every package.
const path = require('node:path')
const { getDefaultConfig } = require('@react-native/metro-config')

const config = getDefaultConfig(__dirname)
module.exports = { ...config, watchFolders: [path.resolve(__dirname, '..')] }
