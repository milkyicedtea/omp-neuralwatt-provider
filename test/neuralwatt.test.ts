import { describe, expect, test } from "bun:test";
import {
	createNeuralWattProvider,
	fetchNeuralWattModels,
	fetchNeuralWattUsage,
	NEURALWATT_API_KEY_URL,
	NEURALWATT_PROVIDER_ID,
	neuralWattUsageProvider,
	toProviderModelConfig,
} from "../src/neuralwatt.js";

describe("NeuralWatt model mapping", () => {
	test("preserves catalog capabilities, limits, pricing, and reasoning controls", () => {
		expect(
			toProviderModelConfig({
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
			}) as unknown,
		).toEqual({
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
		expect(
			toProviderModelConfig({
				id: "embed-v1",
				metadata: { capabilities: { task: "embed" } },
			}),
		).toBeUndefined();

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
		await expect(
			fetchNeuralWattModels("sk-test", async (_url, init) => {
				authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
				return new Response(JSON.stringify({ scope: "public", data: [] }));
			}),
		).rejects.toThrow("did not return an authenticated model catalog");
		expect(authorizations).toEqual(["Bearer sk-test"]);
	});

	test("login opens the key page, masks key entry, validates it, and returns it for OMP storage", async () => {
		const provider = createNeuralWattProvider(
			async () =>
				new Response(
					JSON.stringify({
						scope: "customer",
						data: [{ id: "glm-5.3", metadata: { capabilities: {} } }],
					}),
				),
		);
		expect(provider.authHeader).toBeUndefined();
		const login = provider.oauth?.login;
		if (!login) throw new Error("Expected OAuth-backed API-key login");

		const authUrls: string[] = [];
		const prompts: { message: string; placeholder?: string; secret?: boolean }[] = [];
		await expect(
			login({
				onAuth: (info) => authUrls.push(info.url),
				onPrompt: async (prompt) => {
					prompts.push(prompt);
					return "sk-test";
				},
			}),
		).resolves.toBe("sk-test");

		expect(authUrls).toEqual([NEURALWATT_API_KEY_URL]);
		expect(prompts).toEqual([{ message: "NeuralWatt API key", placeholder: "sk-...", secret: true }]);
	});
});

describe("NeuralWatt usage reporting", () => {
	const quotaFixture = {
		snapshot_at: "2026-04-16T18:30:00Z",
		balance: {
			credits_remaining_usd: 32.6774,
			total_credits_usd: 52.34,
			credits_used_usd: 19.6626,
			accounting_method: "energy",
		},
		usage: {
			lifetime: { cost_usd: 243.9145, requests: 37801, tokens: 1235477176, energy_kwh: 15.6009 },
			current_month: { cost_usd: 160.1463, requests: 23902, tokens: 1116658995, energy_kwh: 9.7278 },
		},
		limits: { overage_limit_usd: null, rate_limit_tier: "standard" },
		subscription: {
			plan: "standard",
			status: "active",
			billing_interval: "month",
			current_period_start: "2026-04-11T05:05:25Z",
			current_period_end: "2026-05-11T05:05:25Z",
			auto_renew: true,
			kwh_included: 20,
			kwh_used: 13.9023,
			kwh_remaining: 6.0977,
			in_overage: false,
		},
		daily_free_energy: {
			kwh_included: 0.15,
			kwh_used: 0.0421,
			kwh_remaining: 0.1079,
			reset_at: "2026-04-17T00:00:00Z",
			model_labels: ["DeepSeek-V4-Flash"],
		},
		key: {
			name: "my-production-key",
			allowance: {
				limit_usd: 10,
				period: "monthly",
				spent_usd: 4,
				remaining_usd: 6,
				blocked: false,
			},
		},
	};

	test("maps the quota snapshot into OMP usage limits", async () => {
		const requests: { url: string; authorization: string }[] = [];
		const report = await fetchNeuralWattUsage(
			{
				provider: NEURALWATT_PROVIDER_ID,
				credential: { type: "api_key", apiKey: "sk-test" },
				baseUrl: "https://api.neuralwatt.com/v1/",
			},
			{
				fetch: async (url, init) => {
					requests.push({
						url: String(url),
						authorization: new Headers(init?.headers).get("Authorization") ?? "",
					});
					return Response.json(quotaFixture);
				},
			},
		);

		expect(requests).toEqual([{ url: "https://api.neuralwatt.com/v1/quota", authorization: "Bearer sk-test" }]);
		expect(report?.limits.map((limit) => limit.id)).toEqual([
			"neuralwatt:subscription:energy",
			"neuralwatt:daily-free-energy",
			"neuralwatt:prepaid:usd",
			"neuralwatt:key-allowance:monthly",
		]);
		expect(report?.limits.map((limit) => limit.status)).toEqual(["ok", "ok", "ok", "ok"]);
		expect(report?.limits.map((limit) => limit.label)).toEqual([
			"Electricity (SUB) 13.90/20.00 kWh",
			"Daily free energy 0.04/0.15 kWh",
			"Prepaid credits (PAYG)",
			"Key allowance (monthly)",
		]);
		expect(report?.limits[0]?.amount.usedFraction).toBeCloseTo(13.9023 / 20);
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse("2026-05-11T05:05:25Z"));
		expect(report?.limits[0]?.notes).toEqual(["13.90 kWh charged · 6.10 kWh remaining (30.5% left)"]);
		expect(report?.limits[1]?.window?.resetsAt).toBe(Date.parse("2026-04-17T00:00:00Z"));
		expect(report?.limits[1]?.notes).toEqual([
			"0.04 kWh charged · 0.11 kWh remaining (71.9% left)",
			"Covers DeepSeek-V4-Flash",
		]);
		expect(report?.limits[2]?.amount).toEqual({ remaining: 32.6774, unit: "usd" });
		expect(report?.limits[2]?.notes).toEqual(["Does not reset; top up to refill"]);
		expect(report?.limits[3]?.amount).toMatchObject({ used: 4, limit: 10, remaining: 6, unit: "usd" });
		expect(report?.limits[3]?.notes).toEqual([
			"$6.00 remaining of $10.00 · 60.0% left · NeuralWatt does not report the reset date",
		]);
		expect(report?.metadata).toMatchObject({ accountId: "my-production-key", plan: "standard" });
		expect(report?.notes).toEqual(["Current month: $160.15 across 23902 requests"]);
		expect(report?.raw).toEqual(quotaFixture);
	});

	test("marks overage, exhausted allowance, and missing subscription windows", async () => {
		const report = await fetchNeuralWattUsage(
			{
				provider: NEURALWATT_PROVIDER_ID,
				credential: { type: "api_key", apiKey: "sk-test" },
			},
			{
				fetch: async () =>
					Response.json({
						balance: { credits_remaining_usd: 0, total_credits_usd: 10, credits_used_usd: 10 },
						subscription: {
							plan: "pro",
							kwh_included: 10,
							kwh_used: 12,
							kwh_remaining: -2,
							in_overage: true,
							current_period_end: null,
						},
						daily_free_energy: null,
						key: {
							name: null,
							allowance: { limit_usd: 5, period: "daily", spent_usd: 5, remaining_usd: 0, blocked: true },
						},
					}),
			},
		);

		expect(report?.limits.map((limit) => [limit.id, limit.status])).toEqual([
			["neuralwatt:subscription:energy", "exhausted"],
			["neuralwatt:prepaid:usd", "exhausted"],
			["neuralwatt:key-allowance:daily", "exhausted"],
		]);
		expect(report?.limits[0]?.label).toBe("Electricity (SUB) 12.00/10.00 kWh");
		expect(report?.limits[0]?.notes).toEqual([
			"12.00 kWh charged · 2.00 kWh over (0.0% remaining)",
			"Account is in overage",
		]);
		expect(report?.limits[1]?.amount).toEqual({ remaining: 0, unit: "usd" });
		expect(report?.limits[1]?.notes).toEqual(["Does not reset; top up to refill"]);
		expect(report?.limits[2]?.notes).toEqual([
			"$0.00 remaining of $5.00 · 0.0% left · NeuralWatt does not report the reset date",
			"This key is blocked at its spending limit",
		]);
		expect(report?.metadata).not.toHaveProperty("accountId");
	});

	test("returns null without a usable API key or quota response", async () => {
		expect(
			await fetchNeuralWattUsage(
				{ provider: NEURALWATT_PROVIDER_ID, credential: { type: "oauth", accessToken: "token" } },
				{ fetch: async () => Response.json({}) },
			),
		).toBeNull();

		expect(
			await fetchNeuralWattUsage(
				{ provider: NEURALWATT_PROVIDER_ID, credential: { type: "api_key", apiKey: "sk-test" } },
				{ fetch: async () => new Response("unauthorized", { status: 401 }) },
			),
		).toBeNull();

		expect(
			await fetchNeuralWattUsage(
				{ provider: NEURALWATT_PROVIDER_ID, credential: { type: "api_key", apiKey: "sk-test" } },
				{ fetch: async () => Response.json({ balance: {}, subscription: null, key: null }) },
			),
		).toBeNull();
	});

	test("registers the usage provider with the NeuralWatt provider config", () => {
		expect(createNeuralWattProvider().usage).toBe(neuralWattUsageProvider);
		expect(
			neuralWattUsageProvider.supports?.({
				provider: NEURALWATT_PROVIDER_ID,
				credential: { type: "api_key", apiKey: "sk-test" },
			}),
		).toBe(true);
		expect(
			neuralWattUsageProvider.supports?.({
				provider: NEURALWATT_PROVIDER_ID,
				credential: { type: "oauth", accessToken: "token" },
			}),
		).toBe(false);
	});
});
