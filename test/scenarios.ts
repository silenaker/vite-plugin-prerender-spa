import type { UserConfig } from "vite";

import type { Scenario } from "./pipeline.ts";

/**
 * The scenarios the pipeline builds.
 *
 * A scenario is only an input: plugin options, Vite config, and the app it runs
 * against. What the build must emit lives in `test/expected/<scenario>/`,
 * checked in as HTML.
 */

function routeSlug(route: string): string {
  if (route === "/") return "index";
  return route.replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function router(routes: Record<string, readonly string[]>): string {
  const cases = Object.entries(routes).map(([route, specifiers]) => {
    const loads = specifiers
      .map((specifier) => `      await load(() => import(${JSON.stringify(specifier)}));`)
      .join("\n");
    return `    case ${JSON.stringify(route)}: {\n${loads}\n      return '<div data-route="${routeSlug(route)}"></div>';\n    }`;
  });

  return `async function load<T>(loader: () => Promise<T>): Promise<T | undefined> {
  try {
    return await loader();
  } catch {
    return undefined;
  }
}

export async function render(url: string): Promise<string> {
  switch (url) {
${cases.join("\n")}
    default:
      return '<div data-route="fallback"></div>';
  }
}
`;
}

function externalResolvers(
  rules: Array<{ specifier: string; id: string; external: true | "absolute" | "relative" }>,
): string {
  const cases = rules
    .map((rule) => {
      const external = typeof rule.external === "string" ? JSON.stringify(rule.external) : "true";
      return `    if (source === ${JSON.stringify(rule.specifier)}) {
      return { id: ${JSON.stringify(rule.id)}, external: ${external} };
    }`;
    })
    .join("\n");
  return `{
  name: "test-resolve-external",
  resolveId(source) {
${cases}
  },
}`;
}

const STATIC_APP = `export async function render(url: string): Promise<string> {
  return \`<div data-route="static">\${url}</div>\`;
}
`;

const EXAMPLE_ROUTE_PATHS = ["/", "/about", "/users/1"];

/* -------------------------------------------------------------------------- */
/*                              plugin options                                */
/* -------------------------------------------------------------------------- */

const optionScenarios: Scenario[] = [
  {
    name: "options/defaults",
    options: { routes: EXAMPLE_ROUTE_PATHS },
  },
  {
    name: "options/custom",
    options: { routes: ["/"], renderer: "src/entry-server-alt", containerId: "app" },
    sources: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>custom container</title>
  </head>
  <body>
    <div id="app"></div>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      "src/app.ts": router({ "/": ["./pages/home"] }),
      "src/entry-server-alt.ts": `export { render } from "./app.ts";
`,
    },
  },
  {
    name: "options/missing renderer module",
    options: { routes: ["/"], renderer: "src/does-not-exist" },
    sources: { "src/app.ts": STATIC_APP },
    buildFails: true,
  },
  {
    name: "options/missing render export",
    options: { routes: ["/"], renderer: "src/no-render" },
    sources: { "src/app.ts": STATIC_APP, "src/no-render.ts": `export const nope = 1;\n` },
    buildFails: true,
  },
  {
    name: "options/invalid container id",
    options: { routes: EXAMPLE_ROUTE_PATHS, containerId: "nope" },
    buildFails: true,
  },
];

/* -------------------------------------------------------------------------- */
/*                                   routes                                   */
/* -------------------------------------------------------------------------- */

const routeScenarios: Scenario[] = [
  {
    name: "routes/empty",
    options: { routes: [] },
    sources: { "src/app.ts": STATIC_APP },
  },
  {
    name: "routes/render throws",
    options: { routes: [...EXAMPLE_ROUTE_PATHS, "/boom"] },
    sources: {
      "src/entry-server.ts": `import { render as appRender } from "./app.ts";

export async function render(url: string): Promise<string> {
  if (url === "/boom") throw new Error("boom-message");
  return appRender(url);
}
`,
    },
  },
  {
    name: "routes/async interleaving",
    options: { routes: ["/one", "/two"] },
    sources: {
      "src/app.ts": `const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function load<T>(loader: () => Promise<T>): Promise<T | undefined> {
  try {
    return await loader();
  } catch {
    return undefined;
  }
}

export async function render(url: string): Promise<string> {
  if (url === "/one") {
    await sleep(20);
    await load(() => import("./pages/home"));
    return '<div data-route="one"></div>';
  }
  await sleep(200);
  await load(() => import("./pages/about"));
  return '<div data-route="two"></div>';
}
`,
    },
  },
];

