/**
 * Comprehensive E2E Integration Test — ScatterDEX Relayer
 *
 * Requires: anvil + deployed contracts (DeployLocal.s.sol) + running relayer
 *
 * Run:
 *   1. anvil
 *   2. cd contracts && forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *   3. cd relayer && npm run dev
 *   4. npm run test:e2e
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import { EIP712_DOMAIN, EIP712_TYPES, parseOrder, pairKey } from "../src/types/order.js";
import Database from "better-sqlite3";
import path from "path";

// ─── Config ──────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "http://localhost:8545";
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3001";
const SETTLEMENT_ADDRESS = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const WETH = "0x0165878A594ca255338adfa4d48449f69242Eb8F";
const USDC = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853";
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "relayer.db");

// Anvil accounts (#2–#5 to avoid deployer #0 nonce conflicts)
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALICE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // #2
const BOB_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";   // #3
const CHARLIE_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // #4
const DAVE_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";    // #5

// ─── ABIs ────────────────────────────────────────────────────
const SETTLEMENT_ABI = [
  "function deposit(address token, uint256 amount) external",
  "function withdraw(address token, uint256 amount) external",
  "function deposits(address user, address token) external view returns (uint256)",
  "function nonces(address maker, uint256 nonce) external view returns (uint8)",
  "function schedules(bytes32 claimHash) external view returns (address token, uint48 releaseTime, bool claimed, address depositor, uint96 amount)",
  "function claimRelease(bytes32 secret) external",
  "function claimReleaseFor(bytes32 secret, address recipient, uint256 relayerTip, uint256 deadline, bytes calldata recipientSig) external",
  "function refundUnclaimed(bytes32 claimHash) external",
  "function gaslessNonces(address recipient) external view returns (uint256)",
  "event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes)",
  "event Claimed(bytes32 indexed claimHash, address indexed recipient, address indexed token, uint256 amount)",
  "event ClaimedFor(bytes32 indexed claimHash, address indexed recipient, address indexed token, address relayer, uint256 recipientAmount, uint256 relayerTip)",
  "event Refunded(bytes32 indexed claimHash, address indexed depositor, uint256 amount)",
];

const WETH_ABI = [
  "function deposit() external payable",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

const GASLESS_CLAIM_TYPES = {
  GaslessClaim: [
    { name: "secret", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "relayer", type: "address" },
    { name: "relayerTip", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────
function makeClaimHash(secret: string, recipient: string): string {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "address"], [secret, recipient]));
}

/** Get current chain timestamp (may differ from wall clock after evm_increaseTime) */
async function chainTime(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 }),
  });
  const { result } = await res.json();
  return parseInt(result.timestamp, 16);
}

function buildOrder(opts: {
  maker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  nonce: string;
  claims: { claimHash: string; amount: string; releaseDelay: string }[];
  maxFee?: string;
  expiry?: string;
}) {
  return {
    maker: opts.maker,
    sellToken: opts.sellToken,
    buyToken: opts.buyToken,
    sellAmount: opts.sellAmount,
    buyAmount: opts.buyAmount,
    maxFee: opts.maxFee ?? "100",
    expiry: opts.expiry ?? "9999999999", // Far future — safe even after evm_increaseTime
    nonce: opts.nonce,
    claims: opts.claims,
  };
}

async function signOrder(wallet: ethers.Wallet, order: ReturnType<typeof buildOrder>, chainId: bigint) {
  const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: SETTLEMENT_ADDRESS };
  const parsed = parseOrder(order);
  return wallet.signTypedData(domain, EIP712_TYPES, {
    ...parsed,
    claims: parsed.claims.map(c => ({ claimHash: c.claimHash, amount: c.amount, releaseDelay: c.releaseDelay })),
  });
}

