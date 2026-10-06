import { createBrowserHistory, createRouter, defineRoute, interceptLinks } from "@lemma/router";
import type { AnyRoute } from "@lemma/router";

// The packed router in a real page: the browser's history, links navigating in place, back and forward landing later.
interface Page {
  readonly route: AnyRoute;
  readonly name: string;
}
const Home = defineRoute("home", { path: "/" });
const User = defineRoute("user", { path: "/users/:id" });
const root = document.querySelector("main")!;
const status = document.querySelector("output")!;
const ensure = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const until = (condition: () => boolean, what: string) =>
  new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (condition()) return resolve();
      if (performance.now() - started > 2000) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(poll, 5);
    };
    poll();
  });

async function verify() {
  const history = createBrowserHistory();
  const router = createRouter<Page>({ history });
  router.setEntries([
    { route: Home, name: "home" },
    { route: User, name: "user" },
  ]);
  const shown = () => {
    const match = router.match();
    return match.status === "matched" ? match.entry.name : match.status;
  };
  const intents: string[] = [];
  const stop = interceptLinks(router, { onIntent: (href) => intents.push(href) });
  ensure(shown() === "home", "the first address matches");

  const link = document.createElement("a");
  link.href = router.href(User, { id: "ada" });
  link.textContent = "Ada";
  root.append(link);
  link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  ensure(intents[0] === "/users/ada", "focusing a link reports the intent to follow it");
  link.click();
  ensure(location.pathname === "/users/ada" && shown() === "user", "a plain click navigates in place");
  ensure(router.matchOf(User)?.params.id === "ada", "the match carries typed params");

  // A download is left to the browser: the router does not prevent it.
  const download = document.createElement("a");
  download.href = "/users/grace";
  download.download = "grace.txt";
  root.append(download);
  let prevented: boolean | undefined;
  const watch = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", watch);
  download.click();
  document.removeEventListener("click", watch);
  ensure(prevented === false && location.pathname === "/users/ada", "a download is not intercepted");

  // Back lands later, on popstate; a blocker refusing it is undone.
  const unblock = router.block((transition) => transition.action !== "pop", { label: "browser check" });
  router.back();
  await until(() => router.inspect().moving === false && location.pathname === "/users/ada", "the refused back to be undone");
  unblock();
  router.back();
  await until(() => location.pathname === "/" && shown() === "home", "back to land");

  stop();
  router.destroy();
  history.destroy();
  return { journal: router.journal().length };
}

try {
  const result = await verify();
  status.textContent = JSON.stringify(result);
  document.body.dataset.status = "passed";
} catch (error) {
  status.textContent = String(error);
  document.body.dataset.status = "failed";
  console.error(error);
}
