# Testing Veriq

This guide lists the checks, their prerequisites, and the expected results.
Run commands from the Veriq repository root.

## Workspace layout

All standard automated checks are self-contained in the Veriq repository.
Use Node.js 22.18 or newer and install dependencies with `npm ci`.

```text
veriq/
├── src/
├── test/
│   ├── *.test.ts
│   ├── integration/
│   │   ├── http-run.test.ts
│   │   ├── latency.test.ts
│   │   └── concurrency.test.ts
│   └── support/
│       ├── http-target.ts
│       ├── cli-process.ts
│       └── concurrency-target.ts
└── package.json
```

`test/support/http-target.ts` is a small HTTP fixture owned by Veriq's tests.
It supplies real HTTP behavior without importing a separate application.
`cli-process.ts` runs the compiled CLI and bounds child-process execution.
These helpers belong in the Veriq repository. The separate local
`veriq-testcase` applications are not needed for normal verification and are
not included in this repository.

## Automated commands

| Command | What it does | Requirements | Expected result |
| --- | --- | --- | --- |
| `npm run build` | Compile production TypeScript into `dist/`. | Installed dependencies. | Updated executable JavaScript; exit 0. |
| `npm test` | Run unit and CLI-validation tests against source. | Installed dependencies. | All assertions pass; exit 0. |
| `npm run typecheck` | Check source and all repository-owned tests without emitting files. | Installed dependencies. | No type errors; exit 0. |
| `npm run test:integration` | Build and test the compiled HTTP, latency and concurrency commands over real local connections. | Permission to listen on localhost. | All assertions pass; exit 0. |
| `npm run check` | Run type checking, unit/CLI tests, build and all integration suites. | Installed dependencies and localhost permission. | Full verification passes; exit 0. |

Before a commit, run:

```sh
npm run check
```

The integration suites start their own fixtures on automatically assigned ports
and clean up their owned processes and connections. Manually running servers
and external folders are not required. A deliberately expected FAIL report
from Veriq is a passing test when it matches the asserted failure behavior.

## What each test file covers

| Test file | Responsibility |
| --- | --- |
| `test/cli.test.ts` | Help, argument validation, configuration/URL conflicts and structured invocation errors. |
| `test/config-file.test.ts` | Valid JSON, malformed JSON, invalid UTF-8, oversized input, missing paths and non-file input. |
| `test/http-config.test.ts` | Defaults, input snapshots, methods, timing/status validation, header/body limits and URL redaction. |
| `test/http-assertion.test.ts` | Expected status, exact duration boundary, late/wrong responses, timeout and invalid requirements. |
| `test/http-experiment.test.ts` | Evidence/result separation, cancellation ordering, listener cleanup, overlapping-run isolation, transport classification, internal errors, bounded body cleanup and secret omission. |
| `test/http-latency-summary.test.ts` | Known percentile/mean calculations, non-mutating summaries, outcome counts and response-only statistics. |
| `test/integration/http-run.test.ts` | Real compiled-CLI requests, text/JSON output, legacy probe, redirects, streaming cleanup, lateness, timeout, POST/HEAD, signals, reset and refused connections. |
| `test/http-concurrency.test.ts` | Worker caps, unique claims, out-of-order completions, HTTP settings, target failures, cancellation fan-out, internal/cleanup failures and secret omission. |
| `test/integration/concurrency.test.ts` | Actual overlapping requests, independent server counters, busy responses, POST configuration, text/JSON, cancellation, timeouts and refused connections. |
| `test/http-latency.test.ts` | Configurable sequential sampling, target failures, partial completion, cancellation precedence, internal/cleanup errors and unavailable response statistics. |
| `test/integration/latency.test.ts` | Real default/configured latency runs, text/JSON, consistent/occasional delays, status requirements, timeouts, signal cancellation and refused connections. |

DNS/TLS classification tests use controlled runtime errors. They verify
classification rules, not real public DNS resolution or certificate-handshake
behavior. Local HTTP integration tests exercise actual sockets.

## Manual HTTP tests

Start the repository-owned fixture in terminal A:

```sh
node --input-type=module -e 'import { createHttpTarget } from "./test/support/http-target.ts"; createHttpTarget().listen(4300, "127.0.0.1");'
```

The fixture listens at `http://127.0.0.1:4300`. If that port is occupied,
change the listen port and update the URLs/configuration accordingly. Stop the
fixture with Ctrl+C after testing.

Run the following from terminal B. Each row is a separate experiment.

