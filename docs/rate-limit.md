# Rate limiting

A rate limiter gives each caller an allowance. In our example, a caller may make
**three accepted requests in one second**. Extra requests receive **429** until
that caller's window ends. Then the caller gets three available requests again.

This limits how quickly a caller can use an endpoint. Concurrency is different:
five requests can arrive together, and the limiter must still admit only three.
The check and counter update must work together so two requests cannot both
claim the same remaining place.

## The contract this experiment tests

```sh
veriq rate-limit --config examples/rate-limit.json
veriq rate-limit --config examples/rate-limit.json --format json
```

This experiment supports **per-caller, first-request-anchored fixed windows**:

- Each fresh caller begins with the full allowance.
- That caller's window starts when the server receives its first request.
- Accepted requests consume the allowance. Rejections do not extend the window.
- The full allowance becomes available after one window has elapsed.
- The target uses the configured header to identify the rate-limit bucket.

Veriq generates three different UUID identities, labelled primary, isolation
and concurrent in the report. Repeated invocations use fresh identities. The
endpoint must recognize these identities as separate callers with fresh buckets.
A target that ignores this header, limits by source IP, requires provisioned
accounts, or uses a global/shared bucket does not satisfy this contract. Such a
result does not establish that its intended rate-limit policy is defective.

Calendar-aligned windows, sliding windows and token buckets have different reset
rules. This command does not evaluate those algorithms. Configure a dedicated
controlled target matching this contract. There must be no unrelated traffic
using these caller identities. Proxies, caches and load balancers are part of
the observed path; the experiment cannot identify which component responded.

