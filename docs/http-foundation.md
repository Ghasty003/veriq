# HTTP reachability and the configured run command

This reference explains the HTTP command, its implementation, configuration,
results, and manual and automated tests. See [testing](testing.md) for workspace
requirements and all verification commands.

## What Veriq can now do

```sh
veriq run http://127.0.0.1:4300/health
veriq run --config examples/http.json --format json
```

Veriq validates the request, makes a real HTTP request, records what happened,
checks a requirement, and reports its conclusion. It sends no automatic
application-level retries and does not follow redirects.

The property is deliberately precise:

> For this attempt, receive response headers with the configured status within
> the configured response-duration limit.

A 200 response once does not establish high availability, readiness of every
dependency, correct response contents, or behavior under production traffic.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Arguments, process signals, invocation, output and exit codes. |
| `src/config-file.ts` | Bounded file reading and UTF-8 JSON parsing. |
| `src/http-config.ts` | Configuration validation, defaults, header normalization, URL redaction. |
| `src/http-experiment.ts` | Run identity, experiment orchestration, assertion/result and finding. |
| `src/http-observation.ts` | The actual HTTP interaction, timing, transport errors and resource cleanup. |
| `src/http-assertion.ts` | Compare observed status and duration with the requirement. |
| `src/report.ts` | Render one report as terminal text or JSON. |
| `src/http-probe.ts` | Keep the existing probe API working through the shared HTTP lifecycle. |

The latency module runs repeated samples through the same HTTP experiment
execution. Its configurable sampling and partial-result rules are documented
in the [latency reference](latency.md).

## Request execution, step by step

```text
CLI arguments or JSON file
       ↓
validated HTTP configuration
       ↓
experiment identity and cancellation signal
       ↓
HTTP observation: request → headers, transport failure, timeout, or cancellation
       ↓
resource cleanup
       ↓
assertion → result → finding
       ↓
text or JSON report
```

### 1. Validate before touching the target

`parseHttpConfiguration()` accepts unknown input and returns a normalized
configuration or throws `ConfigurationError`.

Example:

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

The waiting limit is 2000 ms. The required response duration is 1000 ms.
A 200 response at 1500 ms is recorded and fails. If nothing arrives by the
waiting limit, the timeout is recorded and fails.

Rules include:

- Require an absolute HTTP(S) URL, without embedded credentials or fragments.
- Accept GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS, in uppercase.
- Validate integer timing limits and final status codes from 200 through 599.
- Reject a waiting limit shorter than the response requirement.
- Reject unknown fields instead of silently accepting misspelled settings.
- Reject malformed headers, duplicate names differing only in case, and
  transport-owned headers such as Host and Content-Length.
- Bound custom headers to 100 entries and 16 KiB of names and values.
- Bound string request bodies to 1 MiB; reject bodies for GET and HEAD.
- Read at most 2 MiB plus one detection byte from a regular configuration file.
  Reject invalid UTF-8 or JSON. Never print the invalid file's contents.

Headers and request bodies are configured in JSON, not command-line flags.
With `--config`, request-setting CLI overrides are rejected. This avoids a
second set of precedence rules and makes the file's request settings explicit.
`--format` remains an invocation setting.

The configuration parser copies headers, so later changes to the caller's
object cannot silently change an already configured request.

### 2. Give the execution an identity

`runHttpExperiment()` generates a UUID and creates a report with
`schemaVersion: 1`. The report keeps configuration, evidence, assertion,
result, finding and Veriq execution errors in separate fields.

It owns the experiment's interpretation. The HTTP capability owns interaction
with the target. The renderer owns presentation. This keeps HTTP execution
independent of terminal output and signal handling.

### 3. Own the request timeout and cancellation

`observeHttp()` creates a new `AbortController` and a timer for each request.
It also listens for cancellation from its caller. The first stop reason wins.

The CLI handles SIGINT (normally Ctrl+C) and SIGTERM by aborting its signal.
The capability accepts an ordinary `AbortSignal`; it does not install process
signal handlers itself. That allows another caller to reuse it without taking
over process-wide behavior.

An already cancelled execution makes no request. Cancellation during a pending
request aborts its wait. Cancellation after header observation is complete
does not rewrite the completed evidence.

The important invariant is:

> Each execution owns its timer and cancellation state, and releases its own
> listeners and HTTP resources when that execution finishes.

The cleanup runs in `finally`, including unexpected failures. One execution's
abort controller cannot cancel another execution. We test overlapping runs
for this isolation; that is not a concurrency or load-testing feature.

### 4. Measure the stated boundary

