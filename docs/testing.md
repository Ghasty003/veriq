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
│   │   ├── concurrency.test.ts
│   │   ├── idempotency.test.ts
│   │   ├── retry.test.ts
│   │   ├── rate-limit.test.ts
│   │   ├── cache.test.ts
│   │   └── load.test.ts
│   └── support/
│       ├── http-target.ts
│       ├── cli-process.ts
│       ├── concurrency-target.ts
│       ├── idempotency-target.ts
│       ├── retry-target.ts
│       ├── rate-limit-target.ts
│       ├── cache-target.ts
│       └── load-target.ts
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
| `npm run test:integration` | Build and test the compiled HTTP, latency, concurrency, idempotency, retry, rate-limit, cache and load commands over real local connections. | Permission to listen on localhost. | All assertions pass; exit 0. |
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
| `test/bounded-workers.test.ts` | Admission closure drains active actions; admission exceptions stop and settle workers. |
| `test/load-config.test.ts` | Increasing levels, endpoint requirements, sample/work caps and budget validation. |
| `test/load-summary.test.ts` | Distinct response populations, failure fractions, null measurements and exact rate denominators. |
| `test/http-load.test.ts` | Timed stages, caps, samples, throughput floors, original/clipped timeouts, partial failures, observer errors and cancellation during cleanup. |
| `test/integration/load.test.ts` | Real plateau/queueing, healthy simulated I/O, rejection, damaged recovery, body/header settings, deadlines and signals. |
| `test/cache-config.test.ts` | Endpoint roles, bounded policy settings, safe URL templates and generated JSON writes. |
| `test/http-cache.test.ts` | Pre-cancellation, fresh-state preconditions, sanitized observer failures, transport uncertainty and retained partial violations. |
| `test/integration/cache.test.ts` | Actual cache hits/loads, TTL expiry, normal-write freshness, isolation, stampedes, invalid counters, JSON limits, deadline/signals and in-flight invalidation. |
| `test/rate-limit-config.test.ts` | Strict fresh-caller window, status, identity-header and budget validation. |
| `test/http-rate-limit.test.ts` | Pre-cancellation, unknown transport outcomes, sanitized internal errors and retained known failures. |
| `test/integration/rate-limit.test.ts` | Real allowance/isolation/reset/burst behavior, broken modes, window overruns, deadlines, optional Retry-After and signals. |
| `test/retry-policy.test.ts` | Configuration, mutation gating, exponential caps/full jitter, Retry-After formats and failure classification. |
| `test/http-retry.test.ts` | Recovery, exhaustion, shared budgets, cancellation, internal/cleanup failures and stable-key state audits. |
| `test/integration/retry.test.ts` | Real recovery/persistent/permanent responses, server delay timing, deadline clipping, slow success, signals and lost-write effects. |
| `test/http-idempotency.test.ts` | Declared contract validation, replay/effect assertions, fresh-state preconditions, unknown original outcomes and internal/cancellation paths. |
| `test/http-json.test.ts` | Bounded JSON reads, invalid UTF-8/JSON, body limits, cancellation, sanitized transport/internal errors. |
| `test/json-value.test.ts` | Canonical fingerprints and safe JSON Pointer selection. |
| `test/integration/idempotency.test.ts` | Correct/naive/racy HTTP targets, unavailable state, malformed/large/stalled bodies, response loss, replay mismatch and SIGINT/SIGTERM. |
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
| `src/retry-policy.ts` | Validate retry safety/policy and compute failure decisions and delays. | Policy unit tests. |
| `src/http-retry.ts` | Execute a bounded recovery policy and optional effect audits under one deadline. | Retry unit and HTTP integration tests. |
| `src/retry-report.ts` | Render attempts, decisions, waits and safety/recovery assertions. | Retry formatting and CLI integration cases. |
| `src/http-idempotency.ts` | Coordinate fresh-key scenarios and assert declared replay, conflict and effect-count requirements. | Idempotency unit and real HTTP integration suites. |
| `src/http-json.ts` | Read bounded JSON with body-completion timing and cleanup. | JSON unit and real streaming/body-failure cases. |
| `src/json-value.ts` | Select JSON values safely and fingerprint canonical representations. | JSON-value unit tests. |
| `src/bounded-workers.ts` | Share bounded scheduling/cancellation between concurrency and idempotency. | Concurrency and idempotency scheduling/cancellation tests. |
| `src/idempotency-report.ts` | Render named assertions and state evidence as text or JSON. | Formatting and CLI integration cases. |
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

For the optional SQLite idempotency application, use `npm run experiment:idempotency`
with `../veriq-testcase/idempotency` available. The harness checks first-use
races, durable replay after restart, shared-database instances, lost responses,
conflicting input and transaction rollback. It is outside the standard suite.
See [idempotency](idempotency.md) for the contract and exact commands.

For optional SQLite retry recovery/effect experiments, run `npm run experiment:retry`
with `../veriq-testcase/retry` available. These local applications stay outside
the repository. See [retry](retry.md) for the policy, exact manual commands,
expected state evidence and verification limits.

## Rate-limit checks

```sh
npm run build
node --test test/integration/rate-limit.test.ts
npm run experiment:rate-limit
```

The first two commands need only this repository. The optional third command
requires `../veriq-testcase/rate-limit`; it compares atomic/global/racy/sticky
SQLite applications and checks one shared allowance across two processes.
See [the rate-limit walkthrough](rate-limit.md) for exact manual commands,
configuration, expected failures and the supported anchored-window contract.
A limiter using another algorithm requires different assertions.

## Cache checks

```sh
npm run build
node --test test/integration/cache.test.ts
npm run experiment:cache
```

Standard checks use only repository-owned HTTP targets. The optional final
command requires `../veriq-testcase/cache`; it compares eight cache modes backed
by an actual SQLite source, checks invalidation during a fill and demonstrates
independent cache state across two processes sharing one source. See the
[caching walkthrough](caching.md) for the explicit API contract, commands and
expected evidence. Diagnostic source snapshots do not increment the source-load
counter; a fast HTTP response alone is not evidence of a cache hit.

## Load and saturation checks

```sh
npm run build
node --test test/integration/load.test.ts
npm run experiment:load
```

The standard suite uses only `test/support/load-target.ts` and owned temporary
HTTP servers. The optional last command requires `../veriq-testcase/load` and
compares real SQLite-backed job processing modes. It also audits persisted
completion after a caller disconnects. See [load and saturation](load.md) for
configuration, exact manual commands, result populations and controlled limits.
Known timing/status failures remain FAIL even when another stage recovers.
