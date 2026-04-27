export function Section({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`mx-auto max-w-6xl px-6 py-20 ${className}`}>
      {children}
    </section>
  );
}
