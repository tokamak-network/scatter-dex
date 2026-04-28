/* Restore `_meta.tsx` for the auto-generated API directory.
 *
 * `typedoc` clears its output dir before each run, so any hand-written
 * navigation file at `developers/api/_meta.tsx` would disappear. We
 * regenerate it deterministically after every `npm run api` so the
 * SDK reference sidebar stays ordered the way humans read the modules
 * (core → contracts → zk → relayer → orderbook → notes → react). */
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(__dirname, "../../../developers/sdk/api");

if (!existsSync(apiDir)) {
  console.error(`[write-api-meta] missing ${apiDir} — run \`npm run api\` first`);
  process.exit(1);
}

const meta = `/* Auto-written by scripts/write-api-meta.mjs after \`npm run api\`.
 * Edit the script, not this file — typedoc's clean step removes
 * untracked entries on each rebuild. */
const meta = {
  index: "Overview",
  core: "core",
  contracts: "contracts",
  zk: "zk",
  relayer: "relayer",
  orderbook: "orderbook",
  notes: "notes",
  react: "react",
};

export default meta;
`;

writeFileSync(resolve(apiDir, "_meta.tsx"), meta, "utf8");
console.log("[write-api-meta] wrote", resolve(apiDir, "_meta.tsx"));
