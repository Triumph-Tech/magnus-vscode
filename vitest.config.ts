import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Vitest scopes to the pure-module unit tests: local mode's under
        // `src/__tests__/` and the SQL tools' under `src/sql/__tests__/`.
        // The legacy `src/test/` tree is the upstream mocha +
        // @vscode/test-electron harness. It imports `vscode`, which only
        // resolves inside the VS Code extension host, so run those tests
        // with `npm run test:integration`, not vitest.
        include: ["src/**/__tests__/**/*.test.ts"]
    }
});
