/**
 * HiddenWebView — 화면에 보이지 않는 ZK 엔진 WebView
 *
 * snarkjs + circomlibjs 번들을 로드하고,
 * ZKBridgeService의 postMessage 명령을 처리한다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { ZKBridgeService } from '../services/ZKBridgeService';

export default function HiddenWebView() {
  const webViewRef = useRef<WebView>(null);
  const [htmlUri, setHtmlUri] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const asset = Asset.fromModule(require('../../assets/zk-webview.html'));
      await asset.downloadAsync();
      if (asset.localUri) {
        setHtmlUri(asset.localUri);
      }
    })();
  }, []);

  useEffect(() => {
    ZKBridgeService.setWebViewRef(webViewRef);
  }, []);

  if (!htmlUri) return null;

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: htmlUri }}
      onMessage={(event) => {
        ZKBridgeService.onMessage(event.nativeEvent.data);
      }}
      javaScriptEnabled
      originWhitelist={['*']}
      style={{ height: 0, width: 0, opacity: 0, position: 'absolute' }}
    />
  );
}
