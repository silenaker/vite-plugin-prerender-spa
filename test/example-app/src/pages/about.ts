import fontUrl from "../assets/sample.woff2";

export default function renderAbout(): string {
  return `<main data-font="${fontUrl}"><h1>About</h1><p>Lazy chunk with a font asset.</p></main>`;
}
