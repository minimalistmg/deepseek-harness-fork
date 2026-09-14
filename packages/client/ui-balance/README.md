---
description: "Account balance pill for the Web GUI: the composer footer reading of the DeepSeek platform balance, for users and maintainers of the composer footer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-balance

English | [中文](README.zh.md)

## Summary

This package shows the DeepSeek platform account balance under the composer card, beside the session statistics. The reading happens on the host, because it needs the account's API key: the browser asks one route, the host answers with the balance it read from the platform, and the pill renders it. Clicking opens the breakdown — granted credit, topped-up credit, whether the platform currently allows spending — and a link to the platform's usage page. A deployment with no account credential renders nothing, so the footer never carries a pill that cannot fill.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and `client-connection`; the host half registers one route, and the browser half renders the pill in the composer's dock row.

### What the pill shows

The pill reads `<total> <currency> · Available`, or `· Unavailable` when the platform refuses spending. Opening it lists the credit buckets that are a real part of the balance and the platform's availability statement. Clicking the platform usage link opens the platform's own page in a new tab.

### Configuration

```yaml
- id: ui-balance
  name: '@deepseek-ai/dsh-client-ui-balance'
  config:
    displayCurrency: INR
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each read through `ctx.credentials`, or from the launch environment when that service is absent |
| `baseURL` | `https://api.deepseek.com` | Platform origin; `/user/balance` is appended |
| `displayCurrency` | *(empty)* | Currency the total is converted into. Empty keeps the account's own currency and skips the exchange-rate request entirely |
| `fxBaseURL` | `https://api.frankfurter.app` | Exchange-rate origin; `/latest?from=&to=` is appended |
| `timeoutMs` | `5000` | Deadline for one read, in milliseconds |

Each read resolves the key again, so a key stored after startup reaches the next read without reloading the plugin. The route path, the platform's balance path, and the `Bearer` authorization header are protocol constants rather than configuration.

### Failures

Conversion is best-effort: when the rate service refuses, cannot be reached, or answers an unusable rate, the pill keeps the account's own currency rather than losing the balance. A refused or unreadable platform response, a transport fault, or a deadline leaves the pill showing its retry affordance, and the next click reads again. No credential renders nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host half registers `ACCOUNT_BALANCE_PATH` on the Connection fetch registry as a buffered `GET`. `src/balance.ts` owns the platform call: the key travels in the `Authorization` header so it never reaches a URL, the request sets `redirect: 'error'` because a credentialed provider request must not follow a redirect to another origin, and one `deadline(signal, timeoutMs, …)` from `@deepseek-ai/dsh-timeout` fuses caller cancellation with the request deadline. `timeoutOf` reads the deadline back, so a request that outlived its own deadline is reported as a timeout rather than as a transport fault.

The report is the platform's first balance row: currency, total, granted, and topped-up amounts, plus the platform's own availability flag. The exchange-rate request is a second request to `fxBaseURL`, taken only when a display currency is configured and differs from the account currency; its failure is not the balance's failure.

The browser half knows only the route path. `src/client/balance.ts` maps one envelope onto the pill's states, and `BalancePill.tsx` renders the pill, its portal panel, and the retry. Both halves share `src/protocol.ts`, which holds no runtime dependency and is therefore inlined into the browser bundle instead of requesting a module-table row.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the pill is not enough. They move from the reading to the transport and the credential plane.

- [client-connection](../connection/README.md) — owns the shared `/api` channel and the exclusive Fetch-route registry this plugin registers on.
- [credentials](../../credentials/credentials/README.md) — the credential service the host half resolves the platform key through.
- [ui-chat](../ui-chat/README.md) — the session statistics pill this reading sits beside.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — the layer rules this package follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as the balance is account metadata read from the platform's own API; it registers no prompt content, no tool schema, and no session event.

#### KV Cache effect

None. The reading changes no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current pill. They are current package constraints, not a billing analysis or a task backlog.

- **No caching** — every mount and every retry reads the platform once; a browser with several tabs open reads once per tab.
- **One account** — the pill reads the credential the host resolves, so a deployment whose users share one host shows one account.
- **Conversion is informational** — a converted total is the platform balance at the published rate; it is not a quoted or settled amount.
- **Platform-specific** — the pill reads DeepSeek's balance endpoint; another provider needs its own reader and envelope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The pill owns no durable state; its only owned relation is that a rendered balance names the platform reading it came from, which this package's provider, route, and component coverage each assert.
