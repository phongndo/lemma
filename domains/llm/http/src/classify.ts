import type { ClassifierAnswer, ClassifierContext, ClassifierInfo, ClassifierQuestion, ClassifierResult, Usage } from "@lemma/llm";
import { abortError, post, ProviderError } from "./http.ts";
import { priced } from "./output.ts";
import type { Auth } from "./wire.ts";

/**
 * Classifier models: not ones to chat with, but ones that answer typed questions about JSON state with probabilities,
 * in one request and its JSON answer. Two protocols serve them: TypeSafe's System One (TypeSafe's Jev, and the
 * classifiers OpenRouter and OpenCode serve), and OpenAI's Decisions API.
 */
export const CLASSIFIER_APIS = ["typesafe-system-one", "openai-decisions"] as const;
export type ClassifierApi = (typeof CLASSIFIER_APIS)[number];

/** A classifier model as this plugin serves it. */
export interface Classifier {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: ClassifierApi;
  readonly baseUrl: string;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  /** USD per million tokens; `longInput`'s prices are the whole request's once its input is over `above` tokens. */
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly longInput?: { readonly above: number; readonly input: number; readonly output: number };
  };
}

/** A classifier as a catalog lists it, before it is placed at a provider. */
export type CatalogClassifier = Omit<Classifier, "provider" | "baseUrl" | "api">;

export const toClassifierInfo = (model: Classifier): ClassifierInfo => ({
  ref: `${model.provider}/${model.id}`,
  provider: model.provider,
  id: model.id,
  name: model.name,
  api: model.api,
  input: [...model.input],
  contextWindow: model.contextWindow,
  cost: { input: model.cost.input, output: model.cost.output },
});

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A classifier protocol: what it is asked, and how its answers are read. */
interface ClassifierWire {
  /** How its failures are named: "System One". */
  readonly label: string;
  /** False: it refuses a signed-in account's token, and takes only an API key (OpenAI's Decisions). */
  readonly signIns: boolean;
  /** The path under the base URL, and the body. */
  readonly build: (model: Classifier, context: ClassifierContext) => { readonly path: string; readonly body: Json };
  /** Each question's answer, by id, from the answer's `answers`; throws on one missing or not of its question's type. */
  readonly answers: (answers: unknown, context: ClassifierContext) => Record<string, ClassifierAnswer>;
  /** Statuses not asked again, though the provider SDKs would. */
  readonly final?: readonly number[];
  /** A failure's message where the provider's own wording misleads. */
  readonly explain?: (error: ProviderError) => string | undefined;
}

