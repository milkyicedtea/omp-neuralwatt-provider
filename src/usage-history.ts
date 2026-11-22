import { NEURALWATT_API_BASE_URL, NEURALWATT_API_KEY_ENV } from "./neuralwatt";

export const NEURALWATT_USAGE_COMMAND = "neuralwatt-usage";
export const NEURALWATT_USAGE_MESSAGE_TYPE = "neuralwatt-usage";

const DAY_MS = 86_400_000;
const REQUEST_GAP_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Wait = (ms: number) => Promise<void>;

export interface NeuralWattUsageWindow {
	days: number;
	startDate: string;
	endDate: string;
}

export interface NeuralWattDailyUsage {
	date: string;
	requests?: number;
	tokens?: number;
	costUsd?: number;
	energyKwh?: number;
	energyKwhCharged?: number;
}

export interface NeuralWattUsageHistory {
	window: NeuralWattUsageWindow;
	accountingMethod?: string;
	requests?: number;
	promptTokens?: number;
	completionTokens?: number;
	cacheTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	energyKwhConsumed?: number;
	energyKwhCharged?: number;
	daily: NeuralWattDailyUsage[];
}

export interface ResolvedNeuralWattUsageKey {
	apiKey: string;
	source: "OMP credential" | "NEURALWATT_API_KEY";
}

export type ParseUsageDaysResult = { ok: true; days: number } | { ok: false; message: string };
export type NeuralWattUsageFetchResult = { ok: true; history: NeuralWattUsageHistory } | { ok: false; message: string };

