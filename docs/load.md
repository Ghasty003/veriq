# Load and saturation

An application has a limited amount of work it can do at once. Imagine a shop
with three cashiers. More customers initially mean more sales. Once all three
cashiers are busy, additional customers mainly create a longer queue.

For an application, those cashiers might be workers, database connections or
a dependency's available capacity. Veriq increases concurrent requests and
records what changes. It does not infer the limiting resource from latency alone.

| Term | Meaning |
| --- | --- |
| Concurrency | Requests the client has active at the same time. |
| Latency | How long one request waits for response headers. |
| Throughput | Responses observed per second, with the population stated explicitly. |
| Saturation | A resource is fully occupied; adding work stops producing a matching increase in useful completions. |
| Recovery | Behavior after returning to the initial, lower concurrency. |

The existing concurrency command sends one finite batch at one level. The load
command runs a sequence of timed levels and compares them.

## Run the experiment

```sh
npm run build
node dist/cli.js load --config examples/load.json
node dist/cli.js load --config examples/load.json --format json
```

The linked equivalent is `veriq load --config examples/load.json`.
The example ramps through **1 → 5 → 10 → 20**, then returns to **1** for recovery.
Each stage admits requests for one second. Active requests finish afterward;
their drain time belongs to that stage. A 250 ms pause separates stages.

Each response must have status 200 within 250 ms. A normal individual waiting
limit is 1000 ms. These are the example's explicit requirements, not universal
latency recommendations. Any observed wrong/late response, full per-request
timeout or transport error violates the request rule. Target failures do not
stop subsequent stages; bounded execution continues to collect comparisons.
Internal Veriq errors, cancellation and the overall deadline stop new work.

## How load is generated

Each stage owns a fixed number of client workers. A worker starts one request,
waits for its observation and cleanup, then starts another while admission is
open. This is **closed-loop load**: slower responses keep workers busy and
reduce how quickly they start additional requests. Concurrency 20 does not mean
20 requests per second.

At the stage boundary, admission closes without aborting active requests.
The runner waits for their evidence and cleanup, then pauses before the next
stage. A request admitted just before the boundary can finish afterward.
Actual network transmission may occur later than client admission because of
runtime scheduling or connection availability. The report does not claim a
hard real-time start or stop boundary.

One request-count cap per stage bounds work and retained evidence. If that cap
is exhausted, the stage is not credited with covering its requested duration,
even if the final responses finish after that duration. A fast capped burst
cannot silently become a PASS for a full-duration requirement. Known target
violations still establish FAIL. Raise the cap within its documented bounds or
shorten the requested window when the cap prevents the desired measurement.

Recovery uses the **first configured concurrency**, the same stage duration,
and the same requirements. It is independently reported: a ramp failure can
coexist with a passing recovery. A passing recovery does not erase the failure.
The pause is an observation setting, not proof that target work has drained.
Requests that timed out on the client may still occupy the server.

## Configuration

[examples/load.json](../examples/load.json) contains the complete local example.

| Field | Default | Meaning and bounds |
| --- | --- | --- |
| `request` | Required | Shared HTTP settings: target, method, headers/body, expectedStatus, maxDurationMs and timeoutMs. Default GET, status 200, duration 200 ms, timeout 2000 ms. |
| `stages` | `[1,5,10,20]` | 1–16 strictly increasing concurrency levels, each 1–256. |
| `stageDurationMs` | 2000 | Per-stage admission window, 50–60000 ms. |
| `maxRequestsPerStage` | 2000 | Attempt cap, 1–10000. Must cover the largest concurrency and minimum sample count. |
| `minSamplesPerStage` | 10 | Minimum evaluated attempts needed for a conclusive PASS, 1–10000. Too few samples are unknown, not a target failure. |
| `pauseMs` | 250 | Pause after a drained stage and before the next, 0–60000 ms. |
| `deadlineMs` | 60000 | One overall budget covering stages, drain, cleanup coordination and pauses; 1–2147483647 ms. |
| `minPassedRequestsPerSecond` | 0 | Optional throughput floor, 0–1000000. Zero disables it. Only evaluated for a complete, sufficiently sampled stage with no unknown attempts. |
| `recovery` | true | Add a final stage at the initial concurrency. |

The combined maximum request budget, including recovery, cannot exceed 50000.
Memory use grows with retained requests and evidence size. This bound is a work
and evidence limit, not a guaranteed memory allocation. Unknown fields, invalid
levels and budgets, and invalid HTTP settings are rejected before requests.
Timing requirements obey the shared rule: timeoutMs must cover maxDurationMs.
Headers/body values are omitted and URL query values are redacted in reports;
URL paths remain visible. See the [HTTP reference](http-foundation.md).

Methods and optional bodies follow the shared HTTP contract. These are real
repeated requests, including configured writes. Use a controlled target whose
operations are appropriate for repeated execution. There are no automatic
retries or redirect following. Changing load does not by itself verify business
state, idempotency or correctness of side effects.

## Read the results correctly

