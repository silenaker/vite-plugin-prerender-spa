declare module "SSR_RENDERER" {
  export function render(url: string): string | Promise<string>;
}