| Behavior | Command | Expected evidence/result |
| --- | --- | --- |
| Healthy headers | `veriq run http://127.0.0.1:4300/health` | 200 within the requirement; PASS. |
| JSON configuration | `veriq run --config examples/http.json --format json` | Versioned JSON with evidence, assertion and PASS. |
| Missing route | `veriq run http://127.0.0.1:4300/missing` | 404; FAIL under the default expected-200 rule. |
| Redirect | `veriq run http://127.0.0.1:4300/redirect --format json` | 302 recorded; no follow-up request; FAIL. |
| Ongoing body | `veriq run http://127.0.0.1:4300/stream --format json` | Header observation passes; unread body is cancelled. |
| Late response | `veriq run 'http://127.0.0.1:4300/delay?ms=500' --max-duration-ms 100 --timeout-ms 2000` | Received 200 after the 100 ms requirement; FAIL. |
| No headers | `veriq run http://127.0.0.1:4300/hang --timeout-ms 200` | Timeout with null status; FAIL. |
| Reset connection | `veriq run http://127.0.0.1:4300/reset --format json` | Request-error evidence; FAIL. |
| Invalid configuration | `veriq run http://127.0.0.1:4300/health --max-duration-ms 2000 --timeout-ms 100` | ERROR before any request. |

To test cancellation, run:

```sh
veriq run http://127.0.0.1:4300/hang --timeout-ms 10000 --format json
```

Press Ctrl+C before the timeout. Expect cancelled evidence, INCONCLUSIVE,
`assertion.passed: null`, and exit code 130. Check the code immediately with
`echo $?`. SIGTERM cancellation uses 143.

To test a refused connection, stop the target and run `/health` again. Expect
request-error evidence with a connection category and FAIL rather than an HTTP
status. Configured millisecond cutoffs are practical timer limits; scheduling
and machine load can affect the exact observed durations.

## Testing each source component

| Component | What it does | How to verify it |
| --- | --- | --- |
| `src/cli.ts` | Parse arguments, handle run signals and choose output/exit behavior. | CLI unit tests and compiled-CLI integration suite. |
| `src/config-file.ts` | Read a bounded UTF-8 JSON file. | Configuration-file unit tests. |
| `src/http-config.ts` | Validate request settings and redact reported URLs. | Configuration unit tests and integration POST/redaction cases. |
| `src/http-observation.ts` | Execute HTTP, time header arrival, classify failures and release resources. | Lifecycle unit tests plus real HTTP integration cases. |
| `src/http-experiment.ts` | Give the run an identity and turn evidence into an assertion, result and finding. | Experiment unit tests and JSON integration reports. |
| `src/http-assertion.ts` | Evaluate status and duration. | Assertion boundary unit tests and manual wrong-status/late cases. |
| `src/http-probe.ts` | Provide the original GET API through the shared observation lifecycle. | Legacy probe integration case and manual probe commands. |
| `src/http-concurrency.ts` | Own bounded worker scheduling and aggregate request evidence/results. | Concurrency unit and integration suites. |
| `src/concurrency-report.ts` | Render status counts, client peak, request records and summaries. | Concurrency formatting and CLI tests. |
| `src/http-latency.ts` | Coordinate configurable sequential attempts and partial completion. | Immediate, slow, occasional-delay and failure experiments in the [latency guide](latency.md). |
| `src/http-latency-summary.ts` | Count outcomes and summarize received-response durations. | Latency-summary unit tests with known distributions. |
| `src/report.ts` | Format run reports as text or JSON. | Experiment unit tests and CLI text/JSON integration cases. |
| `src/latency-report.ts` | Format latency samples and summaries as text or JSON. | Latency unit and CLI integration cases. |
| `src/cli-cancellation.ts` | Share process-signal handling across run, latency and concurrency. | Real SIGINT/SIGTERM integration cases. |

See [the latency guide](latency.md) for repeated-request tests and
[the timeout/deadline guide](dependency-timeouts.md) for checkout experiments.
These are separate properties; a passing failure-handling test does not mean
checkout completed successfully.

## Optional local application experiments

The checkout/dependency experiments are separate from the standard suite. If
maintaining the local companion applications, keep them outside this repository:

```text
workspace/
├── veriq/
└── veriq-testcase/
    ├── http-foundation/
    ├── http-reachability/
    └── dependency-timeout/
        ├── payment.ts
        ├── checkout.ts
        └── experiment.test.ts
```

With that local checkout experiment available:

```sh
npm run experiment:timeouts
```

This explicitly optional script replaces the former `test:timeouts` script.
It builds Veriq and runs the external checkout experiments. It is not part of
`npm run check`, does not run in a standalone checkout, and does not require
pushing the companion folder to GitHub. The external experiment expects its
sibling repository directory to be named `veriq`.

For optional real booking-state and busy-server experiments, use
`npm run experiment:concurrency` with the sibling `concurrency` application
available. This tests SQLite-backed seat uniqueness, including two application
processes sharing a database. It is not part of the standard suite. See
[concurrency](concurrency.md) for setup, expected evidence and limits.
