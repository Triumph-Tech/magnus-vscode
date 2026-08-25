import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Vitest scopes only to our pure-module unit tests under
        // `src/__tests__/`. The legacy `src/test/` tree is the upstream
        // mocha + @vscode/test-electron harness — it imports `vscode`,
        // which only resolves inside the VS Code extension host. Run
        // those tests with `npm run test:integration`, not vitest.
        include: ["src/__tests__/**/*.test.ts"]
    }
});
