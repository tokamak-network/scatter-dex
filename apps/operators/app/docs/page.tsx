import { Suspense } from "react";
import { DocsViewer } from "./DocsViewer";
import { DOCS } from "./docs-data";
import { loadAllDocs } from "./docs-loader";

export const metadata = {
  title: "Docs — Scatter Relayer",
  description:
    "In-app operations guides: setup, deployment, security, fee architecture, and runtime monitoring.",
};

export default function DocsPage() {
  // Build-time read; client component receives plain data.
  const docs = loadAllDocs();
  return (
    <Suspense>
      <DocsViewer docs={docs} index={DOCS} />
    </Suspense>
  );
}
