# Veriq

Veriq runs experiments against applications and reports evidence about explicit
system requirements. The current implementation supports HTTP reachability,
status and header-arrival timing assertions, configurable sequential latency,
bounded HTTP concurrency, HTTP/JSON idempotency, controlled retries, per-caller
rate limits and JSON cache behavior experiments.
It is under active development.

## Setup

Use Node.js **22.18 or newer** and npm. From the repository root:

```sh
npm ci
npm link
veriq --help
```

Installation builds `src/` into `dist/`. `npm link` makes the local `veriq`
executable available through your current Node installation. Run `npm run build`
after changing source to update that executable. Without linking, use
`npm run dev -- run <url>` or `node dist/cli.js run <url>`.

## Commands

| Command | What it does | Default requirement | Output |
| --- | --- | --- | --- |
| `veriq run <url>` | Execute one configured, cancellable HTTP experiment. | GET, status 200 within 2000 ms. | Text; `--format json` for a versioned JSON report. |
| `veriq run --config <file>` | Load request and assertion settings from JSON. | Defaults apply to omitted settings. | Text or JSON. |
| `veriq probe <url>` | Execute a single GET using the original command interface. | Status 200 within 2000 ms. | JSON. |
| `veriq cache --config <file>` | Verify reuse, TTL expiry, normal-write freshness, caller/key isolation and coalesced refresh using explicit source counters. | Fixed TTL 1000 ms, two warm reads, five burst reads, immediate normal-write freshness. | Text or `--format json`. |
| `veriq rate-limit --config <file>` | Check anchored-window allowance, caller isolation, reset and concurrent admission. | Three accepted requests per fresh caller per second; excess status 429. | Text or `--format json`. |
| `veriq retry <url>` / `--config <file>` | Execute a classified retry policy with bounded attempts, backoff/jitter and an overall budget; audit declared writes. | Three attempts, 10 s overall, 100 ms base, 2 s exponential cap, full jitter. | Text or `--format json`. |
| `veriq idempotency --config <file>` | Verify sequential/concurrent same-key replays, changed-input rejection and declared effect counts. Requires a JSON response/state API contract. | Fresh keys, three sequential and five concurrent attempts, conflict status 409. | Text or `--format json`. |
| `veriq concurrency <url>` | Send a bounded number of overlapping HTTP attempts. Accepts `--config` for headers/body. | 20 requests, concurrency 5, status 200 within 500 ms, wait up to 2000 ms each. | Text by default; `--format json` for full evidence. |
| `veriq latency <url>` | Send configurable sequential GET samples with cancellation and per-attempt evidence. | Five samples; every attempt returns 200 within 200 ms; wait up to 2000 ms per attempt. | JSON by default; `--format text` for readable output. |

Use any HTTP(S) application as your target. Veriq does not require the target to
use TypeScript or Node.js. For example, replace the URL with your application's
health endpoint:

```sh
veriq run http://127.0.0.1:3000/health
veriq run http://127.0.0.1:3000/health --max-duration-ms 500 --timeout-ms 2000 --format json
veriq probe http://127.0.0.1:3000/health --expected-status 200
veriq latency http://127.0.0.1:3000/health --samples 20 --max-duration-ms 200 --timeout-ms 2000 --format text
veriq concurrency http://127.0.0.1:3000/health --requests 100 --concurrency 10 --format text
veriq retry http://127.0.0.1:3000/health --max-attempts 3 --deadline-ms 5000
```

Run, probe, latency, concurrency, retry and rate-limit operations measure arrival of **response headers**.
They do not check response-body contents or completion. Idempotency reads bounded
JSON responses and declared effect counts; cache experiments read bounded JSON
and compare selected values and source-load counters; retry write audits also read bounded
JSON. See each explicit API contract.
Commands do not follow redirects. A passing request
does not establish sustained availability or correctness of the whole application.

## Configuration

[examples/http.json](examples/http.json) contains a complete GET example:

```json
{
  "target": "http://127.0.0.1:4300/health",
  "method": "GET",
  "headers": { "accept": "application/json" },
  "timeoutMs": 2000,
  "maxDurationMs": 1000,
  "expectedStatus": 200
}
```

```sh
veriq run --config examples/http.json --format json
```

