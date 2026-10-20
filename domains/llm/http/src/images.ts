import type { ImageContent, ImageModelInfo, ImagesContext, ImagesResult, TextContent, Usage } from "@lemma/llm";
import { completionsUsage } from "./completions.ts";
import type { CompletionsUsage } from "./completions.ts";
import { abortError, post, ProviderError } from "./http.ts";
import type { Cost } from "./model.ts";
import { sanitize } from "./transform.ts";
import type { Auth } from "./wire.ts";

/**
 * Image models: ones that make images from text and images. OpenRouter serves them on its Chat Completions endpoint,
 * asked once for the whole answer with the image modality (`openrouter-images`); it answers with the images as data
 * URLs, and some models with text too.
 */
export const IMAGE_APIS = ["openrouter-images"] as const;
export type ImageApi = (typeof IMAGE_APIS)[number];

/** An image model as this plugin serves it. */
export interface ImageModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: ImageApi;
  readonly baseUrl: string;
  readonly input: readonly ("text" | "image")[];
  /** Always includes `"image"`; `"text"`: it may answer with text too. */
  readonly output: readonly ("text" | "image")[];
  /** USD per million tokens. */
  readonly cost: Cost;
}

/** An image model as a catalog lists it, before it is placed at a provider. */
export type CatalogImageModel = Omit<ImageModel, "provider" | "baseUrl" | "api">;

export const toImageModelInfo = (model: ImageModel): ImageModelInfo => ({
  ref: `${model.provider}/${model.id}`,
  provider: model.provider,
  id: model.id,
  name: model.name,
  api: model.api,
  input: [...model.input],
  output: [...model.output],
  cost: { input: model.cost.input, output: model.cost.output },
});

interface Answer {
  readonly usage?: CompletionsUsage;
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown; readonly images?: readonly { readonly image_url?: string | { readonly url?: string } }[] };
  }[];
}

/** An image from a data URL; undefined for any other URL. */
function image(url: string | undefined): ImageContent | undefined {
  const match = url === undefined ? null : /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return match === null ? undefined : { type: "image", mimeType: match[1]!, data: match[2]! };
}

/** Times a request is asked again before it is answered, as the provider SDKs would. */
const RETRIES = 2;

export interface ImagesOptions {
  readonly fetch: typeof fetch;
  /** Beside its key and content type: the model's own, and Lemma's identity. */
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** How long it may wait for the answer before it fails as stalled; 0, forever. */
  readonly timeoutMs: number;
}

/**
 * Asks `model` for images. It never rejects: a failure is the result's `error`; aborted by `options.signal`, it is
 * `aborted`. An answer with no image is not a failure: the model may have said why in its text.
 */
export async function generateImages(model: ImageModel, context: ImagesContext, auth: Auth, options: ImagesOptions): Promise<ImagesResult> {
  let usage: Usage | undefined;
  const result = (fields: Pick<ImagesResult, "output" | "stopReason" | "errorMessage">): ImagesResult => ({
    provider: model.provider,
    model: model.id,
    ...fields,
    ...(usage === undefined ? {} : { usage }),
  });
  const timeout = options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal = timeout === undefined ? options.signal : AbortSignal.any([options.signal, timeout]);
  try {
    const content = context.input.map((block) =>
      block.type === "text"
        ? { type: "text", text: sanitize(block.text) }
        : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
    );
    const response = await post(options.fetch, `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      headers: new Headers({ ...options.headers, authorization: `Bearer ${auth.key}`, "content-type": "application/json" }),
      body: {
        model: model.id,
        messages: [{ role: "user", content }],
        stream: false,
        modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
      },
      signal,
      retries: RETRIES,
    });
    const answer = (await response.json().catch(() => {
      throw signal.aborted ? abortError() : new Error("OpenRouter answered with something not JSON");
    })) as Answer | null;
    if (answer?.usage !== undefined && answer.usage !== null) usage = completionsUsage(model, answer.usage);
    const message = answer?.choices?.[0]?.message;
    const output: (TextContent | ImageContent)[] = [];
    if (typeof message?.content === "string" && message.content !== "") output.push({ type: "text", text: message.content });
    for (const item of message?.images ?? []) {
      const made = image(typeof item.image_url === "string" ? item.image_url : item.image_url?.url);
      if (made !== undefined) output.push(made);
    }
    return result({ output, stopReason: "stop" });
  } catch (error) {
    if (options.signal.aborted) return result({ output: [], stopReason: "aborted", errorMessage: "Request was aborted" });
    const message =
      timeout?.aborted === true
        ? `OpenRouter sent no images for ${options.timeoutMs / 1000} seconds; the request was cut off as stalled`
        : error instanceof ProviderError
          ? `OpenRouter: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    return result({ output: [], stopReason: "error", errorMessage: message });
  }
}
