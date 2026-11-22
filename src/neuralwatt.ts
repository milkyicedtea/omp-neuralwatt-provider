import type {
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
} from "@oh-my-pi/pi-ai";
import type { ProviderConfigInput, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const NEURALWATT_API_BASE_URL = "https://api.neuralwatt.com/v1";
export const NEURALWATT_API_KEY_URL = "https://portal.neuralwatt.com/dashboard/keys";
export const NEURALWATT_API_KEY_ENV = "NEURALWATT_API_KEY";
export const NEURALWATT_PROVIDER_ID = "neuralwatt";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const EFFORTS = {
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} as const;

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

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoMillis(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function usedFraction(used: number | undefined, limit: number | undefined): number | undefined {
	return used !== undefined && limit !== undefined && limit > 0 ? used / limit : undefined;
}

function usageStatus(fraction: number | undefined): UsageStatus | undefined {
	if (fraction === undefined) return undefined;
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.9) return "warning";
	return "ok";
}

function percentAmount(fraction: number | undefined): UsageLimit["amount"] {
	return {
		...(fraction !== undefined ? { usedFraction: fraction, remainingFraction: Math.max(1 - fraction, 0) } : {}),
		unit: "percent",
	};
}

function usdAmount(used: number | undefined, limit: number | undefined, remaining: number | undefined) {
	const fraction = usedFraction(used, limit);
	return {
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(remaining !== undefined ? { remaining } : {}),
		...(fraction !== undefined ? { usedFraction: fraction, remainingFraction: Math.max(1 - fraction, 0) } : {}),
		unit: "usd" as const,
	};
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
	const thinking =
		capabilities?.reasoning_effort === true && supportedEfforts.length > 0
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
		name: typeof metadata?.display_name === "string" && metadata.display_name.trim() ? metadata.display_name : model.id,
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

export async function fetchNeuralWattModels(
	apiKey: string,
	fetchImpl: Fetch = globalThis.fetch,
): Promise<NeuralWattProviderModelConfig[]> {
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

export async function fetchNeuralWattUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = (params.baseUrl ?? NEURALWATT_API_BASE_URL).replace(/\/+$/, "");
	let payload: unknown;
	try {
		const response = await ctx.fetch(`${baseUrl}/quota`, {
			headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" },
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("NeuralWatt quota fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("NeuralWatt quota fetch error", { error: String(error) });
		return null;
	}

	const snapshot = record(payload);
	if (!snapshot) return null;

	const balance = record(snapshot.balance);
	const subscription = record(snapshot.subscription);
	const daily = record(snapshot.daily_free_energy);
	const key = record(snapshot.key);
	const allowance = record(key?.allowance);
	const usage = record(snapshot.usage);
	const currentMonth = record(usage?.current_month);
	const limits: UsageLimit[] = [];

	if (subscription) {
		const included = finiteNumber(subscription.kwh_included);
		const used = finiteNumber(subscription.kwh_used);
		const fraction = usedFraction(used, included);
		const resetsAt = isoMillis(subscription.current_period_end);
		const plan = typeof subscription.plan === "string" ? subscription.plan : undefined;
		if (included !== undefined || used !== undefined) {
			limits.push({
				id: "neuralwatt:subscription:energy",
				label: "Subscription energy",
				scope: { provider: params.provider, windowId: "billing", ...(plan ? { tier: plan } : {}) },
				window: { id: "billing", label: "billing period", ...(resetsAt !== undefined ? { resetsAt } : {}) },
				amount: percentAmount(fraction),
				status: usageStatus(fraction),
				notes: [
					`${(used ?? 0).toFixed(2)} / ${(included ?? 0).toFixed(2)} kWh charged`,
					...(subscription.in_overage === true ? ["Account is in overage"] : []),
				],
			});
		}
	}

	if (daily) {
		const included = finiteNumber(daily.kwh_included);
		const used = finiteNumber(daily.kwh_used);
		const fraction = usedFraction(used, included);
		const resetsAt = isoMillis(daily.reset_at);
		const labels = Array.isArray(daily.model_labels)
			? daily.model_labels.filter((value): value is string => typeof value === "string")
			: [];
		if (included !== undefined && included > 0 && used !== undefined) {
			limits.push({
				id: "neuralwatt:daily-free-energy",
				label: "Daily free energy",
				scope: { provider: params.provider, windowId: "daily" },
				window: {
					id: "daily",
					label: "daily",
					durationMs: DAY_MS,
					...(resetsAt !== undefined ? { resetsAt } : {}),
				},
				amount: percentAmount(fraction),
				status: usageStatus(fraction),
				notes: [
					`${used.toFixed(2)} / ${included.toFixed(2)} kWh charged`,
					...(labels.length > 0 ? [`Covers ${labels.join(", ")}`] : []),
				],
			});
		}
	}

	if (balance) {
		const remaining = finiteNumber(balance.credits_remaining_usd);
		const total = finiteNumber(balance.total_credits_usd);
		const used =
			finiteNumber(balance.credits_used_usd) ??
			(total !== undefined && remaining !== undefined ? total - remaining : undefined);
		const method = typeof balance.accounting_method === "string" ? balance.accounting_method : undefined;
		if ((total !== undefined && total > 0) || remaining !== undefined) {
			const fraction = usedFraction(used, total);
			limits.push({
				id: "neuralwatt:prepaid:usd",
				label: "Prepaid credit balance",
				scope: { provider: params.provider },
				amount: usdAmount(used, total, remaining),
				status: usageStatus(fraction),
				notes: ["Does not reset; top up to refill", ...(method ? [`Accounting: ${method}`] : [])],
			});
		}
	}

	if (allowance) {
		const limitUsd = finiteNumber(allowance.limit_usd);
		const spentUsd = finiteNumber(allowance.spent_usd);
		const remainingUsd = finiteNumber(allowance.remaining_usd);
		const period = typeof allowance.period === "string" ? allowance.period : "period";
		const durationMs =
			period === "daily" ? DAY_MS : period === "weekly" ? WEEK_MS : period === "monthly" ? 30 * DAY_MS : undefined;
		if (limitUsd !== undefined && limitUsd > 0) {
			limits.push({
				id: `neuralwatt:key-allowance:${period}`,
				label: "Key allowance",
				scope: { provider: params.provider, windowId: period },
				window: { id: period, label: period, ...(durationMs !== undefined ? { durationMs } : {}) },
				amount: usdAmount(spentUsd, limitUsd, remainingUsd),
				status: allowance.blocked === true ? "exhausted" : usageStatus(usedFraction(spentUsd, limitUsd)),
				...(allowance.blocked === true ? { notes: ["This key is blocked at its spending limit"] } : {}),
			});
		}
	}

	if (limits.length === 0) return null;

	const monthCost = finiteNumber(currentMonth?.cost_usd);
	const monthRequests = finiteNumber(currentMonth?.requests);
	const keyName = typeof key?.name === "string" && key.name ? key.name : undefined;
	const plan = typeof subscription?.plan === "string" ? subscription.plan : undefined;

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		...(monthCost !== undefined
			? {
					notes: [
						`Current month: $${monthCost.toFixed(2)}${monthRequests !== undefined ? ` across ${Math.trunc(monthRequests)} requests` : ""}`,
					],
				}
			: {}),
		metadata: {
			...(keyName ? { accountId: keyName, keyName } : {}),
			...(plan ? { plan } : {}),
			...(monthCost !== undefined ? { currentMonthCostUsd: monthCost } : {}),
		},
		raw: payload,
	};
}

export const neuralWattUsageProvider: UsageProvider = {
	id: NEURALWATT_PROVIDER_ID,
	cacheVersion: 1,
	supports: ({ provider, credential }) =>
		provider === NEURALWATT_PROVIDER_ID && credential.type === "api_key" && Boolean(credential.apiKey),
	fetchUsage: fetchNeuralWattUsage,
};

export function createNeuralWattProvider(fetchImpl: Fetch = globalThis.fetch): ProviderConfigInput {
	return {
		baseUrl: NEURALWATT_API_BASE_URL,
		api: "openai-completions",
		apiKey: NEURALWATT_API_KEY_ENV,
		usage: neuralWattUsageProvider,
		oauth: {
			name: "NeuralWatt",
			async login(callbacks) {
				callbacks.onAuth({
					url: NEURALWATT_API_KEY_URL,
					instructions: "Create a NeuralWatt API key, then paste it into omp.",
				});
				const apiKey = (
					await callbacks.onPrompt({
						message: "NeuralWatt API key",
						placeholder: "sk-...",
						secret: true,
					})
				).trim();

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
