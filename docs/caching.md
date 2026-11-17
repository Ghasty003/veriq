# Caching behavior

A cache keeps a copy of a value so the application can reuse it instead of
loading it from the source again. For example, a product endpoint may save a
copy of a price after reading the database. The next request can use that copy.

The benefit is less source work and potentially faster responses. The difficult
part is keeping the copy useful and sufficiently fresh when the source changes.

| Term | Meaning in this experiment |
| --- | --- |
| Cache miss | There is no usable saved copy, so the application loads the source. |
| Cache hit | The application returns an existing usable copy. |
| TTL | Time to live: how long a filled entry can be reused before it expires. |
| Stale value | A saved copy that differs from the current source value. It may still be allowed by a declared TTL policy. |
| Invalidation | Removing an old saved copy after a normal application update. The next read must load fresh data. |
| Write-through refresh | A normal update also replaces the saved copy. A subsequent read can be fresh without loading the source again. |
| Cache stampede | Many requests encounter the same expired entry and each starts a separate source load. |
| Single-flight | Requests for the same missing entry share one in-flight load and its result. |

A fast response alone does not demonstrate a cache hit. Veriq observes an
explicit counter of **source loads caused by cache reads**. Diagnostic source
observations and test writes do not increment this counter. This counter is
not a measurement of every database query performed by the test application.

## Run the experiment

```sh
npm run build
node dist/cli.js cache --config examples/cache.json
node dist/cli.js cache --config examples/cache.json --format json
```

The equivalent linked command is `veriq cache --config examples/cache.json`.
The target must implement the controlled HTTP/JSON contract below. Veriq does
not discover a cache, inspect Redis, or infer a hit from response speed.

## Required target contract

Four endpoint roles describe the application:

| Role | Operation | Required behavior |
| --- | --- | --- |
| `read` | GET the cached resource. | Return a JSON value selected by valuePointer. Fill an absent/expired entry before completing the response. |
| `source` | GET an authoritative diagnostic snapshot. | Return the source value and cumulative count of cache-triggered source loads for that caller/key. Reading this endpoint does not increment the count. |
| `originWrite` | POST, PUT or PATCH generated JSON. | Store the supplied value without invalidating or populating the cache. This represents an out-of-band source change. |
| `write` | POST, PUT or PATCH generated JSON. | Store the supplied value and invalidate or refresh the affected cache entry before acknowledging the write. Required only for the invalidation policy. |

Both mutation roles receive exactly `{"value":"<generated marker>"}` with
Content-Type application/json and must acknowledge completed writes with the
configured status and a complete JSON body, such as `{"ok":true}`. Veriq owns
the request body. Headers, including authorization, can be configured for each
endpoint independently. A failed or ambiguous write does not establish that
the intended state was installed, so dependent cache checks remain unknown.

Every target URL contains exactly one `{caller}` and one `{key}` placeholder,
in its path or query. Veriq replaces these with generated UUIDs. The destination
host cannot be templated. The source must isolate data and counters by the
complete caller/key pair. A never-used pair returns selected value null and
read count 0. Counts are nonnegative safe integers, never decrease during a run,
and increment when a cache-triggered source load starts, including concurrent
loads. Source snapshots must be authoritative and visible after acknowledged
writes; an eventually consistent diagnostic replica does not satisfy this API.

Before seeding a resource, Veriq verifies that fresh-resource precondition.
Existing or unavailable state leaves the phase inconclusive and is not modified.
Runs use two callers and up to six fresh caller/key resources. The generated
records remain available in the target afterward; the runner does not issue
cleanup deletions that could hide partial state or delete unrelated records.

The declared cache uses a fixed TTL from completion of a fill, with no extension
on hits, no early eviction under this experiment's small workload, and no
unsolicited background refresh. A raw origin update intentionally leaves a
warm copy alone until expiry. These are explicit requirements for this
experiment, not universal properties of all valid caches. Sliding TTL,
stale-while-revalidate, early eviction and background refresh need different
assertions. The experiment requires an authorized, controlled namespace with
no unrelated traffic using its resources.

## What Veriq does

