import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
	root: ".",
	publicDir: "public",
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "GdsViewer",
			fileName: "gds-viewer",
			formats: ["es"],
		},
	},
	server: {
		open: true,
	},
});
