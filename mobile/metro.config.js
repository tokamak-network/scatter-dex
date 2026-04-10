const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// .html 파일을 에셋으로 인식 (WebView ZK 엔진)
config.resolver.assetExts.push('html');

module.exports = config;