| Phase | Actions | Evidence required |
| --- | --- | --- |
| Cold read | Seed V1 through originWrite, read the cache, inspect the source count. | Returned V1; exactly one cache-triggered source load. |
| Warm reuse | Change the source to V2 through originWrite, then make repeated reads while the original TTL is safely active. | Returned the cached V1; zero extra source loads. |
| Expiry | Wait beyond the first fill's expiry, then read again. | Returned V2; one additional source load after confirmed warm reuse. |
| Invalidation | On a separate resource, warm V1, write V2 through the normal application write, then read before the old entry would expire. | Returned V2; at most one source load for the post-write read. Zero is allowed for write-through refresh. |
| Isolation | Seed three resources: A/key1, A/key2 and B/key1 with different values. Read each twice. | Each returns its own value, loads once and reuses its own copy. |
| Expired-entry burst | Warm a separate resource, change its source, wait for expiry and send a bounded burst. | Every response returns the new value; the whole burst starts exactly one source load. |

The default required-invalidation run makes **18 cache reads**, plus mutation
and diagnostic requests: 53 HTTP observations when every phase completes.
The healthy local application performs **9 cache-triggered source loads**.
Those are different counts: a cache read can be a hit and do no source load.
The write-through example needs one fewer source load. With invalidation set
to ttl-only, its separate phase is omitted and there are 16 planned cache reads.
The report gives planned and attempted reads separately from all observations.

The warm phase deliberately expects the older V1 after the raw source change.
That demonstrates the declared retention policy. The expiry and normal-write
phases expect V2. A stale value is therefore evaluated against the phase's
explicit freshness requirement.

## Configuration

[examples/cache.json](../examples/cache.json) contains the complete local setup.

| Field | Default | Meaning |
| --- | --- | --- |
| `read` | Required | HTTP GET template for cached JSON; supports headers, expectedStatus, timeoutMs and maxDurationMs. |
| `source` | Required | HTTP GET template for diagnostic source JSON. |
| `originWrite` | Required | Mutation template for seeding and out-of-band updates; default method PUT. |
| `write` | Required when invalidation is required | Normal mutation template; default method PUT. Omit for ttl-only. |
| `valuePointer` | `/value` | JSON Pointer selecting the cached response value. |
| `sourceValuePointer` | `/value` | JSON Pointer selecting the source value. |
| `sourceReadsPointer` | `/reads` | JSON Pointer selecting the per-resource source-load count. |
| `ttlMs` | 1000 | Declared fixed TTL, 100–60000 ms. |
| `windowGuardMs` | Smaller of 50 or floor(ttlMs/10) | Margin before the earliest possible expiry; 1–floor(ttlMs/2) ms. |
| `expiryGraceMs` | 50 | Additional wait after the conservative expiry bound; 0–ttlMs. |
| `hitRequests` | 2 | Warm reads, 1–100. |
| `burstRequests` | 5 | Reads after expiry, 2–100. |
| `concurrency` | 5 | Burst worker limit, 2–32; also bounded by burst size. |
| `deadlineMs` | Larger of 10000 or 4×ttlMs+5000 | Overall budget, 1–2147483647 ms, including requests and expiry waits. |
| `invalidation` | `required` | Require normal writes to invalidate/refresh, or use ttl-only to omit that phase. |

All endpoint statuses must be successful JSON responses: 2xx excluding 204/205.
Unknown fields, invalid templates, unsupported methods, user-supplied mutation
bodies and conflicting content types are rejected before network activity.
The shared [HTTP configuration rules](http-foundation.md) bound headers, URLs
and waiting times. Mutation content type is application/json. Endpoints do not
follow redirects. JSON Pointers support ordinary /path and ~0/~1 escapes.

Each response is bounded to **64 KiB** and must finish as valid UTF-8 JSON.
The measured interval covers the **complete JSON body**, not just headers.
The example requires cache reads to finish within 500 ms. Other endpoint
waiting and duration defaults are 2000 ms. Request header/body values and
returned JSON values are omitted from reports. Selected values are compared by
canonical SHA-256 fingerprints; object key ordering does not change equality.
The report's expectedValues lists the intended initial/updated fingerprints per
resource, so actual response fingerprints can be compared without printing
values. Source confirmations establish whether the intended update was observed.
URL query values are redacted; paths and generated resource IDs remain visible.

## Timing and incomplete evidence

A warm read that runs after expiry cannot establish that a cache failed to
reuse an entry. Veriq therefore checks warm reuse only before
`cold request start + ttlMs - windowGuardMs`. Invalidation is checked inside
the same safe interval, so a naturally expired entry cannot masquerade as
successful invalidation. Isolation reuse uses a separate bound per resource.
The burst and its source-count audit must stay inside one conservative TTL
interval to avoid counting a legitimate second refresh after expiry as a
stampede. These guards can make slow environments inconclusive.

