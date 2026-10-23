# Showrunner: accounts and licensing (design)

Date: 2026-10-23 · Owner: Chris Merrill · Status: approved by owner 2026-10-23 · Ships as **Showrunner 2.0** (owner: "v2.x is where we will implement our licensing scheme")
Repo: `chris-merrill/showrunner` (`~/Projects/whatnot-chat-helper`) · Firebase project: `showrunner-tools`

## Intent

Today anyone with the extension can use it, and nothing ties it to a person. Before paid plans, Showrunner needs:
sellers sign in at showrunner.tools, the extension is connected to that account, and a **license** says what that
account may do. The license is bound to **one Whatnot shop**, which keeps a subscription to one seller and stops
account sharing. The owner's view on security: "my time is worth more than that": licensing should keep honest
people honest and make cheating more trouble than $10 a month, not be uncrackable.

Stripe (taking payment) is **out of this round** (owner: "leave the stripe part for later"). This round builds
everything around it so billing drops in later.

## Goals

1. Sign-in at showrunner.tools (Google), creating a Showrunner account with a 7-day trial (no card).
2. An account page: plan and trial status, connected shop(s), connected computers.
3. "Connect" from the extension to the signed-in account, with no copy-paste.
4. A server-signed license the extension checks locally before printing; renewed quietly in the background.
5. One Whatnot shop per account; the shop is claimed on first connect; other shops are refused.
6. Unlimited computers per account.
7. /admin: accounts, their shops and computers; grant Free; set trial end; release or move a shop; revoke a computer.
8. Feedback from a connected extension carries the account (no email field needed).

## Non-goals (this round)

- Stripe Checkout, the billing portal, webhooks, charging, the extra-shop add-on purchase (the gate exists; buying
  a second shop comes with Stripe).
- The AI add-on, Core Commerce single sign-on, email/password sign-in.
- Self-serve shop switching (admin only for now; see Decisions).

## Anti-goals

- Anything a seller waits on during a show: printing must never call a server.
- Spinners where a value is known; a frozen tap (the DIECASTr UX canon applies to the site and the card).
- Reading anything from Whatnot beyond the shop name already on the seller's own dashboard.
- Obfuscated code (Chrome Web Store bans it) or remote code in the extension.
- `minInstances` / always-on servers.

## Decided by the owner

- Unlimited computers per subscription.
- One Whatnot shop per subscription; extra shop = add-on, $5/month or $50/year (rare; build the gate now).
- The shop gate doubles as the account-sharing guard.
- Price point is the main protection against cracking; don't over-engineer.
- Free tier only the admin can grant; 7-day free trial, no card.
- Stripe later.

## Team members (owner: on his mind; needed for the AI chat moderator later)
- An account is a **seller team**: one owner (the subscriber) plus invited **members** (helpers, packers,
  moderators), each signing in with their own Google account.
- `accounts/{uid}/members/{memberUid}`: `{ email, role: 'helper', invitedAt, joinedAt }`; `members/{memberUid}` index
  `{ accountUid }` so a member's sign-in finds their team.
- Invite: owner enters an email on /app → `POST /api/members/invite` creates `invites/{token}` (expires 7 days)
  → the owner shares the link `showrunner.tools/join/<token>` (no email sending this round) → the invitee signs in
  with Google and joins.
- A member connects their own computers to the team's shop like the owner; licenses carry `uid` (the member) and
  `account` (the team). The owner can remove a member (their computers stop at next renewal).
- Roles: `owner` and `helper` now; the AI moderator later adds its own role. Unlimited members for now.
- This replaces "share the seller's Google login".

## Decided by Claude (owner may override)

### Accounts (site)
- Google sign-in on showrunner.tools (Firebase Auth, project `showrunner-tools`, already enabled).
- `accounts/{uid}` created by the API on first sign-in:
  `email, name, photo, createdAt, trialEndsAt (= createdAt + 7 days), plan: 'trial'|'free'|'active'|'expired',
  freeGrant: {by, at} | null, shops: [shopId], shopLimit: 1`.
  `hasAccess` = freeGrant, or plan 'active', or (plan 'trial' and now < trialEndsAt). Without Stripe, 'active' is
  only set by the admin.
- Rules: the owner reads their own account; all writes go through the API (Admin SDK). Admin reads all.
- The landing page stays as it is (it's live). The signed-in user UI lives at **`/app`** (owner, 2026-10-23), a new
  page with the site's header, footer and theme. `/app` (same look as the site): plan/trial card ("Trial · 5 days left", "Free (granted)", "Expired"),
  Shop card (claimed shop name), Computers card (list with name/last seen, Remove), Sign out. The avatar menu gains
  "My Showrunner" (→ /app). Public pages get a "Sign in" link in the header when signed out.

### Shops
- `shops/{shopId}`: `{ accountUid, name, claimedAt }`. `shopId` = the Whatnot username, lower-cased
  (e.g. `pablosdiecastgarage`).
- Where the extension gets it: the seller dashboard's tab title, `"<username> is live · …"` (verified on Pablo's
  dashboard 2026-10-23); fallback: the chat row carrying the "Host" badge. If neither is found, the card asks the
  seller to open their show and tries again (no printing until known).
- First connect with an empty shop list claims the current shop (transaction: refuse if `shops/{shopId}` belongs
  to another account).
