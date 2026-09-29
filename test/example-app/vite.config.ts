import { defineConfig } from "vite";
import prerender from "../../src/index.ts";

export default defineConfig({
  build: {
    minify: false,
  },
  plugins: [
    prerender({
      routes: ["/", "/about", "/users/1"],
    }),
  ],
});
