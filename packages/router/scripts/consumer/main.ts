import assert from "node:assert/strict";
import { Schema } from "effect";
import { createMemoryHistory, createRouter, defineRoute, isRoute, RouteError } from "@lemma/router";
import type { AnyRoute, Match } from "@lemma/router";

// A separate application using the packed router: typed routes, entries coming and going, blockers, and inspection.
interface Page {
  readonly route: AnyRoute;
  readonly name: string;
}

const Home = defineRoute("home", { path: "/" });
const User = defineRoute("user", {
  path: "/users/:id/:tab?",
  search: Schema.Struct({ page: Schema.optional(Schema.FiniteFromString) }),
});
const Files = defineRoute("files", { path: "/files/*rest" });

const history = createMemoryHistory("/users/ada?page=2");
const router = createRouter<Page>({ history, known: [User] });
const seen: Match<Page>[] = [];
router.subscribe((match) => seen.push(match));

// Known but nothing registered: the address says so rather than matching nothing.
assert.equal(router.match().status, "unavailable");
router.setEntries([
  { route: Home, name: "home" },
  { route: User, name: "user" },
  { route: Files, name: "files" },
]);
const match = router.match();
assert.ok(isRoute(match, User) && match.status === "matched");
assert.equal(match.params.id, "ada");
assert.equal(match.search.page, 2);

// Typed navigation, and links built the same way.
assert.equal(router.href(User, { id: "grace", tab: "posts" }, { page: 3 }), "/users/grace/posts?page=3");
assert.equal(router.navigate(Files, { rest: "a/b/c" }), true);
assert.equal(router.matchOf(Files)?.params.rest, "a/b/c");

// A blocker refuses a navigation; removing it lets the next one through.
const unblock = router.block((transition) => transition.href !== "/", { label: "consumer: unsaved" });
assert.equal(router.navigate("/"), false);
unblock();
assert.equal(router.navigate("/"), true);
router.back();
assert.equal(router.location().pathname, "/files/a/b/c");

// A provider leaving makes its page unavailable at the same address; it returns with it.
router.setEntries([{ route: Home, name: "home" }]);
assert.equal(router.match().status, "unmatched");
router.setKnown([Files]);
assert.equal(router.match().status, "unavailable");

// Values that do not encode are reported, never thrown, by navigate; href throws a RouteError naming the route.
const errors: unknown[] = [];
const strict = createRouter<Page>({ history: createMemoryHistory("/"), onError: (error) => errors.push(error) });
const Numbered = defineRoute("numbered", { path: "/n/:id", params: Schema.Struct({ id: Schema.FiniteFromString }) });
assert.equal(strict.navigate(Numbered, { id: Number.NaN }), false);
assert.ok(errors[0] instanceof RouteError);
assert.throws(() => strict.href(Numbered, { id: Number.NaN }), RouteError);

// Inspection is plain data.
const explained = router.explain("/files/x");
assert.equal(explained.status, "unavailable");
assert.ok(JSON.stringify(router.inspect()).includes("files"));
assert.ok(router.journal().length > 0);
assert.ok(seen.length >= 4);

router.destroy();
strict.destroy();
console.log("Packed router: typed routes, entries, blockers, history, and inspection passed.");
