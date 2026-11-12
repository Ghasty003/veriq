# Dependency timeouts and checkout deadlines

This experiment asks: **when payment is slow, does checkout return a defined
failure promptly instead of leaving its caller waiting?**

These are simulated services. They do not take payments or place orders.
The companion `../veriq-testcase/dependency-timeout` folder is required and
is not included in this repository. See [testing prerequisites](testing.md#workspace-layout).
All commands below run from the Veriq project directory. Use separate terminals
for payment, checkout, and Veriq. Stop a fixture with Ctrl+C before restarting
it with different settings. If ports 4200/4201 are occupied, choose free ports
and update both `PAYMENT_URL` and your probe URL.

## 1. The three participants

```text
Veriq  --->  checkout application  --->  simulated payment service
```

Payment supplies a delayed answer. Checkout waits for payment and answers its
caller. Veriq observes checkout's HTTP response headers and evaluates a rule.

There are three separate numbers in our first experiment:

| Number | Owner | Meaning |
| --- | --- | --- |
| 500 ms | Checkout | Stop waiting for this payment call after about 500 ms. |
| 1000 ms | Test requirement | Checkout must return HTTP 504 within 1000 ms. |
| 2000 ms | Veriq | Stop observing if no response headers arrive within 2000 ms. |

The extra time between 500 and 1000 allows checkout to handle the timeout and
send its failure response. The 2000 ms observer limit lets us distinguish a
late response from no response received within that observation window.
These values are chosen for this experiment; they are not universal production settings.

## 2. Start the slow dependency

Terminal A:

```sh
PORT=4201 PAYMENT_DELAY_MS=3000 node ../veriq-testcase/dependency-timeout/payment.ts
```

Payment waits three seconds before attempting to return 200 with
`{"status":"approved"}`. Its logs show when work starts, when a caller
disconnects early, and when its timer finishes.

## 3. Test the naive checkout

Terminal B:

```sh
PORT=4200 MODE=naive PAYMENT_URL=http://127.0.0.1:4201/payment-status node ../veriq-testcase/dependency-timeout/checkout.ts
```

This version has no explicit short dependency timeout. It waits for payment.
The runtime may have its own eventual network limits; "naive" does not mean
the network can literally wait forever.

Terminal C:

```sh
npm run build
veriq probe http://127.0.0.1:4200/checkout --expected-status 504 --max-duration-ms 1000 --timeout-ms 2000
```

Expected result: **FAIL**. Veriq receives no response within about two seconds.
Its evidence has `outcome: "timeout"` and `status: null`.
This does not prove checkout is permanently broken. Checkout may answer later.
Look at Terminal B: after about three seconds it attempts a 200 response.

The experiment requires a quick, defined timeout response **under this slow
dependency condition**. It is deliberately not the usual expected-200 rule.

## 4. Fix the dependency wait and rerun the same test

Stop checkout in Terminal B. Leave payment running. Restart checkout:

```sh
PORT=4200 MODE=bounded DEPENDENCY_TIMEOUT_MS=500 PAYMENT_URL=http://127.0.0.1:4201/payment-status node ../veriq-testcase/dependency-timeout/checkout.ts
```

Rerun exactly the same Veriq command:

```sh
veriq probe http://127.0.0.1:4200/checkout --expected-status 504 --max-duration-ms 1000 --timeout-ms 2000
```

Expected result: **PASS**, with status 504 after roughly 500 ms.

```text
0 ms       Checkout asks payment for its status.
~500 ms    Checkout stops its payment wait and returns 504.
~3000 ms   Payment's own simulated work still finishes.
```

A passing test means checkout handled this dependency timeout according to
our rule. It does not mean payment succeeded. A normal availability test
requiring 200 would fail that same 504 response.

To inspect the application's body separately:

```sh
curl --include http://127.0.0.1:4200/checkout
```

The body is `{"error":"payment-timeout"}`. Veriq currently checks headers,
status, and header-arrival duration; it does not verify this body. Curl makes
another request, so its response is a separate observation.

## 5. Check the healthy case too

Stop payment in Terminal A and restart it with a shorter delay:

```sh
PORT=4201 PAYMENT_DELAY_MS=50 node ../veriq-testcase/dependency-timeout/payment.ts
```

Leave bounded checkout running. Now use a success requirement:

```sh
veriq probe http://127.0.0.1:4200/checkout --expected-status 200 --max-duration-ms 1000 --timeout-ms 2000
```

Expected result: **PASS**. Payment replies before checkout's 500 ms limit.
Checking both slow and healthy conditions prevents us from calling an
application that always returns 504 a correct implementation.

## 6. Why a timeout for each call is not a checkout deadline

A **per-call timeout** gives each payment call its own allowance.
An **application deadline** gives the whole checkout one shared allowance.

Our fixture can make three sequential payment calls. This deliberately
simulates multiple dependency steps; repeating this simulated status call
is not a recommendation for real checkout design.

Stop payment and checkout. Terminal A:

```sh
PORT=4201 PAYMENT_DELAY_MS=800 node ../veriq-testcase/dependency-timeout/payment.ts
```

Terminal B, initially with only per-call timeouts:

```sh
PORT=4200 MODE=bounded DEPENDENCY_CALLS=3 DEPENDENCY_TIMEOUT_MS=1000 PAYMENT_URL=http://127.0.0.1:4201/payment-status node ../veriq-testcase/dependency-timeout/checkout.ts
```

Terminal C:

```sh
veriq probe http://127.0.0.1:4200/checkout --expected-status 504 --max-duration-ms 2000 --timeout-ms 3500
```

Expected result: **FAIL**. Every 800 ms call fits its individual 1000 ms
timeout, so checkout eventually returns 200 after roughly 2400 ms.
That violates our controlled scenario's requirement for a prompt 504.

```text
Call 1:   0 ->  800 ms
Call 2: 800 -> 1600 ms
Call 3:1600 -> 2400 ms
```

Now stop checkout and restart it with a shared deadline:

```sh
PORT=4200 MODE=deadline DEPENDENCY_CALLS=3 DEPENDENCY_TIMEOUT_MS=1000 DEADLINE_MS=1500 PAYMENT_URL=http://127.0.0.1:4201/payment-status node ../veriq-testcase/dependency-timeout/checkout.ts
```

Rerun the same Veriq command. Expected result: **PASS**, with status 504
after roughly 1500 ms. Checkout's body says `checkout-deadline-exceeded`.

```text
0 ms       Checkout starts its one 1500 ms deadline.
~800 ms    First call finishes. About 700 ms remain for checkout.
~1500 ms   Deadline expires during the second call; checkout returns 504.
           The third call never starts.
```

The second call may normally wait 1000 ms, but checkout has only about 700 ms
left. Its effective allowance is the smaller of those two numbers.
The deadline is created once at checkout's start and reused across calls.
Giving every call a new 1500 ms deadline would lose the total-operation limit.

You can also restart payment with `PAYMENT_DELAY_MS=50` while keeping deadline
checkout running, then test expected 200 within 1000 ms. All three short calls
should finish within the shared deadline.

## 7. What the code does

`checkout.ts` uses `AbortSignal.timeout()` for each bounded dependency call.
Deadline mode creates an additional signal once per checkout.
`AbortSignal.any()` stops the active dependency wait when either limit expires.
The signal covers both fetching payment headers and reading its JSON body.
Checkout also checks the deadline between steps and before returning success.

Checkout distinguishes two failure responses:

| Situation | Response |
| --- | --- |
| Payment wait or checkout deadline expires | 504 |
| Dependency request fails, returns a non-success status, or has invalid JSON | 502 |
| All required dependency steps finish in time | 200 |

To exercise 502 manually, restart checkout with `PAYMENT_URL` ending in
`/missing` instead of `/payment-status`. Payment returns 404, and checkout
maps that dependency failure to 502. An expected-504 test must fail here.
You can inspect the behavior with an expected-502 probe or curl.

`http-probe.ts` handles observation, `http-assertion.ts` applies the chosen
requirement, and `cli.ts` accepts the flags and prints JSON. Commander handles
CLI arguments and help. The default `veriq probe <url>` still requires 200
within 2000 ms. Configurable repeated-request sampling is described in the
[latency reference](latency.md).
The CLI rejects a response requirement longer than its observer limit.

## 8. Repeat the optional local experiments automatically

From the Veriq directory:

```sh
npm run typecheck
npm test
npm run experiment:timeouts
```

The last command is optional, requires the external testcase folder, and is
not part of `npm run check`. It builds Veriq and starts its own temporary services on
automatically assigned ports. It does not stop your manually running services.
It tests naive timeout failure, bounded timeout handling, healthy success,
distinct 502 behavior, three-call behavior without a deadline, deadline
failure handling, and healthy three-call success. It also checks logs for
continuing payment work and confirms the third call does not start after the
checkout deadline. All processes it creates are stopped afterward.

`npm test` checks CLI validation, assertions, and the existing latency summaries
without starting the fixture servers. Exit codes remain 0 for PASS/help,
1 for FAIL, and 2 for invalid invocation or other ERROR.

## 9. What this establishes, and what remains

These experiments establish behavior for these requests under these controlled
delays. They do not establish that every production request meets the budget.
Timers and cancellation require the Node event loop to run. Scheduling,
serialization, and network overhead can make observed responses arrive later
than the configured cutoff. This is a practical time budget, not a hard
real-time guarantee; the assertion evaluates actual observed duration.

**Stopping a wait does not automatically stop another server's work.**
Payment intentionally keeps its timer running after checkout disconnects.
Checkout also does not cancel all its work merely because Veriq stops waiting.
This makes the difference visible in logs. Neither behavior implies rollback
of a payment or transaction.

The checkout deadline currently controls checkout's own waits. We do not send
a deadline value across HTTP for payment to enforce. That further step is
called deadline propagation: the caller communicates the remaining budget,
and the dependency must understand and cooperate with it. Defining and testing
that shared protocol remains a separate next experiment. Likewise, an overall
deadline for a multi-request Veriq run remains separate from an application
deadline. Neither feature is implied by this implementation.

## 10. Reading an experiment as evidence

For the bounded checkout run:

1. **Raw evidence:** HTTP status 504 and measured header-arrival duration around 523 ms.
2. **Observation:** Checkout returned its timeout response before 1000 ms.
3. **Assertion:** Under a three-second payment delay, require 504 within 1000 ms.
4. **Result:** PASS, because the observed status and duration satisfy that assertion.
5. **Finding:** This request exhibited the required timeout handling. It does not
   establish successful payment, cancellation of payment work, or behavior under load.

The protected property is a limit on how long this application waits for its
dependency, plus a defined response when that limit is reached. Without the
limit, many simultaneous callers could all remain waiting for a slow service.
Timeouts reduce that waiting, but they do not by themselves limit how many
requests can enter the application. Concurrency and overload controls are
separate subjects.

Each checkout request gets its own signals. Two requests do not share one
1500 ms allowance. Multiple application instances can apply the same policy
independently; this is not a shared cluster-wide budget.

There is also a trade-off: a shorter timeout gives callers an earlier answer,
but can reject work that would have succeeded shortly afterward. A longer
timeout gives dependencies more time while keeping callers waiting longer.
Choose limits from the caller's needs and observed dependency behavior.

For real operations with side effects, a timeout leaves uncertainty: the
dependency may have completed the operation even though the caller did not
receive its answer. Do not infer that nothing happened or that retrying is
automatically safe. Our simulated payment has no such side effects.