`maxDurationMs` is the response requirement. `timeoutMs` is how long Veriq
observes; it must be at least as long as the requirement. Configure headers and
optional string request bodies in JSON. Request-setting CLI overrides cannot be
combined with `--config`; output format can. See the
[HTTP reference](docs/http-foundation.md) for supported methods and validation limits.

## Results

| Result | Meaning | Exit code |
| --- | --- | --- |
| PASS | This request met its status and duration requirement. | 0 |
| FAIL | The requirement was not met, including timeout or transport failure. | 1 |
| ERROR | Invalid invocation/configuration or Veriq execution/cleanup failure. | 2 |
| INCONCLUSIVE | Execution was cancelled before the assertion could be evaluated. | 3; 130 for SIGINT, 143 for SIGTERM. |

For `run`, Ctrl+C before headers cancels the request and emits an INCONCLUSIVE
report. Run JSON contains `schemaVersion`, `runId`, configuration, evidence,
assertion, result, finding and any execution error. Reports go to stdout;
invocation/configuration errors go to stderr. Probe keeps its JSON output; latency defaults to JSON and also supports text.
For latency and concurrency, cancellation preserves FAIL if an earlier sample already failed;
otherwise a partial run is INCONCLUSIVE. Interrupted sampling exits with 130/143.
For rate-limit experiments, missing admission evidence is INCONCLUSIVE; an observed
requirement violation is FAIL. See the [rate-limit reference](docs/rate-limit.md).
For cache experiments, unavailable source state or TTL-window uncertainty is
INCONCLUSIVE; observed violations are FAIL. See [caching](docs/caching.md).
Help exits with 0.

Request-header values and bodies are omitted from run reports, and URL query
values are redacted. Paths remain visible. See the HTTP reference for reporting
and measurement limits.

## Testing

All standard checks work from this repository alone with dependencies installed:

```sh
npm run check
```

This runs type checking, unit/CLI tests, a build, and real HTTP, latency and concurrency integration
suites. Tests use small repository-owned fixtures under `test/support/` and
assigned localhost ports. They do not depend on the local `veriq-testcase` folder.
See [testing](docs/testing.md) for individual commands and coverage.

The separate checkout/dependency applications remain optional local experiments
outside this repository; their script is `npm run experiment:timeouts`.
The optional busy-server and persisted booking-race experiments run with
`npm run experiment:concurrency`. Neither local application folder is needed
for standard checks. The optional idempotency application and durable replay
experiments run with `npm run experiment:idempotency`. Local retry recovery and
SQLite effect-safety comparisons use `npm run experiment:retry`. Local rate-limit
comparisons and shared-database checks use `npm run experiment:rate-limit`.
Local SQLite-origin cache comparisons use `npm run experiment:cache`.

## Documentation

| Document | Contents |
| --- | --- |
| [HTTP reference](docs/http-foundation.md) | Configuration, module responsibilities, execution flow, errors, cancellation and HTTP tests. |
| [Caching reference](docs/caching.md) | Explicit source instrumentation, reuse, TTL, invalidation, isolation, stampedes and process-local cache limits. |
| [Rate-limit reference](docs/rate-limit.md) | Per-caller window contracts, allowance, isolation, reset, concurrent caps and local experiments. |
| [Retry reference](docs/retry.md) | Classification, backoff/jitter, shared deadlines, server guidance, write safety and experiments. |
| [Idempotency reference](docs/idempotency.md) | Required API contract, replay/effect assertions, JSON bounds, local applications and verification. |
| [Concurrency reference](docs/concurrency.md) | Worker limits, HTTP settings, cancellation, reports, capacity and persisted booking-race experiments. |
| [Latency reference](docs/latency.md) | Sampling options, cancellation/partial results, summaries and reproducible latency tests. |
| [Timeout/deadline experiment](docs/dependency-timeouts.md) | Test checkout's handling of slow dependencies and a shared application deadline. |
| [Testing guide](docs/testing.md) | Automated checks, target setup, failure cases and expected outcomes. |
| [Contributing](CONTRIBUTING.md) | Development workflow and preparing the first GitHub push. |
| [Plan](PLAN.md) | Completed milestones and planned work. |
