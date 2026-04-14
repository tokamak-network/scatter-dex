/**
 * Re-export of the zk-engine circuit parameters so non-engine callers
 * (services, hooks) can import from the stable `lib/zk` path without
 * reaching into `zk-engine`. Single source of truth lives in
 * `zk-engine/constants.ts` — update there.
 */
export { COMMIT_TREE_DEPTH, MAX_CLAIMS_PER_SIDE, CLAIMS_TREE_DEPTH } from '../../zk-engine/constants';
