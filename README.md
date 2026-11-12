# Veriq

Veriq runs experiments against applications and reports evidence about explicit
system requirements. The current implementation supports HTTP reachability,
status and header-arrival timing assertions, and a basic sequential latency
experiment. It is under active development.

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
| `veriq latency <url>` | Send configurable sequential GET samples with cancellation and per-attempt evidence. | Five samples; every attempt returns 200 within 200 ms; wait up to 2000 ms per attempt. | JSON by default; `--format text` for readable output. |

Use any HTTP(S) application as your target. Veriq does not require the target to
use TypeScript or Node.js. For example, replace the URL with your application's
health endpoint:

```sh
veriq run http://127.0.0.1:3000/health
veriq run http://127.0.0.1:3000/health --max-duration-ms 500 --timeout-ms 2000 --format json
veriq probe http://127.0.0.1:3000/health --expected-status 200
veriq latency http://127.0.0.1:3000/health --samples 20 --max-duration-ms 200 --timeout-ms 2000 --format text
```

All commands measure arrival of **response headers**. They do not check response
body contents or completion, and they do not follow redirects. A passing request
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
For latency, cancellation preserves FAIL if an earlier sample already failed;
otherwise a partial run is INCONCLUSIVE. Interrupted sampling exits with 130/143.
Help exits with 0.

Request-header values and bodies are omitted from run reports, and URL query
values are redacted. Paths remain visible. See the HTTP reference for reporting
and measurement limits.

## Testing

All standard checks work from this repository alone with dependencies installed:

```sh
npm run check
```

This runs type checking, unit/CLI tests, a build, and real HTTP/latency integration
suites. Tests use small repository-owned fixtures under `test/support/` and
assigned localhost ports. They do not depend on the local `veriq-testcase` folder.
See [testing](docs/testing.md) for individual commands and coverage.

The separate checkout/dependency applications remain optional local experiments
outside this repository; their script is `npm run experiment:timeouts`.

## Documentation

| Document | Contents |
| --- | --- |
| [HTTP reference](docs/http-foundation.md) | Configuration, module responsibilities, execution flow, errors, cancellation and HTTP tests. |
| [Latency reference](docs/latency.md) | Sampling options, cancellation/partial results, summaries and reproducible latency tests. |
| [Timeout/deadline experiment](docs/dependency-timeouts.md) | Test checkout's handling of slow dependencies and a shared application deadline. |
| [Testing guide](docs/testing.md) | Automated checks, target setup, failure cases and expected outcomes. |
| [Contributing](CONTRIBUTING.md) | Development workflow and preparing the first GitHub push. |
| [Plan](PLAN.md) | Completed milestones and planned work. |
