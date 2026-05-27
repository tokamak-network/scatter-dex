import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
