import fs from "node:fs/promises";
import path, { extname } from "node:path";
import { fileURLToPath } from "node:url";

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

import type { DynImport } from "./dyn-import-collector.ts";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function createSsrBuildPlugin(options: {
  manifest: Manifest;
  ssrManifest: Record<string, string[]>;
}): Plugin {
  const { manifest, ssrManifest } = options;
  let resolvedConfig: ResolvedConfig;
  let resolveClient!: ReturnType<ResolvedConfig["createResolver"]>;
  let entryUrl: string;

  return {
    name: "prerender:ssr-build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
      resolveClient = config.createResolver();
      entryUrl = toAssetUrl(
        Object.values(manifest).find((chunk) => chunk.isEntry)!.file,
        config.base,
      );
    },
    async transform(code, id) {
      const imports: ImportExpression[] = [];
      const edits: Array<{ start: number; end: number; content: string }> = [];

      const importer = path.isAbsolute(id)
        ? normalizePath(path.relative(resolvedConfig.root, id))
        : id;
      let importerUrl = ssrManifest[importer]?.find((url) => url.split("?")[0]!.endsWith(".js"));
      if (!importerUrl && ssrManifest[importer]) {
        importerUrl = entryUrl;
      }

      walkESTree(this.parse(code) as ESTreeNode, (node) => {
        if (node.type === "ImportExpression") {
          imports.push(node);
        }
      });

      const getCodeRange = (node: ESTreeNode) => {
        const hasStart = "start" in node && typeof node.start === "number";
        const hasEnd = "end" in node && typeof node.end === "number";
        return (
          node.range ?? (hasStart && hasEnd ? [node.start as number, node.end as number] : null)
        );
      };

      for (const node of imports) {
        const importRange = getCodeRange(node);
        if (!importRange) continue;
        const source = node.source;

        let moduleId: string;
        let external = false;

        if (isESTreeStringLiteral(source)) {
          const resolved = await this.resolve(source.value, id, { kind: "dynamic-import" });
          if (!resolved) continue;
          const rootDir = resolvedConfig.root;

          // For external import resolution with default behavior,
          // `makeAbsoluteExternalsRelative` has different effects for relative and
          // absolute source imports:
          // - Relative: `true` resolves to an absolute ID and rewrites it to a path
          //   relative to the entry module in the output; `false` resolves to the source
          //   relative import as the module ID and preserves it verbatim in the output.
          //   When unset, it behaves like `true`.
          // - Absolute: both cases resolve to the source absolute import as the module
          //   ID; `true` rewrites it as in the relative source import case, while
          //   with `external` is `'absolute'` preserves it as an absolute path.
          //   When unset, it behaves like `false`.
          // We only handle verbatim copied case currently
          if (
            (resolved.external === true && resolved.id.match(/^(\.\.?\/|https?:\/\/)/)) ||
            (resolved.external === "absolute" && resolved.id.match(/^\//))
          ) {
            moduleId = resolved.id;
            external = true;
          } else if (
            resolved.external === true &&
            !source.value.match(/^(node:|[./]|[a-zA-Z][a-zA-Z\d+.-]*:)/)
          ) {
            const clientResolved = await resolveClient(source.value, id, false, false);
            if (!clientResolved) continue;
            moduleId = path.isAbsolute(clientResolved)
              ? normalizePath(path.relative(rootDir, clientResolved))
              : clientResolved;
          } else if (resolved.external === false) {
            moduleId = path.isAbsolute(resolved.id)
              ? normalizePath(path.relative(rootDir, resolved.id))
              : resolved.id;
          } else {
            continue;
          }
        } else {
          const sourceRange = getCodeRange(source);
          if (!sourceRange) continue;
          moduleId = code.slice(sourceRange[0], sourceRange[1]);
          external = true;
        }

        const originalImport = code.slice(importRange[0], importRange[1]);
        const options = JSON.stringify(
          external
            ? {
                moduleId,
                external,
                importerUrl,
              }
            : moduleId,
        );

        edits.push({
          start: importRange[0],
          end: importRange[1],
          content: `__dynImport(() => ${originalImport}, ${options})`,
        });
      }

      if (edits.length === 0) {
        return null;
      }

      const dynImport = `import { __dynImport } from "${path.join(__dirname, "dyn-import-collector")}";`;
      let transformed = code;
      for (const edit of edits.toReversed()) {
        transformed = transformed.slice(0, edit.start) + edit.content + transformed.slice(edit.end);
      }
      return `${dynImport}\n${transformed}`;
    },
  };
}

const SENTINEL_ORIGIN = "http://_";

function toAssetUrl(file: string, base: string): string {
  const baseUrl = new URL(base, SENTINEL_ORIGIN);
  const assetUrl = new URL(path.posix.join(baseUrl.pathname, file), baseUrl);

  if (baseUrl.origin !== SENTINEL_ORIGIN) {
    return assetUrl.href;
  }
  if (base.startsWith("/")) {
    return assetUrl.href.slice(SENTINEL_ORIGIN.length);
  }
  return `.${assetUrl.pathname}`;
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

function renderPreloadLinks(modules: DynImport[], manifest: Manifest, base: string): string[] {
  const chunks = Object.values(manifest);
  const depGraph: Map<ManifestChunk, ManifestChunk[]> = new Map();
  const loadedChunks: ManifestChunk[] = [];
  const externals: string[] = [];
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

  for (const item of modules) {
    if (item.external) {
      externals.push(item.moduleId);
      continue;
    }
    const chunk = manifest[item.moduleId];
    if (chunk) {
      loadedChunks.push(chunk);
    }
  }

  const entryChunkDeps = getDepChunks([entryChunk], depGraph);
  const preloadChunks = getDepChunks(loadedChunks, depGraph);

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

  assets.js.push(...externals);

  const links: string[] = [];
  for (const type of ASSET_ORDER) {
    for (const file of assets[type]) {
      const link = renderPreloadLink(file, type);
      if (link !== "") {
        links.push(link);
      }
    }
  }

  return links;
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
  dynImports: DynImport[];
}

interface SsrRenderer {
  render: (url: string) => RenderResult | Promise<RenderResult>;
}

function isElement(node: P5Node): node is P5Element {
  return "attrs" in node;
}

function findElement(root: P5Node, test: (el: P5Element) => boolean): P5Element | null {
  const stack: P5Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && test(node)) return node;
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        stack.push(node.childNodes[i]!);
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

interface HeadInjection {
  /** The whitespace between the last head child and `</head>` */
  range: { start: number; end: number };
  /** Indentation of the head's children */
  childIndent: string;
  /** Indentation of the `</head>` line */
  endIndent: string;
}

interface PageTemplate {
  html: string;
  htmlPath: string;
  containerRange: { start: number; end: number };
  head: HeadInjection | null;
}

function lineIndent(html: string, offset: number): string {
  const lineStart = html.lastIndexOf("\n", offset - 1) + 1;
  return html.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
}

function whitespaceBefore(html: string, offset: number): { start: number; end: number } {
  let start = offset;
  while (start > 0 && /[ \t\r\n]/.test(html[start - 1]!)) {
    start -= 1;
  }
  return { start, end: offset };
}

function findHeadInjection(doc: P5Node, html: string): HeadInjection | null {
  const head = findElement(doc, (el) => el.tagName === "head");
  const endTag = head?.sourceCodeLocation?.endTag;
  if (!head || !endTag) return null;

  const children = head.childNodes.filter(isElement);
  const lastChild = children[children.length - 1];
  const endIndent = lineIndent(html, endTag.startOffset);
  const childIndent = lastChild?.sourceCodeLocation
    ? lineIndent(html, lastChild.sourceCodeLocation.startOffset)
    : endIndent
      ? `${endIndent}  `
      : "";

  return { range: whitespaceBefore(html, endTag.startOffset), childIndent, endIndent };
}

function createPageTemplate(html: string, htmlPath: string, containerId: string): PageTemplate {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });

  const container = findElement(doc, (el) =>
    el.attrs.some((a) => a.name === "id" && a.value === containerId),
  );
  if (!container) {
    throw new Error(`Cannot find the prerender container "#${containerId}" in ${htmlPath}`);
  }

  const containerRange = getInnerRange(container);
  if (!containerRange) {
    throw new Error(
      `Cannot locate the content of the prerender container "#${containerId}" in ${htmlPath}`,
    );
  }

  return { html, htmlPath, containerRange, head: findHeadInjection(doc, html) };
}

