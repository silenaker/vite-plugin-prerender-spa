import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path/posix";

export interface DynImport {
  moduleId: string;
  external: boolean;
}

export interface DynImportCollector {
  add(dynImport: DynImport): void;
  getImports(): DynImport[];
}

export function createDynImportCollector(): DynImportCollector {
  const imports = new Map<string, DynImport>();

  return {
    add(dynImport) {
      if (!imports.has(dynImport.moduleId)) {
        imports.set(dynImport.moduleId, dynImport);
      }
    },
    getImports() {
      return [...imports.values()];
    },
  };
}

const collectorStorage = new AsyncLocalStorage<DynImportCollector>();

export async function withDynImportCollector<T>(
  collector: DynImportCollector,
  render: () => T | Promise<T>,
): Promise<T> {
  return collectorStorage.run(collector, () => render());
}

const SENTINEL_ORIGIN = "http://_";

export function __dynImport<T>(
  loader: () => Promise<T>,
  options:
    | string
    | {
        moduleId: string;
        external?: boolean;
        importerUrl?: string;
      },
): Promise<T> {
  let moduleId: string;
  let external: boolean | undefined;
  let importerUrl: string | undefined;

  if (typeof options === "string") {
    moduleId = options;
  } else {
    ({ moduleId, external, importerUrl } = options);
  }

  const collect = () => {
    if (external) {
      if (!moduleId.match(/^(\/|\.\.?\/|https?:\/\/)/)) return;
      if (moduleId.match(/^\.\.?\//)) {
        if (!importerUrl) return;
        const url = new URL(importerUrl, SENTINEL_ORIGIN);
        const dirPath = path.dirname(path.normalize(url.pathname));
        const moduleUrl = new URL(path.join(dirPath, moduleId), url.origin);

        moduleId = importerUrl.startsWith("./")
          ? `.${moduleUrl.pathname}`
          : moduleUrl.href.replace(SENTINEL_ORIGIN, "");
      }
    }
    collectorStorage.getStore()?.add({ moduleId, external: !!external });
  };

  collect();
  return loader();
}