The cache fill completed before the cold response finished. Waiting from that
response's completion plus ttlMs plus expiryGraceMs therefore guarantees a
conservative expiry wait under the declared model. The wait rechecks its
monotonic clock to avoid proceeding early when a timer rounds a delay down.
Evidence offsets after JSON capture include cleanup, which can conservatively
reduce the interval available for subsequent checks.

A single overall deadline limits the workflow. Each observation receives the
smaller of its own timeout and remaining overall budget. The configured
response-duration requirement is still evaluated separately. Ctrl+C or SIGTERM
cancels active observations and expiry waits. Workers stop scheduling, cancel
peers on execution failures and settle before the report returns. JSON stream
cleanup is bounded; scheduling and cleanup can add overhead to the deadline.
Cancelling a request does not guarantee that target work stops.

| Situation | Interpretation |
| --- | --- |
| Source unavailable, missing counter, invalid counter or non-fresh resource | Precondition/instrumentation unavailable; dependent assertions remain unknown. |
| A count decreases | The raw snapshot and counter issue are retained; count-based assertions for that resource become unknown, not a negative number of loads or an assumed hit. |
| Cache returns the wrong selected value | FAIL for the relevant value requirement when its timing preconditions are known. |
| Cache returns an unexpected status or completes JSON too slowly | FAIL for the read-response requirement. |
| Timeout, connection loss, malformed JSON or oversized JSON | Preserve evidence; do not invent a selected value or completed response. Other known failures can still establish FAIL. |
| Several source loads are observed during the guarded burst | FAIL even if some response bodies are missing. Counter evidence directly establishes extra work. |
| Warm reads cross the safe TTL interval | Affected reuse assertions are unknown. Expiry load-count checks are also unknown if warm retention was not established. |
| An unexpected Veriq exception or body cleanup fails | ERROR, with attempted observations retained and sanitized errors. |
| Cancellation after a known violation | Keep FAIL; missing later evidence does not erase the violation. |

Result precedence is ERROR, then observed FAIL, then PASS only when every
applicable assertion is true; otherwise INCONCLUSIVE. Normal exit codes are
2, 1, 0 and 3 respectively. Signal cancellation uses 130/143 while preserving
the report result. Configuration errors go to stderr. Completed execution
reports, including execution errors, go to stdout.

## Implementation walkthrough

| File | Responsibility |
| --- | --- |
| `src/cache-config.ts` | Validate endpoint roles, templates, selected fields, policies and bounds before work begins. |
| `src/http-cache.ts` | Own fresh resources, markers, phase order, deadlines/waits, observations, count deltas and assertions. |
| `src/http-json.ts` | Shared bounded JSON observation: request, complete-body timing, cancellation, transport classification and stream cleanup. |
| `src/json-value.ts` | Shared safe JSON Pointer selection and canonical fingerprints. |
| `src/bounded-workers.ts` | Shared bounded burst execution and cancellation fan-out. |
| `src/cache-report.ts` | Render text or versioned JSON without performing HTTP work or changing results. |
| `src/cli.ts` | Load the bounded configuration file, own process signals, invoke the experiment and set its exit code. |

The runner starts by checking each resource's authoritative empty state. Its
seed path writes a generated marker and confirms that the source installed it
without recording a cache-triggered load. Dependent steps only run when their
setup is confirmed. Independent resources can still provide useful evidence
when an earlier phase could not establish its preconditions.

Every action creates an observation before awaiting HTTP. Its record keeps the
role, phase, bucket label, start/end offsets, HTTP/JSON evidence, selected value
fingerprint and source count where applicable. Responses and assertions remain
separate. A timed-out request does not become an assumed hit, and the runner
never resends an ambiguous mutation automatically.

The expiry wait uses the shared abort signal. The burst uses the existing
worker pool instead of creating unbounded promises or another scheduler.
Source audits compare per-resource cumulative counts around the relevant
actions. There is no reliance on global counters that unrelated keys could
change. No new cache backend integration is required: applications in any
language can expose the declared HTTP contract.

## Local application and manual tests

The standalone application lives in `../veriq-testcase/cache`, outside the
GitHub repository. It uses SQLite for authoritative values and load counters,
and process-local maps for cache entries and shared in-flight promises.
Use Node 22.18 or newer; no extra dependencies are needed. Some Node versions
print a warning for the bundled SQLite module.

Terminal A, from the Veriq repository:

```sh
MODE=single-flight node ../veriq-testcase/cache/server.ts
```

