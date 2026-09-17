# vite-plugin-prerender-spa

A Vite plugin for pre-rendering single-page applications at build time.

Inspired by [Vite's SSR guide](https://vite.dev/guide/ssr), but make it simple and powerful.

## How it works

After the standard client build completes, the plugin:

1. **Builds an SSR bundle** from your `entry-server` using Vite's `--ssr` mode internally.
2. **Renders each route** by calling your `render(url)` function exported by `entry-server`, collecting the output HTML along with the dynamic imported chunks and assets during rendering.
3. **Generates preload links** for the necessary chunks and assets, eliminating the sequential RTT waterfall of lazy-loaded routes.
4. **Injects the rendered HTML** into the client build's `index.html` and writes each route to a static `.html` file.

## Install

```bash
npm install --save-dev vite-plugin-prerender-spa
```

## Usage

### 1. Create your entry-server

This file must export a `render` function that returns the app HTML for a given route:

```tsx
// src/entry-server.tsx
import { prerenderToNodeStream } from "react-dom/static";
import { StaticRouter } from "react-router-dom";

const Home = lazy(() => import("./pages/home"));
const About = lazy(() => import("./pages/about"));

export async function render(url: string): Promise<string> {
  const { prelude } = await prerenderToNodeStream(
    <StaticRouter location={url}>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </Suspense>
    </StaticRouter>,
  );

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    prelude.on("data", (chunk: Buffer) => chunks.push(chunk));
    prelude.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    prelude.on("error", reject);
  });
}
```

### 2. Configure the plugin

```ts
// vite.config.ts
import prerender from "vite-plugin-prerender-spa";

export default defineConfig({
  plugins: [
    prerender({
      routes: ["/", "/about"],
    }),
  ],
});
```

### 3. Build

```bash
vite build
```

The static HTML files will be output alongside the standard client build.

## Options

| Option        | Type       | Default              | Description                                                   |
| ------------- | ---------- | -------------------- | ------------------------------------------------------------- |
| `routes`      | `string[]` | —                    | Routes to pre-render, e.g. `["/"]`                            |
| `renderer`    | `string`   | `"src/entry-server"` | Path to the SSR entry module that exports a `render` function |
| `containerId` | `string`   | `"root"`             | The `#id` of the app mount container in `index.html`          |

## License

[MIT](LICENSE)
