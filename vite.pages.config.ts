import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const repoName = env.GITHUB_REPOSITORY?.split("/")[1] ?? "gds-viewer";

  return {
    root: ".",
    publicDir: "public",
    base: env.GITHUB_ACTIONS ? `/${repoName}/` : "/",
    build: {
      outDir: "dist-pages",
    },
    server: {
      open: true,
    },
  };
});