/* -------------------------------------------------------------------------- */
/*                                vite config                                 */
/* -------------------------------------------------------------------------- */

function configScenario(name: string, vite: UserConfig): Scenario {
  return { name, options: { routes: EXAMPLE_ROUTE_PATHS }, vite };
}

const viteConfigScenarios: Scenario[] = [
  configScenario("config/base sub path", { base: "/app" }),
  configScenario("config/base absolute url", { base: "https://cdn.example.com/sub" }),
  configScenario("config/base relative", { base: "./" }),
  configScenario("config/custom manifest paths", {
    build: { manifest: "custom/manifest.json", ssrManifest: "custom/ssr-manifest.json" },
  }),
  configScenario("config/custom out dir", { build: { outDir: "build-output" } }),
];

/* -------------------------------------------------------------------------- */
/*                      dynamic import module specifier                       */
/* -------------------------------------------------------------------------- */

const SERVER_ONLY = `export async function renderBuiltin(): Promise<string> {
  try {
    await import("node:path");
  } catch {
    // unreachable while prerendering
  }
  return '<div data-route="builtin"></div>';
}

export async function renderServerOnly(): Promise<string> {
  try {
    await import("./lib/server-banner.ts");
  } catch {
    // unreachable while prerendering
  }
  return '<div data-route="only-server"></div>';
}
`;

const SHARED_PAGES: Record<string, string> = {
  "src/shared/format.ts": `export function format(value: string): string {
  return value.toUpperCase();
}
`,
  "src/pages/shared-a.ts": `import { format } from "../shared/format.ts";

export default function render(): string {
  return format("shared-a");
}
`,
  "src/pages/shared-b.ts": `import { format } from "../shared/format.ts";

export default function render(): string {
  return format("shared-b");
}
`,
};

