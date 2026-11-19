# Retries and retry safety

`veriq retry` is a controlled retrying client. It executes a configured policy
against a running target and records whether that policy recovered within its
budget. It does not inspect an application's internal retry implementation.

```sh
veriq retry http://127.0.0.1:4600/flaky --max-attempts 4 --deadline-ms 5000 --format text
veriq retry --config examples/retry-write.json --format json
```

The recovery requirement differs from the latency command's every-request rule.
Retries can PASS after `503 → 503 → 200`, because intermediate failures are
expected inputs to the policy. All attempts remain evidence.

## The concepts in this implementation

A retry is another attempt at the same logical operation. If the first attempt
committed but lost its reply, repeating the write can create a duplicate.
Idempotency keys identify that logical operation across attempts. Generating a
new key for each retry would identify different operations and lose protection.

Backoff increases the waiting time after each retryable failure. With a 100 ms
base and no jitter, the caps are 100, 200, 400 ms, and so on, up to the configured
maximum. Full jitter chooses an integer from zero through each cap, spreading
callers' retry timing. It reduces synchronization; it does not guarantee unique
timing or prevent overload.

The overall deadline is created once. Requests, backoff and declared state checks
share it. Each request also has its own timeout, clipped to remaining budget.
A fresh timeout per attempt alone would not bound a complete retry workflow.

## Configuration

Use a URL and CLI flags for GET recovery experiments, or an exclusive JSON file
for HTTP request settings, policy details and write-state verification.
`--format` can accompany a file; request/policy flags cannot override the file.
Unknown fields and invalid settings fail before network operations.

| Policy field / CLI option | Default | Meaning |
| --- | --- | --- |
| `maxAttempts` / `--max-attempts` | 3 | Total attempts including the first; 1–100. Three means at most two retries. |
| `deadlineMs` / `--deadline-ms` | 10000 | Overall action budget, 1–2147483647 ms, including state observations and backoff. |
| `baseDelayMs` / `--base-delay-ms` | 100 | Initial exponential cap, 0–60000 ms. |
| `maxDelayMs` / `--max-delay-ms` | 2000 | Exponential cap limit, at least the base, at most 60000 ms. |
| `jitter` / `--jitter` | full | `full` or deterministic `none`. |
| `retryableStatuses` | 408, 429, 502, 503, 504 | Up to 32 distinct 4xx/5xx values, configurable in JSON. Empty disables HTTP-status retries. |
| `retryOnTimeout` | true | Retry an individual attempt timeout if budget remains. |
| `retryOnTransportErrors` | true | Retry the fixed set of recognized potentially transient runtime codes. |

HTTP settings live under `request` in JSON and use the existing
[HTTP configuration](http-foundation.md). Expected status must be 2xx. The CLI
supports `--expected-status`, `--timeout-ms` and `--max-duration-ms` for URL GETs.
Defaults are status 200, a 2000 ms per-attempt timeout, and a successful response
requirement equal to that timeout.

The response-duration requirement applies to the successful attempt. The overall
deadline bounds the recovery window; they are different requirements. A late
expected-status response fails its duration requirement and is not retried
merely to replace the slow measurement with a faster one.

## Classification and server guidance

Configured retryable HTTP statuses are potentially recoverable, not proof that
the next call will succeed. Default policy does not retry validation/authentication
statuses such as 400/401/403, redirects, or arbitrary unknown statuses. Redirects
are recorded without being followed.

Recognized potentially transient transport codes are EAI_AGAIN, ECONNREFUSED,
ECONNRESET, ETIMEDOUT, EPIPE, EHOSTUNREACH, ENETUNREACH, UND_ERR_SOCKET and
UND_ERR_CONNECT_TIMEOUT. TLS/certificate failures, ENOTFOUND and unknown
transport errors are not retried by this policy. These are conservative policy
choices, not universal root-cause diagnoses. The transport switch can disable
that set; it does not make every runtime error retryable.

For a retryable response, valid `Retry-After` guidance is interpreted as integer
seconds or an HTTP date. Modern and obsolete HTTP-date forms are accepted.
Dates require wall-clock time; action budgets use a monotonic clock. Malformed
guidance is ignored. Metadata beyond the supported 16 KiB header-value limit
is omitted rather than truncated and interpreted as a different delay.

