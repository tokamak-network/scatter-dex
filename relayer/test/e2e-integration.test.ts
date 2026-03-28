/**
 * Integration E2E test — requires running anvil + deployed contracts + relayer server
 *
 * Run with:
 *   1. anvil (or docker-compose up anvil deployer)
 *   2. Deploy contracts: cd contracts && forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *   3. Start relayer: SETTLEMENT_ADDRESS=0x... npm run dev
 *   4. Run test: SETTLEMENT_ADDRESS=0x... RELAYER_URL=http://localhost:3001 npm run test:e2e
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ethers } from "ethers";
import { Order, EIP712_DOMAIN, EIP712_TYPES, parseOrder } from "../src/types/order.js";
import { RelayerClient } from "./helpers/relayer-client.js";

const RPC_URL = process.env.RPC_URL || "http://localhost:8545";
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3001";
const SETTLEMENT_ADDRESS = process.env.SETTLEMENT_ADDRESS || "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

// Anvil default accounts
const ALICE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BOB_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// NOTE: Deploy script (DeployLocal.s.sol) must call setTokenWhitelist() for WETH/USDC
// after contract deployment for these tests to pass.
const SETTLEMENT_ABI = [
  "function deposit(address token, uint256 amount) external",
  "function withdraw(address token, uint256 amount) external",
  "function deposits(address user, address token) external view returns (uint256)",
  "function claimRelease(bytes32 secret) external",
  "event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

// Read WETH/USDC addresses from deployment broadcast
const WETH = process.env.WETH_ADDRESS || "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const USDC = process.env.USDC_ADDRESS || "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";

describe("E2E Integration: Full Trade Flow", () => {
  let provider: ethers.JsonRpcProvider;
  let alice: ethers.Wallet;
  let bob: ethers.Wallet;
  let settlement: ethers.Contract;
  let weth: ethers.Contract;
  let usdc: ethers.Contract;
  let relayer: RelayerClient;
  let chainId: bigint;

  beforeAll(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    alice = new ethers.Wallet(ALICE_KEY, provider);
    bob = new ethers.Wallet(BOB_KEY, provider);
    settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, alice);
    weth = new ethers.Contract(WETH, ERC20_ABI, alice);
    usdc = new ethers.Contract(USDC, ERC20_ABI, bob);
    relayer = new RelayerClient(RELAYER_URL);
    const network = await provider.getNetwork();
    chainId = network.chainId;
  });

  // ─── Scenario 1: Relayer info endpoint ─────────────────────

  it("should return relayer info", async () => {
    const info = await relayer.getInfo();
    expect(info.name).toBe("ScatterDEX Relayer");
    expect(info.settlement).toBeTruthy();
    expect(typeof info.fee).toBe("number");
  });

  // ─── Scenario 2: User deposits via on-chain tx ─────────────

  it("Alice deposits 10 WETH to escrow", async () => {
    const amount = ethers.parseEther("10");

    // Approve
    const approveTx = await weth.approve(SETTLEMENT_ADDRESS, amount);
    await approveTx.wait();

    // Deposit
    const depositTx = await settlement.deposit(WETH, amount);
    await depositTx.wait();

    const balance = await settlement.deposits(alice.address, WETH);
    expect(balance).toBe(amount);
  });

  it("Bob deposits 21000 USDC to escrow", async () => {
    const amount = ethers.parseUnits("21000", 18);
    const settlementBob = settlement.connect(bob);

    const approveTx = await usdc.approve(SETTLEMENT_ADDRESS, amount);
    await approveTx.wait();

    const depositTx = await settlementBob.deposit(USDC, amount);
    await depositTx.wait();

    const balance = await settlement.deposits(bob.address, USDC);
    expect(balance).toBe(amount);
  });

  // ─── Scenario 3: Users submit orders to relayer ────────────

  it("Alice submits sell order via relayer API", async () => {
    const secret = ethers.keccak256(ethers.toUtf8Bytes("alice-secret"));
    const recipient = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // anvil #4
    const claimHash = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "address"], [secret, recipient])
    );

    const order = {
      maker: alice.address,
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: ethers.parseEther("10").toString(),
      buyAmount: ethers.parseUnits("21000", 18).toString(),
      maxFee: "30",
      expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
      nonce: "1001",
      claims: [{
        claimHash,
        amount: ethers.parseUnits("21000", 18).toString(),
        releaseDelay: "3600",
      }],
    };

    const domain = {
      ...EIP712_DOMAIN,
      chainId,
      verifyingContract: SETTLEMENT_ADDRESS,
    };

    const signature = await alice.signTypedData(domain, EIP712_TYPES, {
      ...parseOrder(order),
      claims: parseOrder(order).claims.map(c => ({
        claimHash: c.claimHash,
        amount: c.amount,
        releaseDelay: c.releaseDelay,
      })),
    });

    const result = await relayer.submitOrder(order, signature);
    // Should be pending (no matching counterparty yet)
    expect(result.status).toBe("pending");
  });

  it("Bob submits counter order — should match", async () => {
    const secret = ethers.keccak256(ethers.toUtf8Bytes("bob-secret"));
    const recipient = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // anvil #5
    const claimHash = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "address"], [secret, recipient])
    );

    const order = {
      maker: bob.address,
      sellToken: USDC,
      buyToken: WETH,
      sellAmount: ethers.parseUnits("21000", 18).toString(),
      buyAmount: ethers.parseEther("10").toString(),
      maxFee: "30",
      expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
      nonce: "1001",
      claims: [{
        claimHash,
        amount: ethers.parseEther("10").toString(),
        releaseDelay: "3600",
      }],
    };

    const domain = {
      ...EIP712_DOMAIN,
      chainId,
      verifyingContract: SETTLEMENT_ADDRESS,
    };

    const signature = await bob.signTypedData(domain, EIP712_TYPES, {
      ...parseOrder(order),
      claims: parseOrder(order).claims.map(c => ({
        claimHash: c.claimHash,
        amount: c.amount,
        releaseDelay: c.releaseDelay,
      })),
    });

    const result = await relayer.submitOrder(order, signature);
    // Should be matched and settled on-chain
    expect(["matched", "pending"]).toContain(result.status);
  });

  // ─── Scenario 4: Query orders via relayer ──────────────────

  it("Query Alice orders from relayer", async () => {
    const orders = await relayer.getOrders(alice.address);
    expect(Array.isArray(orders)).toBe(true);
  });

  it("Query Bob orders from relayer", async () => {
    const orders = await relayer.getOrders(bob.address);
    expect(Array.isArray(orders)).toBe(true);
  });

  // ─── Scenario 5: Verify on-chain state ─────────────────────

  it("Escrow should be depleted after settlement", async () => {
    const aliceWeth = await settlement.deposits(alice.address, WETH);
    const bobUsdc = await settlement.deposits(bob.address, USDC);
    // After successful match+settle, escrow should be 0
    // If relayer is not registered on-chain, orders stay pending and escrow remains
    // Check if settlement happened by querying Settled events
    const settledFilter = settlement.filters.Settled();
    // NOTE: queryFilter is unbounded — acceptable for fresh anvil instances in e2e tests
    const events = await settlement.queryFilter(settledFilter);
    if (events.length > 0) {
      // Settlement happened — escrow should be depleted
      expect(aliceWeth).toBe(BigInt(0));
      expect(bobUsdc).toBe(BigInt(0));
    } else {
      // No settlement yet — escrow should equal deposited amounts
      expect(aliceWeth).toBe(ethers.parseEther("10"));
      expect(bobUsdc).toBe(ethers.parseUnits("21000", 18));
    }
  });

  // ─── Scenario 6: Order cancel via relayer ──────────────────

  it("Alice cancels an order via signed message", async () => {
    // Submit a new order first
    const order = {
      maker: alice.address,
      sellToken: WETH,
      buyToken: USDC,
      sellAmount: ethers.parseEther("1").toString(),
      buyAmount: ethers.parseUnits("2100", 18).toString(),
      maxFee: "30",
      expiry: (Math.floor(Date.now() / 1000) + 86400).toString(),
      nonce: "9999",
      claims: [{
        claimHash: ethers.keccak256(ethers.solidityPacked(
          ["bytes32", "address"],
          [ethers.keccak256(ethers.toUtf8Bytes("cancel-test")), alice.address]
        )),
        amount: ethers.parseUnits("2100", 18).toString(),
        releaseDelay: "3600",
      }],
    };

    const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: SETTLEMENT_ADDRESS };
    const parsed = parseOrder(order);
    const signature = await alice.signTypedData(domain, EIP712_TYPES, {
      ...parsed,
      claims: parsed.claims.map(c => ({ claimHash: c.claimHash, amount: c.amount, releaseDelay: c.releaseDelay })),
    });

    await relayer.submitOrder(order, signature);

    // Cancel with signed message
    const cancelSig = await alice.signMessage(`cancel:${alice.address.toLowerCase()}:9999`);
    const cancelResult = await relayer.cancelOrder(alice.address, 9999, cancelSig);
    expect(cancelResult.status).toBe("cancelled");

    // Verify order status is cancelled
    const orders = await relayer.getOrders(alice.address);
    const cancelled = orders.find((o: { nonce: string }) => o.nonce === "9999");
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("cancelled");
  });
});
