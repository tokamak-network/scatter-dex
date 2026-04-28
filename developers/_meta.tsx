/* Two top-level tabs in the navbar: Document and SDK Reference.
 * `type: "page"` is the Nextra v4 way to surface a folder as a
 * navbar entry — clicking it switches the sidebar to that folder's
 * tree, so the Document sidebar never shows SDK content and vice
 * versa. */
const meta = {
  docs: {
    type: "page",
    title: "Document",
    // Land on the first page in the tab — without `href` Nextra
    // tries to render `/docs` itself, which has no index file.
    href: "/docs/introduction",
  },
  sdk: {
    type: "page",
    title: "SDK Reference",
    href: "/sdk/overview",
  },
};

export default meta;
