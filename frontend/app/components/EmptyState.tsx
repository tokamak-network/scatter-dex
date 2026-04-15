import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Optional action area (button, link) rendered below the description. */
  action?: ReactNode;
}

/**
 * Full-panel empty / unavailable state shared by pages that need to
 * short-circuit the normal render (missing wallet, missing config,
 * etc.). Keeps the icon + title + body stack visually consistent.
 */
export default function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
      <Icon className="w-12 h-12 mb-4 opacity-40" aria-hidden="true" />
      <p className="text-lg font-medium mb-2">{title}</p>
      {description && (
        <div className="text-sm text-center max-w-md">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
