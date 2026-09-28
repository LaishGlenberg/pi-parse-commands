import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The e2e test installs a real npm package, calls a real model, and
		// mutates the user's agent dir. Run it explicitly with `npm run test:e2e`.
		exclude: ["**/node_modules/**", "**/.git/**", "test/e2e.test.ts"],
		environment: "node",
		testTimeout: 30000,
	},
});