Terminal B:

```sh
npm run build
node dist/cli.js cache --config examples/cache.json
node dist/cli.js cache --config examples/cache.json --format json
curl http://127.0.0.1:4800/metrics
```

Expect PASS, 18 cache reads, nine source loads and one active source load at a
time in the healthy experiment. Five overlapping requests in the burst share
one load. Metrics are diagnostics; the experiment asserts the per-resource
source counts from its declared source endpoint.

Stop the application with Ctrl+C before changing modes. Use the same Veriq
configuration against each mode:

| MODE | Expected result | Behavior |
| --- | --- | --- |
| `single-flight` | PASS | Reuses unexpired entries, expires them, invalidates normal writes and shares pending fills. |
| `write-through` | PASS | Normal writes also replace the cached value. |
| `no-cache` | FAIL, warm-source-reuse | Every read loads the source. |
| `never-expire` | FAIL, expiry-value | Cached copies remain usable forever. |
| `no-invalidation` | FAIL, invalidation-value | Normal writes leave the old cached value usable. |
| `shared-key` | FAIL, caller-isolation | The cache ignores the caller and leaks a copy between callers sharing a key. |
| `shared-entry` | FAIL, key-isolation | All resources reuse one cache entry. |
| `stampede` | FAIL, burst-source-coalescing | Sequential hits work, but every simultaneous miss starts another source load. |

For example:

```sh
MODE=stampede node ../veriq-testcase/cache/server.ts
```

Then run the same cache command from terminal B. The burst can return five
correct new values while failing the source-work requirement: five source
loads occurred rather than one. Data correctness and work suppression are
different requirements.

Environment settings are PORT=4800, TTL_MS=1000, SOURCE_DELAY_MS=50 and
DB_PATH=:memory: by default. If changing ports or TTL, update the configuration
to match. Persistent SQLite files belong in the testcase folder or a temporary
directory. GET /metrics exposes process-local diagnostic totals. The source
and mutation endpoints are controlled test interfaces; caller labels are
namespace identifiers, not an application authentication scheme.

### Why single-flight needs careful invalidation

On a miss, the application publishes a promise for that caller/key before
another request can start a competing load. Other misses await that promise.
After success it installs the value with a new fixed TTL. After failure it
removes the pending promise, permitting a later request to try again. A client
disconnecting does not cancel a shared fill that other clients may still need.

A normal write also changes the entry's generation, removes its cached copy
and detaches its older pending promise. A load remembers the generation it
started under; it may populate the cache only if that generation is still
current. Its cleanup may remove only its own pending promise. This prevents
an older fill from restoring stale data or deleting a newer fill's promise
after an acknowledged update. A read already overlapping a write can still
receive its older snapshot; a subsequent read must use the new generation.

These maps are process-local. They are not a distributed lock, and normal
writes invalidate only the receiving process. The application has no retention
or capacity-eviction policy. It is a controlled test target, not a production
cache service or a prescription for deployment.

## Automated tests and their limits

From the Veriq repository:

```sh
npm run check
npm run experiment:cache
```

The first command needs only Veriq and permission to listen on localhost.
Unit tests cover strict configuration, cancelled execution, preconditions,
transport uncertainty, sanitized exceptions and retained known failures.
Real HTTP/compiled-CLI tests cover every mode, required and TTL-only policies,
source count loss/decrease, missing or bounded JSON bodies, guarded intervals,
HTTP failures, deadlines, signals, concurrent misses and invalidation during
an in-flight load. Fixtures are owned by `test/support/cache-target.ts`.

The optional second command needs the local testcase application. It starts
servers on assigned ports and uses temporary databases. It verifies all eight
SQLite-backed modes and the old-fill/write race. It also starts two processes
sharing one SQLite source: each cache starts its own load, and a write to A
invalidates A while B keeps its old copy until expiry. The harness expects
that observed limitation; it does not claim that local invalidation solves
cross-instance freshness. Owned processes and temporary databases are cleaned
up after the checks.

The CLI targets one declared read URL. When that URL is behind a load balancer,
it observes whichever instances receive the requests; it does not prove that
every instance was exercised. The source counter must cover all cache-triggered
loads in the declared scope. There is no guarantee over future background work
after the final snapshot, production load, every race schedule, storage faults,
clock shifts, all eviction algorithms or arbitrary HTTP/CDN caching semantics.
Multi-instance invalidation, distributed coalescing, stale-while-revalidate,
negative caching and capacity behavior require separate contracts and tests.
