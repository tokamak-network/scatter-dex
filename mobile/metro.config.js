const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Asset extensions for ZK engine and circuit files
config.resolver.assetExts.push('html', 'wasm', 'zkey');

module.exports = config;
