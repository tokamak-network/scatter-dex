/* Nextra v4 expects every MDX page to read its component map from
 * `useMDXComponents()` exported here. We compose the docs theme's
 * defaults with our Mintlify-flavoured shims so existing mdx files
 * (`<Card>`, `<Steps>`, `<Accordion>`, …) render unchanged. */
import { useMDXComponents as getDocsMDXComponents } from "nextra-theme-docs";
import {
  Accordion,
  AccordionGroup,
  Card,
  CardGroup,
  Check,
  CodeGroup,
  Frame,
  Note,
  Step,
  Steps,
  Warning,
} from "./components/mintlify";
import { CopyPageButton, SectionBadge } from "./components/page-header";

const docsComponents = getDocsMDXComponents();

export function useMDXComponents(components?: Record<string, unknown>) {
  return {
    ...docsComponents,
    Accordion,
    AccordionGroup,
    Card,
    CardGroup,
    Check,
    CodeGroup,
    Frame,
    Note,
    Step,
    Steps,
    Warning,
    SectionBadge,
    CopyPageButton,
    ...components,
  };
}
