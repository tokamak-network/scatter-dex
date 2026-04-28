import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";
import {
  CopyPageButton,
  SectionBadge,
} from "../../components/page-header";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  return metadata;
}

interface PageProps {
  params: Promise<{ mdxPath: string[] }>;
}

const Wrapper = getMDXComponents().wrapper;

/* Map a URL segment-tuple to a section badge label. After the IA
 * reorg every page lives under either `/docs/*` or `/sdk/*`, so the
 * meaningful tier is the SECOND segment (or the first if there's
 * just one). Falls back to a Title-cased segment so new sections
 * work without code changes. */
const SECTION_LABEL: Record<string, string> = {
  // Document tab
  introduction: "Get started",
  installation: "Get started",
  quickstart: "Get started",
  faq: "Get started",
  concepts: "Architecture",
  guides: "Build",
  protocol: "Protocol reference",
  operate: "Operate",
  // SDK tab
  sdk: "SDK reference",
  api: "SDK reference (auto)",
  rest: "REST API",
};

function deriveSection(mdxPath: string[] | undefined): string | null {
  if (!mdxPath || mdxPath.length === 0) return null;
  // Skip the top-tab segment (`docs` / `sdk`) and read the next
  // tier — that's the actual content category.
  const top = mdxPath[0];
  if (top === "docs" || top === "sdk") {
    if (mdxPath.length === 1) return top === "docs" ? "Documentation" : "SDK reference";
    const seg = mdxPath[1]!;
    if (seg in SECTION_LABEL) return SECTION_LABEL[seg]!;
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  // Pre-reorg URL — fall back to the first segment.
  if (top in SECTION_LABEL) return SECTION_LABEL[top]!;
  return top.charAt(0).toUpperCase() + top.slice(1);
}

export default async function Page(props: PageProps) {
  const params = await props.params;
  const result = await importPage(params.mdxPath);
  const {
    default: MDXContent,
    toc,
    metadata,
  } = result as {
    default: React.ComponentType<unknown>;
    toc: unknown;
    metadata: { title?: string; description?: string };
  };

  const section = deriveSection(params.mdxPath);

  return (
    <Wrapper toc={toc} metadata={metadata}>
      <div className="zs-page-header">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginBottom: "0.4rem",
          }}
        >
          {section ? <SectionBadge>{section}</SectionBadge> : <span />}
          <CopyPageButton />
        </div>
        {metadata?.description && (
          <p
            style={{
              fontSize: "1.05rem",
              opacity: 0.7,
              margin: "0.25rem 0 0",
              lineHeight: 1.5,
            }}
          >
            {metadata.description}
          </p>
        )}
      </div>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
