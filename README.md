# omp NeuralWatt provider

First-class [NeuralWatt](https://neuralwatt.com) provider for [Oh My Pi](https://omp.sh). It adds `neuralwatt` to OMP's provider registry, so `/login neuralwatt` performs the API-key setup and `/model` lists the authenticated NeuralWatt catalog.

## Install

```sh
omp install github:milkyicedtea/omp-neuralwatt-provider#v0.1.0
```

For local development:

```sh
omp plugin link /path/to/omp-neuralwatt-provider
```

Start a new OMP session after installation.

## Authenticate and select a model

1. Run `/login neuralwatt`.
2. OMP opens NeuralWatt's API-key page. Create a key and paste the `sk-...` value into the masked prompt.
3. The plugin validates the key against the authenticated NeuralWatt model catalog.
4. Run `/model` and choose `neuralwatt/<model-id>`.

The login credential is persisted by OMP's credential store. The plugin does not create or maintain a second credential file.

Alternatively, set `NEURALWATT_API_KEY` before starting OMP. A stored `/login` key takes precedence over that environment fallback.

```sh
export NEURALWATT_API_KEY='sk-...'
omp models refresh neuralwatt
```

## Behavior

- Uses NeuralWatt's OpenAI-compatible `https://api.neuralwatt.com/v1/chat/completions` API.
- Discovers models from authenticated `GET /v1/models` responses. A `public` catalog is rejected because it indicates that the API key was not accepted.
- Registers only chat models. Embedding and decision models advertised through `metadata.capabilities.task` are excluded.
- Carries catalog metadata into OMP: display name, context/output limits, vision, tools, reasoning effort levels, and per-million-token pricing.
- Uses the normal OMP OpenAI Completions transport. No custom request or streaming implementation is maintained.

## Development

```sh
bun install
bun run typecheck
bun test
```

The tests cover model mapping plus the complete API-key-login callback contract with a mocked NeuralWatt catalog. A live OMP smoke test requires a real NeuralWatt key:

```sh
omp --extension . -p --model neuralwatt/<model-id> 'Reply with only OK'
```
