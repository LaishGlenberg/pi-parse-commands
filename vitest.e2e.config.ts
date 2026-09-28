import { defineConfig } from "vitest/config";

// Dedicated config for the opt-in end-to-end install test. It is excluded from
// the default `vitest.config.ts` so `npm test` and CI stay offline and
// side-effect free. Run it with `npm run test:e2e`.
export default defineConfig({
	test: {
		include: ["test/e2e.test.ts"],
		environment: "node",
		testTimeout: 300_000,
	},
});