Wall-clock timestamps use UTC dates so the report can be correlated with logs.
Elapsed duration uses `performance.now()`, a monotonic clock, so changing the
wall clock does not directly change the measured interval.

The interval begins immediately before request execution and ends when the
fetch promise supplies response headers or rejects. It can include DNS lookup,
connection setup, TLS, request transmission, server/proxy waiting, and response
header transmission. It is not a measurement of application CPU time.

It excludes configuration reading, CLI startup, response body completion,
cleanup, and report printing. `timeoutMs` is a request observation budget, not
a deadline for the entire process.

The runtime may reuse an existing connection, so not every request performs a
new DNS lookup or TLS handshake. We do not claim per-phase timings because
the current observation does not measure them individually.

### 5. Handle bodies safely

This experiment does not inspect the response body. Reading every body would
consume unbounded memory for large responses and could wait forever for a
stream that never ends.

Instead, after recording header arrival, Veriq cancels the unread body. Cleanup
has a separate 250 ms bound. The request controller is aborted in `finally` to
release request work even if cleanup fails. A cleanup failure produces ERROR
with the observed header evidence preserved and no evaluated assertion.

The request timer and cancellation listener are removed at the completed
observation boundary. A cancellation triggered during cleanup cannot replace
a recorded response with a fictitious timeout or cancellation.

Cancelling local HTTP resources does not guarantee the remote application has
stopped its work, undone writes, or rolled back a transaction.

### 6. Classify what happened without inventing causes

| Observation | Meaning |
| --- | --- |
| `response` | Response headers were received; status is available. |
| `timeout` | No response headers were received within the request waiting limit. |
| `cancelled` | The caller cancelled before header observation completed. |
| `request-error` | The runtime reported a transport failure. |

Transport failures have a category where runtime evidence supports it:
DNS, connection, TLS, or generic transport. For example, ENOTFOUND indicates
a name-resolution failure and ECONNREFUSED indicates a refused connection.
The classifier looks through bounded nested causes, including aggregate errors.
It retains a normalized error code, not arbitrary exception messages containing
potential secrets.

Categories describe runtime evidence. They do not prove the root cause of an
incident. A proxy, firewall, load balancer or application could be involved.
If only generic transport information is available, we retain that uncertainty.

Unexpected execution exceptions outside recognized fetch transport failures
become ERROR. They are not silently treated as proof that the target failed.

### 7. Apply the requirement and report

| Result | Meaning for this command |
| --- | --- |
| PASS | The observed status and header-arrival duration meet the requirement. |
| FAIL | The response violates the requirement, or no qualifying response was observed before a target failure/timeout. |
| INCONCLUSIVE | Execution was cancelled; the response assertion was not evaluated. |
| ERROR | Invalid configuration or Veriq could not execute/clean up correctly. |

Cancellation uses `assertion.passed: null`, not false. It is explicitly an
unevaluated assertion. A Veriq cleanup error can preserve response evidence
while still reporting ERROR.

For a default successful request:

- Raw evidence: response, status 200, measured duration.
- Observation: headers with status 200 arrived in that interval.
- Assertion: require 200 within the configured limit.
- Result: PASS if both conditions match.
- Finding: this request met the requirement. No availability percentage follows.

There is no WARN case for this property yet; we do not invent one merely to
populate every possible framework result state.

## Reporting, security and compatibility

Default output is readable text. `--format json` produces one structured report
on stdout, including completed experiment ERROR reports. Invalid invocation
or configuration produces a JSON ERROR on stderr and no experiment evidence.
Report JSON can be saved with ordinary shell redirection.

| Exit code | Meaning |
| --- | --- |
| 0 | PASS or help |
| 1 | FAIL |
| 2 | ERROR |
| 3 | INCONCLUSIVE without a process signal |
| 130 | SIGINT cancelled the run |
| 143 | SIGTERM cancelled the run |

A second interrupt forces immediate termination and may prevent a final report.
Hard process termination, a broken output pipe, or a machine crash can also
prevent report delivery; this is not a durable evidence store.

Reports omit configured request-header values and request bodies. Query values
are redacted in target and redirect URLs. Embedded redirect credentials and
fragments are removed. Redirect locations are resolved to sanitized absolute
URLs. URL paths and query names remain visible, as does bounded Content-Type
metadata: do not assume this is a universal scrubber for every possible secret.

TLS verification uses the runtime's normal secure defaults. No insecure bypass
is introduced. HTTP is allowed for explicit local and other configured targets.
Choose HTTPS for sensitive traffic. The caller controls the target: Veriq is
a local developer tool, not an SSRF-hardened service for untrusted remote users.

