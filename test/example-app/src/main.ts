import "./style.css";
import { render } from "./app";

const rerender = async () => {
  document.querySelector("#root")!.innerHTML = await render(location.pathname);
};

if (!document.querySelector("#root")!.innerHTML) {
  rerender();
}

const pushState = history.pushState;
const replaceState = history.replaceState;

history.pushState = function (state, unused, url) {
  pushState.call(this, state, unused, url);
  rerender();
};
history.replaceState = function (state, unused, url) {
  replaceState.call(this, state, unused, url);
  rerender();
};
window.addEventListener("popstate", () => {
  rerender();
});

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement)?.closest("a");
  if (!a || a.dataset.href === undefined) return;
  e.preventDefault();
  history.pushState(null, "", a.dataset.href);
});
