import fs from "node:fs/promises";
import path, { extname } from "node:path";

import MagicString from "magic-string";
import * as parse5 from "parse5";
import { build, mergeConfig } from "vite";

import type { Node as ESTreeNode, ImportExpression, SimpleLiteral } from "estree";
import type { DefaultTreeAdapterMap } from "parse5";
import type {
  InlineConfig,
  Manifest,
  ManifestChunk,
  Plugin,
  ResolvedConfig,
  UserConfig,
} from "vite";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

function normalizePath(p: string): string {
  return path.normalize(p).replaceAll("\\", "/");
}

function isESTreeNode(node: unknown): node is ESTreeNode {
  return typeof node === "object" && node !== null && typeof (node as any).type === "string";
}

function isESTreeStringLiteral(node: unknown): node is SimpleLiteral & { value: string } {
  return isESTreeNode(node) && node.type === "Literal" && typeof node.value === "string";
}

function walkESTree(node: ESTreeNode, visit: (node: ESTreeNode) => void) {
  if (isESTreeNode(node)) {
    visit(node);
    for (const children of Object.values(node)) {
      if (Array.isArray(children)) {
        for (const child of children) {
          walkESTree(child, visit);
        }
      } else {
        walkESTree(children, visit);
      }
    }
  }
}

function createSsrBuildPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig;

  return {
    name: "prerender:ssr-build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
    },
    async transform(code, id) {
      const imports: ImportExpression[] = [];
      const edits: Array<{ start: number; end: number; content: string }> = [];

      walkESTree(this.parse(code) as ESTreeNode, (node) => {
        if (node.type === "ImportExpression") {
          imports.push(node);
        }
      });

      for (const node of imports) {
        const hasStart = "start" in node && typeof node.start === "number";
        const hasEnd = "end" in node && typeof node.end === "number";
        const range =
          node.range ?? (hasStart && hasEnd ? [node.start as number, node.end as number] : null);

        if (!range) continue;
        const source = node.source;
        if (isESTreeStringLiteral(source)) {
          const resolved = await this.resolve(source.value, id, {
            kind: "dynamic-import",
          });
          const rootDir = resolvedConfig.root;
          const moduleId = normalizePath(
            resolved?.id ? path.relative(rootDir, resolved.id) : source.value,
          );
          const originalImport = code.slice(range[0], range[1]);
          edits.push({
            start: range[0],
            end: range[1],
            content: `__dynImport(${JSON.stringify(moduleId)}, () => ${originalImport})`,
          });
        }
      }

      if (edits.length === 0) {
        return null;
      }

      const dynImport = `import { __dynImport } from "${path.join(import.meta.dirname, "dyn-import-collector")}";`;
      let transformed = code;
      for (const edit of edits.toReversed()) {
        transformed = transformed.slice(0, edit.start) + edit.content + transformed.slice(edit.end);
      }
      return `${dynImport}\n${transformed}`;
    },
  };
}

function toAssetUrl(file: string, base: string): string {
  return normalizePath(path.join(base, file));
}

type AssetType = "js" | "css" | "font" | "image" | "other";

const ASSET_ORDER: AssetType[] = ["css", "font", "js", "image", "other"];

function getAssetType(file: string): AssetType {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case ".js":
      return "js";
    case ".css":
      return "css";
    case ".woff":
    case ".woff2":
    case ".ttf":
    case ".otf":
      return "font";
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
      return "image";
    default:
      return "other";
  }
}

function getDepChunks(
  inputs: ManifestChunk[],
  depGraph: Map<ManifestChunk, ManifestChunk[]>,
): ManifestChunk[] {
  const visited = new Set<ManifestChunk>();
  const visiting = new Set<ManifestChunk>();
  const result: ManifestChunk[] = [];

  const dfs = (node: ManifestChunk) => {
    if (visited.has(node) || visiting.has(node)) return;
    visiting.add(node);
    const depNodes = depGraph.get(node);
    if (depNodes) {
      for (const dep of depNodes) {
        dfs(dep);
      }
    }
    visiting.delete(node);
    visited.add(node);
    result.push(node);
  };

  for (const node of inputs) {
    dfs(node);
  }

  return result;
}

function renderPreloadLinks(modules: string[], manifest: Manifest, base: string): string {
  const chunks = Object.values(manifest);
  const depGraph: Map<ManifestChunk, ManifestChunk[]> = new Map();
  let entryChunk!: ManifestChunk;

  for (const chunk of chunks) {
    if (chunk.isEntry) {
      entryChunk = chunk;
    }
    if (chunk.imports) {
      depGraph.set(
        chunk,
        chunk.imports.map((key) => manifest[key]!),
      );
    }
  }

  const entryChunkDeps = getDepChunks([entryChunk], depGraph);
  const preloadChunks = getDepChunks(
    modules.map((id) => {
      if (id.startsWith("./")) {
        id = id.slice(2);
      } else if (id.startsWith(base)) {
        id = normalizePath(path.relative(base, id));
      }
      if (manifest[id]) return manifest[id]!;
      return chunks.find((chunk) => chunk.file === id)!;
    }),
    depGraph,
  );

  const assets = Object.fromEntries(
    ASSET_ORDER.map((item) => [item, []] as [AssetType, string[]]),
  ) as Record<AssetType, string[]>;

  for (const chunk of preloadChunks) {
    if (entryChunkDeps.includes(chunk)) continue;

    assets[getAssetType(chunk.file)].push(toAssetUrl(chunk.file, base));
    if (chunk.css) {
      for (const cssFile of chunk.css) {
        assets[getAssetType(cssFile)].push(toAssetUrl(cssFile, base));
      }
    }
    if (chunk.assets) {
      for (const assetFile of chunk.assets) {
        assets[getAssetType(assetFile)].push(toAssetUrl(assetFile, base));
      }
    }
  }

  const links: string[] = [];
  for (const type of ASSET_ORDER) {
    for (const file of assets[type]) {
      links.push(renderPreloadLink(file, type));
    }
  }

  return links.join("\n    ");
}

