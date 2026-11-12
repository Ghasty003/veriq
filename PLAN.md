# Veriq learning and build plan

Veriq tests observable system behavior against explicit requirements.
We are building a serious tool and learning system design through experiments.
Build the smallest production-quality implementation for each current feature.
Use the real code as teaching material, and keep explanations simple.

## Working loop — implementation first

This workflow supersedes the earlier teach-first and automatic next-lesson
instructions. For each meaningful feature or architectural slice:

1. Inspect the existing architecture and reason internally about the production
   design: contracts, ownership, failure conditions, cancellation, concurrency,
   security, performance, and testing. Keep design discussion focused.
2. Build the complete useful feature with realistic error handling, validation,
   cleanup, and stable boundaries where needed. Avoid throwaway core code,
   placeholders, speculative abstractions, and infrastructure without a current use.
3. Test isolated logic and real boundaries, including failure paths and relevant
   concurrency. Controlled test targets may simulate faults; Veriq execution
   must perform real interactions where practical.
4. Stop and explain what was built: responsibilities, execution flow, important
   code paths, decisions and alternatives, system-design concepts, failure modes,
   production concerns, test evidence, and limits. Include exact testing commands.
5. Stop for implementation review before the next substantial feature.
   Documentation explains behavior and how to test it; do not include quizzes,
   practice questions, or understanding checks.

The application under test remains language-agnostic. TypeScript is the initial
implementation language; introduce specialized Go components only for a concrete
engineering need. Evidence supports conclusions; avoid architecture scores.
Distinguish target requirement failure (FAIL), insufficient evidence
(INCONCLUSIVE), and inability to execute correctly inside Veriq (ERROR).

## Current implementation and next feature

The HTTP foundation has been strengthened around `veriq run`, validated JSON
configuration, a cancellation-aware HTTP observation lifecycle, explicit results,
and versioned text/JSON reporting. Existing `probe` and `latency` commands remain
available; their earlier work is recorded below as history.

The [HTTP command reference](docs/http-foundation.md) documents the completed
foundation. The strengthened latency command now supports configurable sampling
and requirements, cancellation, preserved per-attempt evidence, explicit partial
completion and text/JSON reports. Standard verification is self-contained in
this repository through `npm run check`. Review the completed latency
implementation and usage before the next substantial feature.

Test applications live in the sibling `../veriq-testcase` folder, outside this
repository. Veriq-owned test helpers stay under `test/support/`; standard checks
do not import companion applications. See [testing](docs/testing.md).
The user manages adding folders to the editor workspace.

## Milestone 1: HTTP reachability and the first CLI

Requirement: receive HTTP response headers with status 200 within two seconds.
The experiment does not inspect the body or establish sustained availability.

- [x] Explain reachability, health checks, and the limits of a single response.
- [x] Build a local application with `/health`.
- [x] Record structured HTTP evidence, including timestamps, duration, status, and request errors.
- [x] Apply the expected-status and waiting-limit assertion.
- [x] Observe PASS for 200, FAIL for 404, and FAIL for a three-second response delay.
- [x] Remove the delay and observe PASS with the same experiment.
- [x] Observe that server work can continue after the client times out.
- [x] Separate the probe, assertion, and command-line invocation.
- [x] Add argument validation and help; distinguish invalid invocation (ERROR) from an unmet requirement (FAIL).
- [x] Package the local executable: `veriq probe <url>`.
- [x] Add the minimal TypeScript build/type-check setup needed for that executable.
- [x] Exercise connection failure and redirects with explicit expectations.
- [x] Review the first concept and its limits before moving on.

Current invocation:

```sh
veriq probe http://127.0.0.1:3000/health
```

The CLI supports `run`, `probe`, `latency`, and `--help`. `run` accepts a URL
or an explicit JSON configuration file; probe and latency require a URL.
Legacy probe/latency exit codes are 0 for PASS/help, 1 for FAIL, and 2 for ERROR.
Run also uses 3 for INCONCLUSIVE, or 130/143 for signal cancellation. Experiment reports
go to standard output; invocation/configuration errors go to standard error.
Completed run reports, including execution ERROR reports, go to standard output. Invalid arguments
are rejected before making a request and do not produce experiment evidence.
The package executable entry maps `veriq` to `dist/cli.js`; `npm link` makes it
available through the current Node installation. `npm run build` compiles source
changes into `dist/`, and `npm run typecheck` checks the TypeScript without
emitting JavaScript. During development, `npm run dev -- probe <url>` runs source
directly. See README.md for local setup.
Initial use is local; publishing to a registry is a separate future decision.
All HTTP commands share the observation lifecycle and expected-status/duration assertion.
Run supports text or JSON output; legacy commands retain their JSON output.
The command interface uses Commander for argument parsing and help. Experiment
logic remains in the probe, assertion, and latency modules.

Additional observed cases:

- `/redirect` returned 302 with `Location: /health`, producing FAIL under the
  expected-200 rule. Server request logs confirmed the probe did not follow it.
