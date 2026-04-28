/* OpenAPI document registry.
 *
 * Builds the spec by combining hand-written path metadata (summary,
 * tags, error codes) with the zod schemas under `./schemas/*`. Keep
 * one entry per route here — the build script (scripts/build-openapi.mjs)
 * turns this into `apps/docs/public/openapi/relayer.yaml` so the docs
 * site can render it without a separate build step. */
import { createDocument } from "zod-openapi";
import { RelayerInfoResponseSchema } from "./schemas/info.js";

export function buildRelayerOpenApi(): ReturnType<typeof createDocument> {
  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "zkScatter Relayer API",
      version: "0.1.0",
      description:
        "HTTP API exposed by every zkScatter relayer node. Apps use this to discover a relayer's identity and fee, submit signed orders, fetch order status, and cancel.\n\n" +
          "All relayers implement the same surface — switch the base URL to switch operators.",
      contact: { name: "Tokamak Network", url: "https://github.com/tokamak-network/scatter-dex" },
    },
    servers: [
      {
        url: "https://relayer.example.com",
        description: "Production relayer (replace with a registered operator's URL — see `RelayerRegistry`).",
      },
    ],
    paths: {
      "/api/info": {
        get: {
          tags: ["Discovery"],
          summary: "Relayer identity, fee, and pending-queue depth",
          description:
            "Returns the operator's identity, on-chain fee (in basis points), and the number of pending authorize orders. Apps use this to filter the on-chain registry list down to operators that are actually online and matching.",
          operationId: "getInfo",
          responses: {
            "200": {
              description: "Relayer info",
              content: {
                "application/json": { schema: RelayerInfoResponseSchema },
              },
            },
          },
        },
      },
    },
    tags: [
      {
        name: "Discovery",
        description: "Operator metadata. Read-only; safe to call without auth.",
      },
    ],
  });
}
