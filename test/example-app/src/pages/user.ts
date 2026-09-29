import imageUrl from "../assets/hero.png";

export default function renderUser(slug: string): string {
  return `<main data-image="${imageUrl}"><h1>User ${slug}</h1></main>`;
}