The boundary is **response headers**, matching the existing HTTP probe.
A status-200 streaming response can satisfy that requirement before its body
finishes. Response bodies are cancelled with bounded cleanup; the command does
not measure body transfer, full application work or server execution time.
The local test application sends headers only after its simulated work and
completion record finish, making the experiment meaningful for that target.

Each stage reports:

- Attempt count; passed, failed and unknown counts; status counts; timeouts and
  transport errors; and the peak number of active client worker actions.
- Durations among all received headers, including HTTP errors, and a second
  duration population containing only responses with the expected status.
- Mean, minimum, maximum, nearest-rank p50/p95/p99 for each response population.
  Timeouts, transport errors and cancellations have no observed response time
  and are excluded. No received responses means null statistics, not zero.
- Rates for starts, all received headers, expected-status responses and passed
  requests. Passed means both the status and duration requirement were met.

For example, one hundred very fast 503 responses create high header throughput
while contributing **zero passed requests**. An expected-status response can
also be too slow and fail. This is why neither a single completion rate nor
response latency alone establishes healthy performance.

Start rate divides admitted attempts by the actual admission interval, stopping
at the window, cap, cancellation or execution stop. Completion rates divide
observed counts by the stage's elapsed time **including drain and cleanup**.
Pauses are excluded. The JSON records both denominators. Partial/capped stages
have descriptive rates, not a sustained-capacity PASS. A zero interval yields
null rates. The optional throughput requirement uses passed requests per second
with the completion denominator.

Failure fraction uses **evaluated attempts only**. Unknown attempts are shown
separately and never counted as successes. This is descriptive; the requirement
remains every request passing, with no configurable failure tolerance here.
Nearest-rank percentiles from small samples do not establish production tail
latency. The sample minimum is an evidence threshold, not statistical confidence.

The comparison names the first tested ramp level with a requirement violation,
lists observed passing levels and reports recovery separately. Ratios compare
passed throughput and expected-status p95 with the first stage; absent/zero
baselines leave a ratio null. These are descriptive comparisons. Noise,
connection establishment, client resource limits, caching and unrelated traffic
can affect them. Passing a higher level after a lower-level failure does not
establish a monotonic capacity boundary.

## Results, partial work and failure handling

| Result | Meaning | Exit |
| --- | --- | --- |
| PASS | Every planned ramp/recovery stage covered its window, had enough evaluated samples and met the declared requirements. | 0 |
| FAIL | An observed request violation or an evaluated throughput floor failed in at least one stage. | 1 |
| INCONCLUSIVE | No established violation, but evidence is missing, sampling is insufficient, work was capped or planned stages were not completed. | 3 |
| ERROR | Invalid invocation/configuration or inability to execute/release resources correctly inside Veriq. | 2 |

A connection failure or an ordinary configured per-request timeout violates the
request requirement. An observation shortened by the overall deadline cannot
establish the original timeout rule and remains unknown unless it received a
response or observed a transport failure. Observed response status/duration is
still evaluated against the original requirement. Caller cancellation before
headers also remains unknown. Late cancellation does not rewrite already
received header evidence.

A known failure survives later interruption. Internal errors have precedence
and preserve attempted observations, including null evidence when HTTP execution
itself failed. Process signals belong to the CLI; the runner uses private abort
controllers. SIGINT/SIGTERM stop new work, cancel active observations and pause
waits, and exit 130/143 while preserving the report's result. The first overall
stop cause is retained if another arrives during cleanup. Scheduling and bounded
cleanup can extend wall time beyond the nominal deadline.

Reports go to stdout; invocation/configuration errors go to stderr. Versioned
JSON preserves each stage's ordered per-request evidence, worker identity,
admission/observation offsets, per-request assertion, summaries, stage assertions
and result. Completion metadata distinguishes duration-completed, request-cap,
cancelled, deadline and execution-error. Unknown stages or samples prevent a
PASS but do not hide violations established by other stages.

## Implementation walkthrough

| File | Responsibility |
| --- | --- |
| `src/load-config.ts` | Validate and normalize HTTP settings, increasing levels, sample/work budgets, timing and recovery policy. |
| `src/http-load.ts` | Own the shared deadline, stage order, admission clock, pause waits, observations, assertions, results and comparisons. |
| `src/load-summary.ts` | Calculate explicit populations, outcome counts and rates without performing network work. |
| `src/load-report.ts` | Render readable text or versioned JSON. |
| `src/bounded-workers.ts` | Shared worker ownership. Its optional shouldStart predicate closes admission and drains active actions without cancelling them. |
| `src/http-observation.ts` | Shared HTTP execution, header/failure measurement, sanitized evidence and bounded body cleanup. |
| `src/cli.ts` | Load the bounded JSON file, own process signals, invoke the runner and select output/exit code. |

The runner validates before allocating network work. It creates each stage
report before starting workers, so partial attempts remain available if a later
operation fails. Workers synchronously claim distinct request numbers. Admission
is checked immediately before a record is created; requests carry client-stage
offsets and the real observation endpoint is stamped before cleanup. Worker
records are sorted by request number after draining, even when responses arrive
out of order.

