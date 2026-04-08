import Link from "next/link";
import { EyeOff, ShieldCheck, Zap, Ban } from "lucide-react";

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
          <h1 className="font-headline font-extrabold text-4xl md:text-5xl lg:text-6xl tracking-tighter text-on-surface mb-8 leading-[1.1]">
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-tertiary">
              zkScatter
            </span>
          </h1>
          <p className="text-2xl md:text-3xl text-on-surface max-w-3xl mx-auto mb-4 leading-snug font-semibold">
            Hide Your Flow. Prove Your Identity.
          </p>
          <p className="text-lg md:text-xl text-on-surface-variant max-w-3xl mx-auto mb-12 leading-relaxed">
            Trade on-chain with absolute privacy. No one sees what you bought,
            who you traded with, or where your funds went.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/trade"
              className="w-full sm:w-auto px-10 py-4 gradient-btn text-on-primary-fixed rounded-md font-bold text-lg hover:shadow-[0_0_40px_-10px_rgba(149,170,255,0.5)] transition-all text-center"
            >
              Start Secret Trade
            </Link>
            <a
              href="https://github.com/tokamak-network/scatter-dex/blob/main/docs/PAPER.md"
              target="_blank"
              rel="noreferrer"
              className="w-full sm:w-auto px-10 py-4 bg-surface-container text-on-surface rounded-md font-bold text-lg border border-outline-variant/20 hover:bg-surface-bright transition-all text-center"
            >
              Read Whitepaper
            </a>
          </div>
        </div>

        {/* Stats */}
        <div className="relative z-10 w-full max-w-6xl mt-24 grid grid-cols-2 md:grid-cols-4 gap-8 px-8 py-10 rounded-xl glass-card border border-outline-variant/10">
          <StatItem label="Privacy Model" value="Dual-CA" />
          <StatItem label="Settlement" value="Scatter" />
          <StatItem label="Claims" value="ZK Proof" />
          <Link href="/identity" className="hover:opacity-80 transition-opacity">
            <StatItem label="Identity" value="zk-X509" />
          </Link>
        </div>
      </section>

      {/* Trilemma */}
      <section className="relative pt-32 pb-16 px-8 overflow-hidden">
        {/* Background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-primary/8 rounded-full blur-[150px]" />

        <div className="relative z-10 max-w-[1200px] mx-auto">
          <div className="mb-16 text-center">
            <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-4">The DEX Trilemma</p>
            <h2 className="font-headline font-extrabold text-4xl md:text-5xl mb-6">
              Pick two?{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-tertiary">
                We pick all three.
              </span>
            </h2>
            <p className="text-on-surface-variant text-lg max-w-2xl mx-auto">
              Existing DEXs sacrifice privacy for compliance, or efficiency for privacy.
              zkScatter breaks the trade-off.
            </p>
          </div>

          {/* Triangle + 3 pillars layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
            {/* Privacy Pillar */}
            <div className="relative rounded-2xl border border-primary/20 bg-gradient-to-b from-primary/10 to-transparent p-8 backdrop-blur-sm">
              <div className="absolute -top-px left-8 right-8 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
              <div className="w-14 h-14 rounded-xl bg-primary/15 flex items-center justify-center mb-6">
                <EyeOff className="w-7 h-7 text-primary" />
              </div>
              <h3 className="font-headline font-bold text-2xl text-primary mb-2">Privacy</h3>
              <p className="text-sm text-primary/70 font-medium mb-4">Cryptographic, not statistical</p>
              <p className="text-on-surface-variant leading-relaxed">
                Poseidon hash commitments make every deposit look identical on-chain.
                Even with one user in the pool, no observer can link deposit to withdrawal.
              </p>
              <div className="mt-6 pt-4 border-t border-primary/10">
                <p className="text-xs text-on-surface-variant/60">Unlike Tornado Cash which degrades with low traffic</p>
              </div>
            </div>

            {/* Compliance Pillar */}
            <div className="relative rounded-2xl border border-tertiary/20 bg-gradient-to-b from-tertiary/10 to-transparent p-8 backdrop-blur-sm lg:mt-12">
              <div className="absolute -top-px left-8 right-8 h-px bg-gradient-to-r from-transparent via-tertiary/60 to-transparent" />
              <div className="w-14 h-14 rounded-xl bg-tertiary/15 flex items-center justify-center mb-6">
                <ShieldCheck className="w-7 h-7 text-tertiary" />
              </div>
              <h3 className="font-headline font-bold text-2xl text-tertiary mb-2">Compliance</h3>
              <p className="text-sm text-tertiary/70 font-medium mb-4">Dual-CA identity model</p>
              <p className="text-on-surface-variant leading-relaxed">
                Users verify via zk-X509 without revealing identity.
                Relayers operate as licensed public entities — law enforcement
                can investigate without breaking encryption.
              </p>
              <div className="mt-6 pt-4 border-t border-tertiary/10">
                <p className="text-xs text-on-surface-variant/60">Legal backdoor without a cryptographic backdoor</p>
              </div>
            </div>

            {/* Efficiency Pillar */}
            <div className="relative rounded-2xl border border-secondary/20 bg-gradient-to-b from-secondary/10 to-transparent p-8 backdrop-blur-sm">
              <div className="absolute -top-px left-8 right-8 h-px bg-gradient-to-r from-transparent via-secondary/60 to-transparent" />
              <div className="w-14 h-14 rounded-xl bg-secondary/15 flex items-center justify-center mb-6">
                <Zap className="w-7 h-7 text-secondary" />
              </div>
              <h3 className="font-headline font-bold text-2xl text-secondary mb-2">Efficiency</h3>
              <p className="text-sm text-secondary/70 font-medium mb-4">L1 + L2 ready</p>
              <p className="text-on-surface-variant leading-relaxed">
                Groth16 proofs verify in constant ~200K gas.
                Full private trade under $0.01 on L2.
                No MPC rounds, no FHE overhead — just math.
              </p>
              <div className="mt-6 pt-4 border-t border-secondary/10">
                <p className="text-xs text-on-surface-variant/60">Unlike Renegade which needs heavy MPC computation</p>
              </div>
            </div>
          </div>

          {/* Connecting line decoration */}
          <div className="hidden lg:flex justify-center mt-12">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-primary/40" />
              <div className="w-24 h-px bg-gradient-to-r from-primary/40 to-tertiary/40" />
              <div className="w-3 h-3 rounded-full bg-tertiary/40" />
              <div className="w-24 h-px bg-gradient-to-r from-tertiary/40 to-secondary/40" />
              <div className="w-3 h-3 rounded-full bg-secondary/40" />
            </div>
          </div>
        </div>
      </section>

      {/* How it works — visual flow */}
      <section className="py-32 px-8 max-w-[1200px] mx-auto">
        <div className="mb-16 text-center">
          <p className="text-tertiary text-sm font-semibold tracking-widest uppercase mb-4">How it works</p>
          <h2 className="font-headline font-extrabold text-4xl md:text-5xl mb-6">
            Trade in 4 steps
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-0">
          {/* Step 1 */}
          <div className="relative p-6 text-center group">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary-dim mx-auto mb-5 flex items-center justify-center text-on-primary font-headline font-bold text-lg shadow-[0_0_30px_-5px_rgba(149,170,255,0.4)]">
              1
            </div>
            <h4 className="font-headline font-bold text-lg mb-2">Verify</h4>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              One-time zk-X509 identity proof. Your real identity never touches the chain.
            </p>
            {/* Arrow */}
            <div className="hidden md:block absolute top-12 -right-3 w-6 text-outline-variant/40">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14m-4-4 4 4-4 4" /></svg>
            </div>
          </div>

          {/* Step 2 */}
          <div className="relative p-6 text-center group">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-tertiary to-tertiary-dim mx-auto mb-5 flex items-center justify-center text-on-tertiary-container font-headline font-bold text-lg shadow-[0_0_30px_-5px_rgba(155,255,206,0.3)]">
              2
            </div>
            <h4 className="font-headline font-bold text-lg mb-2">Deposit</h4>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              Funds become a Poseidon hash commitment — invisible inside the Merkle tree.
            </p>
            <div className="hidden md:block absolute top-12 -right-3 w-6 text-outline-variant/40">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14m-4-4 4 4-4 4" /></svg>
            </div>
          </div>

          {/* Step 3 */}
          <div className="relative p-6 text-center group">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-secondary to-secondary-container mx-auto mb-5 flex items-center justify-center text-on-surface font-headline font-bold text-lg shadow-[0_0_30px_-5px_rgba(200,216,243,0.3)]">
              3
            </div>
            <h4 className="font-headline font-bold text-lg mb-2">Trade</h4>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              Sign orders off-chain. Relayer matches and submits a ZK proof — settlement is private.
            </p>
            <div className="hidden md:block absolute top-12 -right-3 w-6 text-outline-variant/40">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14m-4-4 4 4-4 4" /></svg>
            </div>
          </div>

          {/* Step 4 */}
          <div className="relative p-6 text-center group">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-tertiary mx-auto mb-5 flex items-center justify-center text-on-primary font-headline font-bold text-lg shadow-[0_0_30px_-5px_rgba(149,170,255,0.4)]">
              4
            </div>
            <h4 className="font-headline font-bold text-lg mb-2">Claim</h4>
            <p className="text-on-surface-variant text-sm leading-relaxed">
              Withdraw to a fresh wallet with a ZK proof. Gasless — relayer pays. No link to your deposit.
            </p>
          </div>
        </div>
      </section>

      {/* Value highlight cards */}
      <section className="py-16 px-8 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* MEV Card — large accent */}
          <div className="relative rounded-2xl overflow-hidden border border-error/15 p-10 min-h-[280px] flex flex-col justify-between group hover:border-error/30 transition-all">
            <div className="absolute inset-0 bg-gradient-to-br from-error/8 via-transparent to-transparent" />
            <div className="relative z-10">
              <Ban className="w-10 h-10 text-error mb-5" />
              <h3 className="font-headline font-bold text-2xl md:text-3xl mb-3">
                Bots can&apos;t front-run you
              </h3>
              <p className="text-on-surface-variant text-lg leading-relaxed max-w-md">
                Fixed-price limit orders with off-chain matching.
                No AMM curve to exploit, no mempool to snipe.
              </p>
            </div>
            <p className="relative z-10 text-error/40 text-xs mt-6 font-medium tracking-wide uppercase">Structural MEV immunity</p>
          </div>

          {/* Cost Card */}
          <div className="relative rounded-2xl overflow-hidden border border-primary/15 p-10 min-h-[280px] flex flex-col justify-between group hover:border-primary/30 transition-all">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-transparent" />
            <div className="relative z-10">
              <p className="font-headline font-extrabold text-6xl text-transparent bg-clip-text bg-gradient-to-r from-primary to-tertiary mb-2">
                &lt;$0.01
              </p>
              <h3 className="font-headline font-bold text-2xl mb-3">
                Per private trade on L2
              </h3>
              <p className="text-on-surface-variant text-lg leading-relaxed max-w-md">
                Full ZK privacy at the cost of a normal swap.
                Constant ~200K gas verification on any EVM chain.
              </p>
            </div>
            <p className="relative z-10 text-primary/40 text-xs mt-6 font-medium tracking-wide uppercase">Groth16 constant-cost proofs</p>
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
            Verify your identity once, deposit to escrow, and trade
            with cryptographic privacy — no one sees your flow.
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
