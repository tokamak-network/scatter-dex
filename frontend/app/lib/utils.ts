import { ethers } from "ethers";

export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatBond(bond: bigint, decimals = 2): string {
  const val = Number(ethers.formatEther(bond));
  return val % 1 === 0 ? `${val} ETH` : `${val.toFixed(decimals)} ETH`;
}
