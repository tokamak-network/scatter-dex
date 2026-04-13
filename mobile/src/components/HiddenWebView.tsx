/**
 * HiddenWebView — 화면에 보이지 않는 ZK 엔진 WebView
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { ZKBridgeService } from '../services/ZKBridgeService';

export default function HiddenWebView() {
  const webViewRef = useRef<WebView>(null);
  const [htmlUri, setHtmlUri] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const asset = Asset.fromModule(require('../../assets/zk-webview.html'));
        await asset.downloadAsync();
        console.log('HiddenWebView: localUri =', asset.localUri);
        if (asset.localUri) {
          setHtmlUri(asset.localUri);
        }
      } catch (err) {
        console.error('HiddenWebView: failed to load asset', err);
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
      onLoad={() => console.log('HiddenWebView: onLoad fired')}
      onLoadEnd={() => {
        console.log('HiddenWebView: onLoadEnd fired');
        // Probe WebView JS state after load
        webViewRef.current?.injectJavaScript(`
          try {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              requestId: '__debug__',
              status: 'success',
              result: {
                hasEngine: typeof window._zkEngine !== 'undefined',
                hasReady: typeof window._zkEngineReady !== 'undefined',
                hasRNWebView: typeof window.ReactNativeWebView !== 'undefined',
                keys: Object.keys(window._zkEngine || {}),
              }
            }));
          } catch(e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              requestId: '__debug__',
              status: 'error',
              error: e.message
            }));
          }
          true;
        `);
      }}
      onError={(e) => console.error('HiddenWebView: onError', e.nativeEvent.description)}
      onContentProcessDidTerminate={() => {
        console.error('HiddenWebView: content process terminated — reloading');
        webViewRef.current?.reload();
      }}
      injectedJavaScript={`
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            requestId: '__debug__',
            status: 'success',
            result: {
              hasEngine: typeof window._zkEngine !== 'undefined',
              hasReady: typeof window._zkEngineReady !== 'undefined',
              engineError: window._zkEngineError || null,
              snarkjsType: typeof snarkjs,
            }
          }));
        } catch(e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            requestId: '__debug__',
            status: 'error',
            error: e.message
          }));
        }
        true;
      `}
      javaScriptEnabled
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
      originWhitelist={['*']}
      style={{ height: 0, width: 0, opacity: 0, position: 'absolute' }}
    />
  );
}