interface UsagePayload {
	ok: true;
	payload: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function malformed(part: string): NeuralWattUsageFetchResult {
	return { ok: false, message: `NeuralWatt returned malformed ${part} usage data.` };
}

function periodMismatch(
	payload: Record<string, unknown>,
	window: NeuralWattUsageWindow,
	part: string,
): string | undefined {
	const period = record(payload.period);
	if (!period) return undefined;
	const start = typeof period.start === "string" ? period.start.slice(0, 10) : undefined;
	const end = typeof period.end === "string" ? period.end.slice(0, 10) : undefined;
	if ((!start || start === window.startDate) && (!end || end === window.endDate)) return undefined;
	return `NeuralWatt returned a ${part} period of ${start ?? "unknown"} to ${end ?? "unknown"} instead of ${window.startDate} to ${window.endDate}.`;
}

function rateLimitMessage(response: Response): string {
	const retryAfter = Number(response.headers.get("retry-after"));
	const retry =
		Number.isFinite(retryAfter) && retryAfter > 0 ? ` Retry in ${Math.ceil(retryAfter)}s.` : " Retry shortly.";
	return `NeuralWatt rate limit reached (429).${retry}`;
}

function statusMessage(response: Response, part: string): string {
	if (response.status === 401) {
		return "NeuralWatt rejected the API key (401). Run /login neuralwatt or set NEURALWATT_API_KEY.";
	}
	if (response.status === 403) return `NeuralWatt denied access to ${part} usage (403).`;
	if (response.status === 429) return rateLimitMessage(response);
	if (response.status >= 500) {
		return `NeuralWatt is unavailable (HTTP ${response.status}). Try again shortly.`;
	}
	return `NeuralWatt ${part} usage request failed (HTTP ${response.status}).`;
}

async function fetchUsagePayload(
	fetchImpl: Fetch,
	apiKey: string,
	part: "summary" | "energy",
	window: NeuralWattUsageWindow,
): Promise<UsagePayload | NeuralWattUsageFetchResult> {
	const url = new URL(`${NEURALWATT_API_BASE_URL}/usage/${part}`);
	url.searchParams.set("start_date", window.startDate);
	url.searchParams.set("end_date", window.endDate);

	let response: Response;
	try {
		response = await fetchImpl(url.toString(), {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			return { ok: false, message: `NeuralWatt ${part} usage request timed out.` };
		}
		return { ok: false, message: "Could not reach NeuralWatt. Check your network and retry." };
	}

	if (!response.ok) return { ok: false, message: statusMessage(response, part) };

	let text: string;
	try {
		text = await response.text();
	} catch {
		return { ok: false, message: "Could not read the NeuralWatt response. Check your network and retry." };
	}

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return { ok: false, message: `NeuralWatt returned malformed JSON for ${part} usage.` };
	}

	const parsed = record(payload);
	if (!parsed) return malformed(part);
	const mismatch = periodMismatch(parsed, window, part);
	if (mismatch) return { ok: false, message: mismatch };
	return { ok: true, payload: parsed };
}

function isFailure(value: UsagePayload | NeuralWattUsageFetchResult): value is NeuralWattUsageFetchResult {
	return value.ok === false;
}

function buildHistory(
	summary: Record<string, unknown>,
	energy: Record<string, unknown>,
	window: NeuralWattUsageWindow,
): NeuralWattUsageFetchResult {
	const summaryTotals = record(summary.totals);
	const summarySeries = summary.time_series;
	const energyTotals = record(energy.totals);
	const energyDaily = energy.daily;
	if (!summaryTotals || !Array.isArray(summarySeries)) return malformed("summary");
	if (!energyTotals || !Array.isArray(energyDaily)) return malformed("energy");

	const daily = new Map<string, NeuralWattDailyUsage>();
	for (const entry of summarySeries) {
		const row = record(entry);
		if (!row || typeof row.date !== "string") return malformed("daily summary");
		const current = daily.get(row.date) ?? { date: row.date };
		current.requests = finiteNumber(row.requests) ?? current.requests;
		current.tokens = finiteNumber(row.total_tokens) ?? current.tokens;
		current.costUsd = finiteNumber(row.cost_usd) ?? current.costUsd;
		daily.set(row.date, current);
	}
	for (const entry of energyDaily) {
		const row = record(entry);
		if (!row || typeof row.date !== "string") return malformed("daily energy");
		const current = daily.get(row.date) ?? { date: row.date };
		current.requests = finiteNumber(row.requests) ?? current.requests;
		current.energyKwh = finiteNumber(row.energy_kwh) ?? current.energyKwh;
		current.energyKwhCharged = finiteNumber(row.energy_kwh_charged) ?? current.energyKwhCharged;
		daily.set(row.date, current);
	}

	const accountingMethod = typeof summary.accounting_method === "string" ? summary.accounting_method : undefined;
	return {
		ok: true,
		history: {
			window,
			...(accountingMethod ? { accountingMethod } : {}),
			requests: finiteNumber(summaryTotals.requests) ?? finiteNumber(energyTotals.requests),
			promptTokens: finiteNumber(summaryTotals.prompt_tokens),
			completionTokens: finiteNumber(summaryTotals.completion_tokens),
			cacheTokens: finiteNumber(summaryTotals.cached_tokens),
			totalTokens: finiteNumber(summaryTotals.total_tokens),
			costUsd: finiteNumber(summaryTotals.total_cost_usd),
			energyKwhConsumed:
				finiteNumber(summaryTotals.energy_kwh_consumed) ??
				finiteNumber(summaryTotals.energy_kwh) ??
				finiteNumber(energyTotals.energy_kwh),
			energyKwhCharged: finiteNumber(summaryTotals.energy_kwh_charged) ?? finiteNumber(energyTotals.energy_kwh_charged),
			daily: [...daily.values()].sort((left, right) => left.date.localeCompare(right.date)),
		},
	};
}

export function parseUsageDays(input: string | undefined): ParseUsageDaysResult {
	const trimmed = input?.trim() ?? "";
	if (!trimmed) return { ok: true, days: 30 };
	if (!/^\d+$/.test(trimmed)) {
		return { ok: false, message: "Days must be a whole number from 1 to 365." };
	}
	const days = Number(trimmed);
	if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
		return { ok: false, message: "Days must be between 1 and 365." };
	}
	return { ok: true, days };
}

export function buildUsageWindow(days: number, now: Date = new Date()): NeuralWattUsageWindow {
	const end = new Date(now);
	const endMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
	const startMs = endMs - (days - 1) * DAY_MS;
	return {
		days,
		startDate: new Date(startMs).toISOString().slice(0, 10),
		endDate: new Date(endMs).toISOString().slice(0, 10),
	};
}

