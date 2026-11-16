# Controlled HTTP concurrency

Concurrency means requests overlap. `veriq concurrency` sends a fixed number
of HTTP requests while keeping at most a configured number of client attempts
active at once.

```sh
veriq concurrency http://127.0.0.1:4400/work --requests 100 --concurrency 10 --max-duration-ms 500 --timeout-ms 2000 --format text
```

This requests 100 attempts, not 100 simultaneous requests. Ten workers initially
start up to ten attempts. Each worker reuses its slot after its current request
and cleanup finish. Scheduling is a rolling pool, not synchronized batches.

## Configuration

| Setting / CLI option | Default | Meaning |
| --- | --- | --- |
| `target` / positional URL | Required | Absolute HTTP(S) target. |
| `requests` / `--requests` | 20 | Total attempts, integer from 1 to 10000. |
| `concurrency` / `--concurrency` | 5 | Maximum client attempts in flight, integer from 1 to 256. |
| `method` / `--method` | GET | Supported HTTP method. |
| `expectedStatus` / `--expected-status` | 200 | Required final HTTP status, 200 to 599. |
| `maxDurationMs` / `--max-duration-ms` | 500 | Per-attempt response-header duration requirement. |
| `timeoutMs` / `--timeout-ms` | 2000 | Per-attempt observation limit; at least the duration requirement. |
| `headers`, `body` | None | Optional request settings in JSON. Shared unchanged across attempts. |
| `--format` | text | Text or JSON output. |

Use a URL with scheduling/request flags, or a JSON file exclusively:

```sh
veriq concurrency --config examples/concurrency.json --format json
```

The file accepts the HTTP configuration fields documented in the
[HTTP reference](http-foundation.md), plus `requests` and `concurrency`.
Request-setting flags cannot override `--config`; `--format` remains allowed.
Unknown fields, invalid scheduling settings and invalid HTTP settings fail
before any requests start. If concurrency exceeds the number of requests,
only the needed workers are allocated.

The command does not retry or follow redirects. Repeated POST requests are
real separate attempts and can produce separate side effects. There is no
payload templating, idempotency-key generation, traffic-rate control or global
run deadline.

## Results and cancellation

The assertion requires every requested attempt to receive the expected status
within its header-arrival requirement. Target FAILs do not stop scheduling.

| Situation | Result |
| --- | --- |
| Every requested attempt passes | PASS |
| At least one observed attempt fails, with no internal error | FAIL |
| Cancellation leaves incomplete work and no observed failure | INCONCLUSIVE |
| Veriq execution or cleanup failure | ERROR |

Ctrl+C and SIGTERM cancel active waits and prevent new attempts. Workers settle
and preserve their observations before the report is emitted. A prior failed
attempt remains FAIL after cancellation. An internal error takes priority,
stops scheduling and cancels peers. Evidence from those peers is retained too.

Normal exit codes are 0 PASS, 1 FAIL, 2 ERROR, 3 INCONCLUSIVE. Signal-cancelled
runs use 130 for SIGINT or 143 for SIGTERM, including partial FAIL reports.
A second interrupt forces termination and may prevent a final report.
Completed evidence is not rewritten if cancellation arrives after all required
observations complete. Local cancellation does not guarantee that remote work
or database writes stopped or rolled back.

## Report contents

JSON includes `schemaVersion: 1`, `runId`, UTC start/end timestamps, monotonic
run duration, configuration, completion, individual requests, summary,
assertion, result, finding and any internal error.

Request records are ordered by the number assigned when the worker claimed
the request, even when responses finish out of order. Each has its worker
number, HTTP evidence, assertion, result and error.

| Field | Meaning |
| --- | --- |
| `completion.requestedRequestCount` | Configured total. |
| `completion.attemptedRequestCount` | Attempts started, including cancelled or internally failed attempts. |
| `completion.completedRequestCount` | Attempts with evaluated PASS/FAIL requirements; includes timeouts and transport failures. |
| `completion.unstartedRequestCount` | Requested attempts never started. |
| `completion.reason` | `completed`, `cancelled`, or `execution-error`. |
| `summary.peakInFlight` | Maximum active client attempts, including response cleanup. |
| `summary.statusCounts` | Counts of received HTTP statuses. |
| `summary.unobservedAttemptCount` | Internal failures that produced no evidence record. |

