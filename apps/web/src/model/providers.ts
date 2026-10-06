import type { ProviderInfo, CustomProviderSpec } from "@lemma/contracts";
import claude from "../assets/providers/claude-ai-icon.svg?url";
import openai from "../assets/providers/openai.svg?url";
import openaiDark from "../assets/providers/openai_dark.svg?url";
import gemini from "../assets/providers/gemini.svg?url";
import copilot from "../assets/providers/copilot.svg?url";
import copilotDark from "../assets/providers/copilot_dark.svg?url";
import openrouter from "../assets/providers/openrouter_light.svg?url";
import openrouterDark from "../assets/providers/openrouter_dark.svg?url";
import deepseek from "../assets/providers/deepseek.svg?url";
import mistral from "../assets/providers/mistral-ai_logo.svg?url";
import groq from "../assets/providers/groq.svg?url";
import xai from "../assets/providers/xai_light.svg?url";
import xaiDark from "../assets/providers/xai_dark.svg?url";
import cerebras from "../assets/providers/cerebras-dark.svg?url";
import cerebrasDark from "../assets/providers/cerebras.svg?url";
import together from "../assets/providers/lobehub-together-color.svg?url";
import huggingface from "../assets/providers/hugging_face.svg?url";
import meta from "../assets/providers/meta.svg?url";
import kimi from "../assets/providers/kimi-icon.svg?url";
import nvidia from "../assets/providers/simpleicons-nvidia.svg?url";
import qwen from "../assets/providers/qwen_light.svg?url";
import qwenDark from "../assets/providers/qwen_dark.svg?url";
import vercel from "../assets/providers/vercel.svg?url";
import vercelDark from "../assets/providers/vercel_dark.svg?url";
import cloudflare from "../assets/providers/cloudflare.svg?url";
import azure from "../assets/providers/azure.svg?url";
import aws from "../assets/providers/aws_light.svg?url";
import awsDark from "../assets/providers/aws_dark.svg?url";
import fireworks from "../assets/providers/lobehub-fireworks-color.svg?url";
import minimax from "../assets/providers/lobehub-minimax-color.svg?url";
import vertex from "../assets/providers/lobehub-vertexai-color.svg?url";
import antgroup from "../assets/providers/lobehub-antgroup-color.svg?url";
import moonshot from "../assets/providers/lobehub-moonshot.svg?raw";
import opencode from "../assets/providers/lobehub-opencode.svg?raw";
import xiaomi from "../assets/providers/simpleicons-xiaomi.svg?url";
import earendil from "../assets/providers/earendil.svg?raw";
import zai from "../assets/providers/lobehub-zai.svg?raw";
import baseten from "../assets/providers/lobehub-baseten.svg?raw";

/**
 * How the Providers page presents the host's providers: each brand's logo, a
 * line saying what it is for, and where to get a key. The host knows none of
 * this; a provider missing here (a custom one) shows its initial.
 * The logos are files in `assets/providers`; its README says where they are from.
 */
interface ProviderBrand {
  readonly logo?: ProviderLogo;
  /** What it is, when the auth methods alone do not say. */
  readonly blurb?: string;
  /** Where to create an API key. */
  readonly keyUrl?: string;
  /** Other names a search should find it by. */
  readonly keywords?: string;
}

/** A color logo's file URLs (the dark one for dark themes, when it differs), or a one-color logo's SVG markup that draws in the text color. */
type ProviderLogo = { readonly light: string; readonly dark?: string } | { readonly mono: string };

