// SafeSight parental controls worker (Cloudflare Worker + D1)
//
// Identity — Firebase Auth only, and only for identity:
// - Parents sign in with Google, child devices sign in anonymously (Google
//   works too). The app/console sends the Firebase ID token on every call;
//   this worker verifies it against Google's JWKS (RS256) and treats the
//   token's `sub` (Firebase UID) as the primary key. No passwords, no
//   sessions, no Firestore, no Firebase Hosting — D1 is the whole database.
// - First Google sign-in creates the parent + their family.
//
// Parenting model
// - users   : a parent, keyed by Firebase UID, belongs to one family.
// - families: the household (name, settings).
// - children: child profiles in a family — name, age band, and a `policy`
//   object (blocked sites, sensitivity, screen time, ...) that the app pulls.
// - devices : a paired app install, keyed by its Firebase UID, bound to one
//   child. Read-only on that child's policy; can file unlock requests.
// - pairing_codes: short-lived 6-char codes the parent generates in the
//   console so a child device can bind itself to a child profile.
// - unlock_requests: permission requests from paired devices, decided by a
//   parent in the console.
//
// Local-first: the apps cache the policy and enforce everything on-device.
// The network is only needed to pair, refresh policy (rare), or ask
// permission — so D1 traffic stays trivially small.
//
// Browser extensions (Chrome / Firefox): UNAFFECTED. They keep using the
// legacy accounts/invites path below (/api/register, /api/account-status,
// /api/verify, shared PIN, invite codes) exactly as before. Do not change
// those handlers.
//
// Console at "/": parent console, Google sign-in (was HTTP Basic admin).

// --- Firebase Auth (identity only) ----------------------------------------
const FIREBASE_PROJECT_ID = "safesight-3b61f";
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const MAX_DEVICES = 2;      // devices per email (legacy extension accounts)
const MAX_ATTEMPTS = 5;     // wrong PINs before a lockout
const LOCKOUT_MS = 5 * 60_000;