The planned wait is the larger of the jittered backoff and the server's delay.
`maxDelayMs` caps exponential backoff, not `Retry-After`. If the wait would use
all remaining budget, Veriq stops with `insufficient-budget` instead of shortening
the server delay or waiting without room for another attempt.
See [HTTP retry semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
and [Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).

## Write safety contract

GET/HEAD/OPTIONS use `retrySafety: "read-only"`, the default for those methods.
They assume the target honors the declared safe semantics; Veriq does not
discover hidden writes in a GET handler.

For every other supported method, this experiment conservatively requires:

```json
{
  "request": {
    "target": "http://127.0.0.1:4600/operations?loseFirst=1",
    "method": "POST",
    "headers": { "content-type": "application/json" },
    "body": "{\"amount\":10,\"currency\":\"USD\"}",
    "expectedStatus": 201
  },
  "retrySafety": "idempotency-key",
  "state": {
    "target": "http://127.0.0.1:4600/effects/{key}",
    "countPointer": "/effectCount"
  }
}
```

This is a stricter current tool contract than HTTP method semantics alone;
PUT and DELETE are idempotent methods in HTTP, but this write experiment still
requires explicit key/state evidence. A header cannot make an implementation
honor idempotency. The configured target must support the declared protocol.

Veriq generates one fresh UUID and reuses it in `Idempotency-Key` on every
attempt. Method, target, headers and payload stay unchanged. A manually supplied
key is rejected. The count endpoint must be an authoritative GET JSON API for
exactly that key, using the same count-pointer contract as the
[idempotency experiment](idempotency.md).

Before sending a write, Veriq requires a successful, timely count of zero.
Unavailable or non-fresh state gives INCONCLUSIVE without mutations. The same
overall budget includes this precondition; expiry here leaves recovery unevaluated.

After attempts stop, remaining budget is used for one audit, with no additional
state polling. More than one effect is FAIL. Successful recovery requires exactly
one effect. An unsuccessful recovery with zero or one observed effect can pass
the safety assertion while still failing recovery. Missing audit evidence leaves
safety unknown; recovered writes with unknown safety are INCONCLUSIVE.

## Execution and ownership

| Module | Responsibility |
| --- | --- |
| `src/retry-policy.ts` | Validate request/policy/safety contracts, classify failures, compute backoff/jitter and interpret server delays. |
| `src/http-retry.ts` | Own the overall deadline, execute attempts and waits, reuse the key, audit effects and produce assertions/results. |
| `src/http-observation.ts` | Execute each headers-only attempt, classify transport evidence and release the body; preserve Retry-After metadata. |
| `src/http-json.ts` | Perform bounded JSON state reads with body-completion timing and cleanup. |
| `src/retry-report.ts` | Render text or versioned JSON with every attempt, decision and wait. |
| `src/cli-cancellation.ts` | Translate process interrupts into cancellation and remove signal handlers. |

The executor uses injectable clock, wait and random sources for deterministic
unit tests; production uses monotonic time, abortable timers and Math.random.
Jitter is traffic scheduling, not security randomness. Keys use randomUUID.

Resources are released in finally blocks. Cancellation aborts the active request,
state read or wait and prevents another attempt. Internal errors and cleanup
failures stop retries rather than being classified as target recovery signals.
Attempt records are created before execution; an unexpected exception can retain
a started attempt with null evidence instead of a fabricated HTTP response.

An observation timeout and the overall deadline can race. Per-attempt evidence
retains its actual outcome and effective waiting limit; completion separately
identifies the workflow's stopping reason. Scheduling, final cleanup (up to
250 ms per observation) and reporting can extend process duration beyond the
action budget. This is not a hard real-time process deadline.

## Reports and results

JSON contains schemaVersion 1, run identity, optional generated key, sanitized
configuration, every attempt/decision, state evidence, completion and assertions.
An attempt records its start/observation offsets on the shared budget clock,
actual HTTP evidence, backoff cap, parsed
Retry-After, planned wait and observed wait duration. Later success does not
erase earlier failures.

| Result | Meaning |
| --- | --- |
| PASS | Recovery met the configured status, duration and overall budget; all applicable observed effect assertions passed. |
| FAIL | Attempts/budget were exhausted, a non-retryable/late response ended recovery, or an observed effect requirement failed. |
| INCONCLUSIVE | Cancellation or missing precondition/audit evidence prevents evaluating all required assertions, with no known failure. |
| ERROR | Veriq could not execute or clean up correctly. |

An intermediate retryable 503 is not a final failure by itself. Manual cancellation
during backoff can therefore be INCONCLUSIVE. A known terminal failure remains
FAIL if a later required state audit is cancelled. Internal errors take priority.

Completion reasons include success, non-retryable, response-too-slow,
attempts-exhausted, insufficient-budget, deadline, cancelled, precondition,
state-unavailable and execution-error. Remaining attempt slots are unused budget,
not requests that had to run after success.

