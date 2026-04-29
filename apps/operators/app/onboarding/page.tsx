import Link from "next/link";
import { StatusChecks } from "./StatusChecks";

export const metadata = {
  title: "Onboarding — Scatter Relayer",
  description:
    "Step-by-step guide for new relayer operators: prerequisites, install, configure, register, run, monitor.",
};

export default function Onboarding() {
  return (
    <div className="space-y-20">
      {/* Hero */}
      <section className="pt-8 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
          Getting started · ~30 min end-to-end
        </div>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight">
          From zero to a running relayer.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-[var(--color-text-muted)]">
          Six steps. No hidden prerequisites. Follow top-to-bottom and you will
          have a registered relayer accepting traffic on the testnet.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <a
            href="#status"
            className="rounded-lg bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Check my readiness ↓
          </a>
          <a
            href="#prereqs"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-2.5 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
          >
            Read the guide
          </a>
        </div>
      </section>

      {/* Live status */}
      <section id="status">
        <SectionHeader
          eyebrow="Live status"
          title="Where you are right now"
          body="Auto-checks of your wallet, RPC, and on-chain state. Service health needs your relayer URL."
        />
        <StatusChecks />
      </section>

      {/* Prerequisites */}
      <section id="prereqs">
        <SectionHeader
          eyebrow="Before you start"
          title="What you will need"
          body="Gather these first. Each one is required — the wizard later confirms them automatically."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Prereq
            title="Operator wallet (with private key)"
            body="A dedicated EVM wallet whose private key the relayer process can read. Never reuse a personal/treasury key — operator keys sign settlement txs constantly."
            note="Hardware wallets are not supported for the relayer process. Use a fresh hot wallet held only by the operator host."
          />
          <Prereq
            title="Bond + gas balance"
            body="On Sepolia testnet: at least 0.1 ETH bond plus a gas float (~0.05 ETH) on the operator wallet. Bond is recoverable on exit after a 7-day cooldown."
          />
          <Prereq
            title="EVM RPC endpoint"
            body="A reliable RPC URL (Alchemy/Infura/your own node). For production, a fallback URL is strongly recommended."
            note="Archive support is not required; standard JSON-RPC is enough."
          />
          <Prereq
            title="Server / host"
            body="Minimum 2 vCPU, 4 GB RAM, 50 GB SSD. Docker or Node.js 20+ runtime. Outbound network access to the RPC and inbound HTTPS for your public URL."
          />
          <Prereq
            title="Public HTTPS URL"
            body="A reachable public URL (e.g. https://relayer.example.com) that you will publish on-chain. Clients route orders to this URL. Behind a reverse proxy with TLS termination."
          />
          <Prereq
            title="Admin API key (optional but recommended)"
            body="A strong random secret (openssl rand -hex 32, ≥ 32 bytes). The relayer runs without one, but every /api/admin/* endpoint returns 403 until it is set, so pause/resume, fee updates, and sanctions management are inaccessible."
          />
        </div>
      </section>

      {/* Steps */}
      <section id="steps">
        <SectionHeader
          eyebrow="Step-by-step"
          title="The six steps"
          body="Each step is independent — finish one before moving to the next. Time estimates assume the prerequisites above are ready."
        />
        <div className="space-y-4">
          <Step
            n={1}
            title="Clone the repo and install dependencies"
            time="~5 min"
            body="Each package in the monorepo is standalone (no root npm workspace) — install and build inside zk-relayer/."
            code={`git clone https://github.com/tokamak-network/scatter-dex.git
cd scatter-dex/zk-relayer
npm install
npm run build`}
          />
          <Step
            n={2}
            title="Configure your .env"
            time="~5 min"
            body="Copy the example file and fill in the five required fields (RPC_URL, RELAYER_PRIVATE_KEY, and the three contract addresses). ADMIN_API_KEY is optional but recommended. Other fields have safe defaults."
            code={`cp .env.example .env
# then edit .env`}
            extra={<EnvTable />}
          />
          <Step
            n={3}
            title="Start the relayer service"
            time="~2 min"
            body="Run the service locally first to verify your config. Once /health returns 200, you are ready to register."
            code={`# from zk-relayer/
npm start

# in another shell:
curl -s http://localhost:3002/health | jq`}
            extra={
              <p className="text-xs text-[var(--color-text-muted)]">
                Expected: <code className="font-mono">{`{ "status": "healthy", "uptime": <seconds>, "checks": { "rpc": "ok", "db": "ok" } }`}</code>.
                A 503 with <code className="font-mono">status: "degraded"</code> means one of the checks failed — inspect the response body.
              </p>
            }
          />
          <Step
            n={4}
            title="Register on-chain"
            time="~3 min"
            body="Connect your operator wallet and publish your public URL plus per-trade fee. The bond is escrowed in the RelayerRegistry contract."
            extra={
              <Link
                href="/register"
                className="inline-block rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
              >
                Open the registration flow →
              </Link>
            }
          />
          <Step
            n={5}
            title="Verify the relayer is live"
            time="~3 min"
            body="Confirm registration on-chain, then check that orders can reach your endpoint. Your registry entry must list the same URL the service is exposing."
            code={`# inspect the relayer's self-reported state:
curl -s https://YOUR_PUBLIC_URL/api/info | jq

# expected shape:
# {
#   name: "ScatterDEX ZK Relayer", version: "0.1.0",
#   address: "0x...", fee: 30, orderCount: 0,
#   commitmentPool: "0x...", privateSettlement: "0x...",
#   profile: { name, description, ... }
# }
#
# cross-check on-chain registration via the leaderboard page or
# the RelayerRegistry contract directly.`}
            extra={
              <Link
                href="/dashboard"
                className="inline-block text-sm font-medium text-[var(--color-primary)] hover:underline"
              >
                Open the operator dashboard →
              </Link>
            }
          />
          <Step
            n={6}
            title="Set up monitoring + alerts"
            time="~10 min"
            body="At minimum: poll /health from your monitoring stack and route alerts to a channel you actually watch. Phase 2 will add in-app webhooks; for now wire it externally."
            extra={
              <ul className="space-y-1.5 text-sm text-[var(--color-text-muted)]">
                <li>· Poll <code className="font-mono">GET /health</code> every 30 s — alert on non-200.</li>
                <li>· Tail process stdout for <code className="font-mono">[tx-recovery]</code> and <code className="font-mono">[admin]</code> lines.</li>
                <li>· Track operator wallet ETH balance — alert below ~0.02 ETH.</li>
                <li>· Watch the on-chain bond — slashing or self-exit changes it.</li>
              </ul>
            }
          />
        </div>
      </section>

      {/* Concepts */}
      <section id="concepts">
        <SectionHeader
          eyebrow="Glossary"
          title="Core concepts"
          body="Terms you will see repeatedly in this app, the docs, and the contracts."
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Concept term="Bond">
            ETH you escrow in <span className="font-mono text-xs">RelayerRegistry</span> when registering. Acts as a registration deposit. Recoverable in full on exit after a 7-day cooldown — the current contract has no bond-slashing mechanism (a misbehaving relayer only loses gas on failed <code className="font-mono">settle()</code> attempts).
          </Concept>
          <Concept term="Fee bps">
            Your per-trade fee in basis points (1 bp = 0.01%). Published on-chain at registration; updatable via <code className="font-mono">/profile</code>. Default reference: 30 bps (0.30%).
          </Concept>
          <Concept term="Platform fee">
            A protocol-level skim on relayer claims, capped at 50% by contract (governance default sub-10%). What you see on <code className="font-mono">/treasury</code> is net of platform fee.
          </Concept>
          <Concept term="FeeVault">
            On-chain contract that holds your accrued fees per token until you claim. The <code className="font-mono">/treasury</code> page is a UI on top of this contract.
          </Concept>
          <Concept term="Half-proof / authorize flow">
            Each side of a trade submits an <span className="font-mono text-xs">authorize.circom</span> proof; the relayer combines them in <code className="font-mono">settleAuth</code>. You never hold witness data — only proofs and public signals.
          </Concept>
          <Concept term="Sanctions lists (two of them)">
            <span className="font-medium">On-chain</span>: <span className="font-mono text-xs">SanctionsList</span> contract — a blocklist of <em>EVM addresses</em> (e.g. OFAC SDN). Enforced by <code className="font-mono">PrivateSettlement</code> for claim/settle paths.
            <br />
            <span className="font-medium">Operator-local</span>: a JSON file (or admin-API-managed) blocklist of <em>EdDSA pubkeys</em>. Rejects matching orders before they reach the chain.
          </Concept>
          <Concept term="Exit cooldown">
            Time between <code className="font-mono">requestExit</code> and <code className="font-mono">executeExit</code> on the registry — 7 days. <code className="font-mono">isActiveRelayer</code> returns <code className="font-mono">false</code> as soon as <code className="font-mono">requestExit</code> is called, so settlement is blocked for the entire cooldown — plan to drain your queue before requesting exit.
          </Concept>
          <Concept term="Slashing — not implemented">
            Despite the term being common in relayer designs, the current <code className="font-mono">RelayerRegistry</code> has no slashing path. If/when it ships, it will appear on <code className="font-mono">/profile</code>.
          </Concept>
        </div>
      </section>

      {/* Troubleshooting */}
      <section id="troubleshooting">
        <SectionHeader
          eyebrow="When things go wrong"
          title="Troubleshooting"
          body="Common failures and the first thing to check."
        />
        <div className="space-y-3">
          <FAQ
            q="/health returns 503"
            a="One of the readiness checks failed. Look at the response body — checks.rpc means your RPC_URL is unreachable; checks.db means the DB_PATH is not writable. Fix the underlying cause; the service does not need a restart once the dependency is healthy."
          />
          <FAQ
            q="Registration tx reverts with InsufficientBond"
            a="Your operator wallet does not hold enough native token to cover the minimum bond plus gas. Top up and retry — the registry returns the failure cleanly without consuming the bond."
          />
          <FAQ
            q="Orders arrive but never settle"
            a="Check the relayer's stdout for [gas-guard] or [tx-recovery] lines. If gas-guard rejected the settlement (gasPrice above MAX_GAS_PRICE_GWEI), the SettlementWorker classifies the failure as 'unknown' and does not auto-retry — the order will likely be picked up by another relayer. Raise the cap in .env (then restart) or accept that some flow will route around you during fee spikes."
          />
          <FAQ
            q="I rotated my admin key — old shells are still authorised"
            a="The admin key is read at process start; restart the relayer for the new value to take effect. Until then, the in-memory key is still valid."
          />
          <FAQ
            q="My public URL on-chain does not match my running service"
            a="Update via /profile or POST /api/admin/profile. The leaderboard and clients route to whatever the registry says — a stale URL silently drops traffic to you."
          />
          <FAQ
            q="Settlement fails with NullifierAlreadyUsed"
            a="The order has already been settled — usually by a competing relayer. This is normal under contention; the relayer drops the order from its queue and moves on."
          />
        </div>
      </section>

      {/* Final CTA */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-primary-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Ready when your checklist is green.</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          Once the prerequisites are gathered and the service is up, the
          registration flow is a single tx.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/register"
            className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Go to registration
          </Link>
          <Link
            href="/docs"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white"
          >
            Read the full operator docs
          </Link>
        </div>
      </section>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="mb-8 text-center">
      <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-primary)]">
        {eyebrow}
      </div>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
        {body}
      </p>
    </div>
  );
}