Existing `probe` and `latency` invocations remain available. Probe keeps its
JSON output, and latency keeps JSON as its default. Latency now adds versioned
reports, configurable sampling, text output, cancellation and explicit partial
completion. Both commands use the shared observation lifecycle; probe reports
do not become schema-version-1 run reports.

## Why this design

We reused Node's standard fetch implementation rather than writing our own DNS,
TCP, TLS, HTTP parser and connection pool. Those are networking mechanisms;
Veriq's responsibility is to control the experiment and interpret its evidence.

We separated configuration, interaction, interpretation and presentation
because these boundaries are already useful. We did not introduce a generic
adapter registry, distributed runner, database, dashboard or metrics backend.
There is only one current capability. The request contract and versioned JSON
boundary can be reused without requiring another application to use TypeScript.

Tests inject fetch for deterministic rare errors and lifecycle races, but the
real CLI integration suite uses actual HTTP servers and sockets. Injection is
a test seam, not the production implementation.

Run has no persistence layer, automatic retry policy, phase-level latency
instrumentation or multi-machine coordination. The separate [retry command](retry.md)
explicitly executes a configured recovery policy; it does not change run. Run does not assert bodies;
[the idempotency experiment](idempotency.md) separately reads bounded JSON for
its declared replay and state-count contract.
Those need separate experiments and contracts when introduced.

## Try it against the controlled test target

From the Veriq directory, terminal A:

```sh
node --input-type=module -e 'import { createHttpTarget } from "./test/support/http-target.ts"; createHttpTarget().listen(4300, "127.0.0.1");'
```

This repository-owned fixture binds to localhost port 4300. Change the listen
port and URLs/configuration if needed. Stop it with Ctrl+C after testing. It
bounds request bodies and clears route timers when connections close. Its
intentional fault endpoints are test behavior, not application business logic.

Terminal B:

```sh
npm run build
veriq run --config examples/http.json
veriq run --config examples/http.json --format json
veriq run http://127.0.0.1:4300/missing
veriq run http://127.0.0.1:4300/redirect --format json
veriq run http://127.0.0.1:4300/stream --format json
veriq run 'http://127.0.0.1:4300/delay?ms=500' --max-duration-ms 100 --timeout-ms 2000
veriq run http://127.0.0.1:4300/hang --timeout-ms 200
veriq run http://127.0.0.1:4300/reset --format json
```

Expected results, in order: PASS, PASS, FAIL for 404, FAIL for the unfollowed
302, PASS at streaming headers, FAIL for a late 200, FAIL for timeout, and
FAIL with transport-error evidence. Watch the target's logs as you test.

For cancellation:

```sh
veriq run http://127.0.0.1:4300/hang --timeout-ms 10000 --format json
```

Press Ctrl+C before ten seconds. Expect INCONCLUSIVE, cancelled evidence,
an unevaluated assertion, and exit code 130. Run `echo $?` immediately afterward
to inspect the exit code. Stop the target and probe `/health` again to observe
a refused connection instead of an HTTP response.

For a request body, use a configuration with `method: "POST"`, a string `body`,
and `expectedStatus: 201`, targeting `/echo`. The target reports received method
and body size in its response, but Veriq still checks only response headers.

## Automated verification and its limits

```sh
npm run check
```

Type checking includes the implementation and repository-owned tests/fixtures.
No companion application folder is required for the standard checks. See
[testing](testing.md) for individual scripts and optional local experiments.

Unit tests cover configuration limits, file parsing, redaction, assertion
boundaries, received responses, timeout, pre-cancellation, in-flight
cancellation, completed-response races, listener cleanup, overlapping execution
isolation, network-error normalization, internal failures and failed/stalled
body cleanup.

The compiled-CLI integration suite starts a real local target on an assigned
port and checks successful responses, wrong status, legacy probe behavior,
text/JSON output, unfollowed redirects, streaming body cleanup, late responses,
timeout, actual method/header/body transmission, HEAD, SIGINT/SIGTERM, socket
reset and refused connections. It stops only the processes it owns.

DNS and TLS classification are tested with controlled runtime errors, not a
public DNS service or real certificate failure. Unit tests establish those
mapping rules, not the behavior of every resolver or TLS stack. Real local
sockets are needed to establish the request/cleanup/signal integration that
a mocked fetch alone cannot demonstrate.

The checkout slow-dependency and shared-deadline experiments are optional local
regression checks via `npm run experiment:timeouts`; they are outside the
standard self-contained verification.

These tests do not establish throughput, high-load resource behavior, hard
real-time bounds, cross-platform signal equivalence, all Node versions, or
production availability. The exercised runtime is the locally installed Node.
The declared minimum is Node 22.18; a multi-version CI matrix remains future work.
