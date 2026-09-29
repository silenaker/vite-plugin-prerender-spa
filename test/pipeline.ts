import fs from "node:fs/promises";
import path from "node:path";

import { build } from "vite";

import type { UserConfig } from "vite";
import type { PrerenderOptions } from "../src/index.ts";

/**
 * The plugin is a function `(app sources, plugin options, vite config) ->
 * emitted HTML`, so every test is: materialize a workspace, build it, and
 * compare the HTML it emitted - file for file, byte for byte - against the HTML
 * checked in under `test/expected/<scenario>/`.
 */

/* -------------------------------------------------------------------------- */
/*                                  scenario                                  */
/* -------------------------------------------------------------------------- */

export interface Scenario {
  name: string;
  /** Plugin options under test. */
  options: PrerenderOptions;
  /** Vite config for the workspace. It has to be expressible as JSON. */
  vite?: UserConfig;
  /** Extra `plugins` entries, as source text. */
  plugins?: string[];
  /** Overlay written into the app copy, relative to the app root. */
  sources?: Record<string, string | null>;
  /** `true` when `vite build` itself must fail, so no HTML is compared. */
  buildFails?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                  workspace                                 */
/* -------------------------------------------------------------------------- */

const EXAMPLE_APP_DIR = path.join(import.meta.dirname, "./example-app");
const WORKSPACES_DIR = path.join(import.meta.dirname, "./.tmp");
const EXPECTED_DIR = path.join(import.meta.dirname, "./expected");
const PLUGIN_ENTRY = path.join(import.meta.dirname, "../src/index.ts");

const COPIED_EXCLUDE = /[\\/](node_modules|dist)([\\/]|$)/;

function slug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function workspaceFor(scenario: Scenario): string {
  return path.join(WORKSPACES_DIR, slug(scenario.name));
}

export function expectedDirFor(scenario: Scenario): string {
  return path.join(EXPECTED_DIR, slug(scenario.name));
}

export async function cleanupWorkspaces(): Promise<void> {
  await fs.rm(WORKSPACES_DIR, { recursive: true, force: true });
}

function configSource(scenario: Scenario, appDir: string): string {
  const config: Record<string, unknown> = {
    ...scenario.vite,
    build: { minify: false, ...scenario.vite?.build },
  };
  if (config["plugins"] !== undefined) {
    throw new Error(
      "scenario.vite.plugins is shadowed by the generated plugins array; use scenario.plugins (source text)",
    );
  }
  assertExpressible(config, "scenario.vite");
  assertExpressible(scenario.options, "scenario.options");

  const settings = Object.entries(config)
    .map(([key, value]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `  ${name}: ${reindent(JSON.stringify(value, null, 2))},`;
    })
    .join("\n");

  const plugins = [
    ...(scenario.plugins ?? []),
    `prerender(${JSON.stringify(scenario.options, null, 2)})`,
  ]
    .map((source) => reindent(source, "    "))
    .join(",\n    ");
  const relative = path.relative(appDir, PLUGIN_ENTRY).replaceAll("\\", "/");
  const pluginPath = relative.startsWith(".") ? relative : `./${relative}`;

  return `import { defineConfig } from "vite";
import prerender from ${JSON.stringify(pluginPath)};

export default defineConfig({
${settings.length > 0 ? `${settings}\n` : ""}  plugins: [
    ${plugins},
  ],
});
`;
}

function reindent(source: string, indent = "  "): string {
  return source.replaceAll("\n", `\n${indent}`);
}

function assertExpressible(value: unknown, where: string): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertExpressible(item, `${where}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null && value.constructor === Object) {
    for (const [key, item] of Object.entries(value)) assertExpressible(item, `${where}.${key}`);
    return;
  }
  throw new Error(
    `${where} contains ${describeValue(value)}, which cannot be written to the generated vite.config.ts`,
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const constructor = (value as object).constructor;
  return constructor === undefined ? typeof value : `a ${constructor.name}`;
}

async function createWorkspace(scenario: Scenario): Promise<string> {
  const appDir = workspaceFor(scenario);

  await fs.rm(appDir, { recursive: true, force: true });
  await fs.cp(EXAMPLE_APP_DIR, appDir, {
    recursive: true,
    filter: (src) => !COPIED_EXCLUDE.test(src),
  });

  for (const [rel, content] of Object.entries(scenario.sources ?? {})) {
    const abs = path.join(appDir, rel);
    if (content === null) {
      await fs.rm(abs, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  await fs.writeFile(path.join(appDir, "vite.config.ts"), configSource(scenario, appDir));

  return appDir;
}

/* -------------------------------------------------------------------------- */
/*                                   build                                    */
/* -------------------------------------------------------------------------- */

export interface BuildResult {
  failed: boolean;
  error: string;
}

async function runBuild(appDir: string): Promise<BuildResult> {
  try {
    await build({ root: appDir, logLevel: "silent" });
    return { failed: false, error: "" };
  } catch (err) {
    return { failed: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ObservedPage {
  file: string;
  content: string;
}

export interface Observed {
  appDir: string;
  build: BuildResult;
  pages: ObservedPage[];
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(dir, rel)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

export async function observe(scenario: Scenario): Promise<Observed> {
  const appDir = await createWorkspace(scenario);
  const build = await runBuild(appDir);
  if (build.failed) return { appDir, build, pages: [] };

  const outDir = scenario.vite?.build?.outDir ?? "dist";
  const distDir = path.isAbsolute(outDir) ? outDir : path.join(appDir, outDir);
  const files = await listFiles(distDir).catch(() => []);
  const pages = await Promise.all(
    files
      .filter((file) => file.endsWith(".html"))
      .map(async (file) => ({
        file,
        content: await fs.readFile(path.join(distDir, file), "utf8"),
      })),
  );

  return { appDir, build, pages };
}

/* -------------------------------------------------------------------------- */
/*                                 expectation                                */
/* -------------------------------------------------------------------------- */

export interface Expected {
  buildFails: boolean;
  pages: Map<string, string>;
}

export async function readExpected(scenario: Scenario): Promise<Expected> {
  const dir = expectedDirFor(scenario);
  const files = await listFiles(dir).catch(() => []);
  const pages = new Map<string, string>();
  for (const file of files) {
    pages.set(file, await fs.readFile(path.join(dir, file), "utf8"));
  }
  return { buildFails: scenario.buildFails ?? false, pages };
}

export async function writeExpected(scenario: Scenario, observed: Observed): Promise<string[]> {
  const buildFails = scenario.buildFails ?? false;
  if (observed.build.failed !== buildFails) {
    throw new Error(
      `refusing to write expectations for "${scenario.name}": the build ` +
        `${observed.build.failed ? `failed (${firstLine(observed.build.error)})` : "succeeded"}, ` +
        `but the scenario declares buildFails: ${buildFails}`,
    );
  }

  const dir = expectedDirFor(scenario);
  await fs.rm(dir, { recursive: true, force: true });

  const written: string[] = [];
  for (const page of observed.pages) {
    const file = path.join(dir, page.file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, page.content);
    written.push(page.file);
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/*                                   check                                    */
/* -------------------------------------------------------------------------- */

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function firstDifference(expected: string, actual: string): string {
  const want = expected.split("\n");
  const got = actual.split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] === got[i]) continue;
    return [
      `  line ${i + 1}`,
      `  expected ${JSON.stringify(want[i] ?? null)}`,
      `  actual   ${JSON.stringify(got[i] ?? null)}`,
    ].join("\n");
  }
  return "  the files differ, but no line does";
}

export function check(observed: Observed, expected: Expected): string[] {
  const violations: string[] = [];

  if (observed.build.failed !== expected.buildFails) {
    violations.push(
      expected.buildFails
        ? "build should have failed, but it succeeded"
        : `build should have succeeded, but it failed: ${firstLine(observed.build.error)}`,
    );
    return violations;
  }
  if (observed.build.failed) return violations;

  const emitted = new Map(observed.pages.map((page) => [page.file, page.content]));
  const unexpected = [...emitted.keys()].filter((file) => !expected.pages.has(file));
  const missing = [...expected.pages.keys()].filter((file) => !emitted.has(file));
  if (unexpected.length > 0 || missing.length > 0) {
    violations.push(
      `html file set — emitted ${emitted.size} [${[...emitted.keys()].join(", ")}], ` +
        `expected ${expected.pages.size} [${[...expected.pages.keys()].join(", ")}]`,
    );
  }
  for (const file of unexpected) violations.push(`emitted ${file}, which is not expected`);
  for (const file of missing) violations.push(`missing ${file}`);
  for (const [file, content] of emitted) {
    const want = expected.pages.get(file);
    if (want === undefined || want === content) continue;
    violations.push(`${file} differs from the expected HTML\n${firstDifference(want, content)}`);
  }

  return violations;
}