The summary also counts responses, timeouts, request errors and cancelled
attempts. Received-response durations include mean, min, max, p50, p95 and
p99 using nearest rank. Timeouts/errors/cancellations remain evidence but do
not become received-response durations. No received responses means null
statistics, not zero latency. HTTP error responses are received responses.

Per-request time begins when the worker starts execution; it excludes waiting
for an available worker slot. Whole-run duration includes scheduling and cleanup.
Neither duration measures response-body completion.

`peakInFlight` is not a measurement of server concurrency or TCP socket count.
Connection behavior, proxies and application queues can change how work reaches
the target. Multiple Veriq processes each enforce their own limit; there is no
cluster-wide concurrency budget.

## Implementation

| Module | Responsibility |
| --- | --- |
| `src/http-concurrency.ts` | Validate HTTP/scheduling configuration and aggregate bounded request results. |
| `src/bounded-workers.ts` | Shared bounded worker allocation, unique claims, cancellation fan-out and settled result collection. |
| `src/http-experiment.ts` | Execute one attempt through shared validation, observation and assertion logic. |
| `src/http-observation.ts` | Own each request timer, caller cancellation, transport evidence and body cleanup. |
| `src/concurrency-report.ts` | Render full JSON or readable text with status counts, peak active attempts and every request record. |
| `src/cli.ts` | Parse URL/config settings and invoke concurrency execution. |
| `src/cli-cancellation.ts` | Own and remove process-signal handlers. |

There are only as many active worker promises as needed, capped at the worker
limit. A worker claims a request number before its first await. JavaScript
executes that claim synchronously, so two workers cannot claim the same number
inside this process. No shared-memory mutex is required for this scheduler.

Each worker owns a private cancellation controller. The caller's signal has
one subscription, which fans cancellation out to those controllers. This avoids
hundreds of listeners on the caller signal. Finalization removes the caller
listener and aborts any remaining worker resources. Active requests are awaited,
not abandoned when another worker reports an internal error.

All evidence is kept in memory until reporting, so memory grows with the number
of attempts. The configured bounds constrain growth but do not establish load
capacity or make this a throughput benchmark. There is no durable report store.

## Self-contained verification

```sh
npm run check
```

The unit suite verifies scheduling limits, unique claims, out-of-order results,
slot reuse, invalid settings, pre/in-flight cancellation, partial FAILs,
timeouts, cleanup errors, worker errors and report redaction.

The compiled-CLI integration suite uses real HTTP to verify healthy overlap,
independent server-side counters, capacity rejection, POST configuration,
text/JSON output, SIGINT/SIGTERM, timeouts and refused connections. It uses
repository-owned fixtures and automatically assigned ports. No external
testcase directory or SQLite database is required by `npm run check`.

For a manual test using only the repository, terminal A:

```sh
node --input-type=module -e 'import { createConcurrencyTarget } from "./test/support/concurrency-target.ts"; createConcurrencyTarget({capacity: 2, delayMs: 150}).server.listen(4400, "127.0.0.1");'
```

Terminal B:

```sh
veriq concurrency http://127.0.0.1:4400/work --requests 10 --concurrency 2 --format text
veriq concurrency http://127.0.0.1:4400/work --requests 10 --concurrency 5 --format text
curl http://127.0.0.1:4400/metrics
```

Expected: PASS at concurrency 2 when responses meet the timing requirement;
FAIL at concurrency 5 with some 503 responses. Metrics independently show
server work never exceeded its configured capacity. Counters accumulate for
the lifetime of the target. Stop it with Ctrl+C when finished.

## Optional busy-server and booking application

