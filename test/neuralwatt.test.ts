import { describe, expect, test } from "bun:test";
import {
  createNeuralWattProvider,
  fetchNeuralWattModels,
  NEURALWATT_API_KEY_URL,
  toProviderModelConfig,
} from "../src/neuralwatt.js";

describe("NeuralWatt model mapping", () => {
  test("preserves catalog capabilities, limits, pricing, and reasoning controls", () => {
    expect(toProviderModelConfig({
      id: "kimi-k3",
      max_model_len: 1_048_560,
      metadata: {
        display_name: "Kimi K3",
        pricing: {
          input_per_million: 3,
          output_per_million: 15,
          cached_input_per_million: 0.3,
          cached_output_per_million: null,
        },
        capabilities: {
          tools: true,
          vision: true,
          reasoning: true,
          reasoning_effort: true,
        },
        reasoning: {
          supported_efforts: ["max", "high", "none"],
          default_effort: "max",
        },
        limits: {
          max_context_length: 1_048_560,
          max_output_tokens: 32_768,
        },
      },
    }) as unknown).toEqual({
      id: "kimi-k3",
      name: "Kimi K3",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["max", "high"], defaultLevel: "max" },
      input: ["text", "image"],
      supportsTools: true,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1_048_560,
      maxTokens: 32_768,
    });
  });

  test("excludes non-chat models and uses safe defaults for incomplete metadata", () => {
    expect(toProviderModelConfig({
      id: "embed-v1",
      metadata: { capabilities: { task: "embed" } },
    })).toBeUndefined();

    expect(toProviderModelConfig({ id: "chat-v1" })).toEqual({
      id: "chat-v1",
      name: "chat-v1",
      reasoning: false,
      input: ["text"],
      supportsTools: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  });
});

describe("NeuralWatt authentication and discovery", () => {
  test("sends bearer auth and rejects an unauthenticated catalog", async () => {
    const authorizations: string[] = [];
    await expect(fetchNeuralWattModels("sk-test", async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return new Response(JSON.stringify({ scope: "public", data: [] }));
    })).rejects.toThrow("did not return an authenticated model catalog");
    expect(authorizations).toEqual(["Bearer sk-test"]);
  });

  test("login opens the key page, masks key entry, validates it, and returns it for OMP storage", async () => {
    const provider = createNeuralWattProvider(async () => new Response(JSON.stringify({
      scope: "customer",
      data: [{ id: "glm-5.3", metadata: { capabilities: {} } }],
    })));
    expect(provider.authHeader).toBeUndefined();
    const login = provider.oauth?.login;
    if (!login) throw new Error("Expected OAuth-backed API-key login");

    const authUrls: string[] = [];
    const prompts: { message: string; placeholder?: string; secret?: boolean }[] = [];
    await expect(login({
      onAuth: (info) => authUrls.push(info.url),
      onPrompt: async (prompt) => {
        prompts.push(prompt);
        return "sk-test";
      },
    })).resolves.toBe("sk-test");

    expect(authUrls).toEqual([NEURALWATT_API_KEY_URL]);
    expect(prompts).toEqual([{ message: "NeuralWatt API key", placeholder: "sk-...", secret: true }]);
  });
});
