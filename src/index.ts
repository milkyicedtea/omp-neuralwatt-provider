import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createNeuralWattProvider, NEURALWATT_API_KEY_ENV, NEURALWATT_PROVIDER_ID } from "./neuralwatt";
import {
	buildUsageWindow,
	fetchNeuralWattUsageHistory,
	formatNeuralWattUsageReport,
	NEURALWATT_USAGE_COMMAND,
	NEURALWATT_USAGE_MESSAGE_TYPE,
	parseUsageDays,
	resolveNeuralWattUsageKey,
} from "./usage-history";

export {
	createNeuralWattProvider,
	fetchNeuralWattModels,
	fetchNeuralWattUsage,
	NEURALWATT_API_BASE_URL,
	NEURALWATT_API_KEY_ENV,
	NEURALWATT_API_KEY_URL,
	NEURALWATT_PROVIDER_ID,
	neuralWattUsageProvider,
	toProviderModelConfig,
} from "./neuralwatt";
export {
	buildUsageWindow,
	fetchNeuralWattUsageHistory,
	formatNeuralWattUsageReport,
	NEURALWATT_USAGE_COMMAND,
	NEURALWATT_USAGE_MESSAGE_TYPE,
	parseUsageDays,
	resolveNeuralWattUsageKey,
} from "./usage-history";

export default function neuralWattProvider(pi: ExtensionAPI): void {
	pi.registerProvider(NEURALWATT_PROVIDER_ID, createNeuralWattProvider());

	pi.registerCommand(NEURALWATT_USAGE_COMMAND, {
		description: "Show NeuralWatt retrospective usage for the last N days (default: 30)",
		handler: async (args, ctx) => {
			const parsed = parseUsageDays(args);
			if (!parsed.ok) {
				ctx.ui.notify(`${parsed.message} Usage: /${NEURALWATT_USAGE_COMMAND} [days]`, "warning");
				return;
			}

			ctx.ui.setStatus(NEURALWATT_USAGE_COMMAND, `Fetching NeuralWatt usage (${parsed.days} days)...`);
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const resolved = await resolveNeuralWattUsageKey(() =>
					ctx.modelRegistry.authStorage.keys.get(NEURALWATT_PROVIDER_ID, sessionId),
				);
				if (!resolved) {
					ctx.ui.notify(
						`No NeuralWatt API key. Run /login ${NEURALWATT_PROVIDER_ID} or set ${NEURALWATT_API_KEY_ENV}.`,
						"error",
					);
					return;
				}

				const window = buildUsageWindow(parsed.days);
				const result = await fetchNeuralWattUsageHistory(resolved.apiKey, window);
				if (!result.ok) {
					ctx.ui.notify(result.message, "error");
					return;
				}

				pi.sendMessage({
					customType: NEURALWATT_USAGE_MESSAGE_TYPE,
					content: `\`\`\`\n${formatNeuralWattUsageReport(result.history, resolved.source)}\n\`\`\``,
					display: true,
				});
			} catch {
				ctx.ui.notify("Could not read the NeuralWatt credential or usage data.", "error");
			} finally {
				ctx.ui.setStatus(NEURALWATT_USAGE_COMMAND, undefined);
			}
		},
	});
}
