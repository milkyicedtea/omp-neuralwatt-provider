import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createNeuralWattProvider, NEURALWATT_PROVIDER_ID } from "./neuralwatt.js";

export {
  createNeuralWattProvider,
  fetchNeuralWattModels,
  NEURALWATT_API_BASE_URL,
  NEURALWATT_API_KEY_ENV,
  NEURALWATT_API_KEY_URL,
  NEURALWATT_PROVIDER_ID,
  toProviderModelConfig,
} from "./neuralwatt.js";

export default function neuralWattProvider(pi: ExtensionAPI): void {
  pi.registerProvider(NEURALWATT_PROVIDER_ID, createNeuralWattProvider());
}