- `/health` passed while the temporary server was listening on port 3001.
  After stopping that server, the same URL produced request-error, no status,
  and FAIL. The preserved underlying error reported ECONNREFUSED.
- Evidence now includes the Location header and the underlying error cause
  when the runtime provides one. A request error remains evidence for a valid
  experiment; it does not by itself mean Veriq encountered an ERROR.

## Milestone 2: Latency measurement

Learn what the measured interval includes, why one sample is insufficient,
and how repeated measurements differ from a latency guarantee. Design the
smallest repeated-request experiment before adding statistics or load.

Current experiment: `veriq latency <url>` sends configurable sequential GET
requests. Defaults remain five samples, status 200 within 200 ms each, and a
2000 ms observation limit per attempt. Flags configure sample count, expected
status, duration requirement, timeout and text/JSON output. These timing values
are example requirements, not universal latency recommendations.

Production implementation additions:

- [x] Validate bounded sampling and timing requirements before requests.
- [x] Reuse cancellation-aware HTTP execution and cleanup for each sample.
- [x] Preserve target failures and continue remaining attempts.
- [x] Preserve partial evidence and distinguish completed, cancelled and execution-error runs.
- [x] Retain FAIL after an observed failure even if later sampling is cancelled.
- [x] Report versioned JSON or readable text with per-attempt results.
- [x] Verify real immediate, slow, occasional-delay, timeout, status, signal and connection-error cases.
- [x] Make standard build/type/unit/integration checks independent of local testcase applications.
- [x] Document behavior and testing without review questions.

- [x] Explain waiting time versus handler execution time and the measurement boundary.
- [x] Distinguish the latency requirement from the waiting limit.
- [x] Preserve all five evidence records and per-sample assertions, even after failures.
- [x] Run the same latency experiment against immediate responses, 350 ms delayed responses, and restored immediate responses: PASS, FAIL, PASS.
- [x] Confirm the original probe still passes a 350 ms response under its two-second rule.
- [x] Confirm fast 404 responses fail the latency experiment despite their short durations.
- [x] Explain sample variation, first-request overhead, and connection reuse without assuming causes from total duration alone.
- [x] Compare an average-only requirement with the every-sample requirement using a controlled occasional slow response.
- [x] Explain percentiles and tail latency, including the limitations of small sample counts.
- [x] Discuss timeouts as incomplete latency measurements and the observer's limitations.
- [x] Add outcome counts and received-response statistics: mean, minimum, maximum, p50, p95, and p99 using nearest rank.
- [x] Check calculations with known distributions and run real response, slow-response, timeout, and connection-failure experiments.
- [x] Reflect on what sequential samples establish and what remains untested.

Occasional-delay experiment:

- Start a fresh single test application instance with RESPONSE_DELAY_MS=0 and
  OCCASIONAL_DELAY_MS=800. Every third `/health` request in a group of five gets
  an extra 800 ms delay; other requests get no intentional delay.
- Run the existing five-sample latency command without other `/health` traffic.
  The server counter resets when the application restarts.
- Observed samples were approximately 14.97, 2.22, 803.32, 3.02, and 2.60 ms,
  all with status 200. Their average was 165.23 ms, below 200 ms.
- An average-only requirement would pass those observations. The actual
  every-sample requirement failed the third sample and returned FAIL.
- Restarting with OCCASIONAL_DELAY_MS=0 restored PASS with the same command.
- The report now includes an average and percentiles among received responses.
  These summarize evidence; they do not replace the every-sample assertion.
- This fixture establishes the cause through controlled setup and server logs.
  The external durations alone do not identify causes in arbitrary applications.

Summary rules:

- Counts distinguish received responses, timeouts, and request errors.
- Received responses include any HTTP status; a fast 404 can appear in duration
  statistics while still failing the assertion.
- Statistics use only elapsed durations ending at received response headers.
  Timeout and request-error durations describe the attempt's observation interval,
  not an observed response time, and are excluded.
- If no response headers arrive, responseDurations is null, not zero.
- Reports state the received-response population, its count, and nearest-rank
  percentile method. With five received responses, p95 and p99 equal the maximum;
  this does not establish production tail latency.
- In a real mixed run, four responses averaged approximately 5.54 ms, while
  one attempt timed out. The overall result remained FAIL.
- Unit checks can be rerun with `npm test`; build and type checking remain separate.

## Milestone 3: Timeouts and deadlines

Build on the waiting limit already observed. Explore client and server work,
deadline propagation, and the difference between stopping a wait and cancelling
an operation. Add capabilities only when an experiment requires them.

