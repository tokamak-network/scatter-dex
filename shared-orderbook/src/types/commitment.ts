/**
 * Commitment-tree leaf as stored/served by the orderbook. One
 * `CommitmentInserted` event, normalised: `commitment` is the 0x-hex of the
 * uint256, `leafIndex` is its position in the incremental Merkle tree.
 */
export interface CommitmentLeaf {
  leafIndex: number;
  commitment: string;
  blockNumber: number;
}
