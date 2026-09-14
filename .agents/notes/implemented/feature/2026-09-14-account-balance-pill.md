# Agent Note: Credentialed account reading as a browser plugin with a host route

Status: implemented

English | [中文](2026-09-14-account-balance-pill.zh.md)

## Problem

The composer footer already reports what a Session consumed — turns, steps, tokens, cache hits — from durable projections the browser computes for itself. What it cannot report is what the account still holds, because that reading needs the platform API key and therefore a request the browser must not make.

A plugin that wants to show it faces two questions: which half makes the credentialed call, and what the browser half may then say about a failure. The answer is not the same as for the voice plugin, whose remote calls are best-effort by design because the user's own words are already in hand. Here the reading *is* the feature.

## Decision

Add `@deepseek-ai/dsh-client-ui-balance`, a package with a host half that reads the DeepSeek platform balance behind one Connection Fetch route and a browser half that renders it as a pill in the composer's dock row.

### Transport

The host registers an exact Connection Fetch route at `/api/account/balance` as a buffered `GET`, the way the voice plugin registers its routes. The browser knows only the path and the envelope; the key never leaves the host, and no Typert Remote namespace is warranted for one unary read.

### The reading

`src/balance.ts` owns the platform call. The key travels in the `Authorization` header so no secret reaches a URL, the request sets `redirect: 'error'` so a credentialed request never follows a redirect to another origin, and one `deadline(signal, timeoutMs, …)` fuses caller cancellation with the request deadline. `timeoutOf` reads the deadline back, so a read that outlived its own deadline is reported as a timeout rather than as a transport fault.

The result is a discriminated union — the balance, or the outcome that replaced it — rather than an optional report, so the route cannot serialize a success without one.

### Display currency

A configured display currency converts the total through a second request to the configured exchange-rate origin. The conversion is best-effort in the way the voice plugin's cleanup is: a refused, unreachable, or unusable rate leaves the balance in the account's own currency instead of turning the whole read into a failure. The balance is what the user came for, and the conversion is a convenience.

### Browser states

The browser maps one envelope onto four states. A deployment with no credential reports `unavailable`, and the pill renders nothing: a pill that can never fill is noise in every composer. A failed read keeps a pill that offers a retry, because that is a state the user can act on. Before the first answer the pill renders nothing, so the footer does not flash a placeholder.

## Alternatives considered

**Read the balance in the browser.** Rejected outright: any key the browser holds is readable by the page, and the deployment's `.env` is not the browser's to read.

**Add a Typert Remote namespace.** Rejected: one unary read over the existing channel does not justify a Remote, its generated client, and a split compiler face. The voice plugin reached the same conclusion for its buffered route.

**Cache the reading on the host.** Rejected: a cache is state with its own invalidation question, and the pill reads once per mount and once per retry. A deployment that needs to bound its platform traffic can put a proxy in front of it, which the request already respects.

**Show the pill whenever the plugin is mounted.** Rejected: the pill would either sit empty or report a fault in deployments that have no DeepSeek account, which is most of the footer's life. An absent reading is absent, not broken.

**Fail the whole read when the rate service fails.** Rejected: the conversion is not what the user asked for.

**Show every bucket unconditionally.** Rejected: granted and topped-up credit usually sum to the total, and a row that repeats the header teaches nothing. A bucket appears only when it is a real part of the balance.

## Consequences

The footer now carries a reading that depends on an external service, so a deployment with no credential or no network shows either nothing or a retry, and the pill must not be read as a Session statistic. Each mount and each retry reads the platform once, so several open tabs read several times.

Coverage pins the request mapping and the header the secret travels in, every failure arm including quota-free timeout and an unreadable body, the conversion's degradation, the route's method validation and envelopes, the browser's four states, the pill's rendering and retry, and outbound egress through the installed proxy policy.
