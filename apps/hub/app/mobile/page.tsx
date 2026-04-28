import Link from "next/link";

export const metadata = {
  title: "zkScatter Mobile — privacy in your pocket",
  description:
    "Self-custody wallet, on-device proof generation, and gasless claims. iOS and Android.",
};

export default function MobilePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-24 px-6 py-12">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-mobile)]" />
          iOS · Android · React Native
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Privacy in your pocket.
          <br />
          <span className="text-[var(--color-accent-mobile)]">
            One app for wallet, trading, and private payments.
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Self-custody EdDSA keys live in the device&apos;s secure enclave.
          Groth16 proofs run on-device — no server sees your inputs.
          Pair with the Pro web app over QR for a desktop trading session.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <DownloadCTA store="App Store" disabled />
          <DownloadCTA store="Google Play" disabled />
        </div>
        <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
          Public beta opens with the v1 launch. Sign up below to get an
          install link.
        </p>
      </section>

      {/* What you get */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">What you get</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          The same private settlement rail as the web apps — packaged for
          phone-first wallets.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Card
            title="Self-custody, no cloud"
            body="EdDSA keys derived from a PIN-wrapped seed; never leave the device. PIN unlock, biometrics, and a QR-based recovery flow are built in."
          />
          <Card
            title="On-device proofs"
            body="Native Rust prover (deposit, authorize, claim, cancel) runs inside the app — your amounts and identities never reach a server."
          />
          <Card
            title="Quick Sign with Pro"
            body="Scan a QR code from the Pro workbench to sign on your phone. Trade from a laptop, sign from your pocket — no relayer can replay."
          />
        </div>
      </section>

      {/* Feature stack */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Feature stack</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Same SDK as the web apps, optimised for the device.
        </p>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Layer</th>
                <th className="px-5 py-3 text-left">Mobile</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Runtime" value="React Native (Expo, dev client + new arch)" />
              <Row label="Storage" value="expo-secure-store (keys) + expo-sqlite (history) + AsyncStorage" />
              <Row label="Prover" value="Native Rust (groth16) over snarkjs-compatible witness" />
              <Row label="Stealth" value="EIP-5564 sender + recipient (PR #252 / #256)" />
              <Row label="Identity" value="zk-X509 IdentityGate, on-device verification" />
            </tbody>
          </table>
        </div>
      </section>

      {/* Status */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-accent-mobile-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Status</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          Public beta opens with v1 launch. Phase C native prover (deposit
          / authorize / claim / cancel) shipped; PIN auth + Cancel UI
          shipped; transport stall handling and stealth recipient porting
          in flight.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-[var(--color-accent-mobile-soft)]"
          >
            ← Back to apps
          </Link>
          <a
            href="https://github.com/tokamak-network/scatter-dex"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-[var(--color-accent-mobile)] px-6 py-3 font-medium text-white hover:bg-[var(--color-accent-mobile-hover)]"
          >
            Source on GitHub →
          </a>
        </div>
      </section>
    </div>
  );
}

function DownloadCTA({ store, disabled }: { store: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={
        disabled
          ? "cursor-not-allowed rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-3 font-medium text-[var(--color-text-subtle)]"
          : "rounded-lg bg-[var(--color-accent-mobile)] px-6 py-3 font-medium text-white hover:bg-[var(--color-accent-mobile-hover)]"
      }
      title={disabled ? "Public beta opens with v1 launch." : undefined}
    >
      {store} {disabled && "· soon"}
    </button>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="font-semibold">{title}</div>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-5 py-3 font-medium">{label}</td>
      <td className="px-5 py-3 text-[var(--color-text-muted)]">{value}</td>
    </tr>
  );
}
