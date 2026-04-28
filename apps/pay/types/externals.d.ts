/**
 * Ambient declarations for SDK runtime dependencies that ship without
 * type definitions on npm. The `@zkscatter/sdk` source imports these
 * directly, and Pay's strict `next build` type-check pulls the same
 * tree, so missing declarations break the build even though the
 * runtime works.
 *
 * Each entry is intentionally `any` — the SDK already wraps these
 * libraries behind its own typed surface, so the app has no business
 * touching the raw modules. If a stricter shape is wanted later, lift
 * it into `packages/sdk/types/` so every consumer benefits.
 */

declare module "snarkjs";
declare module "circomlibjs";
