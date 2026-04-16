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

  // The packaged ZK engine HTML lives at a `file://` URI inside the app
  // bundle. The navigation guard below is pinned to that exact URI so a
  // compromised script can never navigate to a remote origin or another
  // local file. The WebView's coarser `originWhitelist` (`file://*`)
  // exists only because Android RN-WebView normalizes file-URI origins
  // inconsistently — the exact-URI guard is the real lockdown.
  const allowedUri = htmlUri;

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: htmlUri }}
      onMessage={(event) => {
        ZKBridgeService.onMessage(event.nativeEvent.data);
      }}
      onShouldStartLoadWithRequest={(req) => {
        // iOS fires this for the initial load too, so the equality check
        // against `allowedUri` is what permits the bundled HTML to load at
        // all. Android only fires for *subsequent* navigations, which is
        // why the explicit `originWhitelist` below is the real lockdown
        // there. Anything else (data:, http(s), other file://) is denied.
        if (req.url === allowedUri) return true;
        console.warn('HiddenWebView: blocked navigation to', req.url);
        return false;
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
      // `allowFileAccess` is needed to load the bundled `file://` URI at all.
      // Proving assets (wasm/zkey) are passed as base64 via the bridge,
      // so the page does not need to `fetch()` sibling file:// resources
      // — `allowFileAccessFromFileURLs` is intentionally omitted to reduce
      // blast radius if the bundled page were ever compromised.
      // `allowUniversalAccessFromFileURLs` is likewise NOT set: it would
      // let this file:// page read other file:// URIs in the sandbox
      // (logs, SecureStore-adjacent files, etc.). The bundle is
      // self-contained (snarkjs + circomlibjs are inlined per
      // build-zk-webview.mjs) so cross-origin file access isn't required.
      allowFileAccess
      // The exact bundled URI plus a coarse `file://*` fallback for
      // Android — RN-WebView's origin matching can normalize file URIs
      // inconsistently across platforms; the navigation guard above is
      // the precise check.
      originWhitelist={[allowedUri, 'file://*']}
      style={{ height: 0, width: 0, opacity: 0, position: 'absolute' }}
    />
  );
}
