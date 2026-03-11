import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["./src/index.ts"],
	platform: "browser",
	dts: true,
	tsconfig: "./tsconfig.build.json"
	// This change the package.json formatting, un-comment when needed.
	// exports: {
	// 	devExports: true
	// }
})
