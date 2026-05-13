import Link from "next/link";
import { Brand } from "./Brand";
import { CurrentYear } from "./CurrentYear";
import { APP_BY_ID, DOCS_URL } from "../lib/apps";

type FooterLink = { label: string; href: string; comingSoon?: boolean };

export function Footer() {
  return (
    <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 md:grid-cols-5">
        <div className="md:col-span-1">
          <Brand />
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">
            Private trades. Compliant identity. One ZK stack.
          </p>
        </div>
        <FooterCol
          title="Apps"
          links={[
            { label: "Pro", href: APP_BY_ID.pro.href, comingSoon: APP_BY_ID.pro.comingSoon },
            { label: "Pay", href: APP_BY_ID.pay.href, comingSoon: APP_BY_ID.pay.comingSoon },
            { label: "Drop", href: APP_BY_ID.drop.href, comingSoon: APP_BY_ID.drop.comingSoon },
            { label: "Mobile", href: "/mobile" },
          ]}
        />
        <FooterCol
          title="Operators"
          links={[
            { label: "Relayers", href: APP_BY_ID.relayer.href, comingSoon: APP_BY_ID.relayer.comingSoon },
            { label: "Run a node", href: `${DOCS_URL}/operate/run-a-relayer-node` },
            // Relayer leaderboard is gated on the relayer app being
            // live — when relayer is `comingSoon` the deep link
            // would 404, so dim it the same way.
            { label: "Leaderboard", href: `${APP_BY_ID.relayer.href}/leaderboard`, comingSoon: APP_BY_ID.relayer.comingSoon },
          ]}
        />
        <FooterCol
          title="Developers"
          links={[
            { label: "Quickstart", href: `${DOCS_URL}/quickstart` },
            { label: "SDK", href: `${DOCS_URL}/sdk/overview` },
            { label: "Contracts", href: `${DOCS_URL}/contracts/overview` },
            { label: "Circuits", href: `${DOCS_URL}/circuits/overview` },
          ]}
        />
        <FooterCol
          title="Company"
          links={[
            { label: "Research", href: "/research" },
            { label: "GitHub", href: "https://github.com/tokamak-network/scatter-dex" },
          ]}
        />
      </div>
      <div className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
        <div>© <CurrentYear /> zkScatter · Tokamak Network</div>
        <div className="mt-1">
          Not a mixer or anonymity tool. Use is prohibited for money laundering, terrorist financing, sanctions evasion, Travel Rule evasion, or any other illegal activity.
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
        {title}
      </div>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((l) => (
          <li key={l.label}>
            <FooterLinkItem link={l} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FooterLinkItem({ link }: { link: FooterLink }) {
  const className =
    "text-[var(--color-text-muted)] hover:text-[var(--color-text)]";
  if (link.comingSoon) {
    // Dim + non-interactive so a hosting:disabled target doesn't
    // present as a working link. AppCard uses the same affordance
    // for cards; matching the footer treatment keeps the signal
    // consistent across surfaces.
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--color-text-subtle)]">
        <span>{link.label}</span>
        <span className="text-[10px] uppercase tracking-wider">soon</span>
      </span>
    );
  }
  const isExternal = /^(https?:|mailto:)/.test(link.href);
  if (isExternal) {
    const isMailto = link.href.startsWith("mailto:");
    return (
      <a
        href={link.href}
        target={isMailto ? undefined : "_blank"}
        rel={isMailto ? undefined : "noopener noreferrer"}
        className={className}
      >
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}
