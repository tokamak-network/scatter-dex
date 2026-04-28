/* zod schemas for `GET /api/info`.
 *
 * Single source of truth for both:
 *   1. Runtime: optional response shape sanity check before sending.
 *   2. Docs: OpenAPI spec generation (`scripts/build-openapi.mjs`).
 *
 * Keep these schemas aligned with `RelayerProfile` in
 * `src/core/profile.ts` and the `RelayerApiInfo` type the SDK expects
 * (`packages/sdk/src/relayer/types.ts`). When fields drift, the spec
 * regenerates and the docs site picks up the change without manual
 * edits — that's the point.
 *
 * Uses zod 4's native `.meta({ id, description, example })` for
 * OpenAPI metadata; zod-openapi v5 picks these up automatically. */
import { z } from "zod";

export const RelayerProfileSchema = z
  .object({
    name: z.string().max(64).optional(),
    description: z.string().max(280).optional(),
    logoUrl: z.string().url().max(256).optional(),
    contact: z.string().max(256).optional(),
    socialX: z.string().max(64).optional(),
    website: z.string().url().max(256).optional(),
    updatedAt: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Unix seconds since the operator last edited the profile." })
      .optional(),
  })
  .meta({
    id: "RelayerProfile",
    description:
      "Operator-set cosmetic metadata. Untrusted by the SDK — every consumer must run it through `sanitizeProfile` before rendering.",
  });

export const RelayerInfoResponseSchema = z
  .object({
    name: z.string().meta({
      example: "ScatterDEX ZK Relayer",
      description: "Human-readable relayer name. Matches what the operator advertises on-chain.",
    }),
    version: z.string().meta({
      example: "0.1.0",
      description:
        "Relayer software version. Use to gate features that require a specific server build.",
    }),
    address: z.string().meta({
      example: "0xabcdef0123456789abcdef0123456789abcdef01",
      description:
        "Operator EOA — must match the address registered in `RelayerRegistry`. Apps cross-check this against the on-chain record before submitting.",
    }),
    fee: z.number().int().nonnegative().meta({
      example: 30,
      description:
        "Per-trade fee in basis points (100 = 1%). Must equal the on-chain `fee` field.",
    }),
    orderCount: z.number().int().nonnegative().meta({
      example: 12,
      description:
        "Number of pending authorize orders the relayer is currently holding.",
    }),
    commitmentPool: z.string().meta({
      description:
        "Address of the `CommitmentPool` contract this relayer matches against.",
    }),
    privateSettlement: z.string().meta({
      description:
        "Address of the `PrivateSettlement` contract this relayer submits to.",
    }),
    profile: RelayerProfileSchema.optional(),
  })
  .meta({
    id: "RelayerApiInfo",
    description:
      "Identity, fee, capabilities, and pending-queue depth. Apps probe this on relayer discovery to filter out offline operators.\n\n" +
      "Note: this schema mirrors what `zk-relayer/src/routes/info.ts` actually returns today. The SDK's `RelayerApiInfo` type uses a single `settlement` field instead of the separate `commitmentPool` + `privateSettlement` fields below — that drift is tracked separately and will be reconciled with an SDK type update.",
  });

export type RelayerInfoResponse = z.infer<typeof RelayerInfoResponseSchema>;
