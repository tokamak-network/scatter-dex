/* Extract the relayer's OpenAPI 3.1 spec from `src/openapi/registry.ts`
 * and write it directly into the docs app's `public/openapi/` so
 * Scalar fetches it at runtime.
 *
 * Lives outside `developers/` because Nextra's content scanner trips on
 * yaml siblings. The docs app is the only consumer, so the spec lives
 * with it.
 *
 * Idempotent: run on every relayer build / pre-commit. CI also runs
 * this and fails if the committed yaml differs from regenerated output
 * — that's our drift detector for code/docs alignment. */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { buildRelayerOpenApi } from "../src/openapi/registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "../../apps/docs/public/openapi/relayer.yaml");

const doc = buildRelayerOpenApi();
const yaml = stringify(doc, { lineWidth: 100, aliasDuplicateObjects: false });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, yaml, "utf8");
console.log(`[build-openapi] wrote ${out} (${yaml.length} bytes)`);
