# HTTP idempotency experiment

Idempotency means repeating the same logical operation does not repeat its
effect. A client may receive no answer even though an operation committed.
Repeating a request with the same key should return the existing operation's
result, rather than create another effect. A new logical operation needs a new
key. Reusing a key with different input should be rejected.

```sh
veriq idempotency --config examples/idempotency.json --format text
```

This experiment checks a declared HTTP/JSON contract. It does not infer which
application records are effects or discover an application's idempotency API.

## The experiment

Veriq generates two fresh UUID keys and sends them as `Idempotency-Key` headers:

1. Read the declared count API for both keys. Require zero existing effects
   before sending any operation. If this cannot be established, stop without
   mutations and report INCONCLUSIVE.
2. Send sequential requests with the first key, including the first execution.
   Check successful JSON responses, replay equality and one observed effect.
3. Send different input under that key, require the configured rejection status,
   and check that its effect count remains one. This phase is skipped when a
   prior effect cannot be established, so changed input does not accidentally
   become the key's first accepted operation.
4. Send a bounded concurrent burst with the second, still-unused key. Check
   replay equality and one observed effect for that key.

The second key matters. Sending a burst after seeding a cached result would
miss a race where two initial requests both believe they own the operation.

The default workload is three sequential operations, five concurrent first-use
attempts, one conflicting operation and five state observations. Each run uses
fresh keys; it does not clear application data or reuse a previous run's keys.

## Configuration and supported contract

The included [configuration](../examples/idempotency.json) targets the optional
local application described below. Configure the endpoints for your own system
when using a different target.

| Field | Purpose |
| --- | --- |
| `request` | Existing HTTP configuration: target, POST/PUT/PATCH method, optional headers/body, successful expected status and timing limits. Default method POST; default expected status 200. |
| `state` | HTTP GET configuration with exactly one `{key}` placeholder in the target URL. Explicit headers can authenticate this endpoint independently. |
| `state.countPointer` | JSON Pointer selecting a nonnegative safe-integer effect count. Default `/effectCount`. |
| `responsePointer` | JSON Pointer selecting the response value that must replay consistently, such as `/operationId`. Default empty pointer compares the entire JSON value. |
| `conflictBody` | Different string request body for the existing key. Required. Identical bodies and supported JSON-equivalent inputs are rejected before requests. |
| `conflictExpectedStatus` | Expected 4xx rejection status. Default 409. |
| `sequentialRequests` | Total sequential attempts including the first; 2–100, default 3. |
| `concurrentRequests` | Total first-use burst attempts; 2–100, default 5. |
| `concurrency` | Maximum burst attempts active at once; 2–32, default 5. |

Timing limits, headers and request bodies use the validation rules in the
[HTTP reference](http-foundation.md). Unknown configuration fields fail before
execution. Do not configure an Idempotency-Key header yourself: Veriq injects
isolated keys. Only `--config` and `--format text|json` are accepted by this command.

The operation and its replays must return the same configured successful status
and usable JSON. Bodyless statuses 204/205 are unsupported. APIs returning 201
initially and 200 for replay, temporary in-progress responses, different key
headers, or non-JSON replay contracts need a different contract; this command
does not silently retry or reinterpret them.

The count endpoint must be authoritative for exactly the supplied key and
reflect completed writes. It must return a successful JSON status and report
zero for a new key. A lagging replica can produce misleading counts; this
experiment does not poll for eventual consistency. The meaning and accuracy
of the application's count API are preconditions, not facts Veriq can establish
from the count alone.

## Evidence and assertions

The report separates JSON observations, per-phase effect counts, the conflict
HTTP report, named assertions, completion, result and finding. It preserves
generated keys so they can be inspected through the state API. Sequential and
concurrent keys represent two different logical operations, so a correct run
normally creates two effects in total, one per key.

For each JSON observation, evidence records the URL, method, timestamps,
header-arrival duration, full JSON-observation duration, status, observed byte
count, outcome and normalized error. Concurrent observations retain their phase
and attempt number even if they finish out of order.