function genHtml(template: PageTemplate, appHtml: string, preloadLinks: string[]): string {
  const s = new MagicString(template.html);

  const { start, end } = template.containerRange;
  if (start === end) {
    s.prependRight(start, appHtml);
  } else {
    s.overwrite(start, end, appHtml);
  }

  if (preloadLinks.length > 0) {
    const head = template.head;
    if (!head) {
      throw new Error(`Cannot inject preload links: ${template.htmlPath} has no </head>`);
    }
    const lf = head.childIndent ? "\n" : "";
    const links = preloadLinks.map((link) => `${head.childIndent}${link}`).join(lf);
    const block = `${lf}${links}${head.endIndent ? "\n" : ""}${head.endIndent}`;
    if (head.range.start === head.range.end) {
      s.appendRight(head.range.start, block);
    } else {
      s.overwrite(head.range.start, head.range.end, block);
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
  manifest: Manifest,
  ssrManifest: Record<string, string[]>,
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
    createSsrBuildPlugin({ manifest, ssrManifest }),
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
          ssrManifest:
            typeof config.build?.ssrManifest === "string" ? config.build.ssrManifest : true,
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
      const outDir = path.resolve(rootDir, resolvedConfig.build.outDir);

      const manifestPath = path.join(
        outDir,
        typeof resolvedConfig.build.manifest === "string"
          ? resolvedConfig.build.manifest
          : ".vite/manifest.json",
      );
      const manifest: Manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const ssrManifestPath = path.join(
        outDir,
        typeof resolvedConfig.build.ssrManifest === "string"
          ? resolvedConfig.build.ssrManifest
          : ".vite/ssr-manifest.json",
      );
      const ssrManifest: Record<string, string[]> = JSON.parse(
        await fs.readFile(ssrManifestPath, "utf8"),
      );

      await createSsrBundle(
        userConfig,
        resolvedConfig,
        plugin,
        path.join(__dirname, "renderer"),
        options.renderer ?? "src/entry-server",
        manifest,
        ssrManifest,
      );

      const htmlPath = path.join(outDir, "index.html");
      const builtHtml = await fs.readFile(htmlPath, "utf8");
      const template = createPageTemplate(builtHtml, htmlPath, options.containerId ?? "root");
      const renderer: SsrRenderer = await import(`${path.join(outDir, ".prerender/renderer.js")}`);

      await Promise.all(
        options.routes.map(async (route) => {
          let appHtml: string;
          let dynImports: DynImport[];
          try {
            ({ appHtml, dynImports } = await renderer.render(route));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.warn(`Failed to render route "${route}": ${message}`);
            return;
          }
          const preloadLinks = renderPreloadLinks(dynImports, manifest, resolvedConfig.base);
          const html = genHtml(template, appHtml, preloadLinks);
          const filePath = path.join(outDir, route === "/" ? "index.html" : `${route}.html`);

          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, html);
        }),
      );
    },
  };

  return plugin;
}
