// Only the platform-agnostic core ships through the root entrypoint.
// `./zk` (Web Worker types) and `./react` (React hook) live behind
// their own subpaths so a Node consumer that omits `lib.dom` from
// tsconfig doesn't import DOM-only types just by reaching for
// `chainName` or an ABI.
export * from "./core";
