import Link from "next/link";
import { buttonClassName } from "@zkscatter/ui";
import { Brand } from "./Brand";
import { DOCS_URL } from "../lib/apps";

export function Nav() {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Brand />
        <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
          <Link href="/apps" className="hover:text-[var(--color-text)]">Apps</Link>
          <Link href="/technology" className="hover:text-[var(--color-text)]">Technology</Link>
          <Link href="/research" className="hover:text-[var(--color-text)]">Research</Link>
          <a
            href={`${DOCS_URL}/docs/introduction`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-text)]"
          >
            Developers
          </a>
          <a
            href="https://github.com/tokamak-network/scatter-dex"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-text)]"
          >
            GitHub
          </a>
          <Link href="/apps" className={buttonClassName({ size: "sm" })}>
            Launch app
          </Link>
        </nav>
      </div>
    </header>
  );
}
