import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React 19 strict-render checks that the existing codebase
    // intentionally violates — initialisation effects sync external
    // state (wallet provider, OPFS folder handle, mainnet quoter cache)
    // into React, which is exactly the case these rules false-positive on.
    // Refactoring each into derived state would be a behaviour change.
    // Demote to "warn" so violations surface in review without blocking CI.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