HTTP 429 describes excessive requests. Retry-After is optional in the
[HTTP specification](https://www.rfc-editor.org/rfc/rfc6585.html#section-4).
Veriq requires that header only when `requireRetryAfter` is true. This command
records rejection responses directly; it does not automatically retry them.

## What Veriq sends

With allowance 3 and excessRequests 2:

| Phase | Requests | Required behavior |
| --- | --- | --- |
| Primary | Five sequential requests using caller A. | First three return 200; the next two return 429. |
| Isolation | Three requests using caller B, while A's first window remains active. | All three return 200. A cannot consume B's allowance. |
| Reset | Wait for A's first window to expire, then send five using A again. | First three return 200; the next two return 429. |
| Concurrent | Five requests using fresh caller C, up to five active at once. | Exactly three return 200 and two return 429, regardless of completion order. |

The default complete experiment sends **18 requests**, calculated as
`4 × allowance + 3 × excessRequests`. It creates no unbounded background load.
If A's initial consumption cannot be confirmed, the reset phase is skipped and
its assertions remain unknown. The separate fresh-caller burst can still run.
A limiter that rejects every request fails the allowance requirement.

All supported HTTP methods and optional bodies can be configured. These are
real repeated operations; choose a target whose operations are appropriate for
the experiment. This command does not verify their business effects.

## Configuration

[The complete example](../examples/rate-limit.json) targets the local application.

| Field | Default | Meaning and bounds |
| --- | --- | --- |
| `request` | Required | HTTP target, optional method/headers/body, accepted expectedStatus, timeoutMs and maxDurationMs. See the [HTTP reference](http-foundation.md). Accepted status must be 2xx. |
| `algorithm` | `anchored-fixed-window` | The only supported window contract. |
| `identityHeader` | `x-ratelimit-client` | Header populated with generated caller UUIDs. It must be absent from request.headers and pass HTTP header validation. |
| `allowance` | 3 | Accepted requests per caller per window; 1–100. |
| `excessRequests` | 2 | Extra requests used to check rejection; 1–100. |
| `windowMs` | 1000 | First-request-anchored window length; 100–60000 ms. |
| `windowGuardMs` | Smaller of 50 or floor(windowMs/10) | Safety margin before the earliest possible window reset; 1–floor(windowMs/2) ms. |
| `resetGraceMs` | 50 | Extra wait beyond the conservative expiry bound; 0–windowMs. |
| `concurrency` | 5 | Active client worker limit for the burst; 2–64. Actual workers are also bounded by burst size. |
| `deadlineMs` | Larger of 10000 or 3×windowMs+1000 | Overall budget for requests, waiting and cleanup coordination; 1–2147483647 ms. |
| `rejectedStatus` | 429 | Expected excess rejection status; 400–499. |
| `requireRetryAfter` | false | Require a valid Retry-After value on observed rejections. |

Unknown fields and invalid values are rejected before requests. Request defaults
are GET, accepted status 200, timeout 2000 ms and maximum duration equal to the
timeout. The example explicitly requires response headers within 500 ms.
A valid Retry-After may be seconds or an HTTP date. The check validates syntax;
it does not establish that the hint matches the exact reset instant.

## Keeping timing conclusions honest

Suppose a window lasts one second but sending the first five requests takes
two seconds. Some extra requests may legally belong to a new window. Counting
them as a bypass would be incorrect.

Veriq starts a monotonic clock before the first request in each phase group.
Only responses observed before `phase start + windowMs - windowGuardMs` count
as confirmed inside that window. Isolation shares the primary group's clock.
It clips each request's waiting limit to the remaining phase and overall
budgets. Boundary overruns leave affected rate assertions unknown. The report
preserves the original response evidence even if it was outside the safe interval.

The server saw A's first request before Veriq received its first response.
Waiting until that response's observation time plus windowMs plus resetGraceMs
gives a conservative upper bound on the first window's expiry. Veriq then
checks a fresh full allowance using the same caller A.

The shared deadline stops new work, interrupts active requests and cancels the
reset wait. Ctrl+C and SIGTERM do the same. HTTP timers and bounded body cleanup
can add scheduling/cleanup overhead; this is not a hard real-time guarantee.
Cancelling observation does not guarantee cancellation of server work.

## Reports and results

Each attempt includes its phase, number, start and observation offsets,
`inWindow`, HTTP status/outcome/duration and cleanup evidence. The measured
boundary is **response headers**, not response-body completion. Client peak
activity counts active worker actions, including cleanup; it does not establish
the server's internal concurrency.

Assertions cover primary allowance, excess rejection and successful admission
cap; caller isolation; reset allowance/excess/cap; concurrent cap and exact
status distribution; response duration; and optional Retry-After validity.
The cap counts any observed 2xx response as a successful admission, even if it
is not the configured accepted status. The status distribution checks the exact
accepted and rejected statuses separately.

| Result | Meaning | Exit |
| --- | --- | --- |
| PASS | All required assertions are supported and satisfied. | 0 |
| FAIL | At least one observed requirement violation, such as too many admissions. | 1 |
| INCONCLUSIVE | Required evidence is unavailable, with no established violation. | 3 |
| ERROR | Invalid configuration or internal execution/cleanup failure. | 2 |

A timeout or lost connection does not reveal whether the server admitted that
request, so it is unknown admission evidence. Missing evidence does not become
an assumed rejection. More than the allowance of confirmed successful
admissions establishes a cap violation even if other requests are missing.
Known failures survive later cancellation; internal errors take precedence.
Signal cancellation exits 130/143 while preserving the report's result.
Invocation/configuration errors go to stderr; execution reports go to stdout.

Reports omit request header/body values, do not print generated identity values,
and redact URL query values. URL paths remain visible. They include run IDs,
versioned JSON, configuration summaries, assertions, completion reason and a
finding. Available completion reasons include completed, cancelled, deadline,
window-overrun, insufficient-evidence and execution-error.

## How the implementation fits together

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Read `--config`, validate output format, own process signals and map report results to exit codes. |
| `src/rate-limit-config.ts` | Validate and normalize the declared request, caller header, window, limits and budget before network activity. |
| `src/http-rate-limit.ts` | Own the experiment clock, generated callers, phase order, reset wait, per-attempt evidence and assertions. |
| `src/http-observation.ts` | Execute one HTTP request, capture headers or failure, sanitize evidence and release response resources. Shared with other commands. |
| `src/bounded-workers.ts` | Bound the concurrent burst, reuse available worker slots, cancel peers on stopping conditions and await their cleanup. |
| `src/retry-policy.ts` | Supply the existing Retry-After parser. No retry scheduling is used by the rate-limit command. |
| `src/rate-limit-report.ts` | Render the completed report as readable text or versioned JSON. |

The CLI loads a bounded JSON configuration and calls the experiment. The
experiment validates it before creating network work, sends the primary and
isolation phases, waits for reset only after confirmed consumption, and finally
runs a fresh-caller burst. Each observation records the measurement endpoint
before body cleanup so cleanup time does not silently become response time.
The shared experiment clock still includes cleanup when allocating future work.

The observer receives a private timeout clipped to the window and deadline.
The original configured duration requirement remains the assertion threshold.
A shorter available observation budget therefore yields unknown evidence if
no response is received; it does not silently redefine the user's requirement.

Assertions are separate from HTTP evidence. They use only observations that
support their specific claim, and the result is selected after all available
phases finish. The report formatter does no HTTP work and changes no outcomes.
No new generic rate-limiter or distributed execution framework is introduced:
this feature evaluates a declared target policy from outside the application.

## Run the local application

The application lives in `../veriq-testcase/rate-limit`, outside the GitHub
repository. It uses Node's bundled SQLite and needs no package installation.
Use Node 22.18 or newer; some versions print an experimental SQLite warning.

Terminal A, from the Veriq repository root:

```sh
MODE=atomic node ../veriq-testcase/rate-limit/server.ts
```

Terminal B:

```sh
npm run build
node dist/cli.js rate-limit --config examples/rate-limit.json
node dist/cli.js rate-limit --config examples/rate-limit.json --format json
curl http://127.0.0.1:4700/metrics
```

Expect PASS, 18 attempts, three caller roles, and three successful admissions
in the five-request concurrent burst. Metrics expose request/admission/rejection
counts and server handler activity. They are diagnostic and are not used as
Veriq assertions. Stop the application with Ctrl+C between modes.

| Start command | Expected result with the same example | Defect demonstrated |
| --- | --- | --- |
| `MODE=atomic node ../veriq-testcase/rate-limit/server.ts` | PASS | Counter check/update share one SQLite write transaction. |
| `MODE=global node ../veriq-testcase/rate-limit/server.ts` | FAIL, caller-isolation | All identities incorrectly share one bucket. |
| `MODE=racy node ../veriq-testcase/rate-limit/server.ts` | FAIL, concurrent-cap | A deliberate wait between reading and saving the counter lets competing requests reuse the same place. |
| `MODE=sticky node ../veriq-testcase/rate-limit/server.ts` | FAIL, reset-allowance | The bucket never renews after expiry. |

`PORT` defaults to 4700, `LIMIT` to 3, `WINDOW_MS` to 1000, and `DB_PATH` to
`:memory:`. Keep configuration and server settings aligned. Use `DB_PATH` for
persistent shared state; the file belongs in the testcase folder or a temporary
directory. Caller identifiers are hashed before storage. The trusted identity
header is for testing; accepting arbitrary caller-supplied identities would let
real users evade an identity-based production limit. The application does not
provide authentication, bucket retention/pruning, or production deployment setup.

The atomic mode uses `BEGIN IMMEDIATE`, reads/renews the bucket, compares its
usage and increments it before committing. No asynchronous wait spans the
transaction. SQLite serializes writers sharing the same database file; see its
[transaction documentation](https://www.sqlite.org/lang_transaction.html).
The racy mode reads outside that transaction and deliberately waits before
writing. Its stored counter can undercount actual admissions, which is why
Veriq checks externally observed successful requests rather than trusting that
counter alone.

## Automated verification

From the Veriq repository root:

```sh
npm run check
npm run experiment:rate-limit
```

The first command needs only the Veriq repository and localhost access. Unit
checks validate configuration, pre-cancellation, sanitized execution errors,
unknown transport outcomes and preservation of known failures. Real HTTP/CLI
tests exercise correct, global, racy, never-reset and deny-all limiters,
optional/required Retry-After, window overrun, deadline clipping, text/JSON and
both cancellation signals. Fixtures live under `test/support`.

The second command requires the local testcase folder. It starts temporary
SQLite applications on assigned ports and verifies all four modes. A separate
test sends ten concurrent requests across two processes sharing one database
and one caller: exactly three receive 200 and seven receive 429. That case
checks shared storage directly; the CLI experiment itself targets one URL.
Temporary databases and owned processes are cleaned up.

A passing burst provides evidence for the exercised schedule, caller count,
window and endpoint. It cannot prove that every possible race is absent, that
every load-balanced instance shares state, or that limits stay correct under
production load, clock shifts or storage failure. The local SQLite example
assumes a usable shared database file and does not model distributed storage.
