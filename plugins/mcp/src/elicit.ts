import { Effect } from "effect";
import { looksSecret } from "@lemma/contracts";
import type { Context } from "effect";
import type { Interaction, NoticePayload } from "@lemma/contracts";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";

type InteractionService = Context.Tag.Service<typeof Interaction>;

/** A field of a form the server asks to have filled (MCP's primitive schemas), read loosely: servers vary. */
interface Field {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly enumNames?: readonly string[];
  readonly oneOf?: readonly { readonly const: string; readonly title?: string }[];
  readonly items?: { readonly enum?: readonly string[]; readonly anyOf?: readonly { readonly const: string; readonly title?: string }[] };
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly format?: string;
  readonly default?: unknown;
}

type Value = string | number | boolean | string[];

/** Tries a field gets before the form is given up as cancelled. */
const ATTEMPTS = 3;

const choicesOf = (field: Field): { value: string; label: string }[] | undefined => {
  if (field.oneOf !== undefined) return field.oneOf.map((option) => ({ value: option.const, label: option.title ?? option.const }));
  if (field.enum !== undefined) return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  return undefined;
};

/** Why `text` is not a valid answer for `field`, or the value it is. */
function parse(field: Field, text: string): { readonly value: Value } | { readonly error: string } {
  if (field.type === "number" || field.type === "integer") {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(value)) return { error: "a number" };
    if (field.type === "integer" && !Number.isInteger(value)) return { error: "a whole number" };
    if (field.minimum !== undefined && value < field.minimum) return { error: `at least ${field.minimum}` };
    if (field.maximum !== undefined && value > field.maximum) return { error: `at most ${field.maximum}` };
    return { value };
  }
  if (field.type === "array") {
    const allowed = field.items?.enum ?? field.items?.anyOf?.map((option) => option.const);
    const values = text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const wrong = allowed === undefined ? [] : values.filter((value) => !allowed.includes(value));
    return wrong.length > 0 ? { error: `one or more of ${allowed!.join(", ")}` } : { value: values };
  }
  if (field.minLength !== undefined && text.length < field.minLength) return { error: `at least ${field.minLength} characters` };
  if (field.maxLength !== undefined && text.length > field.maxLength) return { error: `at most ${field.maxLength} characters` };
  if (field.format === "email" && !/^[^@\s]+@[^@\s]+$/.test(text)) return { error: "an email address" };
  if (field.format === "uri" && !URL.canParse(text)) return { error: "a URL" };
  if (field.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: "a date (YYYY-MM-DD)" };
  return { value: text };
}

/**
 * Answers a server's request for input through `Interaction`, so whichever
 * client runs the turn asks the person: first whether to answer at all
 * (decline and dismiss are the protocol's decline and cancel), then each
 * field in turn. A URL request is shown as a notice to open; Lemma never
 * opens it. Values never pass through the model.
 */
export function elicit(
  interaction: InteractionService,
  publish: (notice: NoticePayload) => Effect.Effect<void>,
  server: string,
  params: ElicitRequest["params"],
): Effect.Effect<ElicitResult> {
  const request = params as unknown as {
    readonly mode?: string;
    readonly message: string;
    readonly url?: string;
    readonly requestedSchema?: { readonly properties?: Readonly<Record<string, Field>>; readonly required?: readonly string[] };
  };
  return Effect.gen(function* () {
    if (request.mode === "url" && request.url !== undefined) {
      const url = request.url;
      if (!/^https?:\/\//i.test(url)) return { action: "decline" } satisfies ElicitResult;
      const go = yield* interaction.select(
        `${server} asks you to open a page`,
        [
          { value: "open", label: "Open it", description: url },
          { value: "decline", label: "Decline" },
        ],
        `${request.message}\n\n${url}`,
      );
      if (go !== "open") return { action: "decline" } satisfies ElicitResult;
      yield* publish({ level: "info", message: `${server}: ${request.message}`, source: `mcp:${server}`, links: [{ url, label: "Open" }] });
      return { action: "accept" } satisfies ElicitResult;
    }
    const properties = Object.entries(request.requestedSchema?.properties ?? {});
    const required = new Set(request.requestedSchema?.required ?? []);
    const fields = properties.map(([key, field]) => field.title ?? key).join(", ");
    const answer = yield* interaction.select(
      `${server} asks: ${request.message}`,
      [
        { value: "accept", label: "Answer", ...(fields === "" ? {} : { description: `It asks for ${fields}` }) },
        { value: "decline", label: "Decline" },
      ],
      "What you answer goes to the MCP server, not to the model.",
    );
    if (answer !== "accept") return { action: "decline" } satisfies ElicitResult;
    const content: Record<string, Value> = {};
    for (const [key, field] of properties) {
      const title = `${server}: ${field.title ?? key}${required.has(key) ? "" : " (optional)"}`;
      if (field.type === "boolean") {
        content[key] = yield* interaction.confirm(title, field.description);
        continue;
      }
      const choices = choicesOf(field);
      if (choices !== undefined) {
        const skip = required.has(key) ? [] : [{ value: "\u0000skip", label: "Leave it out" }];
        const value = yield* interaction.select(title, [...choices, ...skip], field.description);
        if (value !== "\u0000skip") content[key] = value;
        continue;
      }
      let error: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const hint = field.description ?? (field.default === undefined ? undefined : `Default: ${String(field.default)}`);
        const text = yield* interaction.ask(error === undefined ? title : `${title}: enter ${error}`, {
          ...(hint === undefined ? {} : { placeholder: hint }),
          ...(looksSecret(key) ? { secret: true } : {}),
        });
        if (text === "" && !required.has(key)) break;
        const parsed = parse(field, text);
        if ("value" in parsed) {
          content[key] = parsed.value;
          break;
        }
        error = parsed.error;
        if (attempt + 1 >= ATTEMPTS) return { action: "cancel" } satisfies ElicitResult;
      }
    }
    return { action: "accept", content } satisfies ElicitResult;
  }).pipe(
    // Dismissed, or nobody there to ask: the person did not answer.
    Effect.catchAll(() => Effect.succeed({ action: "cancel" } satisfies ElicitResult)),
  );
}
