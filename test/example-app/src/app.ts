const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/users/1", label: "User 1" },
] as const;

function renderNav(url: string): string {
  const links = NAV_ITEMS.map(({ href, label }) => {
    return `<a data-href="${href}"${href === url ? ' class="active"' : ""}>${label}</a>`;
  });
  return `<nav>${links.join("")}</nav>`;
}

export async function render(url: string): Promise<string> {
  const nav = renderNav(url);

  if (url === "/about") {
    return `${nav}${(await import("./pages/about")).default()}`;
  }

  const userMatch = url.match(/\/users\/([^/]+$)/);
  if (userMatch) {
    return `${nav}${(await import("./pages/user")).default(userMatch[1])}`;
  }

  return `${nav}${(await import("./pages/home")).default()}`;
}
