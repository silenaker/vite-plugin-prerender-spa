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

export function __dynImport<T>(moduleId: string, loader: () => Promise<T>): Promise<T> {
  currentCollector?.add(moduleId);
  return loader();
}
