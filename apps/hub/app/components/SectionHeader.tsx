export function EyebrowLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
      {children}
    </div>
  );
}

export function SectionHeading({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={`text-3xl font-semibold tracking-tight md:text-4xl ${className}`}>
      {children}
    </h2>
  );
}
