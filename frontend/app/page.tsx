import Link from "next/link";
import { Shield, ArrowLeftRight, Network, Lock } from "lucide-react";

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="relative min-h-[870px] flex flex-col items-center justify-center px-6 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
          <div className="absolute top-1/4 right-0 w-[400px] h-[400px] bg-tertiary/5 rounded-full blur-[100px]" />
        </div>
        <div className="relative z-10 max-w-5xl text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-container border border-outline-variant/15 mb-8">
            <span className="w-2 h-2 rounded-full bg-tertiary animate-pulse" />
            <span className="text-xs font-medium text-on-surface-variant tracking-wider uppercase">
              Privacy-Preserving DEX with ZK Settlements
            </span>
          </div>
          <h1 className="font-headline font-extrabold text-5xl md:text-7xl lg:text-8xl tracking-tighter text-on-surface mb-8 leading-[1.05]">
            zkScatter:{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-tertiary">
              Secure, Stealth
            </span>
            , and Decentralized.
          </h1>
          <p className="text-xl md:text-2xl text-on-surface-variant max-w-3xl mx-auto mb-12 leading-relaxed">
            Trade transparently, settle privately. Seven-dimensional dissociation
            makes your fund flows untraceable — powered by stealth addresses and
            zero-knowledge proofs.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/trade"
              className="w-full sm:w-auto px-10 py-4 gradient-btn text-on-primary-fixed rounded-md font-bold text-lg hover:shadow-[0_0_40px_-10px_rgba(149,170,255,0.5)] transition-all text-center"
            >
              Launch Terminal
            </Link>
            <Link
              href="/docs/PAPER.md"
              className="w-full sm:w-auto px-10 py-4 bg-surface-container text-on-surface rounded-md font-bold text-lg border border-outline-variant/20 hover:bg-surface-bright transition-all text-center"
            >
              Read Whitepaper
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="relative z-10 w-full max-w-6xl mt-24 grid grid-cols-2 md:grid-cols-4 gap-8 px-8 py-10 rounded-xl glass-card border border-outline-variant/10">
          <StatItem label="Privacy Model" value="Dual-CA" />
          <StatItem label="Settlement" value="Scatter" />
          <StatItem label="Claims" value="Stealth" />
          <StatItem label="Gas Savings" value="~74%" />
        </div>
      </section>

      {/* Features Bento Grid */}
      <section className="py-32 px-8 max-w-[1400px] mx-auto">
        <div className="mb-20 text-center md:text-left">
          <h2 className="font-headline font-bold text-4xl mb-4">Core Infrastructure</h2>
          <p className="text-on-surface-variant max-w-xl">
            Privacy-preserving primitives designed for compliant decentralized finance.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Stealth Claims */}
          <div className="md:col-span-8 rounded-xl bg-surface-container border border-outline-variant/10 p-8 flex flex-col justify-between min-h-[400px]">
            <div>
              <Shield className="w-10 h-10 text-tertiary mb-6" />
              <h3 className="font-headline font-bold text-3xl mb-4">Stealth Claims</h3>
              <p className="text-on-surface-variant text-lg max-w-md">
                Recipients use one-time stealth addresses derived from meta-addresses.
                Mathematically unlinkable — no fresh wallet management needed.
              </p>
            </div>
          </div>

          {/* Atomic Escrow */}
          <div className="md:col-span-4 rounded-xl bg-surface-container border border-outline-variant/10 p-8 flex flex-col justify-center min-h-[400px] hover:bg-surface-bright transition-colors">
            <Lock className="w-10 h-10 text-primary mb-6" />
            <h3 className="font-headline font-bold text-2xl mb-4">Atomic Escrow</h3>
            <p className="text-on-surface-variant">
              Trustless asset holding with identity-gated deposits.
              zk-X509 verified users only — compliant by design.
            </p>
          </div>

          {/* Order Matching */}
          <div className="md:col-span-4 rounded-xl bg-surface-container border border-outline-variant/10 p-8 flex flex-col justify-center min-h-[400px] hover:bg-surface-bright transition-colors">
            <ArrowLeftRight className="w-10 h-10 text-secondary mb-6" />
            <h3 className="font-headline font-bold text-2xl mb-4">Scatter Settlement</h3>
            <p className="text-on-surface-variant">
              Amount splitting, temporal dispersion, address separation,
              and hash-lock concealment — seven dimensions of unlinkability.
            </p>
          </div>

          {/* Relayer Network */}
          <div className="md:col-span-8 rounded-xl bg-surface-container border border-outline-variant/10 p-8 flex flex-col justify-between min-h-[400px]">
            <div>
              <Network className="w-10 h-10 text-tertiary mb-6" />
              <h3 className="font-headline font-bold text-3xl mb-4">Dual-CA Relayer Network</h3>
              <p className="text-on-surface-variant text-lg max-w-md">
                Publicly identified relayers (Relayer CA) match orders from
                privacy-preserving users (User CA). Legal backdoor without
                a cryptographic backdoor.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-40 text-center relative overflow-hidden">
        <div className="absolute inset-0 z-0">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-primary/20 rounded-full blur-[100px]" />
        </div>
        <div className="relative z-10 max-w-4xl mx-auto px-8">
          <h2 className="font-headline font-extrabold text-5xl mb-8">
            Ready to trade privately?
          </h2>
          <p className="text-on-surface-variant text-xl mb-12 max-w-2xl mx-auto">
            Connect your wallet, deposit to escrow, and start trading with
            cryptographic privacy guarantees.
          </p>
          <Link
            href="/trade"
            className="inline-block px-12 py-5 gradient-btn text-on-primary-fixed rounded-md font-bold text-xl hover:scale-105 active:scale-95 transition-all"
          >
            Start Trading
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full px-8 py-16 flex flex-col md:flex-row justify-between items-center border-t border-outline-variant/10">
        <div className="mb-8 md:mb-0 text-center md:text-left">
          <div className="text-lg font-headline font-bold tracking-tight text-on-surface mb-2">zkScatter</div>
          <p className="text-xs text-on-surface-variant">Privacy-Preserving Decentralized Exchange</p>
        </div>
        <div className="flex gap-8">
          <a className="text-xs text-on-surface-variant hover:text-on-surface transition-all" href="https://github.com/tokamak-network/scatter-dex">GitHub</a>
        </div>
      </footer>
    </>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center md:text-left">
      <p className="text-on-surface-variant text-sm font-medium mb-1">{label}</p>
      <p className="font-headline font-bold text-3xl text-primary">{value}</p>
    </div>
  );
}
