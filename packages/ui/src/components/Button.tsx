"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, the button renders full-width (e.g. modal action
   *  rows where the button takes the entire footer). */
  block?: boolean;
  children: ReactNode;
}

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40",
  secondary:
    "border border-[var(--color-border-strong)] bg-white hover:bg-[var(--color-primary-soft)] disabled:opacity-40",
  danger:
    "bg-[var(--color-danger)] text-white hover:opacity-90 disabled:opacity-40",
  ghost:
    "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40",
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

/** Primitive button with the four variants used across the apps:
 *  primary call-to-action, secondary outline, destructive (cancel /
 *  delete), and a ghost row-action. Keeps the modal action footers
 *  and inline list actions visually consistent. */
export function Button({
  variant = "primary",
  size = "md",
  block,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    "font-medium transition-colors",
    VARIANT_CLS[variant],
    SIZE_CLS[size],
    RADIUS_CLS[size],
    block ? "w-full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type ?? "button"} className={cls} {...rest}>
      {children}
    </button>
  );
}