export async function resolveNeuralWattUsageKey(
	loadStored: () => Promise<string | undefined>,
	loadEnv: () => string | undefined = () => process.env[NEURALWATT_API_KEY_ENV],
): Promise<ResolvedNeuralWattUsageKey | undefined> {
	const stored = (await loadStored())?.trim();
	if (stored) return { apiKey: stored, source: "OMP credential" };
	const env = loadEnv()?.trim();
	return env ? { apiKey: env, source: NEURALWATT_API_KEY_ENV } : undefined;
}

export async function fetchNeuralWattUsageHistory(
	apiKey: string,
	window: NeuralWattUsageWindow,
	fetchImpl: Fetch = globalThis.fetch,
	wait: Wait = (ms) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	},
): Promise<NeuralWattUsageFetchResult> {
	const summary = await fetchUsagePayload(fetchImpl, apiKey, "summary", window);
	if (isFailure(summary)) return summary;

	await wait(REQUEST_GAP_MS);

	const energy = await fetchUsagePayload(fetchImpl, apiKey, "energy", window);
	if (isFailure(energy)) return energy;

	return buildHistory(summary.payload, energy.payload, window);
}

function formatInteger(value: number | undefined): string {
	return value === undefined ? "n/a" : Math.trunc(value).toLocaleString("en-US");
}

function formatUsd(value: number | undefined): string {
	return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function formatKwh(value: number | undefined, digits: number): string {
	return value === undefined ? "n/a" : `${value.toFixed(digits)} kWh`;
}

function asciiBar(value: number | undefined, max: number, width = 10): string {
	if (value === undefined || max <= 0 || value <= 0) return ".".repeat(width);
	const filled = Math.max(1, Math.min(width, Math.round((value / max) * width)));
	return "#".repeat(filled) + ".".repeat(width - filled);
}

export function formatNeuralWattUsageReport(
	history: NeuralWattUsageHistory,
	keySource?: ResolvedNeuralWattUsageKey["source"],
): string {
	const lines = [
		`NeuralWatt usage  ${history.window.startDate} to ${history.window.endDate} (${history.window.days} days, UTC)`,
		"Account: NeuralWatt",
		...(keySource ? [`Key source: ${keySource}`] : []),
		...(history.accountingMethod ? [`Billing: ${history.accountingMethod}`] : []),
		"",
		"Totals",
		`  Requests: ${formatInteger(history.requests)}`,
		`  Input tokens: ${formatInteger(history.promptTokens)}`,
		`  Output tokens: ${formatInteger(history.completionTokens)}`,
		`  Cache tokens: ${formatInteger(history.cacheTokens)}`,
		`  Total tokens: ${formatInteger(history.totalTokens)}`,
		`  Cost: ${formatUsd(history.costUsd)}`,
		`  Energy: ${formatKwh(history.energyKwhConsumed, 4)} consumed / ${formatKwh(history.energyKwhCharged, 4)} charged`,
	];

	if (history.daily.length === 0) {
		lines.push("", "Daily", "  No daily rows returned for this window.");
		return lines.join("\n");
	}

	const useEnergyBar = history.daily.every((row) => row.costUsd === undefined);
	const maxBar = Math.max(...history.daily.map((row) => (useEnergyBar ? row.energyKwh : row.costUsd) ?? 0));
	lines.push("", "Daily", "  Date        Reqs        Tokens        Cost         kWh  Bar");
	for (const row of history.daily) {
		const barValue = useEnergyBar ? row.energyKwh : row.costUsd;
		lines.push(
			`  ${row.date}  ${formatInteger(row.requests).padStart(6)}  ${formatInteger(row.tokens).padStart(12)}  ${formatUsd(row.costUsd).padStart(10)}  ${formatKwh(row.energyKwh, 6).padStart(13)}  ${asciiBar(barValue, maxBar)}`,
		);
	}

	return lines.join("\n");
}
