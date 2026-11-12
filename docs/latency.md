# Latency experiment

`veriq latency <url>` sends a configurable number of sequential GET requests,
records each attempt, and checks whether every attempt met the configured
status and response-header duration requirement.

```sh
veriq latency http://127.0.0.1:4300/health --samples 20 --max-duration-ms 200 --timeout-ms 2000 --format text
```

Sequential means a request and its cleanup finish before the next request
starts. This experiment measures repeated single-request behavior; it does not
establish behavior under concurrent traffic or explain the internal cause of delay.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `--samples <count>` | 5 | Requested attempts; integer from 1 to 10000. |
| `--expected-status <status>` | 200 | Required final HTTP status, from 200 to 599. |
| `--max-duration-ms <ms>` | 200 | Maximum header-arrival duration for each attempt. |
| `--timeout-ms <ms>` | 2000 | How long to observe each attempt before aborting its wait. |
| `--format <format>` | json | `json` for full evidence or `text` for a readable summary and sample list. |

Timing values must be positive integers no greater than 2147483647 ms. The
waiting limit must be at least the duration requirement. Invalid settings are
rejected before a request is made. Latency currently supports URL/CLI settings,
GET requests and no custom headers/body; it does not accept a configuration file.

The existing default invocation still requests five samples and produces JSON:

```sh
veriq latency http://127.0.0.1:4300/health
```

## Requirement and result rules

Every requested attempt must receive the expected status within its duration
limit to PASS. A wrong status, late response, timeout or request error fails
that sample. Target failures do not stop the remaining samples.

| Situation | Overall result |
| --- | --- |
| All requested attempts complete and pass | PASS |
| At least one sample fails, with no internal execution error | FAIL, even if later sampling is cancelled |
| Cancelled before completion, with no observed failed sample | INCONCLUSIVE |
| Veriq execution or response-cleanup error | ERROR; stop sampling and preserve collected evidence |

These rules avoid hiding an observed failure when a later sample is cancelled.
INCONCLUSIVE and ERROR leave the overall assertion unevaluated (`passed: null`).
A partial FAIL has `passed: false`, because one counterexample already violates
an every-sample requirement. Per-sample assertions remain available independently.

For an uninterrupted run, exits are 0 PASS, 1 FAIL, 2 ERROR, and 3 INCONCLUSIVE.
If SIGINT or SIGTERM cancels sampling, exit codes are 130 or 143 respectively,
including when the partial report retains FAIL from an earlier sample.

## Cancellation and completion

Ctrl+C aborts the active request and prevents the next sample from starting.
Completed samples are preserved. A second interrupt forces termination and
may prevent report delivery. Cancellation after all requested observations
complete does not rewrite the completed run.

The `completion` section states:

| Field | Meaning |
| --- | --- |
| `reason` | `completed`, `cancelled`, or `execution-error`. |
| `requestedSampleCount` | Configured sample count. |
| `attemptedSampleCount` | Attempts that started, including cancelled and internally failed attempts. |
| `completedSampleCount` | Attempts whose response requirement was evaluated as PASS or FAIL; includes timeouts/transport failures, not just responses. |
| `unstartedSampleCount` | Requested attempts that never started. |

For example, cancelling during sample 2 of 5 can produce one completed sample,
one cancelled attempt, and three unstarted samples. Veriq does not invent
observations for the unstarted work.

There is no shared overall run deadline. Five 2000 ms timeouts can take about
ten seconds plus overhead. The per-attempt timer limits waiting, not remote
server work or the entire process lifetime.

## Evidence and statistics

JSON reports include `schemaVersion: 1`, a run ID, run timestamps and duration,
configuration, completion, samples, summary, assertion, result, finding and any
internal error. Each sample keeps its number, evidence, assertion, result and
error. Existing configuration/sample/summary/result fields remain, with new
fields added and nullable assertions/evidence for interrupted/internal-error cases.

Run duration covers sampling and cleanup; each evidence duration stops at
response headers or request failure. Neither measures response-body completion.
Response bodies are released through the shared HTTP observation lifecycle.

| Summary field | Meaning |
| --- | --- |
| `attemptCount` | Attempts that started. |
| `responseCount` | Attempts receiving headers, regardless of status. |
| `timeoutCount` | Observation limits that expired. |
| `requestErrorCount` | Transport failures. |
| `cancelledCount` | Attempts cancelled before headers arrived. |
| `unobservedAttemptCount` | Internal failures without an evidence record. |
| `responseDurations` | Mean, min, max, p50, p95 and p99 among received responses; null when none arrived. |

