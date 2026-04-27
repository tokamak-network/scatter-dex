import Link from "next/link";
import { TokamakMark } from "@zkscatter/ui";

export function Nav() {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-[var(--color-primary)]"
        >
          <TokamakMark height={22} />
          <span className="text-[var(--color-text)]">zkScatter</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
          <Link href="/apps" className="hover:text-[var(--color-text)]">Apps</Link>
          <Link href="/#technology" className="hover:text-[var(--color-text)]">Technology</Link>
          <a
            href="https://docs.zkscatter.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-text)]"
          >
            Developers
          </a>
          <Link href="/#research" className="hover:text-[var(--color-text)]">Research</Link>
          <a
            href="https://github.com/tokamak-network"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--color-text)]"
          >
            GitHub
          </a>
          <Link
            href="/apps"
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Launch app
          </Link>
        </nav>
      </div>
    </header>
  );
}
