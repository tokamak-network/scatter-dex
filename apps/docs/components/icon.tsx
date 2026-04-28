/* Map Mintlify-style icon names (font-awesome flavour) onto Lucide
 * components. Unknown names render a neutral square placeholder so a
 * typo doesn't crash the page. */
import {
  BookOpen,
  Box,
  Code,
  Database,
  Download,
  FileCode,
  Gift,
  Grid3x3,
  Hammer,
  House,
  LayoutGrid,
  LineChart,
  ListOrdered,
  Network,
  Send,
  Server,
  Shield,
  ShieldCheck,
  ShieldHalf,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  "chart-line": LineChart,
  "paper-plane": Send,
  gift: Gift,
  server: Server,
  "file-contract": FileCode,
  "shield-halved": ShieldHalf,
  "network-wired": Network,
  "list-ol": ListOrdered,
  database: Database,
  react: Code,
  cube: Box,
  "shield-check": ShieldCheck,
  bolt: Zap,
  book: BookOpen,
  code: Code,
  "diagram-project": Workflow,
  download: Download,
  grid: LayoutGrid,
  "grid-2": Grid3x3,
  wrench: Wrench,
  hammer: Hammer,
  house: House,
  shield: Shield,
};

export function Icon({
  name,
  size = 16,
}: {
  name: string | undefined;
  size?: number;
}) {
  if (!name) return null;
  const Cmp = MAP[name];
  if (!Cmp) {
    return (
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: size,
          height: size,
          borderRadius: 4,
          background: "currentColor",
          opacity: 0.18,
        }}
      />
    );
  }
  return <Cmp size={size} strokeWidth={2} />;
}
