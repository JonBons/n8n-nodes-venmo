# n8n-nodes-venmo

Unofficial Venmo API client and n8n nodes. Sign in with your Venmo email and password (SMS 2FA included), then send payments, request money, look up users and read transactions from a workflow. Instead of copying a whole session cookie every time it expires, you keep one stable device id and the client handles the rest.

> Not affiliated with, endorsed by, or supported by Venmo or PayPal. This talks to the same private endpoints the Venmo mobile app uses. It can break without notice, and payments it creates are real. Use your own account and your own risk.

The node icons are original artwork drawn for this package: a "V" with a dollar sign nested in it, two blues per theme — `#225F8C` with `#4196CF` on light, `#7AB8DC` with `#2F86BE` on dark. The blues sit next to Venmo's brand blue without copying it (`#008CFF` primary, `#3D95CE` legacy), and the mark contains no Venmo glyph, badge or wordmark.

## Why this exists

Venmo has no public API for personal accounts, so the usual workaround is logging into venmo.com, opening DevTools, and copying a cookie/session by hand every time it expires. This package does the real OAuth password grant against `api.venmo.com/v1`, keeps the device ID stable so Venmo stops asking for codes, and caches the token in the n8n process.

This implementation was checked against a decompile of the real Android app (com.venmo 26.27.1); see [What the Android app confirmed](#what-the-android-app-confirmed). The important caveat: Venmo's edge firewall rejects any request whose body carries the login field `phone_email_or_username`, before authentication runs, so email/password and SMS sign-in cannot complete from a server. Access Token mode works, and a refresh token renews it unattended.

## Setup

```bash
npm install
npm run build
```

Install it into n8n's custom extensions folder (the same folder for npm-installed community nodes):

```bash
# macOS / Linux
mkdir -p ~/.n8n/custom
cd ~/.n8n/custom
npm install /absolute/path/to/n8n-nodes-venmo

# Windows (PowerShell)
mkdir "$env:USERPROFILE\.n8n\custom" -Force
cd "$env:USERPROFILE\.n8n\custom"
npm install C:\path\to\n8n-nodes-venmo
```

Restart n8n. **Venmo** and **Venmo Sign-In** appear in the node panel.

Docker:

```bash
docker run -v /path/to/n8n-nodes-venmo:/data/custom/n8n-nodes-venmo \
  -e N8N_CUSTOM_EXTENSIONS=/data/custom \
  ... n8nio/n8n
```

Rebuild (`npm run build`) after changing the source, then restart n8n. Keep `dist/` present — n8n loads the compiled files listed in `package.json` → `n8n`.

## Credential: Venmo API

| Mode | What it needs | When to use |
| --- | --- | --- |
| **Email & Password (Auto Sign-In)** | Email/phone/username + password | Only where Venmo's firewall still lets a server post the login field. From a normal machine this fails with `HTTP 403`, so treat it as legacy. |
| **Access Token** | An access token, optionally a refresh token | The working mode. Venmo accepts the token for reads and payments; when it rejects one, the refresh token mints a new one without the blocked login endpoint. |

**Device ID** identifies this client to Venmo and is what two-factor challenges get bound to. Left empty, a stable id is derived from the account. It does **not** decide whether sign-in works: the firewall rejects the login field itself before any device id is read, so copying the `v_id` cookie does not get past a `403`. Access Token mode does not use it.

**Refresh token.** A refresh token is exchanged at `POST /v1/oauth/access_token` with `grant_type=refresh_token` — the one grant this client can send that Venmo's edge does not filter. Paste one into the credential and the client keeps itself signed in: it uses the access token, and when Venmo rejects it, renews with the refresh token instead of the login endpoint. Venmo may rotate the refresh token; the newest value is kept in memory for the life of the process, so re-copy it if a restart leaves the old one rejected. **Unverified:** renewal has only been exercised with a bogus token, which Venmo answered with `275 Could not refresh tokens` — that proves the route and grant are accepted, not that a real token mints a working session. Keep an access token alongside it until you have tried renewal with your own.

In Access Token mode the credential needs at least one of the two tokens; an empty pair is rejected with an error saying so, instead of falling through to a password sign-in that was never configured. Press **Test** to check it: the test makes the same `GET /account` call the nodes use and reports the account the token belongs to.

### First sign-in (only when Venmo wants a code)

1. Add the **Venmo Sign-In** node, pick your `Venmo API` credential, leave it in **Start** mode, and execute the step. Venmo texts a code to the phone on the account (the node also returns `otpSecret`).
2. Switch the node to **Complete**, type the code, and execute the step again. It returns an `accessToken`.
3. Paste the returned `accessToken` into the credential (*Access Token* mode), plus the `refreshToken` if the response included one. Leaving the credential on *Email & Password* does not help: the next sign-in is blocked before it starts.

The OTP secret from step 1 is saved in the workflow's static data, so you only have to type the code in step 2. If you re-run Start, you get a new code.

Venmo picks the second factor, not you. Before sending an SMS the node checks `GET /account/two-factor/token`: if the account answers with a security question instead of a phone number, it stops with that question named — no doomed SMS call. Those accounts cannot finish the challenge from n8n, so switch the credential to *Access Token* and supply an access token or refresh token.

A two-factor code saved in the credential is single-use and expires in minutes. If Venmo rejects it, sign-in falls back to "a fresh code is needed" instead of failing with a code error, so auto sign-in keeps working once you clear the field.

## Operations

**Account**

- Get Profile — `GET /account`
- Get Balance — balance + user from `GET /account`
- Get Payment Methods — `GET /payment-methods`
- Sign Out — `DELETE /oauth/access_token` (revokes the token)

**Payment**

- Send Payment — `POST /payments`, positive amount, optional funding source (defaults to your balance/default method)
- Request Payment — `POST /payments` with a negative amount
- Get Payment — `GET /payments/{id}`
- List Payments — `GET /payments?actor=…&action=…&before_id=…`
- Update Payment — `PUT /payments/{id}` with `approve`, `deny`, `cancel` or `remind`
- Get Transaction — `GET /stories/{id}`
- List Transactions — `GET /stories/target-or-actor/{id}` (max 50 per page)

**User**

- Get User — `GET /users/{id}`
- Search Users — `GET /users?query=…`, with an option to match usernames exactly
- Get Friends — `GET /users/{id}/friends`

**Custom API Call** — any `api.venmo.com/v1` path with `GET`/`POST`/`PUT`/`DELETE`, JSON query and body. This is the escape hatch for endpoints not wrapped above (comments, likes, groups, etc.).

The **Recipient** field accepts a Venmo user ID, a username (`@name` or `name`), an email address, or a US phone number. Usernames are resolved to a user ID automatically.

## Using the client outside n8n

```js
const { VenmoClient, deriveDeviceId } = require('n8n-nodes-venmo');

const client = new VenmoClient({
  deviceId: deriveDeviceId('me@example.com'),
  username: 'me@example.com',
  password: process.env.VENMO_PASSWORD,
});

const login = await client.login();
if (login.needsTwoFactor) {
  // login.otpSecret + the code Venmo texted
  const done = await client.completeTwoFactor(login.otpSecret, '123456');
  console.log(done.accessToken);
}

const account = await client.getAccount();
await client.sendPayment({ target: 'someone@example.com', amount: 5, note: 'Coffee' });
```

## Behavior notes

- **Token lifetime.** Venmo tokens do not expire on their own until you sign out, so the client caches them per account+device for the life of the n8n process. If one is rejected, a `GET` is retried once after the refresh token mints a new one (or, with no refresh token, after a password sign-in).
- **Payment idempotency.** *Send Payment* and *Request Payment* put a `uuid` in the body (the field the app sends). By default it is derived from the execution, node name and item index, so **Retry On Fail** — which re-runs the node inside the same execution — reuses it. That default does **not** cover a retry from the Executions list, an error-workflow re-run, or a re-triggered schedule/webhook: each of those is a new execution with a new id and therefore a new uuid. Set **Idempotency Key** to a business id (order, invoice, row id) when a retry must not create a second payment; expression values such as `{{ $json.orderId }}` work. Venmo's deduplication on this field is untested — it is sent to match the app, not proven to prevent a double charge, so still design workflows so a retry cannot pay twice.
- **No retry on writes.** A `GET` that 401s is retried once after a fresh sign-in. `POST`/`PUT`/`DELETE` are never retried, because a retried payment can move money twice.
- **Amounts and IDs.** User and payment IDs are 19-digit numbers sent as strings, so they are not rounded by JSON. Amounts are always positive in the UI; *Request Payment* sends the negative value Venmo expects.
- **Errors** map to readable messages, including `81109`/`81110` (2FA), `261`/`262` (bad/revoked token), `13006` (insufficient balance), and `2901`/`2905`/`2907` (nothing pending / reminder already sent).
- The old `tools/parse-cookies.js` helper is kept for reference only; nothing here needs a browser cookie.

## What the Android app confirmed

Static analysis of `base.apk` (jadx, 13 dex) was used to validate this client:

| Behaviour | Evidence in the app |
| --- | --- |
| Password login is **form-encoded** | `LogInApi` is `@POST("oauth/access_token")` with `@FormUrlEncoded` and `@Field("phone_email_or_username", "password", "client_id")` |
| 2FA headers | `@Header("VENMO-OTP-SECRET")`, `@Header("VENMO-OTP")`; options come from `@GET("account/two-factor/token")` |
| Device header | `device-id` sent on every request (`PayPalSDKNetworkInterceptor`) |
| App headers | `application-id: com.venmo`, `X-Venmo-Android-Version-Name: 26.27.1`, `X-Venmo-Android-Version-CODE: 9042`, `Venmo-Client-Id: 4` |
| User-Agent | `UserAgent#getFormattedUserAgent()` → `"<manufacturer>/<model>Venmo/<version> Android/<release> "` |
| Payments | `@POST("payments")` with a JSON `PaymentRequestBody` (user id / username / email / phone, amount, note, audience, funding source, metadata) |
| Login has also moved to token exchange | `AuthenticationTokenExchangeApiService` posts `code` + `client_id` to the same `oauth/access_token` after PayPal web login; `RefreshTokenApiService` posts `grant_type`/`refresh_token` |
| TLS pinning | OkHttp `CertificatePinner` is used, so the app's traffic cannot be replayed without its trust chain |

The decisive experiment: the same `POST /v1/oauth/access_token` answers normal JSON (`400` `241 Missing argument: client_id`, `276 Grant type is invalid`, `275 Could not refresh tokens`) for empty bodies, `client_id`-only bodies and refresh grants, but returns a bare `403` from `awselb/2.0` the moment the body contains `phone_email_or_username` — with or without a password, with client ids 1/3/4, the app's exact user agent and version headers, a Chrome user agent, or web `Origin`/`Referer` headers. The rule is applied to the login parameter itself before authentication: an anti-credential-stuffing control, not TLS, device trust or app identity. That is why password and SMS sign-in cannot work from n8n, and why `v_id` advice does not help.

## If sign-in fails

The Sign-In node reports what Venmo actually answered:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `HTTP 403` with an HTML body on sign-in | Venmo's firewall rejects any login request carrying `phone_email_or_username`, before authentication — not a wrong password, not a device id | Use Access Token mode: paste a token and, if you have one, a refresh token |
| `code 2` — "update to the latest version of the app" | The app version this client claims is no longer accepted | Bump `VENMO_APP_VERSION` in `nodes/Venmo/VenmoClient.ts` — the user agent and both version headers derive from it |
| `code 81109` | Two-factor challenge | Run Sign-In in Start mode, then Complete |
| `code 81110` | The code, or the challenge itself, expired | Start again for a fresh text message |
| `code 261` / `262` | Token missing, invalid or revoked | Add a refresh token and the client renews it; otherwise sign in on the phone and paste a new access token |

Reads never carry the login field, so a bare 403 on a read is a different problem: the network is being blocked (VPN, region, IP reputation) rather than the account. That points at where n8n runs, not at the token.

## Limitations

- Unofficial and undocumented: venue for breaking changes. Venmo can add captchas or fingerprinting at any time, and a flagged account may be challenged on every sign-in.
- Password and SMS sign-in are blocked from servers: Venmo's firewall filters the login field before authentication, so those flows can only report the block. An access token plus a refresh token is the supported path.
- Security-question 2FA is not automated: SMS codes are unreachable too, and accounts that only offer a security question are reported clearly and need Access Token mode.
- Refresh-token renewal is route-verified only with a bogus token; a real refresh token has not been exercised yet. If renewal fails, fall back to an access token.
- No webhooks: poll with *List Payments* or *List Transactions* on a Schedule Trigger.

## Tests

`npm test` builds and runs the committed `node:test` suite in `test/` — no extra dependencies. It covers the refresh grant shape, refresh-only renewal, `401` renewal on reads, the no-retry rule for writes, form-encoded login, the `403` message, and credential validation. The transport is stubbed; nothing in the suite touches Venmo.
