import type { Metadata } from "next";
import { faqs, categoryColors } from "./faq-data";

export const metadata: Metadata = {
  title: "FAQ | zkScatter",
  description: "Learn how zkScatter works — zero-knowledge proofs, privacy, compliance, and more.",
};

// Group by category
const grouped = faqs.reduce<Record<string, typeof faqs>>((acc, faq) => {
  (acc[faq.category] ??= []).push(faq);
  return acc;
}, {});

export default function FaqPage() {
  return (
    <section className="pt-28 pb-32 px-6 max-w-[960px] mx-auto">
      {/* Header */}
      <div className="mb-16 text-center">
        <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-4">FAQ</p>
        <h1 className="font-headline font-extrabold text-4xl md:text-5xl mb-6">
          Understanding zkScatter
        </h1>
        <p className="text-on-surface-variant text-lg max-w-2xl mx-auto">
          Everything you need to know about zero-knowledge privacy, compliance, and how zkScatter works.
        </p>
      </div>

      {/* Category groups */}
      <div className="space-y-12">
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <div className="flex items-center gap-3 mb-5">
              <span className={categoryColors[category] ?? "text-on-surface-variant"}>
                {items[0].icon}
              </span>
              <h2 className="font-headline font-bold text-xl text-on-surface">{category}</h2>
            </div>
            <div className="space-y-3">
              {items.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-xl border border-outline-variant/10 bg-surface-container overflow-hidden transition-colors hover:border-outline-variant/25"
                >
                  <summary className="flex items-center justify-between cursor-pointer px-8 py-5 text-on-surface font-headline font-semibold text-lg select-none list-none [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <span
                      className="ml-4 shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-surface-bright text-on-surface-variant text-sm transition-transform group-open:rotate-45"
                      aria-hidden="true"
                    >
                      +
                    </span>
                  </summary>
                  <div className="px-8 pb-6 text-on-surface-variant leading-relaxed">
                    {faq.a}
                  </div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