Timeout, transport-error and cancelled durations are observation intervals, not
received-response latencies. They stay in evidence and counts but are excluded
from response-duration statistics. A fast 404 is included in those statistics
while failing an expected-200 assertion. If cleanup fails after headers arrive,
that response evidence remains in the summary while the run reports ERROR.

Percentiles sort individual response durations. For `10, 20, 30, 40, 50` ms,
nearest-rank p50 is 30 ms: at least half finished within 30 ms of their own
start. Durations are not added together to calculate a percentile. With five
responses, p95 and p99 equal the maximum; this does not establish production
tail latency. Summaries do not replace the every-sample assertion.

## Manual tests using only this repository

After `npm ci` and `npm link`, start the small test fixture from the repository
root in terminal A:

```sh
node --input-type=module -e 'import { createHttpTarget } from "./test/support/http-target.ts"; createHttpTarget().listen(4300, "127.0.0.1");'
```

This is a repository-owned automated-test helper, not a production server.
Stop it with Ctrl+C when finished. Choose another free port and update URLs
if 4300 is occupied. No `veriq-testcase` directory is required.

In terminal B, run each experiment separately:

| Behavior | Command | Expected result |
| --- | --- | --- |
| Immediate responses | `veriq latency http://127.0.0.1:4300/health --samples 10 --format text` | PASS when all samples meet 200 ms. |
| Consistent delay | `veriq latency 'http://127.0.0.1:4300/delay?ms=350' --samples 3 --max-duration-ms 200 --format text` | FAIL for late 200 responses. |
| Occasional delay | `veriq latency http://127.0.0.1:4300/sequence --samples 5 --max-duration-ms 200 --format text` | FAIL; the third request in each group of five gets 350 ms extra delay. |
| Wrong status | `veriq latency http://127.0.0.1:4300/missing --samples 3 --format text` | FAIL for received 404 responses. |
| Custom expected status | `veriq latency http://127.0.0.1:4300/missing --samples 3 --expected-status 404 --format text` | PASS when all 404 responses meet the duration limit. |
| No headers | `veriq latency http://127.0.0.1:4300/hang --samples 3 --max-duration-ms 100 --timeout-ms 100 --format text` | FAIL; three timeouts, unavailable response statistics. |

Run the occasional-delay example against a fresh fixture or after a complete
group of five `/sequence` requests; that route has an instance-local counter.
An average below 200 ms still cannot hide a sample exceeding 200 ms.

For cancellation:

```sh
veriq latency http://127.0.0.1:4300/hang --samples 10 --max-duration-ms 1000 --timeout-ms 10000 --format text
```

Press Ctrl+C while waiting. Expect INCONCLUSIVE if no earlier sample failed,
partial counts, and exit 130. Stop the fixture and run `/health` again to see
request errors rather than response latencies. Machine load and scheduling can
affect actual timings; the report evaluates observed evidence.

## Implementation and verification

| Module | Responsibility | Verification |
| --- | --- | --- |
| `src/http-latency.ts` | Validate settings, coordinate sequential attempts, preserve samples and choose completion/result semantics. | Latency unit tests and real CLI integration tests. |
| `src/http-experiment.ts` | Execute each attempt through the shared HTTP lifecycle and assertion. | HTTP lifecycle tests, including body cleanup and transport errors. |
| `src/http-latency-summary.ts` | Count outcomes and compute nearest-rank response statistics without changing evidence order. | Known-distribution summary tests. |
| `src/latency-report.ts` | Render JSON or readable text with every attempted sample. | Unit formatting checks and compiled-CLI integration tests. |
| `src/cli-cancellation.ts` | Own process-signal handlers for run and latency and remove them afterward. | SIGINT/SIGTERM integration cases for both commands. |

Run `npm run check` for the full repository-owned verification. See
[testing](testing.md) for individual commands and coverage.

All evidence is retained in memory until the final report, so resource use grows
with the sample count; the 10000-sample cap bounds this growth. This experiment
provides no concurrency, throughput, causal diagnosis, automatic retries,
persistent evidence store, hard real-time guarantee or production availability
claim. The application under test may run in any language.
