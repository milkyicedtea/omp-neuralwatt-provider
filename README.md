# omp NeuralWatt provider

First-class [NeuralWatt](https://neuralwatt.com) provider for [Oh My Pi](https://omp.sh). It adds `neuralwatt` to OMP's provider registry, so `/login neuralwatt` performs the API-key setup and `/model` lists the authenticated NeuralWatt catalog.

## Install

```sh
omp install github:milkyicedtea/omp-neuralwatt-provider#v0.3.0
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
- Reports account quota through OMP's built-in `/usage` command (and `omp usage --provider neuralwatt`) from authenticated `GET /v1/quota`: subscription energy, daily free energy, prepaid credit balance, and per-key spending allowance.
- Provides `/neuralwatt-usage [days]` for retrospective token, cost, and energy reporting. It reads NeuralWatt's usage summary and energy endpoints and never changes `/usage`.
- Uses the normal OMP OpenAI Completions transport. No custom request or streaming implementation is maintained.

## Retrospective usage

`/neuralwatt-usage` reports what the account actually used over a UTC date window. This is separate from `/usage`, which shows live quota and allowance state.

```sh
/neuralwatt-usage       # last 30 days
/neuralwatt-usage 7     # last 7 days
/neuralwatt-usage 365   # maximum window
```

The report includes request and token totals, charged cost in USD, consumed and charged energy in kWh, and a per-day series with an ASCII cost bar. The command resolves the key from OMP credentials first, then `NEURALWATT_API_KEY`; it never prints the key. Requests are spaced to respect NeuralWatt's one-request-per-second limit. Invalid arguments such as `0`, `abc`, or `366` return a usage error.

## Development

```sh
bun install
bun run typecheck
bun test
```

The tests cover model mapping, the complete API-key-login callback contract, and quota-to-usage mapping with mocked NeuralWatt responses. A live OMP smoke test requires a real NeuralWatt key:

```sh
omp --extension . -p --model neuralwatt/<model-id> 'Reply with only OK'
```

## Release

Update `package.json` and the matching dated section in `CHANGELOG.md`, then push a `v<version>` tag. The release workflow validates that the tag, package version, and changelog agree, runs typecheck/tests/lint, and creates a GitHub Release with the changelog body. GitHub generates the source archives; no binaries are attached.
