export type AppSurface = "web" | "mobile";
export type AppAudience = "user" | "operator";
export type AppId = "pro" | "pay" | "drop" | "mobile" | "relayer";

/** Per-app URL with env override. `NEXT_PUBLIC_*_URL` lets local
 *  dev (`apps/hub` on :4000) point at the sibling apps running on
 *  :4001–:4004 without editing source. Production deploys leave
 *  the env unset and fall through to the canonical zkscatter.xyz
 *  subdomains. */
const appUrl = (id: string, fallback: string): string => {
  const key = `NEXT_PUBLIC_${id.toUpperCase()}_URL` as const;
  return process.env[key] ?? fallback;
};

export type AppEntry = {
  id: AppId;
  name: string;
  tagline: string;
  persona: string;
  bullets: string[];
  surface: AppSurface;
  audience: AppAudience;
  href: string;
  cta: string;
  accent: string;
};

export const SURFACE_LABEL: Record<AppSurface, string> = {
  web: "Web app",
  mobile: "iOS · Android",
};

export const APPS: AppEntry[] = [
  {
    id: "pro",
    name: "Pro",
    tagline: "Trade privately. No MEV.",
    persona:
      "For semi-pro and OTC traders who need private limit orders without front-running.",
    bullets: [
      "Hidden orders, public proof",
      "Half-proof authorization (~15K constraints)",
      "Gasless claims via relayer network",
    ],
    surface: "web",
    audience: "user",
    href: appUrl("pro", "https://pro.zkscatter.xyz"),
    cta: "Open Pro",
    accent: "var(--color-accent-pro)",
  },
  {
    id: "pay",
    name: "Pay",
    tagline: "Pay your team privately.",
    persona:
      "For crypto-native companies and DAOs running payroll, vendor payouts, and treasury ops.",
    bullets: [
      "Bulk payouts in one private tx",
      "Recipient amounts hidden on-chain",
      "zk-X509 compliance built in",
    ],
    surface: "web",
    audience: "user",
    href: appUrl("pay", "https://pay.zkscatter.xyz"),
    cta: "Open Pay",
    accent: "var(--color-accent-pay)",
  },
  {
    id: "drop",
    name: "Drop",
    tagline: "Airdrops to humans, not bots.",
    persona:
      "For token launch teams who want sybil-resistant, private distribution.",
    bullets: [
      "Identity gating without doxxing",
      "Anti-sybil via zk-X509 attestations",
      "Claimers stay private",
    ],
    surface: "web",
    audience: "user",
    href: appUrl("drop", "https://drop.zkscatter.xyz"),
    cta: "Open Drop",
    accent: "var(--color-accent-drop)",
  },
  {
    id: "mobile",
    name: "Mobile",
    tagline: "Privacy in your pocket.",
    persona:
      "One app for wallet, trading, and private payments — wherever you are.",
    bullets: [
      "Self-custody EdDSA keys",
      "On-device proof generation",
      "iOS + Android",
    ],
    surface: "mobile",
    audience: "user",
    href: "/mobile",
    cta: "Get the app",
    accent: "var(--color-accent-mobile)",
  },
  {
    id: "relayer",
    name: "Relayer",
    tagline: "Match orders. Earn fees.",
    persona:
      "For node operators running the network — match private orders off-chain, generate ZK proofs, settle on-chain.",
    bullets: [
      "Live leaderboard (volume, uptime, stake)",
      "Stake-based reputation",
      "Fee share per fill",
    ],
    surface: "web",
    audience: "operator",
    href: appUrl("relayer", "https://relayer.zkscatter.xyz"),
    cta: "Open Relayer",
    accent: "var(--color-accent-relayer)",
  },
];

export const APP_BY_ID: Record<AppId, AppEntry> = Object.fromEntries(
  APPS.map((a) => [a.id, a]),
) as Record<AppId, AppEntry>;

export const USER_APPS = APPS.filter((a) => a.audience === "user");
export const OPERATOR_APPS = APPS.filter((a) => a.audience === "operator");
