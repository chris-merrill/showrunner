# Showrunner 2.0: Accounts and Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sellers sign in at showrunner.tools, invite helpers, connect the extension to their team, and the extension prints only with a valid server-signed license bound to one Whatnot shop.

**Architecture:** Firebase project `showrunner-tools`: Google sign-in, Firestore (owner-read rules, API-only writes), one Cloud Functions codebase (`site/functions`, Node 22, scale-to-zero) serving `/api/*` plus the session-gated `/app` and `/admin` pages. The extension (MV3) receives a device secret and an Ed25519-signed license through `externally_connectable` from `/connect`, verifies licenses locally with WebCrypto before every print, and renews in the background.

**Tech Stack:** Firebase Functions v2 (`firebase-functions` ^6, `firebase-admin` ^13), Node `node:test`, `@firebase/rules-unit-testing` + Firestore emulator (Java 17 present), Firebase JS SDK 10.12.2 from gstatic on pages, Chrome MV3 + WebCrypto Ed25519.

**Spec:** `docs/specs/2026-10-23-accounts-and-licensing-design.md` (approved 2026-10-23)

## Global Constraints

- No Stripe this round; plan `'active'` is set only by an admin.
- Trial: `trialEndsAt = max(createdAt + 7 days, 2026-11-23T07:00:00Z)` for accounts created before 2026-11-23; otherwise createdAt + 7 days.
- One shop per account (`shopLimit: 1`); `shopId` = Whatnot username lower-cased; unlimited computers; unlimited members.
- License: Ed25519, payload `{uid, account, shop, device, plan, iat, exp}`, `exp = iat + 24h`; renew every 6 h; offline grace 72 h past `exp`; an explicit refusal ends printing at once.
- Admin accounts may connect on any shop without claiming it.
- `/app` and `/admin` return HTTP 404 (the site's 404 page) unless a valid `__session` cookie is present (`/admin`: and the uid is in `admins/`).
- Landing page `/` and existing pages must not change behaviour.
- Never set `minInstances`. No remote code or obfuscation in the extension.
- Every 2.x copy (store or unpacked) needs a license; remove `betaStatus()` from the extension.
- Copy: no platform name on the website; card copy as quoted in the spec.
- Secrets in Secret Manager: `LICENSE_PRIVATE_KEY` (Ed25519 PKCS8 PEM); public key (raw, base64url) built into `license-core.js` and `site/functions/lib/license.js`.

## Review Focus

1. Clock skew on the seller's PC (clock hours ahead/behind): a fresh license must still verify; allow 5 min `iat` skew.
2. Two people connecting the same unclaimed shop at the same moment: exactly one account wins (transaction).
3. A revoked device or removed member with a license still inside grace: the next successful renewal attempt returns a refusal and printing stops immediately.
4. Tab title not yet "<user> is live" (scheduled show) or Whatnot changes it: card must not print for a different shop; test print still works on the license's shop.
5. Session cookie expired/forged on `/app`: 404, never a 500 or a partial page.

---

### Task 1: Server core: license signing and access rules

**Files:**
- Create: `site/functions/lib/license.js`, `site/functions/lib/access.js`
- Create: `site/functions/test/license.test.js`, `site/functions/test/access.test.js`
- Modify: `site/functions/package.json` (script `"test": "node --test test/"`)

**Interfaces:**
- Produces: `signLicense(payload, privateKeyPem) -> string` (`base64url(JSON).base64url(sig)`), `verifyLicense(token, publicKeyB64u, nowMs) -> payload | null` (checks signature only; caller checks exp), `makeLicense({uid, account, shop, device, plan}, privateKeyPem, nowMs) -> string` (sets iat/exp 24 h).
- Produces: `trialEndsAt(createdAtMs) -> ms`, `hasAccess(account, nowMs) -> boolean`, `accessReason(account, nowMs) -> 'ok'|'trial-ended'|'expired'`.

- [ ] **Step 1: Write failing tests**
  - `license.test.js`: generates an Ed25519 pair with `crypto.generateKeyPairSync('ed25519')`; `verifyLicense(makeLicense(p, priv, T), pubB64u)` returns payload with `exp === T + 86400000`; a token with one payload byte changed → `null`; a token signed by another key → `null`.
  - `access.test.js`: `trialEndsAt(Date.parse('2026-10-24T00:00:00Z')) === Date.parse('2026-11-23T07:00:00Z')`; `trialEndsAt(Date.parse('2026-12-01T00:00:00Z')) === Date.parse('2026-12-08T00:00:00Z')`; `hasAccess({plan:'trial', trialEndsAt: now+1})` true, `now-1` false; `freeGrant` set → true regardless of plan; `plan:'active'` → true; `accessReason` returns `'trial-ended'` for an ended trial.
- [ ] **Step 2: Run `cd site/functions && npm test`** → FAIL (modules missing).
- [ ] **Step 3: Implement** with `crypto.sign(null, data, key)` / `crypto.verify` (Ed25519); public key passed as raw 32 bytes base64url (convert via `crypto.createPublicKey({key: {kty:'OKP', crv:'Ed25519', x}, format:'jwk'})`).
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit** `feat(api): license signing and access rules`.

### Task 2: Firestore rules for accounts, members, shops, devices, invites

**Files:**
- Modify: `site/firestore.rules`
- Create: `site/test-rules/rules.test.mjs`, `site/test-rules/package.json` (`@firebase/rules-unit-testing`, `firebase`), `site/firebase.json` emulator block (`"emulators":{"firestore":{"port":8085}}`)

**Interfaces:** Collections: `accounts/{uid}` (+ `devices/{deviceId}`, `members/{memberUid}`), `members/{memberUid}` (index `{accountUid}`), `shops/{shopId}`, `invites/{token}`, existing `feedback`, `admins`, `rate`.

- [ ] **Step 1: Failing tests** (run via `firebase emulators:exec --only firestore --project demo-showrunner "node --test test-rules/"`): owner reads own `accounts/{uid}` and its `devices` ✓; a member (uid listed in `accounts/{a}/members/{uid}`) reads that account ✓; another user ✗; any client write to `accounts`, `shops`, `invites`, `members` ✗; admin (in `admins/`) reads any account ✓; unauthenticated reads ✗; existing feedback rules unchanged (create ✗, admin read ✓).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write the rules** (helper `isMemberOf(a)` = `exists(.../accounts/$(a)/members/$(request.auth.uid))`).
- [ ] **Step 4: Run** → PASS; deploy `firebase deploy --only firestore:rules --project showrunner-tools`.
- [ ] **Step 5: Commit** `feat(rules): accounts, members, shops, devices`.

### Task 3: Sessions, account creation, and the 404 gate

**Files:**
- Create: `site/functions/lib/http.js` (shared: `authUser(req) -> {uid,email}|null` from Bearer ID token, `json(res, code, body)`, origin check like `feedback`), `site/functions/api/session.js`, `site/functions/api/me.js`, `site/functions/pages.js`
- Create: `site/functions/views/app.html`, `site/functions/views/admin.html` (move `site/public/admin.html` here), `site/public/404.html`, `site/public/signin.html`
- Modify: `site/functions/index.js` (export `api` = one Express-free router function for `/api/*` except feedback, and `pages`), `site/firebase.json` rewrites: `/api/**` → `api`, `/app` and `/admin` → `pages` (feedback rewrite stays first)
- Test: `site/functions/test/pages.test.js`

**Interfaces:**
- Produces: `POST /api/session {idToken}` → sets `__session` (httpOnly, Secure, SameSite=Lax, 14 d via `auth.createSessionCookie`) → `{ok:true}`; `POST /api/session/out` clears it.
- Produces: `POST /api/me` (Bearer) → `{account, role:'owner'|'helper', isAdmin}`; creates `accounts/{uid}` with `{email,name,photo,createdAt,trialEndsAt,plan:'trial',freeGrant:null,shops:[],shopLimit:1}` unless the uid is a member of another account.
- Produces: `pages` handler: `GET /app` → `views/app.html` with 200 when `verifySessionCookie(cookie, true)` passes, else `public/404.html` body with 404; `GET /admin` additionally requires `admins/{uid}`; responses `Cache-Control: private, no-store`.

- [ ] **Step 1: Failing tests** for `pages` with an injected verifier: no cookie → 404 + 404 body; bad cookie (verifier throws) → 404; good cookie → 200 app body; `/admin` good cookie but not admin → 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** `signin.html`: Google popup sign-in (same SDK/config as `assets/acct.js`), then `POST /api/session`, then `location = '/app'`. `assets/acct.js`: header shows "Sign in" (→ `/signin`) when signed out; menu item "My Showrunner" (→ `/app`); sign-out also calls `/api/session/out`.
- [ ] **Step 4: Run tests** → PASS; deploy `functions:api,functions:pages,hosting`; manual: `curl -s -o /dev/null -w '%{http_code}' https://showrunner.tools/app` → `404`.
- [ ] **Step 5: Commit** `feat: session cookie, account creation, /app and /admin 404 unless signed in`.

### Task 4: Connect, license renewal, devices

**Files:**
- Create: `site/functions/api/connect.js`, `site/functions/api/license.js`, `site/functions/api/devices.js`, `site/public/connect.html`
- Modify: `site/functions/index.js` (secret `LICENSE_PRIVATE_KEY`), router
- Test: `site/functions/test/connect.test.js` (logic tested through `connectCore(db, {...})` with the Firestore emulator)

**Interfaces:**
- Consumes: `makeLicense`, `hasAccess`, `accessReason` (Task 1); `authUser` (Task 3).
- Produces: `connectCore(db, {uid, shopId, deviceId, deviceName, isAdmin, nowMs}) -> {deviceSecret, license} | {error:'shop-taken'|'shop-limit'|'no-access'}`; team = the account the uid owns or is a member of; claims `shops/{shopId}` in a transaction when the team has no shop and the uid is not admin; stores `accounts/{team}/devices/{deviceId}` `{name, ownerUid: uid, createdAt, lastSeen, revoked:false, secretHash: sha256 hex}`.
- Produces: `renewCore(db, {deviceId, deviceSecret, nowMs}) -> {license} | {refused:'revoked'|'trial-ended'|'expired'|'removed'|'unknown-device'}` (finds the device via a collection-group query on `devices` by document id; `removed` when `ownerUid` no longer owner/member).
- Produces: `POST /api/connect`, `POST /api/license`, `POST /api/devices/remove {deviceId}` (owner removes any team device; a helper only their own).
- `connect.html`: reads `ext`, `shop`, `device` from the query; signs in if needed; shows "Connect this computer to <email> for shop <shop>"; on click calls `/api/connect` then `chrome.runtime.sendMessage(ext, {type:'showrunner-license', deviceSecret, license})`; shows "Connected. You can close this tab." or the error copy from the spec.

- [ ] **Step 1: Failing tests:** first connect claims the shop; second account connecting the same shop → `shop-taken`; same team second device → ok, shop unchanged; team with a shop connecting a different shop → `shop-limit`; admin connect on an unclaimed shop does not create `shops/{id}`; two concurrent `connectCore` calls from two accounts on one shop → exactly one success (Review Focus 2); `renewCore` with a wrong secret → `unknown-device`; revoked → `revoked`; ended trial → `trial-ended`; valid → license whose payload `device`, `shop`, `account` match.
- [ ] **Step 2: Run** (emulator) → FAIL. **Step 3: Implement.** Rate limit connect 20/h per uid and license 60/h per device via the existing `underLimit` (move it to `lib/rate.js`).
- [ ] **Step 4: Run** → PASS; create the key: `node -e` generating Ed25519, store private PEM with `firebase functions:secrets:set LICENSE_PRIVATE_KEY --data-file`, record the raw public key (base64url) for Task 1/7 constants; deploy.
- [ ] **Step 5: Commit** `feat(api): connect, license renewal, devices`.

### Task 5: Team members

**Files:**
- Create: `site/functions/api/members.js`, `site/public/join.html`
- Test: `site/functions/test/members.test.js`

**Interfaces:**
- Produces: `POST /api/members/invite {email}` (owner) → `{link: 'https://showrunner.tools/join/<token>'}`; `invites/{token}` `{account, email, createdAt, expiresAt: +7 d}`; token 24 random bytes base64url.
- Produces: `POST /api/members/join {token}` (Bearer) → adds `accounts/{a}/members/{uid}` `{email, role:'helper', invitedAt, joinedAt}` and `members/{uid}` `{accountUid:a}`; refuses expired/used tokens and users who own an account with a shop or devices (`already-has-account`).
- Produces: `POST /api/members/remove {memberUid}` (owner) → deletes both docs and marks that member's devices `revoked:true`.
- Hosting rewrite `/join/**` → `join.html`.

- [ ] **Step 1: Failing tests:** invite by non-owner → 403; join with valid token → member docs exist and `/api/me` returns `role:'helper'`; join expired → refused; remove member → their devices revoked and `renewCore` refuses with `removed`/`revoked`.
- [ ] **Step 2–4:** run, implement, run → PASS. **Step 5: Commit** `feat(api): team members by invite link`.

### Task 6: Admin actions and feedback identity

**Files:**
- Create: `site/functions/api/admin.js`
- Modify: `site/functions/index.js` (`feedback`: optional `{deviceId, deviceSecret}` → store `uid`, `account`, `shop` on the report; email no longer required when identified)
- Test: `site/functions/test/admin.test.js`

**Interfaces:**
- Produces: `POST /api/admin/{grant-free|remove-free|set-trial|set-active|release-shop|move-shop|revoke-device}` (Bearer + `admins/{uid}`): bodies `{account}`, `{account, trialEndsAt}`, `{shopId}`, `{shopId, toAccount}`, `{account, deviceId}`. Non-admin → 403.

- [ ] **Step 1: Failing tests:** non-admin 403; grant-free sets `freeGrant {by, at}`; release-shop deletes `shops/{id}` and removes it from the account; move-shop reassigns atomically; feedback with valid device secret stores `account` and accepts an empty email.
- [ ] **Step 2–4:** run, implement, run → PASS. **Step 5: Commit** `feat(api): admin actions; feedback carries the account`.

### Task 7: /app and /admin pages

**Files:**
- Modify: `site/functions/views/app.html` (from Task 3 stub), `site/functions/views/admin.html`
- Uses: `site/public/assets/site.css`, `assets/acct.js`

**Interfaces:** Consumes the APIs from Tasks 3–6; reads its own account live with Firestore `onSnapshot` (rules from Task 2).

- [ ] **Step 1:** `/app`: cards for **Plan** ("Trial · N days left" / "Free" / "Expired"), **Shop** (claimed shop or "Connect the extension on your show to claim your shop"), **Computers** (name, last seen, Remove), **Team** (owner only: members list, Invite → shows the link with Copy, Remove); helpers see Plan, Shop and their own computers. Optimistic updates with a toast; same header/footer/theme as the site.
- [ ] **Step 2:** `/admin`: add an **Accounts** tab beside the feedback inbox: email, plan, trial end, shop, computers, members; actions call Task 6 routes; live via `onSnapshot` on `accounts`.
- [ ] **Step 3: Verify** in a browser (Playwright script under `site/test-ui/`): signed-out `/app` → 404 page; after sign-in → Plan card shows "Trial"; invite produces a `/join/` link.
- [ ] **Step 4: Commit** `feat(site): /app account page and admin accounts`.

### Task 8: Extension 2.0

**Files:**
- Create: `license-core.js` (UMD: `globalThis.ShowrunnerLicense` and `module.exports`), `test/license-core.test.js`
- Modify: `manifest.json` (version `2.0.0`, `"externally_connectable": {"matches": ["https://showrunner.tools/*"]}`), `background.js` (`importScripts('license-core.js')`; remove `betaStatus`/`BETA_*`; license store/renew; gate `dymoPrint`; `onMessageExternal` for `showrunner-license` from `https://showrunner.tools` only), `capture.js` (shop detection, Connect state, refusal states), `dev/package.sh` (include `license-core.js`)

**Interfaces:**
- Produces in `license-core.js`: `verifyLicense(token, nowMs) -> Promise<payload|null>` (WebCrypto `Ed25519`, built-in public key constant), `licenseState(payload, {nowMs, deviceId, pageShop, refused}) -> 'ok'|'connect'|'expired'|'refused'|'wrong-shop'|'shop-unknown'` (5 min iat skew; ok until `exp + 72h` unless `refused`), `shopFromTitle(title) -> string|null` (`/^(\S+) is live\b/i`, lower-cased).
- Background messages: `license-status` → `{state, shop, plan, refused}`; renewal on startup and every 6 h (`chrome.alarms`; add `"alarms"` permission and its store justification).
- Card: state `connect` → yellow **Connect** button (opens `/connect?ext=<id>&shop=<pageShop>&device=<installId>`); `refused` → spec copy + one button to `/app`; `wrong-shop` → "This shop isn't on your Showrunner account. Renamed your shop? Contact us"; test print uses the license's shop when `pageShop` is null (Review Focus 4).

- [ ] **Step 1: Failing tests** (`node --test test/`): `shopFromTitle('pablosdiecastgarage is live · Whatnot')` → `'pablosdiecastgarage'`; `licenseState` ok for a license with `iat = now + 4 min` (skew), `connect` when no license, `expired` at `exp + 72h + 1`, `refused` when `refused` set even before exp, `wrong-shop` when pageShop differs, `ok` for test print when pageShop null; `verifyLicense` rejects a tampered token (use a key pair generated in the test and an injectable public key).
- [ ] **Step 2–4:** run, implement, run → PASS.
- [ ] **Step 5: Manual:** reload unpacked, open a show: card shows Connect; connect → card shows status; `/app` lists the computer; revoke on /admin → after `license-status` renew the card shows the refusal.
- [ ] **Step 6: Commit** `feat(extension): 2.0 accounts and licensing`; `bash dev/sync-local.sh`; do NOT publish a GitHub release (Pablo stays on 1.x).

### Task 9: Security review, store package

- [ ] **Step 1:** Dispatch a security review over the branch diff (session cookie handling, token verification, rules, `onMessageExternal` origin check, rate limits, XSS in /app and /admin rendering); fix findings with tests.
- [ ] **Step 2:** `bash dev/package.sh`; copy to `store/Showrunner-2.0.0-chrome-web-store.zip`; update `store/LISTING.md` (alarms justification, description: accounts and 7-day trial replace the beta paragraph).
- [ ] **Step 3: Commit** `chore: 2.0.0 store package`. Hand to the owner; do not submit.