/** A finite number at `field` of the answer, or a failure naming it. */
function number(label: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} answered with an invalid ${field}`);
  return value;
}

/**
 * TypeSafe's System One: `POST /systemone` with the state and the questions by id, answered by id. Its yes-or-no
 * question is its `noul` type. It takes no images.
 */
const systemOne: ClassifierWire = {
  label: "System One",
  signIns: true,
  build: (model, context) => {
    if (context.images !== undefined && context.images.length > 0) throw new Error("System One classifiers take no images");
    const questions = Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => [id, question.type === "bool" ? { ...question, type: "noul" } : question]),
    );
    return { path: "systemone", body: { model: model.id, state: context.state, questions } };
  },
  answers: (answers, context) => {
    if (!isRecord(answers)) throw new Error("System One answered with no answers");
    return Object.fromEntries(
      Object.entries(context.questions).map(([id, question]): [string, ClassifierAnswer] => {
        const answer = answers[id];
        if (!isRecord(answer)) throw new Error(`System One did not answer ${id}`);
        return [id, systemOneAnswer(id, question, answer)];
      }),
    );
  },
};

function systemOneAnswer(id: string, question: ClassifierQuestion, answer: Json): ClassifierAnswer {
  const label = "System One";
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !isRecord(answer.probabilities))
      throw new Error(`${label} did not answer ${id} with a choice`);
    const probabilities = Object.fromEntries(
      Object.entries(answer.probabilities).map(([choice, value]) => [choice, number(label, value, `probability for ${id}.${choice}`)]),
    );
    return { type: "choice", choice: answer.choice, probabilities, confidence: number(label, answer.confidence, `confidence for ${id}`) };
  }
  if (question.type === "score") {
    if (answer.type !== "score") throw new Error(`${label} did not answer ${id} with a score`);
    return { type: "score", score: number(label, answer.score, `score for ${id}`), confidence: number(label, answer.confidence, `confidence for ${id}`) };
  }
  if (answer.type !== "noul") throw new Error(`${label} did not answer ${id} with a yes or no`);
  return { type: "bool", probability: number(label, answer.noul, `probability for ${id}`) };
}

/** The most images one Decisions request takes. */
const MAX_IMAGES = 128;

/**
 * OpenAI's Decisions API (https://developers.openai.com/api/docs/guides/decisions): `POST /decisions` with the state as
 * JSON text (with images, one user message of it and them), and the questions as a list by name, answered as one. A
 * yes-or-no question is its `predicate`, which has no criteria: their meanings go in its instructions. It takes only an
 * API key: a ChatGPT sign-in's token is refused there.
 */
const decisions: ClassifierWire = {
  label: "OpenAI Decisions",
  signIns: false,
  build: (model, context) => {
    const state = JSON.stringify(context.state);
    const images = context.images ?? [];
    if (images.length > MAX_IMAGES) throw new Error(`OpenAI Decisions takes at most ${MAX_IMAGES} images, not ${images.length}`);
    const input =
      images.length === 0
        ? state
        : [
            {
              role: "user",
              content: [
                { type: "input_text", text: state },
                ...images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` })),
              ],
            },
          ];
    const questions = Object.entries(context.questions).map(([name, question]) => {
      if (question.type === "choice")
        return {
          type: "choice",
          name,
          instructions: question.instructions,
          choices: Object.entries(question.criteria).map(([value, description]) => (description ? { value, description } : { value })),
        };
      if (question.type === "score") return { type: "score", name, instructions: question.instructions, levels: question.criteria.map((label) => ({ label })) };
      const meanings = [
        question.criteria.true ? `True means: ${question.criteria.true}` : "",
        question.criteria.false ? `False means: ${question.criteria.false}` : "",
      ].filter(Boolean);
      return { type: "predicate", name, instructions: meanings.length === 0 ? question.instructions : `${question.instructions}\n\n${meanings.join("\n")}` };
    });
    return { path: "decisions", body: { model: model.id, input, questions } };
  },
  answers: (answers, context) => {
    if (!Array.isArray(answers)) throw new Error("OpenAI Decisions answered with no answers");
    const byName = new Map<string, Json>();
    for (const answer of answers) if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
    return Object.fromEntries(
      Object.entries(context.questions).map(([id, question]): [string, ClassifierAnswer] => {
        const answer = byName.get(id);
        if (answer === undefined) throw new Error(`OpenAI Decisions did not answer ${id}`);
        return [id, decisionsAnswer(id, question, answer)];
      }),
    );
  },
  // Cloudflare in front of OpenAI ends a request running over about five seconds with a 504, and a large input runs
  // that long again.
  final: [504],
  explain: (error) =>
    error.status === 504
      ? "OpenAI Decisions: 504: the request timed out at OpenAI's gateway. An input above about 600K tokens takes longer than it allows."
      : undefined,
};

function decisionsAnswer(id: string, question: ClassifierQuestion, answer: Json): ClassifierAnswer {
  const label = "OpenAI Decisions";
  if (answer.type === "refusal") throw new Error(`${label} refused to answer ${id}`);
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !Array.isArray(answer.probabilities))
      throw new Error(`${label} did not answer ${id} with a choice`);
    const probabilities = Object.fromEntries(
      answer.probabilities.map((entry: unknown) => {
        if (!isRecord(entry) || typeof entry.value !== "string") throw new Error(`${label} answered ${id} with invalid probabilities`);
        return [entry.value, number(label, entry.probability, `probability for ${id}.${entry.value}`)];
      }),
    );
    return { type: "choice", choice: answer.choice, probabilities, confidence: number(label, answer.confidence, `confidence for ${id}`) };
  }
  if (question.type === "score") {
    if (answer.type !== "score") throw new Error(`${label} did not answer ${id} with a score`);
    return { type: "score", score: number(label, answer.score, `score for ${id}`), confidence: number(label, answer.confidence, `confidence for ${id}`) };
  }
  if (answer.type !== "predicate") throw new Error(`${label} did not answer ${id} with a yes or no`);
  return { type: "bool", probability: number(label, answer.probability, `probability for ${id}`) };
}

