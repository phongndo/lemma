import { describe, expect, it } from "vitest";
import { errorView } from "../src/model/error.ts";

describe("errorView", () => {
  it("shows an embedded JSON body by the description it holds", () => {
    const message =
      'OAuth refresh failed for openai: OpenAI OAuth token request failed (400): { "error": "invalid_grant", "error_description": "A fresh sign-in is required." }. Run /login openai to sign in again.';
    expect(errorView(message)).toEqual({
      summary: "OAuth refresh failed for openai: OpenAI OAuth token request failed (400)",
      description: "A fresh sign-in is required.",
      hint: "Run /login openai to sign in again.",
    });
  });

  it("leaves a message without JSON whole", () => {
    expect(errorView("The model request failed.")).toEqual({ summary: "The model request failed." });
    expect(errorView("rate limited [429] {not json}")).toEqual({ summary: "rate limited [429] {not json}" });
  });

  it("finds a nested description, and reads braces inside strings as text", () => {
    expect(errorView('529: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded }"}}')).toEqual({
      summary: "529",
      description: "Overloaded }",
    });
  });

  it("drops a body with no description from view", () => {
    expect(errorView('failed (500): {"code": 13}')).toEqual({ summary: "failed (500)" });
  });
});
