# Changelog

## 0.3.0 - 2026-11-22

- Add `/neuralwatt-usage [days]` for retrospective usage over a UTC date window, defaulting to 30 days and accepting 1-365.
- Report request, input/output/cache token, cost, and energy totals from NeuralWatt's aggregated usage and energy endpoints, plus a chronological daily series with an ASCII cost bar.
- Resolve the API key from OMP credentials before `NEURALWATT_API_KEY`, never print the key, and surface 401, 403, 429, 5xx, malformed JSON, invalid payloads, timeouts, and network failures as user-facing messages.
- Space the two usage requests by one second and leave the built-in `/usage` quota report unchanged.

## 0.2.0 - 2026-11-22

- Report NeuralWatt account quota through OMP's built-in `/usage` command and `omp usage --provider neuralwatt`, sourced from authenticated `GET /v1/quota`.
- Show subscription energy against the billing-period allowance, daily free energy, the prepaid USD credit balance, and per-key spending allowances with reset windows and usage bars.
- Include current calendar-month spend and request count as provider notes, and label reports by API-key name when available.
- Return no report on quota failures so OMP retains the last successful snapshot and applies its normal backoff.
- Add a tag-triggered release workflow that validates the package version and changelog, runs typecheck/tests/lint, and creates a GitHub Release from the matching changelog section.

## 0.1.0 - 2026-11-06

- Initial public release: NeuralWatt provider registration, API-key login, live model discovery, and catalog metadata mapping for Oh My Pi.
