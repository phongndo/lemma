import { describe, expect, it } from "vitest";
import { safeReturn, signInPage } from "../src/page.ts";
import { browserPlace } from "../src/web.tsx";

describe("the page a sign-in's browser lands on", () => {
  it("says how it went, escaping what a callback's URL can put on it, with a way back only to http(s) or Lemma", () => {
    const html = signInPage({ title: "<b>x</b>", lines: ['a "quoted" line'], badge: { ok: false, text: "Not signed in" }, returnTo: "javascript:alert(1)" });
    expect(html).toContain("<title>&lt;b&gt;x&lt;/b&gt; · Lemma</title>");
    expect(html).toContain("<p>a &quot;quoted&quot; line</p>");
    expect(html).toContain('<body class="failed">');
    expect(html).not.toContain("Return to Lemma");
    expect(signInPage({ title: "Signed in", lines: [], returnTo: "lemma://settings/providers" })).toContain(
      '<a class="back" href="lemma://settings/providers">',
    );
    expect(safeReturn("https://lemma.test/settings/providers")).toBe("https://lemma.test/settings/providers");
    expect(safeReturn("not a url")).toBeUndefined();
  });

  it("has no badge when it is about no sign-in in particular", () => {
    expect(signInPage({ title: "Not found", lines: ["This address only takes a sign-in coming back to Lemma."] })).not.toContain('class="badge"');
  });
});

describe("where this page's browser is", () => {
  it("is here only when the page came from the host's own machine", () => {
    expect(browserPlace("localhost")).toBe("here");
    expect(browserPlace("127.0.0.1")).toBe("here");
    expect(browserPlace("[::1]")).toBe("here");
    expect(browserPlace("devbox.local")).toBe("elsewhere");
  });
});
