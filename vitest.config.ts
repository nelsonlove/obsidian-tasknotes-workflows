import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		// Prefer TypeScript sources: `npm run build` writes main.js beside
		// main.ts, and tests that import "../main" must load the source, not
		// the bundle (which requires the real "obsidian" module).
		extensions: [".mts", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"],
		alias: {
			obsidian: resolve(import.meta.dirname, "tests/__mocks__/obsidian.ts"),
		},
	},
});