export const CLASSIFIER_WIRES: Readonly<Record<ClassifierApi, ClassifierWire>> = {
  "typesafe-system-one": systemOne,
  "openai-decisions": decisions,
};

/** Whether `auth` can ask `model`: a protocol taking API keys alone refuses a sign-in's token. */
export const accepts = (model: Classifier, auth: Pick<Auth, "oauth">): boolean => CLASSIFIER_WIRES[model.api].signIns || !auth.oauth;

/** Token counts priced at `model`'s rates, its long input's where the input is over their threshold; none reported, undefined. */
function usageOf(model: Classifier, value: unknown): Usage | undefined {
  if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
  const count = (tokens: unknown) => (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : 0);
  const input = count(value.input_tokens);
  const long = model.cost.longInput;
  const rates = long !== undefined && input > long.above ? long : model.cost;
  return priced(
    { cost: { input: rates.input, output: rates.output, cacheRead: 0, cacheWrite: 0 } },
    { input, output: count(value.output_tokens), cacheRead: 0, cacheWrite: 0 },
  );
}

/** Times a request is asked again before it is answered, as the provider SDKs would. */
const RETRIES = 2;

export interface ClassifyOptions {
  readonly fetch: typeof fetch;
  /** Beside its key and content type: the model's own, and Lemma's identity. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** How long it may wait for the answer before it fails as stalled; 0, forever. */
  readonly timeoutMs: number;
}

/**
 * Asks `model` `context`'s questions. It never rejects: a failure, the provider's or its answer's, is the result's
 * `error`; aborted by `options.signal`, it is `aborted`. A failed answer's usage is kept, as it was billed.
 */
export async function classify(model: Classifier, context: ClassifierContext, auth: Auth, options: ClassifyOptions): Promise<ClassifierResult> {
  const wire = CLASSIFIER_WIRES[model.api];
  let usage: Usage | undefined;
  const result = (fields: Pick<ClassifierResult, "answers" | "stopReason" | "errorMessage">): ClassifierResult => ({
    provider: model.provider,
    model: model.id,
    ...fields,
    ...(usage === undefined ? {} : { usage }),
  });
  const timeout = options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal = timeout === undefined ? options.signal : AbortSignal.any([options.signal, timeout]);
  try {
    if (!accepts(model, auth)) throw new Error(`${wire.label} takes an API key, not a signed-in account's token`);
    const { path, body } = wire.build(model, context);
    const response = await post(options.fetch, new URL(path, `${model.baseUrl.replace(/\/+$/, "")}/`).toString(), {
      headers: new Headers({ ...options.headers, authorization: `Bearer ${auth.key}`, "content-type": "application/json" }),
      body,
      signal,
      retries: RETRIES,
      ...(wire.final === undefined ? {} : { final: wire.final }),
    });
    const answer: unknown = await response.json().catch(() => {
      throw signal.aborted ? abortError() : new Error(`${wire.label} answered with something not JSON`);
    });
    if (!isRecord(answer)) throw new Error(`${wire.label} answered with something not an object`);
    usage = usageOf(model, answer.usage);
    return result({ answers: wire.answers(answer.answers, context), stopReason: "stop" });
  } catch (error) {
    if (options.signal.aborted) return result({ answers: {}, stopReason: "aborted", errorMessage: "Request was aborted" });
    const message =
      timeout?.aborted === true
        ? `${wire.label} sent no answer for ${options.timeoutMs / 1000} seconds; the request was cut off as stalled`
        : error instanceof ProviderError
          ? (wire.explain?.(error) ?? `${wire.label}: ${error.message}`)
          : error instanceof Error
            ? error.message
            : String(error);
    return result({ answers: {}, stopReason: "error", errorMessage: message });
  }
}
