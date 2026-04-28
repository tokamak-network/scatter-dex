import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";
import { DocsPageShell } from "../../components/page-header";

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
 * reorg every page lives under `/docs/*` or `/sdk/*`, so the
 * meaningful tier is the SECOND segment. Falls back to a Title-cased
 * segment so new sections work without code changes. */
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
  const top = mdxPath[0];
  if (top === "docs" || top === "sdk") {
    if (mdxPath.length === 1) return top === "docs" ? "Documentation" : "SDK reference";
    const seg = mdxPath[1]!;
    return SECTION_LABEL[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  return SECTION_LABEL[top] ?? top.charAt(0).toUpperCase() + top.slice(1);
}

export default async function Page(props: PageProps) {
  const params = await props.params;
  // Let importPage's return type flow through — `Wrapper` expects
  // the precise `Heading[]` shape Nextra emits for `toc`, and a
  // local `as { toc: unknown }` cast strips that and breaks the
  // `next build` type check.
  const result = await importPage(params.mdxPath);
  const { default: MDXContent, ...wrapperProps } = result;

  const section = deriveSection(params.mdxPath);
  const { metadata } = result;

  return (
    <Wrapper {...wrapperProps}>
      <DocsPageShell
        section={section ?? undefined}
        description={metadata?.description}
      />
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
