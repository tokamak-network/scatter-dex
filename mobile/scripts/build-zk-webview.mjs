/**
 * ZK WebView HTML 빌드 스크립트
 *
 * circomlibjs + snarkjs를 브라우저용으로 번들링하고,
 * 메시지 핸들러와 함께 단일 HTML 파일로 생성.
 *
 * Usage: node scripts/build-zk-webview.mjs
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Step 1: esbuild로 zk-engine 번들링
console.log('[1/3] Building zk-engine bundle...');
execSync(`npx esbuild src/zk-engine/index.ts \
  --bundle \
  --platform=browser \
  --format=iife \
  --minify \
  --alias:stream=stream-browserify \
  --alias:crypto=crypto-browserify \
  --define:global=globalThis \
  --outfile=.build/zk-engine.min.js`, {
  cwd: root,
  stdio: 'inherit',
});

// Step 2: 파일 읽기
console.log('[2/3] Reading bundles...');
const zkEngine = readFileSync(resolve(root, '.build/zk-engine.min.js'), 'utf8');
const snarkjs = readFileSync(resolve(root, 'node_modules/snarkjs/build/snarkjs.min.js'), 'utf8');

// Step 3: HTML 생성
console.log('[3/3] Generating zk-webview.html...');

const messageHandler = `
window.addEventListener('message', async function(event) {
  var data;
  try { data = JSON.parse(event.data); } catch(e) { return; }
  var requestId = data.requestId;
  var cmd = data.cmd;

  function reply(result) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      requestId: requestId,
      status: 'success',
      result: result
    }));
  }

  function replyError(err) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      requestId: requestId,
      status: 'error',
      error: err.message || String(err)
    }));
  }

  try {
    switch (cmd) {
      case 'ping': {
        reply({ pong: true, engine: typeof window._zkEngine !== 'undefined' });
        break;
      }

      case 'poseidon_hash': {
        var poseidon = await window._zkEngine.buildPoseidon();
        var inputs = data.inputs.map(function(x) { return BigInt(x); });
        var hash = poseidon(inputs);
        reply({ hash: poseidon.F.toString(hash, 10) });
        break;
      }

      case 'build_poseidon': {
        // 초기화만 — 이후 캐싱됨
        await window._zkEngine.buildPoseidon();
        reply({ ok: true });
        break;
      }

      case 'compute_commitment': {
        var poseidon = await window._zkEngine.buildPoseidon();
        var F = poseidon.F;
        // CommitmentV2: Poseidon(TAG_COMMITMENT_V2, secret, token, balance, salt, pubKeyAx, pubKeyAy)
        var TAG = BigInt(data.tag);
        var inputs = [TAG, data.secret, data.token, data.balance, data.salt, data.pubKeyAx, data.pubKeyAy].map(function(x) { return BigInt(x); });
        var hash = poseidon(inputs);
        reply({ commitment: F.toString(hash, 10) });
        break;
      }

      case 'compute_nullifier': {
        var poseidon = await window._zkEngine.buildPoseidon();
        var F = poseidon.F;
        var inputs = [data.tag, data.secret, data.salt].map(function(x) { return BigInt(x); });
        var hash = poseidon(inputs);
        reply({ nullifier: F.toString(hash, 10) });
        break;
      }

      case 'derive_eddsa_key': {
        var eddsa = await window._zkEngine.buildEddsa();
        var babyJub = await window._zkEngine.buildBabyjub();
        // signatureHash (hex string) → 32 bytes → EdDSA privKey
        var hexStr = data.signatureHash.startsWith('0x') ? data.signatureHash.slice(2) : data.signatureHash;
        var privKey = new Uint8Array(32);
        for (var i = 0; i < 32; i++) {
          privKey[i] = parseInt(hexStr.substr(i * 2, 2), 16);
        }
        var pubKey = eddsa.prv2pub(privKey);
        reply({
          privateKeyHex: Array.from(privKey).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''),
          pubKeyAx: babyJub.F.toString(pubKey[0], 10),
          pubKeyAy: babyJub.F.toString(pubKey[1], 10),
        });
        break;
      }

      case 'sign_eddsa': {
        var eddsa = await window._zkEngine.buildEddsa();
        var babyJub = await window._zkEngine.buildBabyjub();
        var hexStr = data.privateKeyHex;
        var privKey = new Uint8Array(32);
        for (var i = 0; i < 32; i++) {
          privKey[i] = parseInt(hexStr.substr(i * 2, 2), 16);
        }
        var msg = babyJub.F.e(BigInt(data.message));
        var sig = eddsa.signPoseidon(privKey, msg);
        reply({
          S: sig.S.toString(),
          R8x: babyJub.F.toString(sig.R8[0], 10),
          R8y: babyJub.F.toString(sig.R8[1], 10),
        });
        break;
      }

      case 'hash_order': {
        var poseidon = await window._zkEngine.buildPoseidon();
        var F = poseidon.F;
        var inputs = data.inputs.map(function(x) { return BigInt(x); });
        var hash = poseidon(inputs);
        reply({ hash: F.toString(hash, 10) });
        break;
      }

      case 'generate_proof': {
        // 범용 proof 생성: wasm/zkey를 base64로 받아서 fullProve 실행
        var wasmBytes = Uint8Array.from(atob(data.wasmB64), function(c) { return c.charCodeAt(0); });
        var zkeyBytes = Uint8Array.from(atob(data.zkeyB64), function(c) { return c.charCodeAt(0); });
        // inputs의 bigint 값들을 string → BigInt 변환은 snarkjs가 처리
        var t0 = Date.now();
        var result = await snarkjs.groth16.fullProve(data.circuitInputs, wasmBytes, zkeyBytes);
        var elapsed = Date.now() - t0;

        reply({
          proof: result.proof,
          publicSignals: result.publicSignals,
          elapsedMs: elapsed,
        });
        break;
      }

      case 'verify_proof': {
        var valid = await snarkjs.groth16.verify(data.vkey, data.publicSignals, data.proof);
        reply({ valid: valid });
        break;
      }

      default:
        replyError(new Error('Unknown command: ' + cmd));
    }
  } catch (err) {
    replyError(err);
  }
});

// 초기화 완료 알림
var engineStatus = typeof window._zkEngine !== 'undefined'
  ? 'ready'
  : (window._zkEngineError || 'unknown error');

window.ReactNativeWebView.postMessage(JSON.stringify({
  requestId: '__init__',
  status: typeof window._zkEngine !== 'undefined' ? 'success' : 'error',
  result: { engine: engineStatus }
}));
`;

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body>
<script>${snarkjs}<\/script>
<script>${zkEngine}<\/script>
<script>${messageHandler}<\/script>
</body></html>`;

// 출력
if (!existsSync(resolve(root, 'assets'))) {
  execSync('mkdir -p assets', { cwd: root });
}
writeFileSync(resolve(root, 'assets/zk-webview.html'), html);
const sizeMB = (html.length / 1024 / 1024).toFixed(1);
console.log(`✅ Generated assets/zk-webview.html (${sizeMB} MB)`);
