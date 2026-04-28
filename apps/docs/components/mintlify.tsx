/* Mintlify-flavoured component shims used inside `developers/**.mdx`.
 * Polished pass — driven by class names defined in `app/globals.css`
 * so dark-mode tokens and hover states track Nextra's theme. */
import * as React from "react";
import { CheckCircle2, Info, AlertTriangle } from "lucide-react";
import { Icon } from "./icon";

export function CardGroup({
  cols = 2,
  children,
}: {
  cols?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="zs-card-grid"
      style={{
        // Only legitimately-dynamic style on the page — `cols` is
        // author-provided per CardGroup.
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

export function Card({
  title,
  href,
  icon,
  children,
}: {
  title?: React.ReactNode;
  href?: string;
  icon?: string;
  children?: React.ReactNode;
}) {
  const inner = (
    <div className="zs-card">
      {icon && (
        <span className="zs-card-icon" aria-hidden>
          <Icon name={icon} size={18} />
        </span>
      )}
      {title && <div className="zs-card-title">{title}</div>}
      {children && <div className="zs-card-body">{children}</div>}
    </div>
  );
  if (href) {
    return (
      <a className="zs-card-link" href={href}>
        {inner}
      </a>
    );
  }
  return inner;
}

/* `Steps` numbers each direct child by injecting `__index` via
 * `cloneElement`. Context would be cleaner but server components
 * can't `createContext`, and forcing the whole MDX subtree to "use
 * client" just for step numbering is the wrong tradeoff. */
interface StepProps {
  title?: React.ReactNode;
  children?: React.ReactNode;
  __index?: number;
}

export function Steps({ children }: { children: React.ReactNode }) {
  let i = 0;
  return (
    <ol className="zs-steps">
      {React.Children.toArray(children)
        .filter(Boolean)
        .map((child) => {
          if (!React.isValidElement(child)) return child;
          i += 1;
          return React.cloneElement(child as React.ReactElement<StepProps>, {
            __index: i,
          });
        })}
    </ol>
  );
}

export function Step({ title, children, __index }: StepProps) {
  return (
    <li className="zs-step">
      <span className="zs-step-bullet" aria-hidden>
        {__index ?? "•"}
      </span>
      {title && <div className="zs-step-title">{title}</div>}
      <div>{children}</div>
    </li>
  );
}

export function AccordionGroup({ children }: { children: React.ReactNode }) {
  return <div className="zs-accordion-group">{children}</div>;
}

export function Accordion({
  title,
  children,
}: {
  title?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <details className="zs-accordion">
      <summary>{title}</summary>
      <div className="zs-accordion-body">{children}</div>
    </details>
  );
}

const CALLOUT_VARIANTS = {
  info: { cls: "zs-callout", icon: Info },
  success: { cls: "zs-callout zs-callout--success", icon: CheckCircle2 },
  warn: { cls: "zs-callout zs-callout--warn", icon: AlertTriangle },
} as const;

type CalloutVariant = keyof typeof CALLOUT_VARIANTS;

function Callout({
  variant = "info",
  children,
}: {
  variant?: CalloutVariant;
  children: React.ReactNode;
}) {
  const { cls, icon: Icn } = CALLOUT_VARIANTS[variant];
  return (
    <div className={cls}>
      <span className="zs-callout-icon" aria-hidden>
        <Icn size={16} />
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <Callout variant="info">{children}</Callout>;
}

export function Check({ children }: { children: React.ReactNode }) {
  return <Callout variant="success">{children}</Callout>;
}

export function Warning({ children }: { children: React.ReactNode }) {
  return <Callout variant="warn">{children}</Callout>;
}

export function CodeGroup({ children }: { children: React.ReactNode }) {
  return <div className="zs-codegroup">{children}</div>;
}

export function Frame({ children }: { children: React.ReactNode }) {
  return <div className="zs-frame">{children}</div>;
}
