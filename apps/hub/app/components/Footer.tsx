import Link from "next/link";
import { Brand } from "./Brand";
import { CurrentYear } from "./CurrentYear";
import { APP_BY_ID, DOCS_URL } from "../lib/apps";

type FooterLink = { label: string; href: string };

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
            { label: "Pro", href: APP_BY_ID.pro.href },
            { label: "Pay", href: APP_BY_ID.pay.href },
            { label: "Drop", href: APP_BY_ID.drop.href },
            { label: "Mobile", href: "/mobile" },
          ]}
        />
        <FooterCol
          title="Operators"
          links={[
            { label: "Relayers", href: APP_BY_ID.relayer.href },
            { label: "Run a node", href: `${DOCS_URL}/operate/run-a-relayer-node` },
            { label: "Leaderboard", href: `${APP_BY_ID.relayer.href}/leaderboard` },
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
        © <CurrentYear /> zkScatter · Tokamak Network
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
  const isExternal = /^(https?:|mailto:)/.test(link.href);
  const className =
    "text-[var(--color-text-muted)] hover:text-[var(--color-text)]";
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