// Abuse control: registration is invite-only, so the only thing left to slow
// down is hammering the endpoint (or guessing invite codes) from one IP.
const REGISTER_RATE_LIMIT = 10;         // attempts per IP …
const REGISTER_RATE_WINDOW_MS = 10 * 60_000; // … per 10 minutes
const STATUS_RATE_LIMIT = 30;           // /api/account-status polls, same window

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// ---------------------------------------------------------------------------
// Firebase ID token verification (RS256 against Google's Secure Token JWKS).
// Identity only: a verified token proves "this is Firebase UID X" — all
// authorization still lives in the D1 records that reference X.
// ---------------------------------------------------------------------------
const b64urlBytes = (s) => {
  const b = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 === 0 ? "" : "=".repeat(4 - (b.length % 4));
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// Cached signing keys — Google rotates rarely; refresh hourly (or on kid miss).
let jwksCache = { at: 0, keys: new Map() };
async function getFirebaseKey(kid) {
  const fresh = Date.now() - jwksCache.at < 3600_000;
  if (!fresh || !jwksCache.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks fetch failed: " + res.status);
    const doc = await res.json();
    const keys = new Map();
    for (const k of doc.keys || []) {
      if (k.kty !== "RSA" || (k.use && k.use !== "sig")) continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        k,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.set(k.kid, key);
    }
    jwksCache = { at: Date.now(), keys };
  }
  return jwksCache.keys.get(kid) || null;
}

/// Returns the verified token payload, or null. Never throws on bad input —
/// garbage tokens are just "not signed in".
async function verifyFirebaseToken(bearer) {
  try {
    const parts = String(bearer || "").split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const header = b64urlJson(h);
    if (header.alg !== "RS256") return null;
    const key = await getFirebaseKey(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64urlBytes(s),
      new TextEncoder().encode(h + "." + p)
    );
    if (!ok) return null;
    const claims = b64urlJson(p);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
    if (claims.aud !== FIREBASE_PROJECT_ID) return null;
    if (!claims.sub || typeof claims.sub !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

const bearerOf = (request) => {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  return m ? m[1].trim() : "";
};

/// Gate for the extension-admin endpoints: a valid Google-signed Firebase
/// token (the parent's family data lives in Firestore now, so D1 holds no
/// user rows to check — possession of a Google token for this Firebase
/// project is the credential).
async function requireParent(request) {
  const claims = await verifyFirebaseToken(bearerOf(request));
  if (!claims) return null;
  const provider = claims.firebase && claims.firebase.sign_in_provider;
  return provider === "google.com" ? claims : null;
}

const unauthorized = () =>
  json({ ok: false, error: "unauthorized" }, 401);

const newPin = () => String(Math.floor(100000 + Math.random() * 900000));

/// Human-typable invite code (no 0/O/1/I), 8 chars — 32^8 ≈ 10^12, so it
/// can't be brute-forced even without the rate limit.
const newInviteCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return "SS-" + out;
};

const normalizeEmail = (v) =>
  String(v == null ? "" : v).trim().toLowerCase().slice(0, 120);
const normalizeName = (v) =>
  String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 80);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ---------------------------------------------------------------------------
// D1 storage — one JSON document per row. Same shapes the KV build used, so
// every handler below is unchanged; only the storage helpers moved. Reads are
// indexed primary-key lookups (no list-then-get fan-out), which is what blew
// through KV's free 1k reads/day.
// ---------------------------------------------------------------------------
const parseDoc = (row) => (row && row.data ? JSON.parse(row.data) : null);

const getDoc = (env, sql, ...binds) =>
  env.DB.prepare(sql).bind(...binds).first().then(parseDoc);

const putDoc = (env, table, pkCol, pkValue, doc) =>
  env.DB
    .prepare(
      `INSERT INTO ${table} (${pkCol}, data) VALUES (?, ?)
       ON CONFLICT(${pkCol}) DO UPDATE SET data = excluded.data`
    )
    .bind(pkValue, JSON.stringify(doc))
    .run();

const delDoc = (env, table, pkCol, pkValue) =>
  env.DB.prepare(`DELETE FROM ${table} WHERE ${pkCol} = ?`).bind(pkValue).run();

const getClient = (env, id) =>
  id ? getDoc(env, "SELECT data FROM clients WHERE id = ?", id) : null;
const putClient = (env, c) => putDoc(env, "clients", "id", c.id, c);
const deleteClient = (env, id) => delDoc(env, "clients", "id", id);

const getAccount = (env, email) =>
  email ? getDoc(env, "SELECT data FROM accounts WHERE email = ?", email) : null;
const putAccount = (env, a) => putDoc(env, "accounts", "email", a.email, a);
const deleteAccount = (env, email) => delDoc(env, "accounts", "email", email);

// --- invites (one code creates one account, and is spent on use) ------------
const getInvite = (env, code) =>
  code ? getDoc(env, "SELECT data FROM invites WHERE code = ?", code) : null;
const putInvite = (env, i) => putDoc(env, "invites", "code", i.code, i);


async function allInvites(env) {
  const { results } = await env.DB.prepare("SELECT code, data FROM invites").all();
  const out = results.map((r) => {
    const i = parseDoc(r);
    if (i && !i.code) i.code = r.code;
    return i;
  }).filter(Boolean);
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/// The invites table is created lazily so a deploy that hasn't re-run
/// schema.sql still works (D1 lets us DDL in the request path).
let dbReady = null;
function ensureDb(env) {
  if (!dbReady) {
    dbReady = env.DB
      .prepare(
        "CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, data TEXT NOT NULL)"
      )
      .run()
      .catch(() => {});
  }
  return dbReady;
}

/// Accounts written before approval existed have no status — they were
/// registered the old (open) way, so they count as approved.
const accountStatus = (a) => (a && a.status) || "approved";

// --- per-IP sliding window (in-isolate; good enough to blunt bursts) --------
const rateHits = new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  // Crude sweep so a long-lived isolate can't grow this forever.
  if (rateHits.size > 5000) rateHits.clear();
  return true;
}

const clientIp = (request) =>
  String(request.headers.get("CF-Connecting-IP") || "").slice(0, 60);

async function allClients(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, data FROM clients"
  ).all();
  const out = results.map((r) => {
    const c = parseDoc(r);
    if (c && !c.id) c.id = r.id;
    return c;
  }).filter(Boolean);
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

async function allAccounts(env) {
  const { results } = await env.DB.prepare(
    "SELECT email, data FROM accounts"
  ).all();
  const out = [];
  for (const r of results) {
    const a = parseDoc(r);
    if (!a) continue;
    a.email = a.email || r.email;
    const devices = [];
    for (const id of a.devices || []) {
      const c = await getClient(env, id);
      if (c) devices.push(c);
    }
    // A device record can outlive its account entry; drop the dangling ids.
    if (devices.length !== (a.devices || []).length) {
      a.devices = devices.map((c) => c.id);
      await putAccount(env, a);
    }
    out.push({ ...a, devices });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/// Has this exact device registered before? Used so a reinstall (or a popup
/// reopening) reclaims its own slot instead of burning the last one.
async function findDevice(env, account, deviceId) {
  if (!deviceId) return null;
  for (const id of account.devices || []) {
    const c = await getClient(env, id);
    if (c && c.deviceId === deviceId) return c;
  }
  return null;
}

function failLogin(holder, now) {
  holder.fails = (holder.fails || 0) + 1;
  if (holder.fails >= MAX_ATTEMPTS) {
    holder.lockUntil = now + LOCKOUT_MS;
    holder.fails = 0;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.searchParams;
    const path = url.pathname;

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });

    try {
      await ensureDb(env);

      // ---------------- public API (used by the apps / extensions) ----------------

      if (path === "/api/register" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const ip = clientIp(request);
        if (!rateOk("register:" + ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);

        const email = normalizeEmail(b.email);
        const accountName = normalizeName(b.accountName);

        // No email at all used to fall through to registerLegacy() — an
        // unlimited, approval-free device factory. Closed.
        if (!email) return json({ ok: false, error: "invite_required" }, 403);
        if (!isEmail(email))
          return json({ ok: false, error: "invalid_email" }, 400);
        if (!accountName)
          return json({ ok: false, error: "account_name_required" }, 400);

        const deviceId = String(b.deviceId || "").slice(0, 80);
        const info = {
          device: String(b.device || "Unknown").slice(0, 80),
          version: String(b.version || "").slice(0, 20),
          ua: String(b.ua || "").slice(0, 160),
        };

        let account = await getAccount(env, email);
        const isNewAccount = !account;
        if (account && account.name && normalizeName(account.name) !== accountName)
          return json({ ok: false, error: "account_name_mismatch" }, 409);
        if (!account) {
          // A new email only exists because an admin issued an invite for it.
          const code = String(b.invite || "").trim().toUpperCase().slice(0, 40);
          const invite = await getInvite(env, code);
          if (!invite || invite.status !== "active")
            return json({ ok: false, error: "invite_required" }, 403);

          account = {
            email,
            name: accountName,
            pin: newPin(),
            fails: 0,
            lockUntil: 0,
            createdAt: Date.now(),
            lastSeen: 0,
            devices: [],
            deviceLimit: MAX_DEVICES,
            deviceRequests: [],
            // Stays pending (and the PIN stays here) until the console approves.
            status: "pending",
            invite: code,
            createdIp: ip,
            createdUa: info.ua,
          };
          invite.status = "used";
          invite.usedBy = email;
          invite.usedAt = Date.now();
          await putInvite(env, invite);
        } else if (!account.name) {
          account.name = accountName;
        }

        const status = accountStatus(account);

        const known = await findDevice(env, account, deviceId);
        if (known) {
          Object.assign(known, info);
          known.lastSeen = Date.now();
          known.ip = known.ip || ip;
          await putClient(env, known);
          account.lastSeen = Date.now();
          await putAccount(env, account);
          // This device has already held the PIN, so it's safe to hand back —
          // but only once its account has actually been approved.
          return json({
            ok: true,
            id: known.id,
            email,
            accountName,
            pin: status === "approved" ? account.pin : null,
            devices: account.devices.length,
             deviceLimit: Number(account.deviceLimit) || MAX_DEVICES,
             newAccount: false,
            rejoined: true,
            status,
          });
        }

        const deviceLimit = Number(account.deviceLimit) || MAX_DEVICES;
        if (account.devices.length >= deviceLimit)          return json(
            {
              ok: false,
              error: "device_limit",
              email,
              devices: account.devices.length,
              deviceLimit,
              status,
            },
            409
          );

        const c = {
          id: crypto.randomUUID(),
          deviceId,
          email,
          ip,
          ...info,
          createdAt: Date.now(),
          lastSeen: Date.now(),
          requests: [],
        };
        await putClient(env, c);
        account.devices.push(c.id);
        account.lastSeen = Date.now();
        await putAccount(env, account);        return json({
          ok: true,
          id: c.id,
          email,
          accountName,
          // Shown once on the device that creates the account. Later devices
          // share the same PIN, but aren't told it again — and a pending
          // account is never told it at all (clients poll /api/account-status).
          pin: isNewAccount && status === "approved" ? account.pin : null,
          devices: account.devices.length,
           deviceLimit,
          newAccount: isNewAccount,
          status,
        });
      }

      // ---------------- pending-account polling ----------------
      // The only way out of "waiting for approval": the client asks by its own
      // device id (never by email, so this can't be used to fish for accounts).
      if (path === "/api/account-status") {
        const id = String(p.get("id") || "");
        const c = await getClient(env, id);
        if (!c) return json({ ok: false, error: "unknown client" }, 404);
        if (!rateOk("status:" + (clientIp(request) || id), STATUS_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);

        const account = c.email ? await getAccount(env, c.email) : null;
        const status = account ? accountStatus(account) : "approved";
        c.lastSeen = Date.now();
        await putClient(env, c);
        // The PIN travels with the approval, so the device that created the
        // account gets it exactly once the admin says go.
        return json({
          ok: true,
          status,
          email: c.email || null,
          pin: status === "approved" && account ? account.pin : null,
        });
      }

      if (path === "/api/device-request" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const email = normalizeEmail(b.email);
        const deviceId = String(b.deviceId || "").slice(0, 80);
        if (!isEmail(email) || !deviceId)
          return json({ ok: false, error: "invalid_request" }, 400);

        const account = await getAccount(env, email);
        if (!account) return json({ ok: false, error: "unknown_account" }, 404);

        const deviceLimit = Number(account.deviceLimit) || MAX_DEVICES;
        if ((account.devices || []).length < deviceLimit)
          return json({ ok: true, alreadyAvailable: true });

        const requests = account.deviceRequests || [];
        const existing = requests.find((r) => r.deviceId === deviceId && r.status === "pending");
        if (existing) return json({ ok: true, duplicate: true, ticket: existing.ticket });

        const ticket = Date.now() + Math.floor(Math.random() * 1000);
        account.deviceRequests = [...requests.slice(-19), {
          ticket,
          deviceId,
          device: String(b.device || "Unknown").slice(0, 80),
          version: String(b.version || "").slice(0, 20),
          status: "pending",
          at: ticket,
        }];
        await putAccount(env, account);
        return json({ ok: true, ticket });
      }

      if (path === "/api/verify" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const c = await getClient(env, String(b.id || ""));
        if (!c) return json({ ok: false, error: "unknown client" }, 404);

        // One PIN per email: every device on the account checks the same PIN
        // (and shares its lockout). Legacy records carry their own.
        const account = c.email ? await getAccount(env, c.email) : null;
        const holder = account || c;
        const now = Date.now();

        // A pending account has no PIN to give: every destructive action is
        // refused until the admin approves it, which is what keeps a freshly
        // registered extension or app locked.
        if (account && accountStatus(account) !== "approved")
          return json({ ok: false, error: "account_pending" }, 403);

        if (holder.lockUntil > now)
          return json({
            ok: false,
            locked: true,
            error: "locked",
            retry: Math.ceil((holder.lockUntil - now) / 1000),
          });

        if (String(b.pin) !== holder.pin) {
          failLogin(holder, now);
          await (account ? putAccount(env, account) : putClient(env, c));
          return json({
            ok: false,
            error: "wrong pin",
            locked: holder.lockUntil > now,
            retry: holder.lockUntil > now ? Math.ceil((holder.lockUntil - now) / 1000) : 0,
          });
        }

        holder.fails = 0;
        holder.lastSeen = now;
        await (account ? putAccount(env, account) : putClient(env, c));
        c.lastSeen = now;
        await putClient(env, c);
        return json({ ok: true, email: c.email || null });
      }

      if (path === "/api/unlock-request" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const c = await getClient(env, String(b.id || ""));
        if (!c) return json({ ok: false, error: "unknown client" }, 404);
        const ticket = Date.now();
        c.requests = (c.requests || []).slice(-19);
        c.requests.push({
          ticket,
          action: String(b.action || "unlock").slice(0, 80),
          detail: String(b.detail || "").slice(0, 200),
          status: "pending",
          at: ticket,
        });
        await putClient(env, c);
        return json({ ok: true, ticket });
      }

      if (path === "/api/unlock-status") {
        const c = await getClient(env, String(p.get("id") || ""));
        const ticket = Number(p.get("ticket"));
        const r = c && (c.requests || []).find((x) => x.ticket === ticket);
        return json({ status: r ? r.status : "unknown" });
      }

      // ---------------- parent console (Google sign-in) ----------------

      if (path === "/") {
        return new Response(PANEL, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (path === "/api/admin/list") {
        if (!(await requireParent(request))) return unauthorized();
        const [accounts, clients, invites] = await Promise.all([
          allAccounts(env),
          allClients(env),
          allInvites(env),
        ]);
        return json({
          accounts,
          legacy: clients.filter((c) => !c.email),
          invites,
          maxDevices: MAX_DEVICES,
        });
      }

      if (path.startsWith("/api/admin/") && request.method === "POST") {
        // Legacy extension-account management still lives here; it's now
        // gated by a parent's Google sign-in instead of Basic auth.
        if (!(await requireParent(request))) return unauthorized();
        const b = await request.json().catch(() => ({}));
        const email = normalizeEmail(b.email);

        // Account PIN (applies to every device on the email), or a legacy
        // device's own PIN when no email is given.
        if (path === "/api/admin/change-pin") {
          const pin = String(b.pin || "").trim();
          if (!/^\d{4,8}$/.test(pin))
            return json({ ok: false, error: "PIN must be 4-8 digits" });

          if (email) {
            const a = await getAccount(env, email);
            if (!a) return json({ ok: false, error: "unknown account" }, 404);
            a.pin = pin;
            a.fails = 0;
            a.lockUntil = 0;
            await putAccount(env, a);
            return json({ ok: true, pin, email });
          }

          const c = await getClient(env, String(b.id || ""));
          if (!c) return json({ ok: false, error: "unknown device" }, 404);
          c.pin = pin;
          c.fails = 0;
          c.lockUntil = 0;
          await putClient(env, c);
          return json({ ok: true, pin });
        }

        // Approve / deny a newly registered account. Deny deletes it (and its
        // devices) — the invite it was created with is already spent.
        if (path === "/api/admin/account-decision") {
          if (!email) return json({ ok: false, error: "missing email" });
          const a = await getAccount(env, email);
          if (!a) return json({ ok: false, error: "unknown account" }, 404);
          if (b.decision === "approve") {
            a.status = "approved";
            a.approvedAt = Date.now();
            a.fails = 0;
            a.lockUntil = 0;
            await putAccount(env, a);
            return json({ ok: true, status: "approved" });
          }
          for (const id of a.devices || []) await deleteClient(env, id);
          await deleteAccount(env, email);
          return json({ ok: true, status: "deleted" });
        }

        // Invite codes: one code, one new account, spent on use.
        if (path === "/api/admin/invite") {
          const invite = {
            code: newInviteCode(),
            note: String(b.note || "").slice(0, 80),
            status: "active",
            createdAt: Date.now(),
            usedBy: null,
            usedAt: 0,
          };
          await putInvite(env, invite);
          return json({ ok: true, invite });
        }

        if (path === "/api/admin/invite-revoke") {
          const code = String(b.code || "").trim().toUpperCase();
          const invite = await getInvite(env, code);
          if (!invite) return json({ ok: false, error: "unknown invite" }, 404);
          if (invite.status === "active") invite.status = "revoked";
          await putInvite(env, invite);
          return json({ ok: true, invite });
        }

        if (path === "/api/admin/device-request") {
          const a = await getAccount(env, email);
          if (!a) return json({ ok: false, error: "unknown account" }, 404);
          const r = (a.deviceRequests || []).find((x) => x.ticket === Number(b.ticket));
          if (!r) return json({ ok: false, error: "no such request" });
          if (b.decision === "approve") {
            r.status = "approved";
            a.deviceLimit = (Number(a.deviceLimit) || MAX_DEVICES) + 1;
          } else {
            r.status = "denied";
          }
          await putAccount(env, a);
          return json({ ok: true, deviceLimit: a.deviceLimit });
        }

        if (path === "/api/admin/decide") {
          const c = await getClient(env, String(b.id || ""));
          if (!c) return json({ ok: false, error: "unknown device" }, 404);
          const r = (c.requests || []).find((x) => x.ticket === Number(b.ticket));
          if (!r) return json({ ok: false, error: "no such request" });
          r.status = b.decision === "approve" ? "approved" : "denied";
          await putClient(env, c);
          return json({ ok: true });
        }

        // One device off the account — frees a slot for another device. With no
        // email this is a legacy record, which is just a device.
        if (path === "/api/admin/delete-device") {
          const id = String(b.id || "");
          if (!id) return json({ ok: false, error: "missing device id" });
          if (email) {
            const a = await getAccount(env, email);
            if (!a) return json({ ok: false, error: "unknown account" }, 404);
            a.devices = (a.devices || []).filter((x) => x !== id);
            await putAccount(env, a);
          }
          await deleteClient(env, id);
          return json({ ok: true });
        }

        // Whole account: the email plus every device on it.
        if (path === "/api/admin/delete-account") {
          if (!email) return json({ ok: false, error: "missing email" });
          const a = await getAccount(env, email);
          if (!a) return json({ ok: false, error: "unknown account" }, 404);
          for (const id of a.devices || []) await deleteClient(env, id);
          await deleteAccount(env, email);
          return json({ ok: true });
        }
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Admin console (single page, no build step)
// ---------------------------------------------------------------------------
const PANEL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SafeSight Family</title>
<style>
  :root { color-scheme: dark; --bg:#0f172a; --card:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --primary:#6366f1; --danger:#ef4444; --ok:#22c55e; --border:rgba(255,255,255,.08); }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,system-ui,sans-serif; padding:24px; }
  h1 { margin:0 0 4px; font-size:22px; } .sub { color:var(--muted); margin:0 0 20px; }
  .grid { display:flex; flex-direction:column; gap:14px; max-width:1000px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px 16px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .name { font-weight:700; font-size:15px; } .dev { color:var(--muted); font-size:12px; }
  .id { font:11px ui-monospace,monospace; color:var(--muted); }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; background:rgba(99,102,241,.18); color:#a5b4fc; }
  .pill.full { background:rgba(217,119,6,.2); color:#fbbf24; }
  .pill.legacy { background:rgba(148,163,184,.18); color:var(--muted); }
  .pill.awaiting { background:rgba(249,115,22,.2); color:#fdba74; }
  input, select, textarea { background:#0b1220; border:1px solid var(--border); color:var(--text); border-radius:8px; padding:6px 8px; font:13px ui-monospace,monospace; }
  input { width:110px; }
  textarea { width:100%; min-height:60px; font:13px ui-monospace,monospace; }
  button { border:none; border-radius:8px; padding:6px 12px; font-weight:600; cursor:pointer; background:var(--primary); color:#fff; }
  button.ok { background:var(--ok); } button.del { background:var(--danger); } button.ghost { background:rgba(148,163,184,.15); color:var(--muted); }
  .device { border-top:1px solid var(--border); margin-top:10px; padding-top:10px; }
  .req { background:rgba(255,255,255,.04); border-radius:8px; padding:8px 10px; margin-top:6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:13px; }
  .pending { color:#fbbf24; } .approved { color:var(--ok); } .denied { color:var(--danger); }
  .empty { color:var(--muted); padding:30px; text-align:center; }
  .meta { color:var(--muted); font-size:11px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:18px 0 0; }
  .code { font:700 24px ui-monospace,monospace; letter-spacing:.3em; color:#a5b4fc; }
  #signin { max-width:420px; margin:60px auto; text-align:center; }
  #signin button { padding:10px 18px; font-size:15px; }
  .tabs { display:flex; gap:8px; margin-bottom:14px; }
  .tabs button.on { background:var(--primary); }
</style>
</head>
<body>
<div id="signin" class="card" style="display:none">
  <h1>🛡️ SafeSight Family</h1>
  <p class="sub">Sign in as a parent to manage children, devices and unlock requests.</p>
  <button id="googleBtn">Sign in with Google</button>
  <p class="meta" id="authMsg"></p>
</div>

<div id="app" style="display:none">
  <div class="row" style="max-width:1000px;margin-bottom:6px">
    <h1>🛡️ SafeSight Family</h1>
    <span style="flex:1"></span>
    <span class="meta" id="who"></span>
    <button class="ghost" id="signOutBtn">Sign out</button>
  </div>
  <p class="sub">Children · pairing codes · devices · unlock requests · extension accounts</p>
  <div class="tabs">
    <button class="on" data-tab="family">Family</button>
    <button data-tab="legacy">Extension accounts</button>
  </div>
  <div class="card" id="addCard" style="max-width:1000px;margin-bottom:14px">
    <div class="row">
      <span class="name">Add child</span>
      <input id="childName" placeholder="name" style="width:180px">
      <input id="childAge" placeholder="age band (e.g. 8-12)" style="width:150px">
      <button data-act="child-add">Add child</button>
      <span class="meta">Children's devices pair with a one-time code — the app applies its policy locally after that.</span>
    </div>
  </div>
  <div class="grid" id="grid"><div class="empty">Loading…</div></div>
</div>

<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, addDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAJ79A9ZSXT-MLyTlSlPC5bWk2x2eo2qAo",
  authDomain: "safesight-3b61f.firebaseapp.com",
  projectId: "safesight-3b61f",
  storageBucket: "safesight-3b61f.firebasestorage.app",
  messagingSenderId: "816580635380",
  appId: "1:816580635380:web:738203cf7a5900034f8ca1"
};
const MAX_DEVICES = ${MAX_DEVICES};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let idToken = null;
let me = null;
let tab = "family";

const $ = (id) => document.getElementById(id);
const signinEl = $("signin"), appEl = $("app");

// The code *is* the doc id (same scheme as the apps): A-Z minus O/I.
function newPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// First sign-in: family first, then the users doc (rules require it).
async function bootstrap(u) {
  const snap = await getDoc(doc(db, "users", u.uid));
  if (snap.exists()) return snap.data();
  const famRef = doc(collection(db, "families"));
  await setDoc(famRef, {
    id: famRef.id, name: "Family", ownerUid: u.uid, memberUids: [u.uid],
    createdAt: Date.now(), settings: {}
  });
  const profile = {
    uid: u.uid, email: u.email || "", name: u.displayName || "",
    picture: u.photoURL || "", role: "parent", familyId: famRef.id
  };
  await setDoc(doc(db, "users", u.uid), profile);
  return profile;
}

async function famQuery(name, familyId) {
  const snap = await getDocs(query(collection(db, name), where("familyId", "==", familyId)));
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

// Legacy extension endpoints still live on the Worker (Bearer-token API).
async function api(path, body, method) {
  const m = method || (body ? "POST" : "GET");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!idToken && auth.currentUser) idToken = await auth.currentUser.getIdToken();
    const r = await fetch(path, {
      method: m,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && attempt === 0 && auth.currentUser) {
      idToken = await auth.currentUser.getIdToken(true);
      continue;
    }
    if (r.status === 401) { signOut(auth); return { ok: false, error: "unauthorized" }; }
    return r.json().catch(() => ({ ok: false }));
  }
  return { ok: false };
}

function fmt(ts) { return ts ? new Date(ts).toLocaleString() : "never"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m])); }

// ---------- legacy extension-account bits (unchanged behavior) ----------
function requests(c) {
  const pending = (c.requests || []).filter(r => r.status === "pending").map(r =>
    '<div class="req"><span class="pending">⏳</span><b>' + esc(r.action) + '</b><span class="meta">' + esc(r.detail || "") + " · " + fmt(r.at) + "</span>" +
    '<span style="flex:1"></span>' +
    '<button class="ok" data-act="decide" data-id="' + esc(c.id) + '" data-ticket="' + r.ticket + '" data-decision="approve">Approve</button>' +
    '<button class="del" data-act="decide" data-id="' + esc(c.id) + '" data-ticket="' + r.ticket + '" data-decision="deny">Deny</button></div>').join("");
  const history = (c.requests || []).filter(r => r.status !== "pending").slice(-3).map(r =>
    '<div class="req"><span class="' + esc(r.status) + '">' + (r.status === "approved" ? "✅" : "❌") + "</span><b>" + esc(r.action) + '</b><span class="meta">' + esc(r.status) + " · " + fmt(r.at) + "</span></div>").join("");
  return pending + history;
}
function deviceRequests(a) {
  return (a.deviceRequests || []).filter(r => r.status === "pending").map(r =>
    '<div class="req"><span class="pending">➕</span><b>Additional device</b><span class="meta">' + esc(r.device || "Unknown device") + " · " + fmt(r.at) + "</span>" +
    '<span style="flex:1"></span>' +
    '<button class="ok" data-act="device-request" data-email="' + esc(a.email) + '" data-ticket="' + r.ticket + '" data-decision="approve">Approve</button>' +
    '<button class="del" data-act="device-request" data-email="' + esc(a.email) + '" data-ticket="' + r.ticket + '" data-decision="deny">Deny</button></div>').join("");
}
function device(c, email) {
  return '<div class="device">' +
    '<div class="row"><span class="pill">' + esc(c.device) + "</span>" +
    (c.version ? '<span class="pill">v' + esc(c.version) + "</span>" : "") +
    (c.ua ? '<span class="meta">' + esc(c.ua) + "</span>" : "") +
    '<span style="flex:1"></span>' +
    '<button class="ghost" data-act="remove-device" data-id="' + esc(c.id) + '" data-email="' + esc(email || "") + '" data-label="' + esc(c.device) + '">Remove device</button></div>' +
    '<div class="id">' + esc(c.id) + "</div>" +
    '<div class="meta">added ' + fmt(c.createdAt) + " · last seen " + fmt(c.lastSeen) +
    (c.lockUntil > Date.now() ? " · 🔒 LOCKED" : "") + "</div>" +
    requests(c) + "</div>";
}
function account(a) {
  const devices = a.devices || [];
  const limit = a.deviceLimit || MAX_DEVICES;
  const full = devices.length >= limit;
  const pending = (a.status || "approved") !== "approved";
  return '<div class="card">' +
    '<div class="row"><span class="name">' + esc(a.name || "Unnamed account") + '</span><span class="meta">' + esc(a.email) + "</span>" +
    '<span class="pill' + (full ? " full" : "") + '">' + devices.length + " / " + limit + " devices</span>" +
    (pending ? '<span class="pill awaiting">⛔ awaiting approval — locked</span>' : "") +
    (a.lockUntil > Date.now() ? '<span class="pill full">🔒 locked</span>' : "") +
    '<span style="flex:1"></span>' +
    (pending
      ? '<button class="ok" data-act="account-decision" data-email="' + esc(a.email) + '" data-decision="approve">Approve account</button> ' +
        '<button class="del" data-act="account-decision" data-email="' + esc(a.email) + '" data-decision="deny">Deny</button>'
      : "") +
    '<span class="meta">PIN (all devices)</span><input class="pin" value="' + esc(a.pin) + '" maxlength="8">' +
    '<button data-act="pin" data-email="' + esc(a.email) + '">Save</button>' +
    '<button class="del" data-act="delete-account" data-email="' + esc(a.email) + '">Delete account</button></div>' +
    '<div class="meta">registered ' + fmt(a.createdAt) + " · last seen " + fmt(a.lastSeen) +
    (a.invite ? " · invite " + esc(a.invite) : "") + "</div>" +
    deviceRequests(a) +
    (devices.length ? devices.map(c => device(c, a.email)).join("") : '<div class="meta" style="margin-top:8px">No devices.</div>') +
    "</div>";
}
function inviteCard(i) {
  const active = i.status === "active";
  return '<div class="card">' +
    '<div class="row"><span class="name id">' + esc(i.code) + "</span>" +
    '<span class="pill' + (active ? "" : " legacy") + '">' + esc(i.status || "active") + "</span>" +
    (i.note ? '<span class="meta">' + esc(i.note) + "</span>" : "") +
    '<span style="flex:1"></span>' +
    (active
      ? '<button class="ghost" data-act="copy-invite" data-code="' + esc(i.code) + '">Copy code</button> ' +
        '<button class="del" data-act="invite-revoke" data-code="' + esc(i.code) + '">Revoke</button>'
      : "") +
    (i.usedBy ? '<span class="meta">used by ' + esc(i.usedBy) + " · " + fmt(i.usedAt) + "</span>" : "") +
    "</div></div>";
}
function legacyCard(c) {
  return '<div class="card">' +
    '<div class="row"><span class="name">' + esc(c.name) + '</span><span class="pill legacy">legacy · own PIN</span>' +
    '<span style="flex:1"></span>' +
    '<span class="meta">PIN</span><input class="pin" value="' + esc(c.pin) + '" maxlength="8">' +
    '<button data-act="pin" data-id="' + esc(c.id) + '">Save</button>' +
    '<button class="del" data-act="remove-device" data-id="' + esc(c.id) + '" data-email="" data-label="' + esc(c.name) + '">Delete</button></div>' +
    device(c, "") + "</div>";
}

// ---------- family bits ----------
function childCard(c, devices, unlocks) {
  const cds = devices.filter(d => d.childId === c.id);
  const reqs = unlocks.filter(u => u.childId === c.id && u.status === "pending");
  const pol = c.policy || {};
  return '<div class="card">' +
    '<div class="row"><span class="name">' + esc(c.name) + "</span>" +
    (c.ageBand ? '<span class="pill">ages ' + esc(c.ageBand) + "</span>" : "") +
    '<span class="pill">' + cds.length + " device" + (cds.length === 1 ? "" : "s") + "</span>" +
    (reqs.length ? '<span class="pill awaiting">' + reqs.length + " unlock request" + (reqs.length === 1 ? "" : "s") + "</span>" : "") +
    '<span style="flex:1"></span>' +
    '<button data-act="pair" data-id="' + esc(c.id) + '">Pair device</button>' +
    '<button class="ghost" data-act="child-edit" data-id="' + esc(c.id) + '">Edit</button>' +
    '<button class="del" data-act="child-delete" data-id="' + esc(c.id) + '" data-label="' + esc(c.name) + '">Delete</button></div>' +
    '<div class="meta" id="pairbox-' + esc(c.id) + '"></div>' +
    '<div class="meta">blocked sites: ' + (pol.blockedSites || []).length +
      " · sensitivity " + (pol.sensitivity != null ? pol.sensitivity : 50) +
      " · screen time " + (pol.screenTimeMinutes ? pol.screenTimeMinutes + "m/day" : "unlimited") + "</div>" +
    reqs.map(r =>
      '<div class="req"><span class="pending">⏳</span><b>' + esc(r.action) + '</b><span class="meta">' + esc(r.detail || "") + " · " + esc(r.device || "") + " · " + fmt(r.at) + "</span>" +
      '<span style="flex:1"></span>' +
      '<button class="ok" data-act="unlock-decide" data-rid="' + esc(r.id) + '" data-decision="approve">Approve</button>' +
      '<button class="del" data-act="unlock-decide" data-rid="' + esc(r.id) + '" data-decision="deny">Deny</button></div>').join("") +
    cds.map(d =>
      '<div class="device"><div class="row"><span class="pill">' + esc(d.device || "device") + "</span>" +
      (d.platform ? '<span class="pill">' + esc(d.platform) + "</span>" : "") +
      '<span class="meta">last seen ' + fmt(d.lastSeen) + '</span><span style="flex:1"></span>' +
      '<button class="ghost" data-act="device-unpair" data-uid="' + esc(d.uid) + '" data-label="' + esc(d.device || d.uid) + '">Unpair</button></div>' +
      '<div class="id">' + esc(d.uid) + "</div></div>").join("") +
    (cds.length ? "" : '<div class="meta" style="margin-top:8px">No paired devices — hit “Pair device” and enter the code in the app.</div>') +
    "</div>";
}

async function loadFamily() {
  if (!me || !me.user) return '<div class="empty">Could not load family data.</div>';
  const familyId = me.user.familyId;
  const [children, devices, unlocks] = await Promise.all([
    famQuery("children", familyId),
    famQuery("devices", familyId),
    famQuery("unlockRequests", familyId),
  ]);
  me.children = children;
  me.devices = devices;
  me.unlockRequests = unlocks;
  if (!children.length)
    return '<div class="empty">No children yet — add one above.</div>';
  return children.map(c => childCard(c, devices, unlocks)).join("");
}

async function loadLegacy() {
  const data = await api("/api/admin/list");
  if (!data.ok) return '<div class="empty">Could not load extension accounts.</div>';
  const accounts = data.accounts || [];
  const legacy = data.legacy || [];
  const invites = data.invites || [];
  const awaiting = accounts.filter(a => (a.status || "approved") !== "approved");
  const approved = accounts.filter(a => (a.status || "approved") === "approved");
  const inviteBar =
    '<div class="card"><div class="row">' +
    '<span class="name">New extension invite code</span>' +
    '<input id="inviteNote" placeholder="note (optional)" style="width:220px">' +
    '<button data-act="invite-new">Create invite</button>' +
    '<span class="meta">Chrome/Firefox extensions register with one of these — unchanged.</span>' +
    "</div></div>";
  const body =
    (awaiting.length ? '<h2>Awaiting approval (locked)</h2>' + awaiting.map(account).join("") : "") +
    (approved.length ? '<h2>Extension accounts</h2>' + approved.map(account).join("") : "") +
    (invites.length ? '<h2>Invite codes</h2>' + invites.map(inviteCard).join("") : "") +
    (legacy.length ? '<h2>Legacy devices</h2>' + legacy.map(legacyCard).join("") : "");
  return inviteBar + (body || '<div class="empty">No extension accounts yet — create an invite code above.</div>');
}

async function load() {
  const grid = $("grid");
  grid.innerHTML = '<div class="empty">Loading…</div>';
  grid.innerHTML = tab === "family" ? await loadFamily() : await loadLegacy();
  if (me && me.user) $("who").textContent = (me.user.name || "") + " · " + (me.user.email || "");
}

// ---------- actions ----------
document.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest("button[data-tab]");
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b === tabBtn));
    $("addCard").style.display = tab === "family" ? "" : "none";
    return load();
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id || "";
  btn.disabled = true;
  try {
    if (act === "child-add") {
      const name = $("childName").value.trim(), age = $("childAge").value.trim();
      if (!name) return alert("Enter the child's name.");
      await addDoc(collection(db, "children"), {
        familyId: me.user.familyId, name, ageBand: age,
        policy: {
          blockedSites: [], allowedSites: [], sensitivity: 50,
          skinFilter: true, blurAll: false, screenTimeMinutes: 0, schedule: null
        },
        createdAt: Date.now(), updatedAt: Date.now()
      });
      $("childName").value = ""; $("childAge").value = "";
    } else if (act === "child-delete") {
      if (confirm('Delete "' + (btn.dataset.label || id) + '" and unpair their devices?')) {
        await deleteDoc(doc(db, "children", id));
        for (const d of (me.devices || []).filter(x => x.childId === id))
          await deleteDoc(doc(db, "devices", d.uid));
      }
    } else if (act === "child-edit") {
      const cur = me && (me.children || []).find(c => c.id === id);
      if (!cur) return;
      const name = prompt("Name:", cur.name);
      if (name == null) return;
      const age = prompt("Age band (e.g. 8-12):", cur.ageBand || "");
      if (age == null) return;
      const pol = cur.policy || {};
      const blocked = prompt("Blocked sites (comma separated):", (pol.blockedSites || []).join(", "));
      if (blocked == null) return;
      const screen = prompt("Daily screen time in minutes (0 = unlimited):", String(pol.screenTimeMinutes || 0));
      if (screen == null) return;
      const sens = prompt("Sensitivity 0-100:", String(pol.sensitivity != null ? pol.sensitivity : 50));
      if (sens == null) return;
      await updateDoc(doc(db, "children", id), {
        name, ageBand: age, updatedAt: Date.now(),
        "policy.blockedSites": blocked.split(",").map(s => s.trim()).filter(Boolean),
        "policy.screenTimeMinutes": Math.max(0, parseInt(screen, 10) || 0),
        "policy.sensitivity": Math.min(100, Math.max(0, parseInt(sens, 10) || 50)),
      });
    } else if (act === "pair") {
      // Code doubles as the doc id — same format the apps generate.
      const code = newPairingCode();
      const expiresAt = Date.now() + 10 * 60_000;
      await setDoc(doc(db, "pairingCodes", code), {
        code, familyId: me.user.familyId, childId: id,
        createdAt: Date.now(), expiresAt, usedBy: null, usedAt: null
      });
      const box = $("pairbox-" + id);
      if (box) {
        box.innerHTML = 'Pairing code: <span class="code">' + esc(code) + "</span> · expires " + fmt(expiresAt) + " — enter it in the child's app.";
        try { await navigator.clipboard.writeText(code); } catch (_) {}
      }
      return;
    } else if (act === "unlock-decide") {
      await updateDoc(doc(db, "unlockRequests", btn.dataset.rid), {
        status: btn.dataset.decision === "approve" ? "approved" : "denied",
        decidedAt: Date.now()
      });
    } else if (act === "device-unpair") {
      if (confirm('Unpair "' + (btn.dataset.label || "") + '"?'))
        await deleteDoc(doc(db, "devices", btn.dataset.uid));
    } else if (act === "invite-new") {
      const note = ($("inviteNote") || {}).value || "";
      const r = await api("/api/admin/invite", { note });
      if (r.ok) {
        try { await navigator.clipboard.writeText(r.invite.code); } catch (_) {}
        alert("Invite code created (copied):\\n\\n" + r.invite.code);
        $("inviteNote").value = "";
      } else alert(r.error || "failed");
    } else if (act === "invite-revoke") {
      if (confirm("Revoke invite " + btn.dataset.code + "?"))
        await api("/api/admin/invite-revoke", { code: btn.dataset.code });
    } else if (act === "copy-invite") {
      try { await navigator.clipboard.writeText(btn.dataset.code); } catch (_) {}
      alert("Copied: " + btn.dataset.code);
    } else if (act === "account-decision") {
      const approve = btn.dataset.decision === "approve";
      if (approve || confirm("Deny this extension account? It and its devices are deleted."))
        await api("/api/admin/account-decision", { email: btn.dataset.email, decision: btn.dataset.decision });
    } else if (act === "pin") {
      const pin = btn.closest(".row").querySelector("input.pin").value;
      const r = await api("/api/admin/change-pin", btn.dataset.email ? { email: btn.dataset.email, pin } : { id, pin });
      alert(r.ok ? "PIN updated" : (r.error || "failed"));
    } else if (act === "delete-account") {
      if (confirm("Delete this extension account and all of its devices?"))
        await api("/api/admin/delete-account", { email: btn.dataset.email });
    } else if (act === "remove-device") {
      if (confirm("Remove device " + (btn.dataset.label || id) + "?"))
        await api("/api/admin/delete-device", btn.dataset.email ? { email: btn.dataset.email, id } : { id });
    } else if (act === "decide") {
      await api("/api/admin/decide", { id, ticket: Number(btn.dataset.ticket), decision: btn.dataset.decision });
    } else if (act === "device-request") {
      await api("/api/admin/device-request", { email: btn.dataset.email, ticket: Number(btn.dataset.ticket), decision: btn.dataset.decision });
    }
  } finally {
    btn.disabled = false;
    if (act !== "pair") load(); // pair shows the code in-place; a reload would wipe it
  }
});

$("googleBtn").addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch(err => {
    $("authMsg").textContent = err.message || String(err);
  });
});
$("signOutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (u) => {
  if (!u) {
    signinEl.style.display = "";
    appEl.style.display = "none";
    idToken = null;
    me = null;
    return;
  }
  try {
    // Creates the parent + family in Firestore on first sign-in.
    const profile = await bootstrap(u);
    me = { user: profile, children: [], devices: [], unlockRequests: [] };
  } catch (err) {
    $("authMsg").textContent = "Sign-in failed: " + (err.message || String(err));
    await signOut(auth);
    return;
  }
  signinEl.style.display = "none";
  appEl.style.display = "";
  $("authMsg").textContent = "";
  $("who").textContent = (me.user.name || "") + " · " + (me.user.email || "");
  load();
});
</script>
</body>
</html>`;
