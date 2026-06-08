"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Menu, Plus, X } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { RPC_URL, EXPECTED_CHAIN_ID, getChainName } from "../lib/config";
import { shortenAddress } from "../lib/utils";

// Fork-mode flag — dev-fork.sh writes this into .env.local to unlock the
// "Add Fork Network" button. Production builds never see it. The button
// reuses the wallet context's switchNetwork(), which adds the chain on the
// EIP-1193 4902 ("unknown chain") path and then switches to it.
const IS_FORK_MODE = process.env.NEXT_PUBLIC_FORK_MODE === "true";

interface NavLinkSpec {
  href: string;
  label: string;
}

const navLinks: NavLinkSpec[] = [
  { href: "/", label: "Home" },
  { href: "/identity", label: "Identity Verification" },
  { href: "/trade", label: "Trade" },
  { href: "/relayer", label: "Relayer" },
  { href: "/wallets", label: "Address Book" },
  { href: "/faq", label: "FAQ" },
  // Local dev only — the route itself refuses non-31337 chains.
  ...(EXPECTED_CHAIN_ID === 31337 ? [{ href: "/faucet", label: "Faucet" }] : []),
];

function shortenRpc(url: string) {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? `:${u.port}` : "");
  } catch {
    return url;
  }
}

// Single source of truth for the active-route rule used by both the
// desktop nav bar and the mobile drawer. Match on a path-segment
// boundary so `/identity` doesn't light up for a hypothetical
// `/identity-verification` sibling route.
function isLinkActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
}

function NavLink({ link, active, variant }: { link: NavLinkSpec; active: boolean; variant: "desktop" | "mobile" }) {
  const className =
    variant === "desktop"
      ? // Always reserve the underline space (transparent on inactive)
        // so the link doesn't jump vertically when it becomes active.
        `text-sm font-medium transition-colors border-b-2 pb-1 ${
          active ? "text-primary border-primary" : "text-on-surface-variant border-transparent hover:text-on-surface"
        }`
      : `px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
          active ? "bg-primary/10 text-primary" : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
        }`;
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

function NetworkBadge({ size }: { size: "sm" | "md" }) {
  const text = size === "sm" ? "text-[10px]" : "text-[11px]";
  return (
    <div className={`flex items-center gap-2 ${text} font-mono text-on-surface-variant`}>
      <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
      {getChainName(EXPECTED_CHAIN_ID)} ({EXPECTED_CHAIN_ID})
      <span className="text-outline-variant">|</span>
      {shortenRpc(RPC_URL)}
    </div>
  );
}

export default function Header() {
  const pathname = usePathname();
  const { account, chainId, isWrongNetwork, walletName, connect, disconnect, switchNetwork } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile drawer on route change so navigating from the menu
  // doesn't leave it stuck open over the new page.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Lock the body scroll while the drawer is open so the page beneath
  // doesn't ghost-scroll when the user drags inside the panel. Cleanup
  // restores the original value (not just `""`) so other code that
  // controls overflow keeps working after the drawer closes.
  //
  // Also force-close the drawer if the viewport crosses the `md`
  // breakpoint while it's open. The drawer + hamburger themselves are
  // CSS-hidden via `md:hidden`, but `menuOpen` would otherwise stay
  // true — pinning `body { overflow: hidden }` on a desktop viewport
  // with no visible close affordance.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setMenuOpen(false); };
    mq.addEventListener("change", onChange);
    return () => {
      document.body.style.overflow = previous;
      mq.removeEventListener("change", onChange);
    };
  }, [menuOpen]);

  return (
    <>
      <header className="fixed top-0 left-0 w-full z-40 bg-background">
        <nav className="flex justify-between items-center w-full px-8 h-16 max-w-[1920px] mx-auto">
          {/* Left: Logo + Service Info */}
          <div className="flex items-center gap-4">
            <Link href="/" className="text-2xl font-headline font-bold tracking-tight text-on-surface">
              zkScatter
            </Link>
            <div className="hidden md:flex px-3 py-1 rounded-md bg-surface-container border border-outline-variant/10">
              <NetworkBadge size="sm" />
            </div>
          </div>

          {/* Center: Nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <NavLink key={link.href} link={link} active={isLinkActive(pathname, link.href)} variant="desktop" />
            ))}
          </div>

          {/* Right: Wallet + mobile menu toggle */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="md:hidden flex items-center justify-center w-10 h-10 rounded-md text-on-surface hover:bg-surface-container transition-colors"
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            {IS_FORK_MODE && (
              <button
                onClick={() => void switchNetwork()}
                className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-tertiary/10 border border-tertiary/30 text-tertiary hover:bg-tertiary/20 transition-colors"
                title="Add the local fork network to MetaMask"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Fork Network
              </button>
            )}
            {account && chainId !== null && (
              <div
                className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono ${
                  isWrongNetwork
                    ? "bg-error/10 border border-error/30 text-error"
                    : "bg-surface-container border border-outline-variant/10 text-on-surface-variant"
                }`}
              >
                {isWrongNetwork && <AlertTriangle className="w-3.5 h-3.5" />}
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: isWrongNetwork ? undefined : "#9bffce" }} />
                {getChainName(chainId)}
              </div>
            )}
            {account ? (
              <button
                onClick={disconnect}
                className="bg-surface-container text-on-surface px-5 py-2 rounded-md font-semibold text-sm border border-outline-variant/20 hover:bg-surface-bright transition-all font-mono"
              >
                {walletName && <span className="text-on-surface-variant mr-1">{walletName}</span>}
                {shortenAddress(account)}
              </button>
            ) : (
              <button
                onClick={() => connect()}
                className="gradient-btn text-on-primary-fixed px-5 py-2 rounded-md font-semibold text-sm active:scale-95 duration-100 transition-all"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
      </header>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
            className="md:hidden fixed inset-0 top-16 z-40 bg-black/40"
          />
          <div className="md:hidden fixed top-16 inset-x-0 z-50 bg-background border-b border-outline-variant/10 shadow-lg">
            <nav className="flex flex-col px-6 py-4 gap-1">
              {navLinks.map((link) => (
                <NavLink key={link.href} link={link} active={isLinkActive(pathname, link.href)} variant="mobile" />
              ))}
            </nav>
            <div className="border-t border-outline-variant/10 px-6 py-3 space-y-3">
              <NetworkBadge size="md" />
              {IS_FORK_MODE && (
                <button
                  onClick={() => { setMenuOpen(false); void switchNetwork(); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-tertiary/10 border border-tertiary/30 text-tertiary hover:bg-tertiary/20 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Fork Network
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Wrong Network Banner */}
      {isWrongNetwork && (
        <div className="fixed top-16 left-0 w-full z-30 bg-error/10 border-b border-error/20 px-8 py-3 flex items-center justify-center gap-3">
          <AlertTriangle className="w-4 h-4 text-error" />
          <span className="text-sm text-error font-medium">
            Wrong network: connected to {getChainName(chainId!)} ({chainId}) — please switch to{" "}
            <strong>{getChainName(EXPECTED_CHAIN_ID)} ({EXPECTED_CHAIN_ID})</strong>
          </span>
          <button
            onClick={() => void switchNetwork()}
            className="px-3 py-1 rounded-md text-xs font-semibold bg-error text-background hover:bg-error/90 transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}
    </>
  );
}
