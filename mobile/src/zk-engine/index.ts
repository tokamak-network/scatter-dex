/**
 * ZK Engine — WebView 내에서 실행되는 circomlibjs + snarkjs 번들 엔트리
 *
 * esbuild로 브라우저용 번들링 후 zk-webview.html에 인라인됨.
 * Hermes에서는 실행 불가 (Node.js API 의존성).
 */

// ─── Node.js 글로벌 폴리필 ────────────────────────────
import { Buffer } from 'buffer';
import process from 'process/browser';

if (typeof globalThis.Buffer === 'undefined') (globalThis as any).Buffer = Buffer;
if (typeof globalThis.process === 'undefined') (globalThis as any).process = process;

// Worker stub — ffjavascript가 초기화 시 Worker를 생성하려 하지만
// WebView 로컬 HTML에서는 Worker 생성이 제한됨 (single-threaded fallback)
if (typeof globalThis.Worker === 'undefined') {
  (globalThis as any).Worker = function () {
    this.postMessage = function () {};
    this.terminate = function () {};
    this.onmessage = null;
  };
}

// ─── circomlibjs 초기화 ───────────────────────────────
try {
  const { buildPoseidon, buildEddsa, buildBabyjub } = require('circomlibjs');

  (window as any)._zkEngine = {
    buildPoseidon,
    buildEddsa,
    buildBabyjub,
  };
  (window as any)._zkEngineReady = true;
} catch (e: any) {
  (window as any)._zkEngineError = e?.message || String(e);
  console.error('ZK Engine init error:', e);
}