const specifierScenarios: Scenario[] = [
  {
    name: "specifier/mixed module specifiers",
    options: {
      routes: [
        "/home",
        "/about",
        "/user",
        "/vars-home",
        "/vars-about",
        "/vars-user",
        "/extern-rel",
        "/extern-rel-parent",
        "/extern-abs",
        "/extern-hook-rel-default",
        "/extern-hook-rel-relative",
        "/extern-hook-rel-absolute",
        "/extern-hook-abs-default",
        "/extern-hook-abs-relative",
        "/extern-hook-abs-absolute",
        "/hook-alias",
        "/https",
        "/http",
        "/mixed",
        "/dep",
        "/absent",
        "/builtin",
        "/server-only",
        "/shared-a",
        "/shared-b",
      ],
    },
    vite: {
      build: {
        rollupOptions: {
          external: [
            "./rel-external.js",
            "../rel-parent-external.js",
            "/abs-external.js",
            "not-installed-pkg",
          ],
          makeAbsoluteExternalsRelative: false,
        },
      },
    },
    plugins: [
      externalResolvers([
        {
          specifier: "./resolved-relative.js",
          id: "./resolved-relative.js",
          external: true,
        },
        {
          specifier: "./resolved-relative-2.js",
          id: "./resolved-relative-2.js",
          external: "relative",
        },
        {
          specifier: "./resolved-relative-3.js",
          id: "./resolved-relative-3.js",
          external: "absolute",
        },
        {
          specifier: "/resolved-absolute.js",
          id: "/resolved-absolute.js",
          external: true,
        },
        {
          specifier: "/resolved-absolute-2.js",
          id: "/resolved-absolute-2.js",
          external: "relative",
        },
        {
          specifier: "/resolved-absolute-3.js",
          id: "/resolved-absolute-3.js",
          external: "absolute",
        },
        {
          specifier: "./source-alias.js",
          id: "/alias-target.js",
          external: true,
        },
      ]),
    ],
    sources: {
      "src/app.ts": router({
        "/home": ["./pages/home"],
        "/about": ["./pages/about"],
        "/user": ["./pages/user"],
        "/extern-rel": ["./rel-external.js"],
        "/extern-rel-parent": ["../rel-parent-external.js"],
        "/extern-abs": ["/abs-external.js"],
        "/extern-hook-rel-default": ["./resolved-relative.js"],
        "/extern-hook-rel-relative": ["./resolved-relative-2.js"],
        "/extern-hook-rel-absolute": ["./resolved-relative-3.js"],
        "/extern-hook-abs-default": ["/resolved-absolute.js"],
        "/extern-hook-abs-relative": ["/resolved-absolute-2.js"],
        "/extern-hook-abs-absolute": ["/resolved-absolute-3.js"],
        "/hook-alias": ["./source-alias.js"],
        "/https": ["https://cdn.example.com/lib.js"],
        "/http": ["http://cdn.example.com/lib.js"],
        "/mixed": ["./pages/home", "https://cdn.example.com/lib.js"],
        "/dep": ["parse5"],
        "/absent": ["not-installed-pkg"],
        "/shared-a": ["./pages/shared-a.ts"],
        "/shared-b": ["./pages/shared-b.ts"],
      }),
      "src/entry-server.ts": `import { render as appRender } from "./app.ts";
import { renderBuiltin, renderServerOnly } from "./server-only.ts";
import { renderVars } from "./vars.ts";

export async function render(url: string): Promise<string> {
  if (url.startsWith("/vars-")) return renderVars(url);
  if (url === "/builtin") return renderBuiltin();
  if (url === "/server-only") return renderServerOnly();
  return appRender(url);
}
`,
      "src/vars.ts": `async function load<T>(loader: () => Promise<T>): Promise<T | undefined> {
  try {
    return await loader();
  } catch {
    return undefined;
  }
}

/** \`/vars-home\` loads \`./pages/home.ts\` through a specifier Vite expands. */
export async function renderVars(url: string): Promise<string> {
  const name = url.replace("/vars-", "");
  await load(() => import(\`./pages/\${name}.ts\`));
  return \`<div data-route="vars-\${name}"></div>\`;
}
`,
      "src/server-only.ts": SERVER_ONLY,
      "src/lib/server-banner.ts": `export const banner = "server only";
`,
      ...SHARED_PAGES,
    },
  },
  {
    name: "specifier/relative externals",
    options: {
      routes: [
        "/extern-rel",
        "/extern-rel-parent",
        "/extern-abs",
        "/extern-hook-rel-default",
        "/extern-hook-abs-default",
      ],
    },
    vite: {
      build: {
        rollupOptions: {
          external: ["./rel-external.js", "../rel-parent-external.js", "/abs-external.js"],
          makeAbsoluteExternalsRelative: true,
        },
      },
    },
    plugins: [
      externalResolvers([
        {
          specifier: "./resolved-relative.js",
          id: "./resolved-relative.js",
          external: true,
        },
        {
          specifier: "/resolved-absolute.js",
          id: "/resolved-absolute.js",
          external: true,
        },
      ]),
    ],
    sources: {
      "src/app.ts": router({
        "/extern-rel": ["./rel-external.js"],
        "/extern-rel-parent": ["../rel-parent-external.js"],
        "/extern-abs": ["/abs-external.js"],
        "/extern-hook-rel-default": ["./resolved-relative.js"],
        "/extern-hook-abs-default": ["/resolved-absolute.js"],
      }),
    },
  },
];

/* -------------------------------------------------------------------------- */
/*                           nested dynamic imports                           */
/* -------------------------------------------------------------------------- */

const nestedScenarios: Scenario[] = [
  {
    name: "nested/deep chain",
    options: { routes: ["/deep"] },
    sources: {
      "src/app.ts": `export async function render(): Promise<string> {
  const { default: renderLevel1 } = await import("./deep/level1.ts");
  return renderLevel1();
}
`,
      "src/deep/level1.ts": `export default async function renderLevel1(): Promise<string> {
  const { default: renderLevel2 } = await import("./level2.ts");
  return \`<div data-level="1">\${await renderLevel2()}</div>\`;
}
`,
      "src/deep/level2.ts": `export default async function renderLevel2(): Promise<string> {
  const { default: renderLevel3 } = await import("./level3.ts");
  return \`<div data-level="2">\${await renderLevel3()}</div>\`;
}
`,
      "src/deep/level3.ts": `import { leaf } from "./leaf.ts";

export default function renderLevel3(): string {
  return \`<div data-level="3">\${leaf()}</div>\`;
}
`,
      "src/deep/leaf.ts": `export function leaf(): string {
  return "leaf";
}
`,
    },
  },
];

export const groups: Array<{ name: string; scenarios: Scenario[] }> = [
  { name: "plugin options", scenarios: optionScenarios },
  { name: "routes", scenarios: routeScenarios },
  { name: "vite config", scenarios: viteConfigScenarios },
  { name: "dynamic import module specifiers", scenarios: specifierScenarios },
  { name: "nested dynamic imports", scenarios: nestedScenarios },
];
