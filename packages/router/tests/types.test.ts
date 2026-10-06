import { Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";
import { defineRoute, RouteError } from "../src/route.ts";
import type { ParamsOf, SearchOf } from "../src/route.ts";

describe("route types", () => {
  test("params come from the path when there is no Schema", () => {
    const Thread = defineRoute("thread", { path: "/threads/:id/:view?" });
    expectTypeOf<ParamsOf<typeof Thread>>().toEqualTypeOf<{ readonly id: string; readonly view?: string }>();
    expectTypeOf<SearchOf<typeof Thread>>().toEqualTypeOf<{}>();
    const Files = defineRoute("files", { path: "/files/*rest" });
    expectTypeOf<ParamsOf<typeof Files>>().toEqualTypeOf<{ readonly rest: string }>();
    const Home = defineRoute("home", { path: "/" });
    expectTypeOf<ParamsOf<typeof Home>>().toEqualTypeOf<{}>();
  });

  test("a Schema's decoded types are the route's", () => {
    const Numbered = defineRoute("numbered", {
      path: "/n/:n",
      params: Schema.Struct({ n: Schema.FiniteFromString }),
      search: Schema.Struct({ page: Schema.optional(Schema.FiniteFromString) }),
    });
    expectTypeOf<ParamsOf<typeof Numbered>>().toEqualTypeOf<{ readonly n: number }>();
    expectTypeOf<SearchOf<typeof Numbered>>().toEqualTypeOf<{ readonly page?: number | undefined }>();
  });

  test("a Schema that disagrees with the path, or does not read strings, is a compile error", () => {
    expect(() =>
      defineRoute("renamed", {
        path: "/u/:id",
        // @ts-expect-error the Schema names a field the path does not
        params: Schema.Struct({ userId: Schema.String }),
      }),
    ).toThrow(RouteError);
    expect(() =>
      defineRoute("missing", {
        path: "/u/:id/:tab",
        // @ts-expect-error the path names a param the Schema does not have
        params: Schema.Struct({ id: Schema.String }),
      }),
    ).toThrow(/does not have/);
    defineRoute("numbers", {
      path: "/n/:n",
      // @ts-expect-error a URL holds strings: Schema.Number cannot decode one
      params: Schema.Struct({ n: Schema.Number }),
    });
    defineRoute("search", {
      path: "/s",
      // @ts-expect-error the same for search
      search: Schema.Struct({ page: Schema.Number }),
    });
  });
});