- [x] Distinguish a per-action timeout from an overall operation deadline.
- [x] Calculate remaining budget after sequential work.
- [x] Observe that five fresh two-second waits can take about ten seconds overall.
- [x] Build and verify a simulated payment dependency that responds after three seconds.
- [x] Build a naive checkout endpoint that waits for that dependency without an explicit short timeout.
- [x] Add a bounded dependency wait and a defined checkout error response.
- [x] Run the same Veriq experiment against both checkout versions: require status 504 within 1000 ms under the controlled slow-dependency condition, with a 2000 ms observer waiting limit.
- [x] Implement and document overall application deadlines using multiple sequential dependency calls and remaining budget.
- [x] Observe that cancelling a dependency wait does not automatically cancel dependency work.
- [ ] Implement a shared deadline-propagation protocol and cooperative cancellation across the HTTP boundary in a separate experiment.
- [x] Document deadline guarantees, scheduling limits, and work continuing after observation stops.

Observed baseline: with RESPONSE_DELAY_MS=3000 and OCCASIONAL_DELAY_MS=0,
the existing latency command took approximately 10,042.56 ms overall. All five
attempts timed out after approximately 2000 ms each; no response durations were
available. This demonstrates the current per-attempt waiting policy. We have
not yet implemented an overall experiment deadline.

Current focus is timeout behavior inside the application being tested, rather
than adding an overall run deadline to Veriq. The intended topology is
Veriq -> checkout -> simulated payment dependency. Overall Veriq run deadlines
and incomplete-run result handling are deferred until a concrete experiment
needs them.

First fixture step: `veriq-testcase/dependency-timeout/payment.ts` exposes
GET /payment-status on port 4001 and schedules a status-200 JSON response after
3000 ms. It simulates a payment status; it does not process payments.
A direct request with a five-second wait allowance received 200 after approximately
3020.65 ms. Veriq's existing two-second probe timed out after approximately
2004.45 ms and returned FAIL. This verifies the dependency setup. The probe now accepts a configurable expected status, response-duration
requirement, and observer waiting limit.

Naive checkout step: `veriq-testcase/dependency-timeout/checkout.ts` exposes
GET /checkout on port 4000, calls PAYMENT_URL (defaulting to the simulated
payment service on port 4001), and waits without an explicit short dependency
timeout before responding. It simulates checkout readiness and does not place orders.
The controlled run used ports 4100 and 4101 because 4001 already had a listener.
Veriq timed out after approximately 2004.88 ms. Checkout logged its attempt to
respond after approximately 3.05 seconds, after Veriq finished. A direct caller
with a five-second allowance received 200 after approximately 3019.36 ms.
The corrected modes and configurable expected-504 assertion are now implemented.

Completed timeout/deadline experiment:

- Checkout `MODE=bounded` applies a 500 ms dependency timeout and returns 504
  on timeout; other dependency errors return 502. Healthy responses return 200.
- The same expected-504-within-1000-ms test observed naive FAIL (observer timeout
  at approximately 2004.8 ms) and bounded PASS (504 at approximately 523.3 ms).
- Three sequential 800 ms calls with fresh 1000 ms per-call timeouts returned
  200 at approximately 2444.1 ms, failing the prompt-failure requirement.
- `MODE=deadline` reused one 1500 ms deadline across calls and returned 504 at
  approximately 1523.1 ms, passing the expected-504-within-2000-ms requirement.
  Server logs confirmed the third call did not start.
- Healthy one-call and three-call cases returned 200, while an upstream 404
  became 502 and failed an expected-504 assertion.
- `npm run experiment:timeouts` repeats these real HTTP checks with temporary servers
  on assigned ports. `npm test` covers assertions, CLI validation, and summaries.
- See [the walkthrough](docs/dependency-timeouts.md) for exact commands and
  measurement limits. These are local application budgets; HTTP deadline
  propagation and an overall Veriq run deadline remain separate future work.

## Later concept progression

Each item uses the same working loop; this is a learning sequence, not a promise
to create all features now. Teach prerequisites before dependent concepts.

1. Basic concurrency.
2. Idempotency.
3. Retries and retry safety.
4. Rate limiting.
5. Caching behavior.
6. Load and saturation.
7. Backpressure.
8. Queues and at-least-once delivery.
9. Consistency.
10. Replication-related behavior.
11. Dependency failure and resilience.
12. Circuit breakers.
13. Distributed locking.
14. Horizontal scaling.
15. Observability.
16. Fault injection and chaos experiments.
17. Further distributed-system properties when justified.

## Architecture boundaries

- The invocation reads arguments, coordinates an experiment, and prints results.
- The HTTP probe interacts with the target and returns evidence.
- The assertion evaluates evidence against a stated requirement.
- Tested applications can use any language; HTTP is our first interaction boundary.
- TypeScript is the initial implementation language. Node-specific CLI details
  stay in the invocation where practical.
- Introduce runners, adapters, capabilities, and persistence when a concrete
  experiment needs them. Introduce Go only for a measured engineering reason.

Results will be PASS, FAIL, WARN, INCONCLUSIVE, or ERROR when their meanings
are needed. Never use architecture scores. Keep raw evidence, observations,
assertions, results, and findings distinct, and do not claim more than the
observations support.
