import path from "node:path/posix";

export interface DynImportCollector {
  add(moduleId: string): void;
  getModules(): string[];
}

export function createDynImportCollector(): DynImportCollector {
  const modules: string[] = [];

  return {
    add(moduleId: string) {
      if (!modules.includes(moduleId)) {
        modules.push(moduleId);
      }
    },
    getModules() {
      return [...modules];
    },
  };
}

let currentCollector: DynImportCollector | undefined;

export async function withDynImportCollector<T>(
  collector: DynImportCollector,
  render: () => T | Promise<T>,
): Promise<T> {
  const previousCollector = currentCollector;
  currentCollector = collector;

  try {
    return await render();
  } finally {
    currentCollector = previousCollector;
  }
}

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
        const url = new URL(importerUrl, "http://_");
        const dirPath = path.dirname(path.normalize(url.pathname));
        const moduleUrl = new URL(path.join(dirPath, moduleId), url.origin);

        moduleId = importerUrl.startsWith("/")
          ? moduleUrl.href.replace(/^http:\/\/_/, "")
          : moduleUrl.href;
      }
    }
    currentCollector?.add(moduleId);
  };

  collect();
  return loader();
}