Each observer receives its own timeout clipped to remaining overall budget.
The original HTTP requirement is used for assertions, so shortening observation
never silently changes the user's rule. Target violations continue within the
bounded stage. Veriq exceptions stop admission, cancel peers and await their
settlement. The shared pool also handles an admission-predicate exception this
way; a stage boundary by itself does not abort peers.

The report separates coverage, minimum samples, per-request correctness and
optional throughput. Comparisons are derived from those stage reports rather
than a new heuristic saturation score. No distributed load generator, metrics
backend or resource detector is introduced without a concrete requirement.

## Local test application

The standalone application lives in `../veriq-testcase/load`, outside the GitHub
repository. It uses real HTTP connections and a bounded FIFO worker queue.
Service time is controlled asynchronous waiting, representing a dependency.
SQLite records admission, service start and completion, including work whose
client has disconnected. It is a controlled I/O example, not a CPU benchmark.
Node 22.18+ is required; bundled SQLite needs no extra package installation.
Some Node versions print an experimental SQLite warning.

Terminal A, from Veriq:

```sh
MODE=queue node ../veriq-testcase/load/server.ts
```

Terminal B:

```sh
npm run build
node dist/cli.js load --config examples/load.json
node dist/cli.js load --config examples/load.json --format json
curl http://127.0.0.1:4900/metrics
curl http://127.0.0.1:4900/audit
```

The default application has three workers with 50 ms service time per job.
The example's lower stages should PASS, the 20-worker client stage should FAIL
the 250 ms timing requirement, and recovery at concurrency 1 should PASS. More
waiting customers do not create more server workers: throughput levels off
while queueing increases response time. `/metrics` independently exposes active
and queued work, peaks, completions and rejections. `/audit` exposes the latest
50 persisted job records. Neither endpoint consumes a work-queue slot or is
used as a core Veriq assertion.

Stop the application with Ctrl+C before changing modes:

| Mode | Start setting | Expected pattern with the example |
| --- | --- | --- |
| Queued capacity | `MODE=queue` | Increasing delay after worker capacity is occupied; high-stage FAIL; recovery PASS. |
| Unbounded simulated I/O | `MODE=unbounded` | Bypasses the worker cap; these declared stages should PASS and show more overlapping service work. |
| Immediate rejection | `MODE=reject` | Excess arrivals return 503; high-stage FAIL even when header rates are high. A cap can also limit coverage. |
| Persistent degradation | `MODE=sticky` | Crossing the configured overload population permanently increases service time for that process; recovery should FAIL. |

For example:

```sh
MODE=reject node ../veriq-testcase/load/server.ts
```

Run the same Veriq command from terminal B. Fast 503s are preserved as status
counts and failed requests. They cannot inflate passed throughput. An error
response's short duration can make all-response latency look deceptively low;
expected-status statistics and rejection counts expose that distinction.

Environment settings: PORT=4900, CAPACITY=3, SERVICE_MS=50, MAX_QUEUE=64,
OVERLOAD_AT=10, STICKY_SERVICE_MS=8×SERVICE_MS, DB_PATH=:memory:. Bounds are
validated at startup. If using a different port, update the target URL. Put
persistent databases in the testcase folder or a temporary directory. Startup
prints the assigned URL. Signals stop admission, cancel owned queued/active
jobs, settle workers, close connections and then close SQLite.

This example keeps a bounded queue and diagnostic records, not a production
worker service. There is no log-retention policy, distributed admission control
or cross-process worker coordination. Each instance has its own worker pool;
sharing a log database does not combine their capacity limits.

## Automated verification

From Veriq:

```sh
npm run check
npm run experiment:load
```

Standard checks need only this repository and permission to listen on localhost.
Unit tests cover bounds, exact summary populations/rate arithmetic, cap/sample
uncertainty, original versus clipped waits, retained failures, cleanup, sanitized
errors and admission closure/exception ownership. Real HTTP/CLI tests check
queueing and a throughput plateau, healthy scaling for simulated I/O, fast
rejections, persistent degradation, recovery, caps, samples, POST settings,
secret omission, timeouts, overall deadlines and both process signals. The
fixture belongs to `test/support/load-target.ts`.

The optional command requires the local application. Its assigned-port servers
and temporary SQLite databases exercise all four modes. It also verifies a
persisted completed job after the observing caller cancels. Owned processes and
temporary files are cleaned up. A deliberately expected FAIL report is a passing
harness test when its evidence matches the asserted requirement violation.

These tests establish the exercised client levels, windows and controlled server
conditions. They do not establish maximum sustainable production throughput,
every load-balanced instance's behavior, long-term stability or root cause.
Closed-loop load reduces arrivals when responses slow; it does not reproduce a
fixed external arrival rate, and its latency distribution can miss the waiting
that such arrivals would experience. Request caps, connection reuse, response
body cancellation, instrumentation and the load generator's own resources can
limit achieved load. Actual backend attribution needs independent server data,
such as the local fixture's known worker/queue measurements. Constant-arrival
load, multi-machine generation, production resource metrics, long soak tests and
automatic capacity search remain separate work.
