/** Re-export of the SDK's centralised explorer-URL builders. The
 *  helpers now live in `@zkscatter/sdk/util` so every app (Pay,
 *  Pro, Operators, Frontend, Hub) shares the same `new URL` +
 *  http/https allowlist + `encodeURIComponent` logic instead of
 *  each maintaining a copy.
 *
 *  This thin façade keeps Pay's existing imports stable; a bulk
 *  find/replace would explode the diff for zero behavioural gain.
 *  See [[feedback-explorer-url-safety]] for the why.
 */
export {
  buildExplorerTxUrl,
  buildExplorerAddressUrl,
} from "@zkscatter/sdk/util";