const brands: Readonly<Record<string, ProviderBrand>> = {
  "openai-codex": { logo: { light: openai, dark: openaiDark }, keywords: "chatgpt gpt", blurb: "Sign in with your ChatGPT plan" },
  "github-copilot": { logo: { light: copilot, dark: copilotDark }, blurb: "Use your Copilot subscription" },
  opencode: { logo: { mono: opencode }, blurb: "Pay as you go for models picked for coding", keyUrl: "https://opencode.ai/auth" },
  "opencode-go": { logo: { mono: opencode }, blurb: "A subscription to open coding models", keyUrl: "https://opencode.ai/auth" },
  anthropic: { logo: { light: claude }, keywords: "claude", blurb: "Claude models with an API key", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: {
    logo: { light: openai, dark: openaiDark },
    keywords: "chatgpt gpt",
    blurb: "Sign in with your ChatGPT plan, or use an API key",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  google: { logo: { light: gemini }, keywords: "gemini", blurb: "Gemini models with an API key", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { logo: { light: openrouter, dark: openrouterDark }, blurb: "Hundreds of models behind one key", keyUrl: "https://openrouter.ai/settings/keys" },
  "google-vertex": { logo: { light: vertex } },
  "azure-openai-responses": { logo: { light: azure } },
  "amazon-bedrock": { logo: { light: aws, dark: awsDark } },
  "ant-ling": { logo: { light: antgroup } },
  baseten: { logo: { mono: baseten } },
  cerebras: { logo: { light: cerebras, dark: cerebrasDark } },
  fireworks: { logo: { light: fireworks }, keyUrl: "https://fireworks.ai/account/api-keys" },
  together: { logo: { light: together }, keyUrl: "https://api.together.ai/settings/api-keys" },
  deepseek: { logo: { light: deepseek }, keyUrl: "https://platform.deepseek.com/api_keys" },
  mistral: { logo: { light: mistral }, keyUrl: "https://console.mistral.ai/api-keys" },
  groq: { logo: { light: groq }, keyUrl: "https://console.groq.com/keys" },
  xai: { logo: { light: xai, dark: xaiDark }, keywords: "grok", keyUrl: "https://console.x.ai" },
  huggingface: { logo: { light: huggingface }, keyUrl: "https://huggingface.co/settings/tokens" },
  meta: { logo: { light: meta } },
  minimax: { logo: { light: minimax } },
  "minimax-cn": { logo: { light: minimax } },
  moonshotai: { logo: { mono: moonshot } },
  "moonshotai-cn": { logo: { mono: moonshot } },
  "kimi-coding": { logo: { light: kimi }, keywords: "moonshot" },
  nvidia: { logo: { light: nvidia } },
  "qwen-token-plan": { logo: { light: qwen, dark: qwenDark } },
  "qwen-token-plan-cn": { logo: { light: qwen, dark: qwenDark } },
  "qwen-token-plan-individual": { logo: { light: qwen, dark: qwenDark } },
  // Radius is Earendil's gateway: its maker's mark.
  radius: { logo: { mono: earendil } },
  xiaomi: { logo: { light: xiaomi } },
  "xiaomi-token-plan-ams": { logo: { light: xiaomi } },
  "xiaomi-token-plan-cn": { logo: { light: xiaomi } },
  "xiaomi-token-plan-sgp": { logo: { light: xiaomi } },
  "vercel-ai-gateway": { logo: { light: vercel, dark: vercelDark } },
  "cloudflare-ai-gateway": { logo: { light: cloudflare } },
  "cloudflare-workers-ai": { logo: { light: cloudflare } },
  zai: { logo: { mono: zai } },
  "zai-coding-cn": { logo: { mono: zai } },
};

/** Offered first, in this order, until connected: the quickest ways to start. */
const POPULAR = ["openai", "github-copilot", "opencode", "opencode-go", "anthropic", "google", "openrouter"];

export const providerBrand = (id: string): ProviderBrand => brands[id] ?? {};

const hasOAuth = (provider: ProviderInfo) => provider.auth.some((method) => method.type === "oauth");
/** An environment variable name, as opposed to a stored credential the host can remove. */
export const fromEnv = (source: string | undefined) => source !== undefined && /^[A-Z0-9_]+$/.test(source);

/** How a provider is connected, or how it can be. */
export const describeProvider = (provider: ProviderInfo): string => {
  if (provider.configured) {
    if (fromEnv(provider.source)) return `From $${provider.source}`;
    if (provider.source === "OAuth") return "Signed in with your subscription";
    if (provider.source === "stored credential") return "API key saved on the host";
    return provider.source === undefined ? "Connected" : `Connected · ${provider.source}`;
  }
  const blurb = providerBrand(provider.id).blurb;
  if (blurb !== undefined) return blurb;
  const oauth = hasOAuth(provider);
  const key = provider.auth.some((method) => method.type === "api_key");
  return oauth && key ? "Subscription or API key" : oauth ? "Sign in with your subscription" : "API key";
};

/** What a search over providers matches. */
export const providerText = (provider: ProviderInfo): string => {
  const brand = providerBrand(provider.id);
  return [provider.name, provider.id, describeProvider(provider), brand.blurb, brand.keywords].filter(Boolean).join(" ");
};

/** Which ways in to list: signing in with a subscription, or pasting an API key. */
export type AuthFilter = "all" | "oauth" | "api_key";

interface ProviderGroup {
  readonly title: string;
  readonly providers: readonly ProviderInfo[];
}

/**
 * The page's lists: connected, then the popular ways to start, then the rest
 * by name. A search is one list of every match, connected first; each word of
 * the query must match. `filter` keeps providers that offer that way in.
 */
export const providerGroups = (all: readonly ProviderInfo[], query = "", filter: AuthFilter = "all"): ProviderGroup[] => {
  const providers = filter === "all" ? all : all.filter((provider) => provider.auth.some((method) => method.type === filter));
  const byName = (a: ProviderInfo, b: ProviderInfo) => a.name.localeCompare(b.name);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const found = providers.filter((provider) => {
      const text = providerText(provider).toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const connected = found.filter((p) => p.configured).sort(byName);
    return found.length === 0 ? [] : [{ title: "Results", providers: [...connected, ...found.filter((p) => !p.configured).sort(byName)] }];
  }
  const rank = (provider: ProviderInfo) => POPULAR.indexOf(provider.id);
  const waiting = providers.filter((p) => !p.configured);
  return [
    { title: "Connected", providers: providers.filter((p) => p.configured).sort(byName) },
    { title: "Popular", providers: waiting.filter((p) => rank(p) >= 0).sort((a, b) => rank(a) - rank(b)) },
    { title: "All providers", providers: waiting.filter((p) => rank(p) < 0).sort(byName) },
  ].filter((group) => group.providers.length > 0);
};

/** Wire APIs a custom provider can speak, as the form offers them: most local servers and gateways speak the first. */
export const CUSTOM_APIS = [
  { value: "openai-completions", label: "OpenAI-compatible (Chat Completions)" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Gemini" },
] as const;

export interface CustomProviderDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly api: (typeof CUSTOM_APIS)[number]["value"];
  /** Model ids, separated by commas, spaces, or lines. */
  readonly models: string;
  readonly hasKey: boolean;
}

/** What the host is asked to add for a draft: its fields, trimmed, and each model once. The llm plugin picks the id. */
export const customProviderSpec = (draft: CustomProviderDraft): CustomProviderSpec => {
  const models = [...new Set(draft.models.split(/[\s,]+/).filter(Boolean))];
  return {
    name: draft.name.trim(),
    api: draft.api,
    baseUrl: draft.baseUrl.trim(),
    models: [models[0] ?? "", ...models.slice(1)],
    key: draft.hasKey,
  };
};

/** What is wrong with a draft, if anything. */
export const customProviderProblem = (draft: CustomProviderDraft): string | undefined => {
  if (draft.name.trim() === "") return "Give it a name";
  if (!/^https?:\/\/\S+$/.test(draft.baseUrl.trim())) return "The base URL starts with http:// or https://";
  if (draft.models.trim() === "") return "Add at least one model id";
  return undefined;
};

/** The largest logo file a custom provider takes; logos live in config.jsonc. */
const MAX_LOGO_BYTES = 32 * 1024;

/** What is wrong with an SVG file's text as a logo, if anything. */
export const logoProblem = (svg: string): string | undefined => {
  if (new Blob([svg]).size > MAX_LOGO_BYTES) return `Logos are at most ${MAX_LOGO_BYTES / 1024} KB`;
  const body = svg
    .trim()
    .replace(/^<\?xml[\s\S]*?\?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return /^<svg[\s>]/i.test(body) && /<\/svg>$/i.test(body) ? undefined : "That is not an SVG file";
};

/**
 * A logo as an image source. Drawn with `<img>`, never inline, so scripts and
 * handlers in the file do not run and its ids cannot clash with the page's.
 */
export const logoSource = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.trim())}`;