The standalone application lives at `../veriq-testcase/concurrency/server.ts`,
outside the Veriq repository. It uses Node's built-in SQLite module for actual
booking records. The driver's API is documented in the
[Node SQLite reference](https://nodejs.org/api/sqlite.html).
Some supported Node versions emit an experimental SQLite warning; the Veriq
core does not import SQLite or depend on this local application.

Start the application from the Veriq directory in terminal A:

```sh
PORT=4400 CAPACITY=2 BOOKING_MODE=naive node ../veriq-testcase/concurrency/server.ts
```

`GET /work` simulates asynchronous work. `CAPACITY` bounds accepted work; excess
requests get 503. `WORK_DELAY_MS` defaults to 100, `BOOKING_DELAY_MS` to 300;
both accept integers from 0 to 5000. `CAPACITY` accepts 1 to 256, PORT 0 to 65535.
The server binds to localhost, logs startup as JSON, bounds unexpected POST
bodies, cancels waiting work on disconnect and supports bounded shutdown.

Bookings use SQLite memory storage by default. Set `DB_PATH` to an explicit
local filename to persist records across restarts. Naive and atomic modes have
separate tables. Restarting a memory-backed process resets its data; a file
database preserves it. Use a fresh seat identifier for every new experiment.

### Booking race: same action, different persisted state

While naive mode is running, terminal B:

```sh
veriq concurrency --config examples/bookings-concurrency.json --format json
curl http://127.0.0.1:4400/bookings/A1
```

The config sends 20 POST requests for seat A1, at most five at once. Inspect
the returned `count` and `bookings` through the GET endpoint. A fresh naive
instance can save multiple rows for A1 because its check and write are split:

```text
A: check seat → available → await work → insert
B: check seat → available → await work → insert
```

Stop the application and start a fresh corrected instance, still on 4400:

```sh
PORT=4400 CAPACITY=2 BOOKING_MODE=atomic node ../veriq-testcase/concurrency/server.ts
```

Rerun exactly the same config and GET command. Expected state: one saved row
for A1. One POST returns 201; other attempts return 409 because the seat is taken.

The corrected implementation makes the database enforce `UNIQUE(seat)` and
uses one `INSERT ... ON CONFLICT(seat) DO NOTHING` statement, as described in
[SQLite's UPSERT reference](https://www.sqlite.org/lang_upsert.html). It does not rely
on a check performed earlier or on a lock inside one application process.
Separate application processes sharing that database enforce the same
constraint. Independent database files do not share this guarantee.

The HTTP report can be FAIL for both modes: requiring every POST to return
201 conflicts with legitimate 409 rejections in the corrected application.
That is distinct from the business-state assertion, **at most one booking per
seat**. The local experiment harness reads persisted state through the API
and separately reports that assertion as FAIL for naive and PASS for atomic.
The command itself does not inspect response bodies or automatically discover
application invariants. This distinction prevents false race-detection claims.

### Repeat all local application experiments

```sh
npm run experiment:concurrency
```

This optional script builds Veriq and runs
`../veriq-testcase/concurrency/experiment.test.ts`. It creates temporary database
files and services on assigned ports, then removes only its owned resources.
It requires the sibling repository directory to be named `veriq`.

The experiment checks healthy/capacity behavior, a sequential control, the
naive booking race, the corrected booking state, and two application processes
sharing one SQLite file. Observed results in the completed run were:

| Experiment | Evidence | Assertion/result |
| --- | --- | --- |
| Capacity 2, client concurrency 2 | Eight 200 responses | HTTP PASS |
| Capacity 2, client concurrency 5 | Two 200 and ten 503 responses | HTTP FAIL |
| Naive booking, 20 attempts at concurrency 5 | Five rows for one seat; five 201 and fifteen 409 responses | Seat uniqueness FAIL |
| Atomic booking, same workload | One row; one 201 and nineteen 409 responses | Seat uniqueness PASS |
| Two atomic application instances sharing one file | One saved row for the shared seat | Seat uniqueness PASS |

The simulated asynchronous delay makes the naive race easy to observe; it is
not an atomic simultaneous-start guarantee. Different scheduling can produce
different naive duplicate counts. The local tests assert duplicates exist,
not an exact duplicate count. The SQLite calls are synchronous and appropriate
to this small experiment, not a scalability recommendation for the application
under test. No payment or real booking is performed.

Concurrency increases opportunities to expose races. One passing run cannot
prove the absence of a race under every timing or deployment condition.
