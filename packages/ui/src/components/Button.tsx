"use client";

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost"
  | "inverse"
  | "inverse-outline";
export type ButtonSize = "sm" | "md" | "lg";

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, the button renders full-width (e.g. modal action
   *  rows where the button takes the entire footer). */
  block?: boolean;
  children: ReactNode;
};

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> & {
    href?: undefined;
    type?: "button" | "submit" | "reset";
  };

type ButtonAsAnchor = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "href"> & {
    /** When set, the component renders an `<a>` instead of a `<button>`.
     *  Useful for navigation CTAs that want button styling but need a
     *  real anchor (right-click, middle-click, copy URL, etc.). */
    href: string;
  };

type ButtonProps = ButtonAsButton | ButtonAsAnchor;

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40",
  secondary:
    "border border-[var(--color-border-strong)] bg-white hover:bg-[var(--color-primary-soft)] disabled:opacity-40",
  danger:
    "bg-[var(--color-danger)] text-white hover:opacity-90 disabled:opacity-40",
  ghost:
    "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40",
  // `inverse` = primary on a dark surface (e.g. inside a coloured CTA
  // box). `inverse-outline` = secondary on the same surface.
  inverse:
    "bg-white text-[var(--color-primary)] hover:bg-white/90 disabled:opacity-40",
  "inverse-outline":
    "border border-white/30 text-white hover:bg-white/10 disabled:opacity-40",
};

const SIZE_CLS: Record<ButtonSize, string> = {
  sm: "px-3 py-1 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-4 py-3 text-base",
};

const RADIUS_CLS: Record<ButtonSize, string> = {
  sm: "rounded-md",
  md: "rounded-md",
  lg: "rounded-lg",
};

/** Primitive button with the variants used across the apps:
 *  primary call-to-action, secondary outline, destructive (cancel /
 *  delete), a ghost row-action, and the inverse pair for dark
 *  surfaces (e.g. footer CTA boxes). Renders an `<a>` when `href` is
 *  passed so navigation CTAs keep button styling without losing
 *  anchor semantics. */
export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    block,
    className,
    children,
    ...rest
  } = props;

  const cls = [
    "inline-flex items-center justify-center gap-1.5 font-medium transition-colors",
    VARIANT_CLS[variant],
    SIZE_CLS[size],
    RADIUS_CLS[size],
    block ? "w-full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if ("href" in props && props.href !== undefined) {
    const { href, ...anchorRest } =
      rest as AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
    return (
      <a href={href} className={cls} {...anchorRest}>
        {children}
      </a>
    );
  }

  const { type, ...buttonRest } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button type={type ?? "button"} className={cls} {...buttonRest}>
      {children}
    </button>
  );
}