Selected replay values are canonicalized and SHA-256 hashed. Object key order
and JSON whitespace do not affect equality; array order and value types do.
The selection supports JSON Pointer `~0` and `~1` escapes, checks own properties
only and distinguishes null from missing data. Selected values deeper than 64
levels or without a usable pointer leave replay equality unknown.

The report does not store raw response JSON, request bodies or configured
header values. It stores response fingerprints and the declared effect counts.
Hashes are comparison evidence, not encryption or a universal secret scrubber;
paths, generated keys and configured pointer names remain visible.

### JSON measurement and resource bounds

Run/probe/latency/concurrency still stop at headers. Idempotency needs response
data, so its JSON observations have a different boundary: complete JSON within
the configured duration requirement. The timeout remains active through reading
the body. Reads stop after 64 KiB; UTF-8 and JSON are validated.

Response readers, timers and cancellation listeners are released. Cleanup has
a separate 250 ms bound and is excluded from the measured observation duration.
Expected stream termination after timeout or cancellation is not relabelled as
an internal cleanup failure. Unexpected execution/cleanup failures are ERROR.
The conflict operation uses the existing headers-only HTTP assertion, because
its rejection status is the required evidence; its body is not inspected.

### Result rules

| Result | Meaning |
| --- | --- |
| PASS | Every declared status/timing, replay, conflict and observed effect-count assertion passed for both fresh keys. |
| FAIL | At least one requirement was demonstrably violated, such as two effects, changing replay values, wrong status, or accepted conflicting input. Inspect the assertion name; FAIL does not necessarily mean duplicate effects. |
| INCONCLUSIVE | Required evidence is missing, a fresh-key precondition cannot be established, or the caller cancelled without a prior known failure. |
| ERROR | Veriq could not execute or clean up correctly. |

A timeout or lost response is not by itself proof of duplicate execution.
Malformed, oversized, incomplete JSON or missing count data leaves relevant
assertions unknown. Known violations still produce FAIL even when other
assertions are unknown. Internal errors take priority over other results.

`completion` records its reason and attempted/unstarted sequential/concurrent
counts, concurrent client peak and whether conflicting input was sent.
Cancellation stops later phases and cancels active reads. It cannot undo a
committed target effect. Exit codes are 0 PASS, 1 FAIL, 2 ERROR and 3 INCONCLUSIVE;
SIGINT/SIGTERM cancellation uses 130/143, including a retained partial FAIL.

## Implementation

| Module | Responsibility |
| --- | --- |
| `src/http-idempotency.ts` | Validate the declared experiment, generate keys, execute phases, select evidence and evaluate named assertions. |
| `src/http-json.ts` | Bounded response JSON capture with full-body timing, cancellation, error classification and cleanup. |
| `src/json-value.ts` | Safe JSON Pointer selection and canonical comparison fingerprints. |
| `src/bounded-workers.ts` | Shared bounded scheduling, cancellation fan-out and stable request numbering for concurrency and the first-use burst. |
| `src/idempotency-report.ts` | Text and versioned JSON output. |
| Existing HTTP modules | Validate HTTP configuration and evaluate the conflicting request's status/duration requirement. |

The worker scheduler was extracted from the existing concurrency implementation
because two actual features now need that boundary. Existing concurrency tests
verify its behavior after extraction. No database adapter or application-language
dependency was introduced into Veriq.

## Local application and manual tests

The standalone application lives in `../veriq-testcase/idempotency`, outside the
Veriq repository. Its operations are simulated SQLite rows, not real payments.
From the Veriq directory, terminal A:

```sh
PORT=4500 MODE=naive node ../veriq-testcase/idempotency/server.ts
```

Terminal B:

```sh
npm run build
veriq idempotency --config examples/idempotency.json --format text
```

Expected: FAIL. Naive mode creates a new row for every request. In the verified
run, sequential repeats created three effects and concurrent first-use created
five. Conflicting input created a fourth effect for the sequential key.

