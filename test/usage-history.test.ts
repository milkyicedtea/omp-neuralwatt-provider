import { describe, expect, test } from "bun:test";
import { NEURALWATT_API_KEY_ENV } from "../src/neuralwatt.js";
import {
	buildUsageWindow,
	fetchNeuralWattUsageHistory,
	formatNeuralWattUsageReport,
	parseUsageDays,
	resolveNeuralWattUsageKey,
} from "../src/usage-history.js";

const window = buildUsageWindow(7, new Date("2026-11-22T12:00:00Z"));

const summary = {
	period: { start: "2026-11-16", end: "2026-11-22" },
	accounting_method: "energy",
	totals: {
		requests: 100,
		total_tokens: 1_000,
		prompt_tokens: 700,
		completion_tokens: 300,
		cached_tokens: 100,
		total_cost_usd: 1.25,
		energy_kwh_consumed: 0.02,
		energy_kwh_charged: 0.015,
	},
	time_series: [
		{ date: "2026-11-22", requests: 40, total_tokens: 400, cost_usd: 0.5 },
		{ date: "2026-11-21", requests: 60, total_tokens: 600, cost_usd: 0.75 },
	],
};

const energy = {
	period: { start: "2026-11-16", end: "2026-11-22" },
	totals: {
		requests: 100,
		requests_with_energy: 98,
		energy_kwh: 0.02,
		energy_kwh_charged: 0.015,
		energy_joules: 72_000,
	},
	daily: [
		{ date: "2026-11-22", requests: 40, energy_kwh: 0.008, energy_kwh_charged: 0.006 },
		{ date: "2026-11-21", requests: 60, energy_kwh: 0.012, energy_kwh_charged: 0.009 },
	],
};

const noWait = async () => {};

function usageFetch(
	requests: { url: string; authorization: string }[],
	summaryPayload: unknown = summary,
	energyPayload: unknown = energy,
) {
	return async (url: string, init?: RequestInit) => {
		requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") ?? "" });
		return Response.json(url.includes("/usage/summary") ? summaryPayload : energyPayload);
	};
}

describe("NeuralWatt usage arguments", () => {
	test("defaults to 30 days and accepts explicit whole-day windows", () => {
		expect(parseUsageDays(undefined)).toEqual({ ok: true, days: 30 });
		expect(parseUsageDays("")).toEqual({ ok: true, days: 30 });
		expect(parseUsageDays("7")).toEqual({ ok: true, days: 7 });
		expect(parseUsageDays(" 365 ")).toEqual({ ok: true, days: 365 });
	});

	test("rejects non-integers and out-of-range day counts", () => {
		for (const input of ["0", "366", "abc", "1.5", "-1", "7 8"]) {
			const parsed = parseUsageDays(input);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.message.length).toBeGreaterThan(0);
		}
	});

	test("builds an inclusive UTC window ending today", () => {
		expect(buildUsageWindow(30, new Date("2026-11-22T23:30:00Z"))).toEqual({
			days: 30,
			startDate: "2026-10-24",
			endDate: "2026-11-22",
		});
		expect(buildUsageWindow(7, new Date("2026-11-22T00:00:00Z"))).toEqual({
			days: 7,
			startDate: "2026-11-16",
			endDate: "2026-11-22",
		});
		expect(buildUsageWindow(30, new Date("2026-01-01T00:00:00Z"))).toEqual({
			days: 30,
			startDate: "2025-12-03",
			endDate: "2026-01-01",
		});
	});
});

describe("NeuralWatt usage resolution", () => {
	test("prefers the OMP credential and falls back to the environment", async () => {
		await expect(
			resolveNeuralWattUsageKey(
				async () => " sk-stored ",
				() => "sk-env",
			),
		).resolves.toEqual({ apiKey: "sk-stored", source: "OMP credential" });
		await expect(
			resolveNeuralWattUsageKey(
				async () => undefined,
				() => " sk-env ",
			),
		).resolves.toEqual({ apiKey: "sk-env", source: NEURALWATT_API_KEY_ENV });
		await expect(
			resolveNeuralWattUsageKey(
				async () => undefined,
				() => undefined,
			),
		).resolves.toBeUndefined();
	});

	test("never includes the resolved key in the rendered report", async () => {
		const requests: { url: string; authorization: string }[] = [];
		const result = await fetchNeuralWattUsageHistory("sk-secret", window, usageFetch(requests), noWait);
		if (!result.ok) throw new Error(result.message);
		const rendered = formatNeuralWattUsageReport(result.history, "OMP credential");
		expect(rendered).not.toContain("sk-secret");
		expect(rendered).not.toContain("Authorization");
	});
});