Exit codes are 0 PASS, 1 FAIL, 2 ERROR, 3 INCONCLUSIVE; cancellation uses 130/143
for SIGINT/SIGTERM. A second interrupt forces termination and may prevent a report.
Request-header values and bodies are omitted and URL query values are redacted.
Generated keys, paths, HTTP metadata and policy details remain visible.

## Manual tests

The optional local application is `../veriq-testcase/retry/server.ts`.
It uses real SQLite rows as simulated effects, not real payments. From the
Veriq directory, terminal A:

```sh
PORT=4600 MODE=atomic node ../veriq-testcase/retry/server.ts
```

Terminal B:

```sh
npm run build
veriq retry --config examples/retry.json --format text
veriq retry http://127.0.0.1:4600/always --max-attempts 3 --jitter none
veriq retry http://127.0.0.1:4600/permanent --max-attempts 3
veriq retry http://127.0.0.1:4600/rate --base-delay-ms 1 --max-delay-ms 5 --deadline-ms 4000
veriq retry http://127.0.0.1:4600/hang --deadline-ms 500 --timeout-ms 2000
```

Expected: flaky recovery after `503,503,200` passes; persistent failure stops at
three attempts and fails; 400 stops after one attempt and fails; rate-limit
recovery waits at least the planned 1000 ms server delay and passes; no headers
stops when the remaining budget is insufficient or expires and fails.

The flaky/rate endpoints have per-URL counters. Restart the application or use a
fresh query value such as `/flaky?case=second` to repeat their initial failures.
`FAILURES` controls flaky failures (default 2, 0–100). `SLOW_MS` controls `/slow`
(default 1500, 0–10000). `OPERATION_DELAY_MS` controls writes (default 0, 0–5000).
PORT accepts 0–65535. The server binds to localhost, validates/bounds uploads,
uses abortable work delays and supports bounded shutdown.

For cancellation, start a long retry wait, then press Ctrl+C:

```sh
veriq retry http://127.0.0.1:4600/always --base-delay-ms 4000 --max-delay-ms 4000 --jitter none
```

Expected: the wait stops, no next attempt starts, and the partial report is
INCONCLUSIVE with exit 130.

### Committed write with a lost reply

With atomic mode still running:

```sh
veriq retry --config examples/retry-write.json --format json
```

Expected: first reply is lost after commit; attempt two replays under the same
key; one observed effect; PASS. The report's generated key can be inspected:

```sh
curl http://127.0.0.1:4600/effects/KEY_FROM_REPORT
```

Stop the target and restart the deliberately broken version:

```sh
PORT=4600 MODE=naive node ../veriq-testcase/retry/server.ts
```

Run the same write configuration. Recovery still succeeds on attempt two, but
the saved-effect count is two: FAIL. This distinguishes getting a reply from
safely repeating a logical operation.

Atomic mode stores the effect and replay receipt in one transaction and makes
the key unique. Naive mode ignores receipt-based deduplication. Each mode uses
separate SQLite tables. Storage defaults to memory; `DB_PATH` selects a persistent
file. The response-loss fault destroys only the first reply for each key after
its database commit. It does not roll back that commit.

## Automated verification and limits

```sh
npm run check
```

Standard checks use repository-owned fixtures and need no external application
or SQLite database. Unit tests verify deterministic backoff, jitter bounds,
HTTP-date parsing, classification, caps, shared budget, cancellation, errors,
preconditions and effect audits. Real HTTP tests exercise recovery, persistent
failure, 400, Retry-After timing, active-budget expiry, slow success, process
signals and lost-write responses with correct/broken effect handling.

```sh
npm run experiment:retry
```

The optional local harness uses the external target and temporary SQLite files.
It verified three-attempt recovery, three-attempt exhaustion, one-attempt 400,
two-attempt rate-limit recovery, and lost-response writes with one versus two
saved effects. It owns its assigned-port servers and temporary databases and
cleans them up. It requires the sibling repository directory to be named `veriq`.

PASS describes this policy, these attempts and the state observed at audit time.
The count API must reflect the correct key and completed writes. Pending remote
work can continue after timeout and create later effects; there is no quiescence
or future-state guarantee. Neither the key header nor a single audit proves
permanent exactly-once behavior, retention across key expiry, or atomicity with
external payment/email/queue systems. This experiment does not compare replay
bodies; the separate idempotency command covers that contract.

Retries add work to an already struggling system. Attempt caps and deadlines
bound one Veriq execution; many processes can still amplify load. There is no
shared retry budget, circuit breaker, global rate limiter or automatic retries
added to the existing run/probe/latency/concurrency commands.