function Prereq({
  title,
  body,
  note,
}: {
  title: string;
  body: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-[var(--color-text-muted)]">{body}</p>
      {note ? (
        <p className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function Step({
  n,
  title,
  time,
  body,
  code,
  extra,
}: {
  n: number;
  title: string;
  time: string;
  body: string;
  code?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-semibold text-white">
          {n}
        </div>
        <div className="flex-1">
          <div className="font-semibold">{title}</div>
          <div className="text-xs text-[var(--color-text-subtle)]">{time}</div>
        </div>
      </div>
      <p className="mt-3 text-sm text-[var(--color-text-muted)]">{body}</p>
      {code ? (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--color-bg)] p-4 text-xs leading-relaxed">
          {code}
        </pre>
      ) : null}
      {extra ? <div className="mt-3">{extra}</div> : null}
    </div>
  );
}

function EnvTable() {
  const rows: { key: string; required: boolean; note: string }[] = [
    { key: "RPC_URL", required: true, note: "Your EVM RPC endpoint." },
    {
      key: "RELAYER_PRIVATE_KEY",
      required: true,
      note: "Operator wallet key. Use RELAYER_PRIVATE_KEY_FILE for Docker secrets.",
    },
    {
      key: "COMMITMENT_POOL_ADDRESS",
      required: true,
      note: "From contracts/deployments — must match the chain in RPC_URL.",
    },
    {
      key: "PRIVATE_SETTLEMENT_ADDRESS",
      required: true,
      note: "From contracts/deployments.",
    },
    { key: "FEE_VAULT_ADDRESS", required: true, note: "From contracts/deployments." },
    {
      key: "ADMIN_API_KEY",
      required: false,
      note: "openssl rand -hex 32 (≥ 32 bytes). Without it, /api/admin/* returns 403.",
    },
    {
      key: "RELAYER_PUBLIC_URL",
      required: false,
      note: "Your HTTPS URL. Recommended in production.",
    },
    {
      key: "TOKEN_LIST",
      required: false,
      note: "Per-token symbols for the treasury page.",
    },
    {
      key: "MAX_GAS_PRICE_GWEI",
      required: false,
      note: "Cap above which the relayer pauses settlement.",
    },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Field</th>
            <th className="px-3 py-2 text-left font-medium">Required</th>
            <th className="px-3 py-2 text-left font-medium">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[var(--color-border)]">
              <td className="px-3 py-2 font-mono">{r.key}</td>
              <td className="px-3 py-2">
                {r.required ? (
                  <span className="text-[var(--color-warning)]">required</span>
                ) : (
                  <span className="text-[var(--color-text-subtle)]">optional</span>
                )}
              </td>
              <td className="px-3 py-2 text-[var(--color-text-muted)]">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Concept({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="font-semibold">{term}</div>
      <p className="mt-1.5 text-sm text-[var(--color-text-muted)]">{children}</p>
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <details className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 open:bg-[var(--color-bg)]">
      <summary className="cursor-pointer list-none font-medium">
        <span className="mr-2 text-[var(--color-primary)] group-open:hidden">+</span>
        <span className="mr-2 hidden text-[var(--color-primary)] group-open:inline">−</span>
        {q}
      </summary>
      <p className="mt-3 text-sm text-[var(--color-text-muted)]">{a}</p>
    </details>
  );
}