async function submitOrder(order: Record<string, unknown>, signature: string, feeMode?: string) {
  const res = await fetch(`${RELAYER_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order, signature, ...(feeMode && { feeMode }) }),
  });
  return { status: res.status, body: await res.json() };
}

async function getOrders(address: string) {
  const res = await fetch(`${RELAYER_URL}/api/orders/${address}`);
  return res.json();
}

async function getOrderbook(tokenA: string, tokenB: string) {
  const pair = pairKey(tokenA, tokenB);
  const res = await fetch(`${RELAYER_URL}/api/orderbook/${pair}`);
  return res.json();
}

async function cancelOrder(address: string, nonce: number, signature: string) {
  const res = await fetch(`${RELAYER_URL}/api/orders/${address}/${nonce}`, {
    method: "DELETE",
    headers: { "x-cancel-signature": signature },
  });
  return { status: res.status, body: await res.json() };
}

async function getInfo() {
  return (await fetch(`${RELAYER_URL}/api/info`)).json();
}

async function advanceTime(provider: ethers.JsonRpcProvider, seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

/**
 * Get fresh nonce via direct RPC — bypasses ethers v6 caching.
 * Uses "latest" because Anvil's "pending" returns stale values in auto-mine mode.
 * Sequential await-based test flow ensures no concurrent TX conflicts.
 */
async function rpcNonce(address: string): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [address, "latest"], id: 1 }),
  });
  const { result } = await res.json();
  return parseInt(result, 16);
}

async function depositWETH(wallet: ethers.Wallet, amount: bigint) {
  const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
  const stl = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, wallet);
  let nonce = await rpcNonce(wallet.address);
  await (await weth.deposit({ value: amount, nonce: nonce++ })).wait();
  await (await weth.approve(SETTLEMENT_ADDRESS, amount, { nonce: nonce++ })).wait();
  await (await stl.deposit(WETH, amount, { nonce })).wait();
}

async function mintAndDepositUSDC(wallet: ethers.Wallet, amount: bigint, deployerWallet: ethers.Wallet) {
  const usdcDeployer = new ethers.Contract(USDC, ERC20_ABI, deployerWallet);
  const usdcWallet = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const stl = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, wallet);
  const dNonce = await rpcNonce(deployerWallet.address);
  await (await usdcDeployer.mint(wallet.address, amount, { nonce: dNonce })).wait();
  let nonce = await rpcNonce(wallet.address);
  await (await usdcWallet.approve(SETTLEMENT_ADDRESS, amount, { nonce: nonce++ })).wait();
  await (await stl.deposit(USDC, amount, { nonce })).wait();
}

// ─── Tests ───────────────────────────────────────────────────
describe("E2E Integration: ScatterDEX Relayer", () => {
  let provider: ethers.JsonRpcProvider;
  let deployer: ethers.Wallet;
  let alice: ethers.Wallet;
  let bob: ethers.Wallet;
  let charlie: ethers.Wallet;
  let dave: ethers.Wallet;
  const addr: Record<string, string> = {};
  let settlement: ethers.Contract;
  let chainId: bigint;

  // Shared state for Group 1 → Group 2 (claim tests need secrets from settle)
  let g1AliceSecret: string;
  let g1BobSecret: string;
  let g1AliceRecipient: string; // Charlie (#4)
  let g1BobRecipient: string;   // Dave (#5)

  beforeAll(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    deployer = new ethers.Wallet(DEPLOYER_KEY, provider);
    alice = new ethers.Wallet(ALICE_KEY, provider);
    bob = new ethers.Wallet(BOB_KEY, provider);
    charlie = new ethers.Wallet(CHARLIE_KEY, provider);
    dave = new ethers.Wallet(DAVE_KEY, provider);
    addr.deployer = deployer.address;
    addr.alice = alice.address;
    addr.bob = bob.address;
    addr.charlie = charlie.address;
    addr.dave = dave.address;
    settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, alice);
    chainId = (await provider.getNetwork()).chainId;

    g1AliceSecret = ethers.keccak256(ethers.toUtf8Bytes("alice-g1-secret"));
    g1BobSecret = ethers.keccak256(ethers.toUtf8Bytes("bob-g1-secret"));
    g1AliceRecipient = addr.charlie; // Alice's claim recipient
    g1BobRecipient = addr.dave;      // Bob's claim recipient
  });

  // ─── Group 1: Setup & Basic Flow ─────────────────────────
  describe("Group 1: Setup & Basic Flow", () => {

    it("GET /api/info returns relayer metadata", async () => {
      const info = await getInfo();
      expect(info.name).toBe("ScatterDEX Relayer");
      expect(info.fee).toBe(30);
      expect(info.settlement).toBe(SETTLEMENT_ADDRESS);
      expect(info.orderCount).toBe(0);
    });

    it("Alice deposits 10 WETH to escrow", async () => {
      const amount = ethers.parseEther("10");
      await depositWETH(alice,amount);
      const balance = await settlement.deposits(addr.alice, WETH);
      expect(balance).toBe(amount);
    });

    it("Bob deposits 21,000 USDC to escrow", async () => {
      const amount = ethers.parseUnits("21000", 18);
      await mintAndDepositUSDC(bob, amount, deployer);
      const balance = await settlement.deposits(addr.bob, USDC);
      expect(balance).toBe(amount);
    });

    it("Alice submits sell-WETH order — stays pending", async () => {
      // Alice's claim: receives USDC from Bob's side. distributable = 21000 - fee(21000 * 30/10000) = 21000 - 63 = 20937
      const claimHash = makeClaimHash(g1AliceSecret, g1AliceRecipient);
      const order = buildOrder({
        maker: addr.alice,
        sellToken: WETH,
        buyToken: USDC,
        sellAmount: ethers.parseEther("10").toString(),
        buyAmount: ethers.parseUnits("21000", 18).toString(),
        nonce: "2001",
        claims: [{ claimHash, amount: ethers.parseUnits("20937", 18).toString(), releaseDelay: "3600" }],
      });
      const sig = await signOrder(alice, order, chainId);
      const { body } = await submitOrder(order, sig);
      expect(body.status).toBe("pending");
    });

    it("Bob submits counter order — triggers match and settlement", async () => {
      // Bob's claim: receives WETH from Alice's side. distributable = 10 - fee(10 * 30/10000) = 10 - 0.03 = 9.97
      const claimHash = makeClaimHash(g1BobSecret, g1BobRecipient);
      const order = buildOrder({
        maker: addr.bob,
        sellToken: USDC,
        buyToken: WETH,
        sellAmount: ethers.parseUnits("21000", 18).toString(),
        buyAmount: ethers.parseEther("10").toString(),
        nonce: "2001",
        claims: [{ claimHash, amount: ethers.parseEther("9.97").toString(), releaseDelay: "3600" }],
      });
      const sig = await signOrder(bob, order, chainId);
      const { body } = await submitOrder(order, sig);
      expect(body.status).toBe("matched");
      expect(body.txHash).toBeDefined();
    });

    it("Escrow balances are depleted after settlement", async () => {
      expect(await settlement.deposits(addr.alice, WETH)).toBe(BigInt(0));
      expect(await settlement.deposits(addr.bob, USDC)).toBe(BigInt(0));
    });

    it("Nonces are consumed on-chain (Settled = 1)", async () => {
      expect(await settlement.nonces(addr.alice, 2001)).toBe(1n);
      expect(await settlement.nonces(addr.bob, 2001)).toBe(1n);
    });
  });

  // ─── Group 2: Claim Flow ──────────────────────────────────
  describe("Group 2: Claim Flow", () => {

    it("Claim before release delay reverts", async () => {
      const settlementCharlie = settlement.connect(charlie);
      await expect(settlementCharlie.claimRelease(g1AliceSecret)).rejects.toThrow();
    });

    it("Claim with wrong secret reverts", async () => {
      // Advance well past release delay (3600s). Extra margin for block-level timestamp gaps.
      await advanceTime(provider, 7200);
      await advanceTime(provider, 3600);
      const wrongSecret = ethers.keccak256(ethers.toUtf8Bytes("wrong-secret"));
      const settlementCharlie = settlement.connect(charlie);
      await expect(settlementCharlie.claimRelease(wrongSecret)).rejects.toThrow();
    });

    it("Claim with correct secret succeeds after release delay", async () => {
      // Verify chain time is past release (advanceTime already called in "wrong secret" test)

      const settlementCharlie = settlement.connect(charlie);
      const usdcBefore = await new ethers.Contract(USDC, ERC20_ABI, provider).balanceOf(addr.charlie);
      const nonce = await rpcNonce(addr.charlie);
      const tx = await settlementCharlie.claimRelease(g1AliceSecret, { nonce, gasLimit: 200000 });
      await tx.wait();
      const usdcAfter = await new ethers.Contract(USDC, ERC20_ABI, provider).balanceOf(addr.charlie);
      expect(usdcAfter - usdcBefore).toBe(ethers.parseUnits("20937", 18));
    });

    it("Double-claim reverts", async () => {
      const settlementCharlie = settlement.connect(charlie);
      await expect(settlementCharlie.claimRelease(g1AliceSecret)).rejects.toThrow();
    });

    it("Bob's recipient (Dave) claims WETH", async () => {
      const settlementDave = settlement.connect(dave);
      const wethBefore = await new ethers.Contract(WETH, WETH_ABI, provider).balanceOf(addr.dave);
      const nonce = await rpcNonce(addr.dave);
      const tx = await settlementDave.claimRelease(g1BobSecret, { nonce, gasLimit: 200000 });
      await tx.wait();
      const wethAfter = await new ethers.Contract(WETH, WETH_ABI, provider).balanceOf(addr.dave);
      expect(wethAfter - wethBefore).toBe(ethers.parseEther("9.97"));
    });

    it("Gasless claim via claimReleaseFor", async () => {
      // New trade: Alice sells 1 WETH, Bob sells 2100 USDC
      await depositWETH(alice,ethers.parseEther("1"));
      await mintAndDepositUSDC(bob, ethers.parseUnits("2100", 18), deployer);

      const secret = ethers.keccak256(ethers.toUtf8Bytes("gasless-secret"));
      const recipient = addr.charlie;
      const aliceClaimHash = makeClaimHash(secret, recipient);
      // distributable = 2100 - fee(2100*30/10000) = 2100 - 6.3 = 2093.7
      const aliceOrder = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "2010",
        claims: [{ claimHash: aliceClaimHash, amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const aliceSig = await signOrder(alice, aliceOrder, chainId);
      await submitOrder(aliceOrder, aliceSig);

      const bobSecret = ethers.keccak256(ethers.toUtf8Bytes("gasless-bob-secret"));
      const bobRecipient = addr.dave;
      const bobClaimHash = makeClaimHash(bobSecret, bobRecipient);
      // distributable = 1 - fee(1*30/10000) = 1 - 0.003 = 0.997
      const bobOrder = buildOrder({
        maker: addr.bob, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("2100", 18).toString(),
        buyAmount: ethers.parseEther("1").toString(),
        nonce: "2010",
        claims: [{ claimHash: bobClaimHash, amount: ethers.parseEther("0.997").toString(), releaseDelay: "3600" }],
      });
      const bobSig = await signOrder(bob, bobOrder, chainId);
      const { body } = await submitOrder(bobOrder, bobSig);
      expect(body.status).toBe("matched");

      await advanceTime(provider, 3601);

      // Sign gasless claim
      const tip = ethers.parseUnits("1", 18); // 1 USDC tip
      const deadline = await chainTime() + 7200;
      const gaslessNonce = await settlement.gaslessNonces(recipient);
      const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: SETTLEMENT_ADDRESS };
      // Use alice as the gasless claim relayer (anyone can call claimReleaseFor)
      const recipientSig = await charlie.signTypedData(domain, GASLESS_CLAIM_TYPES, {
        secret, recipient, relayer: addr.alice, relayerTip: tip, deadline, nonce: gaslessNonce,
      });

      const settlementAliceRelay = settlement.connect(alice);
      const nonce = await rpcNonce(addr.alice);
      const tx = await settlementAliceRelay.claimReleaseFor(secret, recipient, tip, deadline, recipientSig, { nonce });
      const receipt = await tx.wait();
      expect(receipt.status).toBe(1);
    });

    it("Refund unclaimed after REFUND_WINDOW (7 days)", async () => {
      // New trade for refund test
      await depositWETH(alice,ethers.parseEther("1"));
      await mintAndDepositUSDC(bob, ethers.parseUnits("2100", 18), deployer);

      const secret = ethers.keccak256(ethers.toUtf8Bytes("refund-secret"));
      const recipient = addr.charlie;
      const claimHash = makeClaimHash(secret, recipient);
      const aliceOrder = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "2011",
        claims: [{ claimHash, amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const aliceSig = await signOrder(alice, aliceOrder, chainId);
      await submitOrder(aliceOrder, aliceSig);

      const bobSecret = ethers.keccak256(ethers.toUtf8Bytes("refund-bob-secret"));
      const bobClaimHash = makeClaimHash(bobSecret, addr.dave);
      const bobOrder = buildOrder({
        maker: addr.bob, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("2100", 18).toString(),
        buyAmount: ethers.parseEther("1").toString(),
        nonce: "2011",
        claims: [{ claimHash: bobClaimHash, amount: ethers.parseEther("0.997").toString(), releaseDelay: "3600" }],
      });
      const bobSig = await signOrder(bob, bobOrder, chainId);
      await submitOrder(bobOrder, bobSig);

      // Advance past releaseDelay + REFUND_WINDOW (7 days = 604800s)
      await advanceTime(provider, 3600 + 604800 + 1);

      // Alice's claims: depositor = makerOrder.maker = Alice
      const settlementAlice = settlement.connect(alice);
      const tx = await settlementAlice.refundUnclaimed(claimHash);
      const receipt = await tx.wait();
      expect(receipt.status).toBe(1);
    });

    it("Refund before window expires reverts", async () => {
      // New trade
      await depositWETH(alice,ethers.parseEther("1"));
      await mintAndDepositUSDC(bob, ethers.parseUnits("2100", 18), deployer);

      const secret = ethers.keccak256(ethers.toUtf8Bytes("refund-early-secret"));
      const claimHash = makeClaimHash(secret, addr.charlie);
      const aliceOrder = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "2012",
        claims: [{ claimHash, amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const aliceSig = await signOrder(alice, aliceOrder, chainId);
      await submitOrder(aliceOrder, aliceSig);

      const bobSecret = ethers.keccak256(ethers.toUtf8Bytes("refund-early-bob-secret"));
      const bobClaimHash = makeClaimHash(bobSecret, addr.dave);
      const bobOrder = buildOrder({
        maker: addr.bob, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("2100", 18).toString(),
        buyAmount: ethers.parseEther("1").toString(),
        nonce: "2012",
        claims: [{ claimHash: bobClaimHash, amount: ethers.parseEther("0.997").toString(), releaseDelay: "3600" }],
      });
      const bobSig = await signOrder(bob, bobOrder, chainId);
      await submitOrder(bobOrder, bobSig);

      // Only advance 1 hour (past releaseDelay but NOT past refund window)
      // Note: time is already advanced from previous tests, but the new trade's releaseTime is fresh
      // The refund window is 7 days AFTER release time. We need to NOT exceed that.
      // Since we just settled, releaseTime = now + 3600. We DON'T advance time here (already past release from previous advances).
      // Actually: let's just try to refund immediately - the claim window hasn't expired for this specific claim.
      const settlementAlice2 = settlement.connect(alice);
      await expect(settlementAlice2.refundUnclaimed(claimHash)).rejects.toThrow();
    });
  });

  // ─── Group 3: Multiple Accounts & Orders ──────────────────
  describe("Group 3: Multiple Accounts & Orders", () => {

    it("Three-way trading: Alice<->Bob and Charlie<->Dave settle independently", async () => {
      // Fund
      await depositWETH(alice,ethers.parseEther("5"));
      await mintAndDepositUSDC(bob, ethers.parseUnits("10500", 18), deployer);
      await depositWETH(charlie, ethers.parseEther("3"));
      await mintAndDepositUSDC(dave, ethers.parseUnits("6300", 18), deployer);

      const s1 = ethers.keccak256(ethers.toUtf8Bytes("g3-alice-secret"));
      const s2 = ethers.keccak256(ethers.toUtf8Bytes("g3-bob-secret"));
      const s3 = ethers.keccak256(ethers.toUtf8Bytes("g3-charlie-secret"));
      const s4 = ethers.keccak256(ethers.toUtf8Bytes("g3-dave-secret"));

      // Alice sells 5 WETH for 10500 USDC
      const aliceOrder = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("5").toString(),
        buyAmount: ethers.parseUnits("10500", 18).toString(),
        nonce: "3001",
        claims: [{ claimHash: makeClaimHash(s1, addr.dave), amount: ethers.parseUnits("10468.5", 18).toString(), releaseDelay: "3600" }],
      });
      const aliceSig = await signOrder(alice, aliceOrder, chainId);
      const r1 = await submitOrder(aliceOrder, aliceSig);
      expect(r1.body.status).toBe("pending");

      // Charlie sells 3 WETH for 6300 USDC
      const charlieOrder = buildOrder({
        maker: addr.charlie, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("3").toString(),
        buyAmount: ethers.parseUnits("6300", 18).toString(),
        nonce: "3001",
        claims: [{ claimHash: makeClaimHash(s3, addr.alice), amount: ethers.parseUnits("6281.1", 18).toString(), releaseDelay: "3600" }],
      });
      const charlieSig = await signOrder(charlie, charlieOrder, chainId);
      const r2 = await submitOrder(charlieOrder, charlieSig);
      expect(r2.body.status).toBe("pending");

      // Bob buys 5 WETH for 10500 USDC → matches Alice
      const bobOrder = buildOrder({
        maker: addr.bob, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("10500", 18).toString(),
        buyAmount: ethers.parseEther("5").toString(),
        nonce: "3001",
        claims: [{ claimHash: makeClaimHash(s2, addr.charlie), amount: ethers.parseEther("4.985").toString(), releaseDelay: "3600" }],
      });
      const bobSig = await signOrder(bob, bobOrder, chainId);
      const r3 = await submitOrder(bobOrder, bobSig);
      expect(r3.body.status).toBe("matched");

      // Dave buys 3 WETH for 6300 USDC → matches Charlie
      const daveOrder = buildOrder({
        maker: addr.dave, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("6300", 18).toString(),
        buyAmount: ethers.parseEther("3").toString(),
        nonce: "3001",
        claims: [{ claimHash: makeClaimHash(s4, addr.bob), amount: ethers.parseEther("2.991").toString(), releaseDelay: "3600" }],
      });
      const daveSig = await signOrder(dave, daveOrder, chainId);
      const r4 = await submitOrder(daveOrder, daveSig);
      expect(r4.body.status).toBe("matched");
    });

    it("Orderbook shows correctly sorted sell and buy sides", async () => {
      // Fund Alice with more WETH for multiple orders
      await depositWETH(alice,ethers.parseEther("10"));
      await depositWETH(charlie, ethers.parseEther("10"));

      const s1 = ethers.keccak256(ethers.toUtf8Bytes("g3-ob-1"));
      const s2 = ethers.keccak256(ethers.toUtf8Bytes("g3-ob-2"));

      // Alice: sell 2 WETH want 4200 USDC (price: 2100/WETH) — cheaper
      const order1 = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("2").toString(),
        buyAmount: ethers.parseUnits("4200", 18).toString(),
        nonce: "3002",
        claims: [{ claimHash: makeClaimHash(s1, addr.dave), amount: ethers.parseUnits("4187.4", 18).toString(), releaseDelay: "3600" }],
      });
      await submitOrder(order1, await signOrder(alice, order1, chainId));

      // Charlie: sell 2 WETH want 4400 USDC (price: 2200/WETH) — more expensive
      const order2 = buildOrder({
        maker: addr.charlie, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("2").toString(),
        buyAmount: ethers.parseUnits("4400", 18).toString(),
        nonce: "3002",
        claims: [{ claimHash: makeClaimHash(s2, addr.dave), amount: ethers.parseUnits("4386.8", 18).toString(), releaseDelay: "3600" }],
      });
      await submitOrder(order2, await signOrder(charlie, order2, chainId));

      const book = await getOrderbook(WETH, USDC);
      const sells = book.sells;
      expect(sells.length).toBeGreaterThanOrEqual(2);
      // Sell side sorted by sell/buy ratio ascending (cross-multiplication).
      // Charlie: 2 WETH for 4400 USDC (ratio 2/4400 ≈ 0.000454) — lower ratio = first
      // Alice:   2 WETH for 4200 USDC (ratio 2/4200 ≈ 0.000476) — higher ratio = second
      // Note: lower ratio means seller demands MORE per unit sold (higher USDC/WETH price).
      expect(sells[0].maker.toLowerCase()).toBe(addr.charlie.toLowerCase());
    });

    it("Self-trade prevented: same maker on both sides stays pending", async () => {
      await mintAndDepositUSDC(alice, ethers.parseUnits("5000", 18), deployer);

      const s1 = ethers.keccak256(ethers.toUtf8Bytes("g3-self-1"));
      const s2 = ethers.keccak256(ethers.toUtf8Bytes("g3-self-2"));

      const sellOrder = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "3003",
        claims: [{ claimHash: makeClaimHash(s1, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const r1 = await submitOrder(sellOrder, await signOrder(alice, sellOrder, chainId));
      expect(r1.body.status).toBe("pending");

      const buyOrder = buildOrder({
        maker: addr.alice, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("2100", 18).toString(),
        buyAmount: ethers.parseEther("1").toString(),
        nonce: "3004",
        claims: [{ claimHash: makeClaimHash(s2, addr.dave), amount: ethers.parseEther("0.997").toString(), releaseDelay: "3600" }],
      });
      const r2 = await submitOrder(buyOrder, await signOrder(alice, buyOrder, chainId));
      expect(r2.body.status).toBe("pending"); // No match: same maker
    });
  });

  // ─── Group 4: Edge Cases ──────────────────────────────────
  describe("Group 4: Edge Cases", () => {

    it("sellToken == buyToken rejected by relayer", async () => {
      const { status } = await submitOrder({
        maker: addr.alice, sellToken: WETH, buyToken: WETH,
        sellAmount: "1000", buyAmount: "1000", maxFee: "100",
        expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
        nonce: "4001",
        claims: [{ claimHash: ethers.hexlify(ethers.randomBytes(32)), amount: "1000", releaseDelay: "3600" }],
      }, "0x" + "00".repeat(65));
      expect(status).toBe(400);
    });

    it("Zero sellAmount rejected", async () => {
      const { status } = await submitOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: "0", buyAmount: "1000", maxFee: "100",
        expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
        nonce: "4002",
        claims: [{ claimHash: ethers.hexlify(ethers.randomBytes(32)), amount: "1000", releaseDelay: "3600" }],
      }, "0x" + "00".repeat(65));
      expect(status).toBe(400);
    });

    it("Empty claims array rejected", async () => {
      const { status } = await submitOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: "1000", buyAmount: "1000", maxFee: "100",
        expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
        nonce: "4003", claims: [],
      }, "0x" + "00".repeat(65));
      expect(status).toBe(400);
    });
  });

  // ─── Group 5: Order Cancellation ──────────────────────────
  describe("Group 5: Order Cancellation", () => {

    it("Cancel a pending order", async () => {
      await depositWETH(alice,ethers.parseEther("1"));
      const s = ethers.keccak256(ethers.toUtf8Bytes("g5-cancel"));
      const order = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "5001",
        claims: [{ claimHash: makeClaimHash(s, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      await submitOrder(order, await signOrder(alice, order, chainId));

      const cancelSig = await alice.signMessage(`cancel:${addr.alice.toLowerCase()}:5001`);
      const { body } = await cancelOrder(addr.alice, 5001, cancelSig);
      expect(body.status).toBe("cancelled");
    });

    it("Cancelled order no longer in orderbook", async () => {
      const book = await getOrderbook(WETH, USDC);
      const found = [...book.sells, ...book.buys].find(
        (o: any) => o.maker.toLowerCase() === addr.alice.toLowerCase() && o.nonce === "5001"
      );
      expect(found).toBeUndefined();
    });

    it("Cancelled order doesn't match with counter order", async () => {
      // Use a unique price point that won't match other pending orders
      await mintAndDepositUSDC(bob, ethers.parseUnits("9999", 18), deployer);
      const s = ethers.keccak256(ethers.toUtf8Bytes("g5-no-match"));
      const bobOrder = buildOrder({
        maker: addr.bob, sellToken: USDC, buyToken: WETH,
        sellAmount: ethers.parseUnits("9999", 18).toString(),
        buyAmount: ethers.parseEther("1").toString(),
        nonce: "5003",
        claims: [{ claimHash: makeClaimHash(s, addr.alice), amount: ethers.parseEther("0.997").toString(), releaseDelay: "3600" }],
      });
      const { body } = await submitOrder(bobOrder, await signOrder(bob, bobOrder, chainId));
      // Alice's 5001 was cancelled. Bob's unique price shouldn't match other pending sells.
      expect(body.status).toBe("pending");
    });

    it("Cancel with wrong signer → 403", async () => {
      const s = ethers.keccak256(ethers.toUtf8Bytes("g5-wrong-signer"));
      const order = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "5002",
        claims: [{ claimHash: makeClaimHash(s, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      await submitOrder(order, await signOrder(alice, order, chainId));

      const bobCancelSig = await bob.signMessage(`cancel:${addr.alice.toLowerCase()}:5002`);
      const { status } = await cancelOrder(addr.alice, 5002, bobCancelSig);
      expect(status).toBe(403);
    });

    it("Cancel non-existent order → 404", async () => {
      const sig = await alice.signMessage(`cancel:${addr.alice.toLowerCase()}:99999`);
      const { status } = await cancelOrder(addr.alice, 99999, sig);
      expect(status).toBe(404);
    });

    it("Cancel without signature header → 401", async () => {
      const res = await fetch(`${RELAYER_URL}/api/orders/${addr.alice}/5002`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });
  });

  // ─── Group 6: Error Cases ─────────────────────────────────
  describe("Group 6: Error Cases", () => {

    it("Invalid signature (wrong signer) → 400", async () => {
      const s = ethers.keccak256(ethers.toUtf8Bytes("g6-wrong-sig"));
      const order = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "6001",
        claims: [{ claimHash: makeClaimHash(s, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const wrongSig = await signOrder(bob, order, chainId); // Bob signs Alice's order
      const { status, body } = await submitOrder(order, wrongSig);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid signature");
    });

    it("Expired order → 400", async () => {
      const s = ethers.keccak256(ethers.toUtf8Bytes("g6-expired"));
      const order = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "6002",
        expiry: "1000000", // Way in the past
        claims: [{ claimHash: makeClaimHash(s, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const sig = await signOrder(alice, order, chainId);
      const { status, body } = await submitOrder(order, sig);
      expect(status).toBe(400);
      expect(body.error).toBe("order expired");
    });

    it("maxFee < relayer fee → 400", async () => {
      const s = ethers.keccak256(ethers.toUtf8Bytes("g6-low-fee"));
      const order = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "6003",
        maxFee: "10", // Relayer charges 30
        claims: [{ claimHash: makeClaimHash(s, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      const sig = await signOrder(alice, order, chainId);
      const { status, body } = await submitOrder(order, sig);
      expect(status).toBe(400);
      expect(body.error).toBe("relayer fee exceeds order maxFee");
    });

    it("Duplicate nonce → 400", async () => {
      const s1 = ethers.keccak256(ethers.toUtf8Bytes("g6-dup1"));
      const s2 = ethers.keccak256(ethers.toUtf8Bytes("g6-dup2"));
      const order1 = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("1").toString(),
        buyAmount: ethers.parseUnits("2100", 18).toString(),
        nonce: "6004",
        claims: [{ claimHash: makeClaimHash(s1, addr.dave), amount: ethers.parseUnits("2093.7", 18).toString(), releaseDelay: "3600" }],
      });
      await submitOrder(order1, await signOrder(alice, order1, chainId));

      const order2 = buildOrder({
        maker: addr.alice, sellToken: WETH, buyToken: USDC,
        sellAmount: ethers.parseEther("2").toString(),
        buyAmount: ethers.parseUnits("4200", 18).toString(),
        nonce: "6004", // Same nonce!
        claims: [{ claimHash: makeClaimHash(s2, addr.dave), amount: ethers.parseUnits("4187.4", 18).toString(), releaseDelay: "3600" }],
      });
      const { status, body } = await submitOrder(order2, await signOrder(alice, order2, chainId));
      expect(status).toBe(400);
      expect(body.error).toBe("duplicate nonce");
    });

    it("Missing signature → 400", async () => {
      const res = await fetch(`${RELAYER_URL}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: { maker: addr.alice } }),
      });
      expect(res.status).toBe(400);
    });

    it("Missing order → 400", async () => {
      const res = await fetch(`${RELAYER_URL}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: "0x1234" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Group 7: DB Persistence ──────────────────────────────
  describe("Group 7: DB Persistence", () => {

    it("Pending orders are saved to DB", async () => {
      const db = new Database(DB_PATH, { readonly: true });
      const rows = db.prepare("SELECT * FROM orders WHERE status = 'pending'").all() as any[];
      expect(rows.length).toBeGreaterThan(0);
      db.close();
    });

    it("Settled orders have status and txHash in DB", async () => {
      const db = new Database(DB_PATH, { readonly: true });
      const rows = db.prepare("SELECT * FROM orders WHERE status = 'settled'").all() as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.settle_tx).toBeTruthy();
      }
      db.close();
    });

    it("Cancelled orders have status in DB", async () => {
      const db = new Database(DB_PATH, { readonly: true });
      const rows = db.prepare("SELECT * FROM orders WHERE status = 'cancelled'").all() as any[];
      expect(rows.length).toBeGreaterThan(0);
      db.close();
    });
  });
});
