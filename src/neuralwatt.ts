import type { ProviderConfigInput, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const NEURALWATT_API_BASE_URL = "https://api.neuralwatt.com/v1";
export const NEURALWATT_API_KEY_URL = "https://portal.neuralwatt.com/dashboard/keys";
export const NEURALWATT_API_KEY_ENV = "NEURALWATT_API_KEY";
export const NEURALWATT_PROVIDER_ID = "neuralwatt";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const EFFORTS = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
} as const;

type NeuralWattEffort = keyof typeof EFFORTS;
type OmpEffort = NonNullable<ProviderModelConfig["thinking"]>["efforts"][number];
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface NeuralWattModel {
  id?: unknown;
  max_model_len?: unknown;
  metadata?: {
    display_name?: unknown;
    pricing?: {
      input_per_million?: unknown;
      output_per_million?: unknown;
      cached_input_per_million?: unknown;
      cached_output_per_million?: unknown;
      pricing_tbd?: unknown;
    };
    capabilities?: {
      task?: unknown;
      tools?: unknown;
      vision?: unknown;
      reasoning?: unknown;
      reasoning_effort?: unknown;
    };
    reasoning?: {
      supported_efforts?: unknown;
      default_effort?: unknown;
    } | null;
    limits?: {
      max_context_length?: unknown;
      max_output_tokens?: unknown;
    };
  };
}

interface NeuralWattCatalog {
  scope?: unknown;
  data?: unknown;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function effort(value: unknown): OmpEffort | undefined {
  return typeof value === "string" && Object.hasOwn(EFFORTS, value) ? (value as OmpEffort) : undefined;
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === "string") return error.message;
    }
  }

  return `HTTP ${status}`;
}

export type NeuralWattProviderModelConfig = ProviderModelConfig & { supportsTools?: boolean };

export function toProviderModelConfig(model: NeuralWattModel): NeuralWattProviderModelConfig | undefined {
  if (typeof model.id !== "string" || !model.id.trim()) return undefined;

  const metadata = model.metadata;
  if (typeof metadata?.capabilities?.task === "string") return undefined;

  const contextWindow = positiveInteger(
    metadata?.limits?.max_context_length ?? model.max_model_len,
    DEFAULT_CONTEXT_WINDOW,
  );
  const maxTokens = positiveInteger(metadata?.limits?.max_output_tokens, Math.min(contextWindow, DEFAULT_MAX_TOKENS));
  const capabilities = metadata?.capabilities;
  const supportedEfforts = Array.isArray(metadata?.reasoning?.supported_efforts)
    ? metadata.reasoning.supported_efforts.map(effort).filter((value): value is OmpEffort => value !== undefined)
    : [];
  const defaultLevel = effort(metadata?.reasoning?.default_effort);
  const reasoning = capabilities?.reasoning === true || supportedEfforts.length > 0;
  const thinking = capabilities?.reasoning_effort === true && supportedEfforts.length > 0
    ? {
        mode: "effort" as const,
        efforts: supportedEfforts,
        ...(defaultLevel && supportedEfforts.includes(defaultLevel) ? { defaultLevel } : {}),
      }
    : undefined;
  const pricing = metadata?.pricing;
  const priced = pricing?.pricing_tbd !== true;

  return {
    id: model.id,
    name: typeof metadata?.display_name === "string" && metadata.display_name.trim()
      ? metadata.display_name
      : model.id,
    reasoning,
    ...(thinking ? { thinking } : {}),
    input: capabilities?.vision === true ? ["text", "image"] : ["text"],
    supportsTools: capabilities?.tools === true,
    cost: priced
      ? {
          input: nonNegativeNumber(pricing?.input_per_million),
          output: nonNegativeNumber(pricing?.output_per_million),
          cacheRead: nonNegativeNumber(pricing?.cached_input_per_million),
          cacheWrite: nonNegativeNumber(pricing?.cached_output_per_million),
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export async function fetchNeuralWattModels(apiKey: string, fetchImpl: Fetch = globalThis.fetch): Promise<NeuralWattProviderModelConfig[]> {
  const response = await fetchImpl(`${NEURALWATT_API_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(`NeuralWatt authentication failed: ${errorMessage(payload, response.status)}`);
  }

  const catalog = payload as NeuralWattCatalog;
  if (catalog.scope !== "customer") {
    throw new Error("NeuralWatt did not return an authenticated model catalog");
  }

  if (!Array.isArray(catalog.data)) {
    throw new Error("NeuralWatt returned an invalid model catalog");
  }

  return catalog.data
    .map((entry) => toProviderModelConfig(entry as NeuralWattModel))
    .filter((model): model is NeuralWattProviderModelConfig => model !== undefined);
}

export function createNeuralWattProvider(fetchImpl: Fetch = globalThis.fetch): ProviderConfigInput {
  return {
    baseUrl: NEURALWATT_API_BASE_URL,
    api: "openai-completions",
    apiKey: NEURALWATT_API_KEY_ENV,
    oauth: {
      name: "NeuralWatt",
      async login(callbacks) {
        callbacks.onAuth({
          url: NEURALWATT_API_KEY_URL,
          instructions: "Create a NeuralWatt API key, then paste it into omp.",
        });
        const apiKey = (await callbacks.onPrompt({
          message: "NeuralWatt API key",
          placeholder: "sk-...",
          secret: true,
        })).trim();

        if (!apiKey) throw new Error("A NeuralWatt API key is required");
        await fetchNeuralWattModels(apiKey, fetchImpl);
        return apiKey;
      },
    },
    async fetchDynamicModels(apiKey) {
      return apiKey ? fetchNeuralWattModels(apiKey, fetchImpl) : [];
    },
  };
}
