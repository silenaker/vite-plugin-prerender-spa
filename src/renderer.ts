import { render as ssrRender } from "SSR_RENDERER";
import { createDynImportCollector, withDynImportCollector } from "./dyn-import-collector.ts";

export async function render(url: string): Promise<{ appHtml: string; dynImports: string[] }> {
  const collector = createDynImportCollector();
  const appHtml = await withDynImportCollector(collector, () => ssrRender(url));

  return { appHtml, dynImports: collector.getModules() };
}
