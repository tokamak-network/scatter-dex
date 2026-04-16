/**
 * HiddenWebView — 화면에 보이지 않는 ZK 엔진 WebView
 */
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { ZKBridgeService } from '../services/ZKBridgeService';
import { hiddenOffscreen } from '../styles/theme';

// Debug probes (console logs + `__debug__` postMessage payloads) are
// noisy and can leak internal engine state into device logs in
// production. Gate them behind React Native's `__DEV__` flag so they
// only run in development builds. Errors (`onError`,
// `onContentProcessDidTerminate`, asset load failure) are still
// logged unconditionally since they're rare and actionable.
const DEBUG_PROBES = __DEV__;

const DEBUG_INJECTED_JS = DEBUG_PROBES
  ? `
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
      `
  : undefined;

export default function HiddenWebView() {
  const webViewRef = useRef<WebView>(null);
  const [htmlUri, setHtmlUri] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const asset = Asset.fromModule(require('../../assets/zk-webview.html'));
        await asset.downloadAsync();
        if (DEBUG_PROBES) console.log('HiddenWebView: localUri =', asset.localUri);
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

  // See `hiddenOffscreen` in theme.ts for why the wrapper is load-bearing.
  return (
    <View style={hiddenOffscreen}>
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
          if (DEBUG_PROBES) console.warn('HiddenWebView: blocked navigation to', req.url);
          return false;
        }}
        onLoad={DEBUG_PROBES ? () => console.log('HiddenWebView: onLoad fired') : undefined}
        onLoadEnd={DEBUG_PROBES ? () => {
          console.log('HiddenWebView: onLoadEnd fired');
          // Probe WebView JS state after load — dev builds only so the
          // `__debug__` payload never lands in production device logs.
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
        } : undefined}
        onError={(e) => console.error('HiddenWebView: onError', e.nativeEvent.description)}
        onContentProcessDidTerminate={() => {
          console.error('HiddenWebView: content process terminated — reloading');
          webViewRef.current?.reload();
        }}
        injectedJavaScript={DEBUG_INJECTED_JS}
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
      />
    </View>
  );
}
