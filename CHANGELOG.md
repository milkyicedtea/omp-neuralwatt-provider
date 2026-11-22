# Changelog

## 0.2.0 - 2026-11-22

- Report NeuralWatt account quota through OMP's built-in `/usage` command and `omp usage --provider neuralwatt`, sourced from authenticated `GET /v1/quota`.
- Show subscription energy against the billing-period allowance, daily free energy, the prepaid USD credit balance, and per-key spending allowances with reset windows and usage bars.
- Include current calendar-month spend and request count as provider notes, and label reports by API-key name when available.
- Return no report on quota failures so OMP retains the last successful snapshot and applies its normal backoff.
- Add a tag-triggered release workflow that validates the package version and changelog, runs typecheck/tests/lint, and creates a GitHub Release from the matching changelog section.

## 0.1.0 - 2026-11-06

- Initial public release: NeuralWatt provider registration, API-key login, live model discovery, and catalog metadata mapping for Oh My Pi.