Stop terminal A and start the cache-only variant:

```sh
PORT=4500 MODE=racy node ../veriq-testcase/idempotency/server.ts
```

Rerun exactly the same Veriq command. Expected: FAIL. The verified run observed
one sequential effect but five concurrent effects. The code checks the cache,
waits for asynchronous work, then creates a row and overwrites the cache.
Sequential testing alone would miss this first-use race.

Stop it and start the transactional variant:

```sh
PORT=4500 MODE=atomic node ../veriq-testcase/idempotency/server.ts
```

Rerun the same command. Expected: PASS, one effect per key, one replayed response
value per key, conflict rejected with 409 and no additional effect.

The report prints both generated keys. To inspect one manually, replace
`KEY_FROM_REPORT` in this command:

```sh
curl http://127.0.0.1:4500/effects/KEY_FROM_REPORT
```

All modes default to in-memory SQLite. `DB_PATH` selects a persistent file;
each mode uses separate tables. `OPERATION_DELAY_MS` defaults to 100, accepts
0–5000, and exposes overlapping first-use work in the broken examples.
PORT accepts 0–65535. The server binds to localhost, bounds uploads, validates
keys/payloads and supports bounded shutdown. Restarting a memory-backed server
clears its data; file-backed data persists.

## Why the corrected application works

The corrected operation starts `BEGIN IMMEDIATE`, then reads the receipt inside
that write transaction. SQLite allows one simultaneous writer; a competing
writer must wait or get a busy error. See the
[SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html).

If a receipt exists, the application compares a normalized payload fingerprint:
same input replays the stored status/body; different input gets 409. If absent,
it creates the effect and receipt in the same transaction, then commits before
sending the response. The effect's key is unique as an additional storage guard.

```text
begin write transaction
  existing receipt → compare input → replay or reject
  no receipt       → create effect + save replay receipt
commit
send response
```

A failure before saving the receipt rolls back the effect too. A lost response
after commit leaves a durable receipt for the repeated request. A process-local
map alone cannot protect a second application instance; two instances must
share the same durable uniqueness/transaction boundary.

This example's effect and receipt are in one SQLite database. It does not make
a transaction atomic with an external payment provider, email server or queue.
Independent databases, receipt expiry/eviction, tenant/authorization scope,
multi-region replication, crash/power-loss testing and external side-effect
coordination require additional design and experiments. Keys must be scoped
to the caller and operation appropriately in a real application. The example
has one simulated operation type and no authentication.

Configure a semantically valid alternate payload for `conflictBody`. Veriq checks
the declared rejection status and resulting count; it does not independently
establish that this alternate payload would succeed under another new key, or
that rejection was internally caused by an input-fingerprint comparison.

## Automated verification

```sh
npm run check
```

Standard checks use repository-owned in-memory protocol fixtures and real HTTP.
They cover naive/racy/correct targets, fresh-key preconditions, replay mismatch,
wrong/missing evidence, body limits, JSON parsing, stream timeouts, lost responses,
sequential and concurrent cancellation, and regression tests for the shared pool.
These fixtures test Veriq's protocol behavior, not database durability.

For the optional SQLite application:

```sh
npm run experiment:idempotency
```

The local harness checks all three implementations, a replay after application
restart, two processes sharing a database, a committed operation with a lost
response, changed-input rejection, and an injected failure between effect and
receipt writes followed by rollback/recovery. It creates temporary databases
and assigned-port services, then cleans up only its own resources. It requires
the sibling repository directory to be named `veriq`; it is not part of the
self-contained standard checks. Node versions may emit a SQLite experimental
warning for this optional target.

One run establishes observed behavior for these keys, payloads, timing and
state API. It cannot prove permanent exactly-once execution or that an
unobserved race is impossible.

The separate [retry experiment](retry.md) now reuses a single fresh key across
a bounded recovery policy. It does not add automatic retries to this idempotency
command or change these sequential/concurrent stimulus rules.