- Shop not on the account: card says "This shop isn't on your Showrunner account" with a link to /app; no
  printing. Shop belongs to another account: "This shop is linked to another Showrunner account. Contact us."
- Switching shops: admin only this round (release or move on /admin).

### Connecting the extension
1. Card shows **Connect** (no license yet) → opens `https://showrunner.tools/connect?ext=<extension id>&shop=<shopId>&device=<deviceId>`.
2. The page signs the seller in if needed, shows "Connect this computer to <email> for shop <shop>", and on click
   calls `POST /api/connect` (Firebase ID token; owner or member of the team): the API checks or claims the shop, registers the device
   `accounts/{uid}/devices/{deviceId}` (`name` from the browser/OS, `createdAt`, `lastSeen`, `revoked:false`), and
   returns a **device secret** (random 32 bytes, only its SHA-256 stored) and a first license.
3. The page hands `{deviceSecret, license}` to the extension with `chrome.runtime.sendMessage(extId, …)`; the
   manifest's `externally_connectable` allows only `https://showrunner.tools/*`. The background verifies the sender
   origin and stores them in `chrome.storage.local`.
4. The page shows "Connected. You can close this tab."; the card updates live.
- The `deviceId` is a random UUID made once per install (already exists as `installId`).
- Works for hand-installed copies too: the connect page reads the extension id from the URL; `externally_connectable`
  is in the manifest, so it works for any id.

### The license
- A compact token signed by the API with an Ed25519 key (private key in Secret Manager `LICENSE_KEY`; the public key
  is built into the extension). Payload: `{ uid, shop, device, plan, exp, iat }`, `exp` = 24 hours.
- Renewal: the background calls `POST /api/license` (`{deviceId, deviceSecret}`) about every 6 hours and on startup;
  the API checks the device isn't revoked, recomputes `hasAccess`, and returns a new license (or a reason it can't).
- Local check before every print (`dymoPrint`): signature valid with the built-in key, `device` matches, `shop`
  matches the shop on the page, and `now < exp + 72 h` (grace for a dropped connection mid-show).
- Unlicensed or ended: the card says why ("Connect your Showrunner account", "Your trial has ended", "This computer
  was removed") with one button; nothing prints, including reprints and test prints.
- **Every 2.x copy needs a license**, store or hand-installed (owner, 2026-10-23). 1.x stays as it is: Pablo keeps
  1.x from the public GitHub repo until he's set up on 2.x with his own free account. The repo stays public until
  the owner confirms Pablo is good on 2.x; making it private comes after that.

### API (site/functions, same `feedback` pattern)
| Route | Auth | Does |
|---|---|---|
| `POST /api/me` | ID token | create account if missing, return it |
| `POST /api/connect` | ID token | claim/check shop, register device, return secret + license |
| `POST /api/license` | device secret | renew license (or reason) |
| `POST /api/devices/remove` | ID token | owner removes one of their computers |
| `POST /api/admin/*` | ID token + admin | grant/remove Free, set trial end, release/move shop, revoke device |
| `POST /api/feedback` | as today; plus device secret | a connected extension's report carries `uid` and shop |
All scale-to-zero (only Connect and /app actions wait on them; nobody waits during a show).

### /admin additions
Accounts tab: email, plan, trial end, shop, computers (count, last seen). Actions: Grant Free / Remove Free, extend
trial, release shop, revoke computer. Live like the inbox.

### Security
- Every API route verifies the Firebase ID token or the device secret; admin routes also check `admins/{uid}`.
- Firestore rules: owners read their own `accounts/{uid}` and `devices`; `shops`, `rate` closed; admin reads all.
- Device secrets stored hashed; licenses signed, short-lived; revocation takes effect at next renewal (≤ 6 h, plus
  grace).
- `externally_connectable` limited to `https://showrunner.tools/*`; the background accepts the license message only
  from that origin.
- Rate limits on connect and license (per uid / per device), reusing `rate/`.
- A security review (subagent) before the store update ships.

### Chrome Web Store
New host/manifest changes: `externally_connectable` only. Privacy answers already cover account email and
authentication information. Ship as a normal update; store users auto-update.

## Builder-check calls (Claude's, owner may override)
- **Beta users:** an account created before the beta end date gets a trial until the later of createdAt + 7 days
  and the beta end (2026-11-23). This release removes `betaStatus()`; the license replaces it.
- **Before the show is live:** if the shop can't be read from the page yet, test prints and settings work on the
  license's own shop alone; auto-print waits until the page's shop is known and matches. The builder verifies on a
  scheduled (not yet live) dashboard what identifies the shop there.
- **Shop renamed on Whatnot:** the card says "This shop isn't on your account. Renamed your shop? Contact us" and
  the admin uses Move shop. No self-serve this round.
- **Refusal vs grace:** an explicit refusal from `/api/license` (trial ended, computer removed, shop released)
  ends printing at once. The 72-hour grace only covers not being able to reach the server.
- **Admin connections:** an admin's account may connect on any shop without claiming it (for testing on Pablo's
  dashboard). Pablo gets his own Google sign-in and an admin-granted Free plan; he claims his shop himself.

## Decisions (open, with my default)
- Shop switching: admin-only now (default). Later: self-serve once a month.
- Grace period: 72 hours (default).

## Left to the builder
File layout, styling details within the site's existing look, test tooling, copy beyond what is quoted.