function renderPreloadLink(file: string, type: AssetType): string {
  const extname = path.extname(file).slice(1);
  const alias: Record<string, string> = {
    jpg: "jpeg",
    svg: "svg+xml",
  };
  switch (type) {
    case "js":
      return `<link rel="modulepreload" crossorigin href="${file}">`;
    case "css":
      return `<link rel="stylesheet" crossorigin href="${file}">`;
    case "font":
      return `<link rel="preload" crossorigin as="font" type="font/${alias[extname] ?? extname}" href="${file}">`;
    case "image":
    // We need some mechanism to know whether the asset should preload
    // such as the logo or the most eye-catching images, etc.
    // return `<link rel="preload" crossorigin as="image" type="image/${alias[extname] ?? extname}" href="${file}">`;
    default:
      return "";
  }
}

interface RenderResult {
  appHtml: string;
  dynImports: string[];
}

interface SsrRenderer {
  render: (url: string) => RenderResult | Promise<RenderResult>;
}

function isElement(node: P5Node): node is P5Element {
  return "attrs" in node;
}

function findElement(root: P5Node, test: (el: P5Element) => boolean): P5Element | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        if (isElement(child) && test(child)) return child;
        if ("childNodes" in child) stack.push(child);
      }
    }
  }
  return null;
}

function getInnerRange(element: P5Element): { start: number; end: number } | null {
  const loc = element.sourceCodeLocation;
  if (!loc?.startTag || !loc?.endTag) return null;
  return {
    start: loc.startTag.endOffset,
    end: loc.endTag.startOffset,
  };
}

function genHtml(
  builtHtml: string,
  appHtml: string,
  preloadLinks: string,
  containerId: string,
): string {
  const doc = parse5.parse(builtHtml, { sourceCodeLocationInfo: true });
  const s = new MagicString(builtHtml);

  const container = findElement(doc, (el) =>
    el.attrs.some((a) => a.name === "id" && a.value === containerId),
  );
  if (container) {
    const range = getInnerRange(container);
    if (range) {
      if (range.start === range.end) {
        s.prependRight(range.start, appHtml);
      } else {
        s.overwrite(range.start, range.end, appHtml);
      }
    }
  }

  if (preloadLinks) {
    const head = findElement(doc, (el) => el.tagName === "head");
    const endTag = head?.sourceCodeLocation?.endTag;
    if (endTag) {
      s.appendLeft(endTag.startOffset, `  ${preloadLinks}\n`);
    }
  }

  return s.toString();
}

async function createSsrBundle(
  userConfig: UserConfig,
  resolvedConfig: ResolvedConfig,
  currentPlugin: Plugin,
  entry: string,
  ssrRenderer: string,
): Promise<void> {
  const config: InlineConfig = mergeConfig(userConfig, {
    configFile: false,
    logLevel: "error",
    resolve: {
      alias: {
        SSR_RENDERER: path.resolve(resolvedConfig.root, ssrRenderer),
      },
    },
    build: {
      ssr: entry,
      outDir: path.join(resolvedConfig.build.outDir, ".prerender"),
    },
  } satisfies InlineConfig);

  config.plugins = [
    ...(userConfig.plugins?.filter((plugin) => plugin !== currentPlugin) ?? []),
    createSsrBuildPlugin(),
  ];

  await build(config);
}

export interface PrerenderOptions {
  /**
   * Routes to pre-render, e.g. `["/"]`.
   */
  routes: string[];
  /**
   * Path to the ssr entry module that exports a `render` function.
   * Default: `"src/entry-server"`.
   */
  renderer?: string;
  /**
   * The `#id` of the app mount container in `index.html`.
   * Default: `"root"`.
   */
  containerId?: string;
}

export default function prerender(options: PrerenderOptions): Plugin {
  let userConfig: UserConfig;
  let resolvedConfig: ResolvedConfig;

  const plugin: Plugin = {
    name: "prerender",
    apply: "build",
    config(config) {
      userConfig = config;
      return {
        build: {
          manifest: typeof config.build?.manifest === "string" ? config.build.manifest : true,
        },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    async closeBundle() {
      if (options.routes.length === 0) {
        return;
      }

      const rootDir = resolvedConfig.root;
      await createSsrBundle(
        userConfig,
        resolvedConfig,
        plugin,
        path.join(import.meta.dirname, "renderer"),
        options.renderer ?? "src/entry-server",
      );

      const outDir = path.resolve(rootDir, resolvedConfig.build.outDir);
      const builtHtml = await fs.readFile(path.join(outDir, "index.html"), "utf8");
      const manifestPath = path.join(
        outDir,
        typeof resolvedConfig.build.manifest === "string"
          ? resolvedConfig.build.manifest
          : ".vite/manifest.json",
      );
      const manifest: Manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const containerId = options.containerId ?? "root";
      const renderer: SsrRenderer = await import(`${path.join(outDir, ".prerender/renderer.js")}`);

      await Promise.all(
        options.routes.map(async (route) => {
          const { appHtml, dynImports } = await renderer.render(route);
          const preloadLinks = renderPreloadLinks(dynImports, manifest, resolvedConfig.base);
          const html = genHtml(builtHtml, appHtml, preloadLinks, containerId);
          const filePath = path.join(outDir, route === "/" ? "index.html" : `${route}.html`);

          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, html);
        }),
      );
    },
  };

  return plugin;
}