describe("NeuralWatt retrospective usage", () => {
	test("fetches summary and energy sequentially and merges the daily series", async () => {
		const requests: { url: string; authorization: string }[] = [];
		const waits: number[] = [];
		const result = await fetchNeuralWattUsageHistory("sk-test", window, usageFetch(requests), async (ms) => {
			waits.push(ms);
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);

		expect(waits).toEqual([1_000]);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.authorization).toBe("Bearer sk-test");
		expect(requests[0]?.url).toContain("/v1/usage/summary?start_date=2026-11-16&end_date=2026-11-22");
		expect(requests[1]?.url).toContain("/v1/usage/energy?start_date=2026-11-16&end_date=2026-11-22");

		expect(result.history).toMatchObject({
			window,
			accountingMethod: "energy",
			requests: 100,
			promptTokens: 700,
			completionTokens: 300,
			cacheTokens: 100,
			totalTokens: 1_000,
			costUsd: 1.25,
			energyKwhConsumed: 0.02,
			energyKwhCharged: 0.015,
		});
		expect(result.history.daily).toEqual([
			{
				date: "2026-11-21",
				requests: 60,
				tokens: 600,
				costUsd: 0.75,
				energyKwh: 0.012,
				energyKwhCharged: 0.009,
			},
			{
				date: "2026-11-22",
				requests: 40,
				tokens: 400,
				costUsd: 0.5,
				energyKwh: 0.008,
				energyKwhCharged: 0.006,
			},
		]);

		const rendered = formatNeuralWattUsageReport(result.history, "OMP credential");
		expect(rendered).toContain("2026-11-16 to 2026-11-22 (7 days, UTC)");
		expect(rendered).toContain("Account: NeuralWatt");
		expect(rendered).toContain("Key source: OMP credential");
		expect(rendered).toContain("Billing: energy");
		expect(rendered).toContain("Cost: $1.2500");
		expect(rendered).toContain("Energy: 0.0200 kWh consumed / 0.0150 kWh charged");
		expect(rendered).toContain("2026-11-21");
		expect(rendered).toContain("$0.7500");
		expect(rendered).toContain("0.012000 kWh");
		expect(rendered).toContain("#");
		expect(rendered).not.toContain("watt");
	});

	test("reports missing optional values as n/a instead of zero", async () => {
		const requests: { url: string; authorization: string }[] = [];
		const result = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			usageFetch(
				requests,
				{
					period: summary.period,
					totals: {},
					time_series: [{ date: "2026-11-22" }],
				},
				{ period: energy.period, totals: {}, daily: [{ date: "2026-11-22" }] },
			),
			noWait,
		);
		if (!result.ok) throw new Error(result.message);
		const rendered = formatNeuralWattUsageReport(result.history);
		expect(rendered).toContain("Requests: n/a");
		expect(rendered).toContain("Cost: n/a");
		expect(rendered).toContain("Energy: n/a consumed / n/a charged");
	});
});

describe("NeuralWatt usage failures", () => {
	test("surfaces HTTP, JSON, network, and payload failures", async () => {
		const unauthorized = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () => new Response("{}", { status: 401 }),
			noWait,
		);
		expect(unauthorized.ok).toBe(false);
		if (!unauthorized.ok) expect(unauthorized.message).toContain("401");

		const limited = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }),
			noWait,
		);
		expect(limited.ok).toBe(false);
		if (!limited.ok) {
			expect(limited.message).toContain("429");
			expect(limited.message).toContain("7s");
		}

		const unavailable = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () => new Response("{}", { status: 503 }),
			noWait,
		);
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) expect(unavailable.message).toContain("503");

		const malformedJson = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () => new Response("{oops", { status: 200 }),
			noWait,
		);
		expect(malformedJson.ok).toBe(false);
		if (!malformedJson.ok) expect(malformedJson.message).toContain("malformed JSON");

		const network = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () => {
				throw new Error("socket closed");
			},
			noWait,
		);
		expect(network.ok).toBe(false);
		if (!network.ok) expect(network.message).toContain("Could not reach NeuralWatt");
	});

	test("rejects malformed payloads and silently changed periods", async () => {
		const malformed = await fetchNeuralWattUsageHistory("sk-test", window, async () => Response.json({}), noWait);
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.message).toContain("malformed");

		const changed = await fetchNeuralWattUsageHistory(
			"sk-test",
			window,
			async () =>
				Response.json({
					period: { start: "2026-01-01", end: "2026-01-07" },
					totals: {},
					time_series: [],
				}),
			noWait,
		);
		expect(changed.ok).toBe(false);
		if (!changed.ok) {
			expect(changed.message).toContain("instead of");
			expect(changed.message).toContain("2026-11-16 to 2026-11-22");
		}
	});
});
