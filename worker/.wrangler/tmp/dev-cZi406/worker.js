var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var FIREBASE_PROJECT_ID = "safesight-3b61f";
var JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
var MAX_DEVICES = 2;
var MAX_ATTEMPTS = 5;
var LOCKOUT_MS = 5 * 6e4;
var REGISTER_RATE_LIMIT = 10;
var REGISTER_RATE_WINDOW_MS = 10 * 6e4;
var STATUS_RATE_LIMIT = 30;
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", ...CORS }
}), "json");
var b64urlBytes = /* @__PURE__ */ __name((s) => {
  const b = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 === 0 ? "" : "=".repeat(4 - b.length % 4);
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}, "b64urlBytes");
var b64urlJson = /* @__PURE__ */ __name((s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))), "b64urlJson");
var jwksCache = { at: 0, keys: /* @__PURE__ */ new Map() };
async function getFirebaseKey(kid) {
  const fresh = Date.now() - jwksCache.at < 36e5;
  if (!fresh || !jwksCache.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks fetch failed: " + res.status);
    const doc = await res.json();
    const keys = /* @__PURE__ */ new Map();
    for (const k of doc.keys || []) {
      if (k.kty !== "RSA" || k.use && k.use !== "sig") continue;
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
__name(getFirebaseKey, "getFirebaseKey");
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
    const now = Math.floor(Date.now() / 1e3);
    if (claims.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
    if (claims.aud !== FIREBASE_PROJECT_ID) return null;
    if (!claims.sub || typeof claims.sub !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
__name(verifyFirebaseToken, "verifyFirebaseToken");
var newPin = /* @__PURE__ */ __name(() => String(Math.floor(1e5 + Math.random() * 9e5)), "newPin");
var normalizeEmail = /* @__PURE__ */ __name((v) => String(v == null ? "" : v).trim().toLowerCase().slice(0, 120), "normalizeEmail");
var normalizeName = /* @__PURE__ */ __name((v) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, 80), "normalizeName");
var isEmail = /* @__PURE__ */ __name((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e), "isEmail");
var parseDoc = /* @__PURE__ */ __name((row) => row && row.data ? JSON.parse(row.data) : null, "parseDoc");
var getDoc = /* @__PURE__ */ __name((env, sql, ...binds) => env.DB.prepare(sql).bind(...binds).first().then(parseDoc), "getDoc");
var putDoc = /* @__PURE__ */ __name((env, table, pkCol, pkValue, doc) => env.DB.prepare(
  `INSERT INTO ${table} (${pkCol}, data) VALUES (?, ?)
       ON CONFLICT(${pkCol}) DO UPDATE SET data = excluded.data`
).bind(pkValue, JSON.stringify(doc)).run(), "putDoc");
var getClient = /* @__PURE__ */ __name((env, id) => id ? getDoc(env, "SELECT data FROM clients WHERE id = ?", id) : null, "getClient");
var putClient = /* @__PURE__ */ __name((env, c) => putDoc(env, "clients", "id", c.id, c), "putClient");
var getAccount = /* @__PURE__ */ __name((env, email) => email ? getDoc(env, "SELECT data FROM accounts WHERE email = ?", email) : null, "getAccount");
var putAccount = /* @__PURE__ */ __name((env, a) => putDoc(env, "accounts", "email", a.email, a), "putAccount");
async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HKDF", hash: "SHA-256" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("safesight"), info: salt },
    key,
    256
  );
  const hash = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(plain + ":" + btoa(String.fromCharCode(...salt)))
  );
  return btoa(String.fromCharCode(...new Uint8Array(hash))) + "$" + btoa(String.fromCharCode(...salt));
}
__name(hashPassword, "hashPassword");
async function verifyPassword(hash, plain) {
  if (!hash || !plain) return false;
  const [storedHash, saltB64] = hash.split("$");
  if (!storedHash || !saltB64) return false;
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HKDF", hash: "SHA-256" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("safesight"), info: salt },
    key,
    256
  );
  const checkHash = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(plain + ":" + btoa(String.fromCharCode(...salt)))
  );
  const checkB64 = btoa(String.fromCharCode(...new Uint8Array(checkHash)));
  return checkB64 === storedHash;
}
__name(verifyPassword, "verifyPassword");
var dbReady = null;
function ensureDb(env) {
  if (!dbReady) {
    dbReady = env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, data TEXT NOT NULL)"
    ).run().catch(() => {
    });
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, data TEXT NOT NULL)"
    ).run().catch(() => {
    });
  }
  return dbReady;
}
__name(ensureDb, "ensureDb");
var accountStatus = /* @__PURE__ */ __name((a) => a && a.status || "approved", "accountStatus");
var rateHits = /* @__PURE__ */ new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  if (rateHits.size > 5e3) rateHits.clear();
  return true;
}
__name(rateOk, "rateOk");
var clientIp = /* @__PURE__ */ __name((request) => String(request.headers.get("CF-Connecting-IP") || "").slice(0, 60), "clientIp");
async function findDevice(env, account, deviceId) {
  if (!deviceId) return null;
  for (const id of account.devices || []) {
    const c = await getClient(env, id);
    if (c && c.deviceId === deviceId) return c;
  }
  return null;
}
__name(findDevice, "findDevice");
function failLogin(holder, now) {
  holder.fails = (holder.fails || 0) + 1;
  if (holder.fails >= MAX_ATTEMPTS) {
    holder.lockUntil = now + LOCKOUT_MS;
    holder.fails = 0;
  }
}
__name(failLogin, "failLogin");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.searchParams;
    const path = url.pathname;
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    try {
      await ensureDb(env);
      if (path === "/api/register" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const ip = clientIp(request);
        if (!rateOk("register:" + ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);
        const email = normalizeEmail(b.email);
        const accountName = normalizeName(b.accountName);
        if (!email) return json({ ok: false, error: "invalid_email" }, 400);
        if (!isEmail(email))
          return json({ ok: false, error: "invalid_email" }, 400);
        if (!accountName)
          return json({ ok: false, error: "account_name_required" }, 400);
        if (b.password && b.password.length < 8)
          return json({ ok: false, error: "password_too_short" }, 400);
        const deviceId = String(b.deviceId || "").slice(0, 80);
        const firstName = normalizeName(b.firstName || (b.displayName ? b.displayName.split(" ")[0] : ""));
        const lastName = normalizeName(b.lastName || (b.displayName ? b.displayName.split(" ").slice(1).join(" ") : ""));
        const phone = String(b.phone || "").trim().slice(0, 20);
        const info = {
          device: String(b.device || "Unknown").slice(0, 80),
          version: String(b.version || "").slice(0, 20),
          ua: String(b.ua || "").slice(0, 160),
          firstName,
          lastName,
          phone
        };
        let account = await getAccount(env, email);
        const isNewAccount = !account;
        if (account && account.name && normalizeName(account.name) !== accountName)
          return json({ ok: false, error: "account_name_mismatch" }, 409);
        if (!account) {
          account = {
            email,
            name: accountName,
            firstName,
            lastName,
            phone,
            passwordHash: b.password ? await hashPassword(b.password) : null,
            firebaseUid: b.firebaseUid || null,
            googleSignIn: !!b.googleSignIn,
            pin: newPin(),
            fails: 0,
            lockUntil: 0,
            createdAt: Date.now(),
            lastSeen: 0,
            devices: [],
            deviceLimit: MAX_DEVICES,
            deviceRequests: [],
            status: "approved",
            createdIp: ip,
            createdUa: info.ua
          };
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
            status
          });
        }
        const deviceLimit = Number(account.deviceLimit) || MAX_DEVICES;
        if (account.devices.length >= deviceLimit) return json(
          {
            ok: false,
            error: "device_limit",
            email,
            devices: account.devices.length,
            deviceLimit,
            status
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
          requests: []
        };
        await putClient(env, c);
        account.devices.push(c.id);
        account.lastSeen = Date.now();
        await putAccount(env, account);
        return json({
          ok: true,
          id: c.id,
          email,
          accountName,
          // Shown once on the device that creates the account. Later devices
          // share the same PIN, but aren't told it again — and a pending
          // account is never told it at all (clients poll /api/account-status).
          pin: isNewAccount ? account.pin : null,
          devices: account.devices.length,
          deviceLimit,
          newAccount: isNewAccount,
          status
        });
      }
      if (path === "/api/login" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const ip = clientIp(request);
        const bearer = request.headers.get("Authorization") || "";
        const bearerToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
        if (!rateOk("login:" + ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);
        const firebaseToken = b.firebaseToken || bearerToken;
        if (firebaseToken) {
          const claims = await verifyFirebaseToken(b.firebaseToken);
          if (!claims) return json({ ok: false, error: "invalid_token" }, 401);
          const email2 = normalizeEmail(claims.email || b.email);
          if (!email2 || !isEmail(email2))
            return json({ ok: false, error: "invalid_email" }, 400);
          const account2 = await getAccount(env, email2);
          if (!account2)
            return json({ ok: false, error: "not_found" }, 404);
          if (account2.firebaseUid && account2.firebaseUid !== claims.sub)
            return json({ ok: false, error: "invalid_token" }, 401);
          const deviceId2 = String(b.deviceId || "").slice(0, 80);
          let client2 = deviceId2 ? await findDevice(env, account2, deviceId2) : null;
          if (!client2) {
            const ua2 = String(b.ua || "").slice(0, 160);
            const device2 = String(b.device || "Unknown").slice(0, 80);
            const version2 = String(b.version || "").slice(0, 20);
            client2 = {
              id: crypto.randomUUID(),
              deviceId: deviceId2 || crypto.randomUUID(),
              email: email2,
              ip,
              device: device2,
              version: version2,
              ua: ua2,
              createdAt: Date.now(),
              lastSeen: Date.now(),
              requests: []
            };
            await putClient(env, client2);
            if (!account2.devices.includes(client2.id)) {
              account2.devices.push(client2.id);
              await putAccount(env, account2);
            }
          } else {
            Object.assign(client2, { ip, lastSeen: Date.now(), ua, device, version });
            await putClient(env, client2);
          }
          account2.lastSeen = Date.now();
          await putAccount(env, account2);
          return json({
            ok: true,
            id: client2.id,
            email: account2.email,
            accountName: account2.name,
            firstName: account2.firstName,
            lastName: account2.lastName,
            phone: account2.phone || ""
          });
        }
        const email = normalizeEmail(b.email);
        if (!email || !isEmail(email))
          return json({ ok: false, error: "invalid_email" }, 400);
        if (!b.password)
          return json({ ok: false, error: "missing_password" }, 400);
        const account = await getAccount(env, email);
        if (!account)
          return json({ ok: false, error: "not_found" }, 404);
        if (!account.passwordHash || !await verifyPassword(account.passwordHash, b.password))
          return json({ ok: false, error: "invalid_credentials" }, 401);
        const deviceId = String(b.deviceId || "").slice(0, 80);
        let client = deviceId ? await findDevice(env, account, deviceId) : null;
        if (!client) {
          const ua2 = String(b.ua || "").slice(0, 160);
          const device2 = String(b.device || "Unknown").slice(0, 80);
          const version2 = String(b.version || "").slice(0, 20);
          client = {
            id: crypto.randomUUID(),
            deviceId: deviceId || crypto.randomUUID(),
            email,
            ip,
            device: device2,
            version: version2,
            ua: ua2,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            requests: []
          };
          await putClient(env, client);
          if (!account.devices.includes(client.id)) {
            account.devices.push(client.id);
            await putAccount(env, account);
          }
        } else {
          Object.assign(client, { ip, lastSeen: Date.now(), ua, device, version });
          await putClient(env, client);
        }
        account.lastSeen = Date.now();
        await putAccount(env, account);
        return json({
          ok: true,
          id: client.id,
          email: account.email,
          accountName: account.name,
          firstName: account.firstName,
          lastName: account.lastName,
          phone: account.phone || ""
        });
      }
      if (path === "/api/reset-request" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const ip = clientIp(request);
        if (!rateOk("reset:" + ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);
        const email = normalizeEmail(b.email);
        if (!email || !isEmail(email))
          return json({ ok: false, error: "invalid_email" }, 400);
        const account = await getAccount(env, email);
        if (!account || !account.passwordHash)
          return json({ ok: true });
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 60 * 6e4;
        const resetRecord = {
          token,
          email,
          expiresAt,
          used: false,
          created: Date.now()
        };
        await putDoc(env, "password_resets", "token", token, resetRecord);
        return json({ ok: true, token });
      }
      if (path === "/api/reset-confirm" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const ip = clientIp(request);
        if (!rateOk("resetconfirm:" + ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS))
          return json({ ok: false, error: "rate_limited" }, 429);
        const token = String(b.token || "").trim();
        const newPassword = String(b.password || "").trim();
        if (!token)
          return json({ ok: false, error: "missing_token" }, 400);
        if (!newPassword || newPassword.length < 8)
          return json({ ok: false, error: "password_too_short" }, 400);
        const row = await getDoc(env, "SELECT data FROM password_resets WHERE token = ?", token);
        if (!row)
          return json({ ok: false, error: "invalid_token" }, 400);
        if (row.used || row.expiresAt < Date.now())
          return json({ ok: false, error: "token_expired" }, 400);
        const account = await getAccount(env, row.email);
        if (!account || !account.passwordHash)
          return json({ ok: false, error: "unknown_account" }, 404);
        account.passwordHash = await hashPassword(newPassword);
        account.fails = 0;
        account.lockUntil = 0;
        await putAccount(env, account);
        row.used = true;
        await putDoc(env, "password_resets", "token", token, row);
        return json({ ok: true });
      }
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
        return json({
          ok: true,
          status,
          email: c.email || null,
          pin: status === "approved" && account ? account.pin : null
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
        const ticket = Date.now() + Math.floor(Math.random() * 1e3);
        account.deviceRequests = [...requests.slice(-19), {
          ticket,
          deviceId,
          device: String(b.device || "Unknown").slice(0, 80),
          version: String(b.version || "").slice(0, 20),
          status: "pending",
          at: ticket
        }];
        await putAccount(env, account);
        return json({ ok: true, ticket });
      }
      if (path === "/api/verify" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const bearer = request.headers.get("Authorization") || "";
        const bearerToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
        const firebaseToken = b.firebaseToken || bearerToken;
        if (firebaseToken) {
          const claims = await verifyFirebaseToken(firebaseToken);
          if (!claims) return json({ ok: false, error: "invalid_token" }, 401);
          const email = normalizeEmail(claims.email || "");
          const account2 = email ? await getAccount(env, email) : null;
          if (!account2) return json({ ok: false, error: "unknown account" }, 404);
          if (accountStatus(account2) !== "approved")
            return json({ ok: false, error: "account_pending" }, 403);
          if (account2.firebaseUid && account2.firebaseUid !== claims.sub)
            return json({ ok: false, error: "invalid_token" }, 401);
          account2.fails = 0;
          account2.lockUntil = 0;
          account2.lastSeen = Date.now();
          await putAccount(env, account2);
          return json({ ok: true, email: account2.email });
        }
        const c = await getClient(env, String(b.id || ""));
        if (!c) return json({ ok: false, error: "unknown client" }, 404);
        const account = c.email ? await getAccount(env, c.email) : null;
        const holder = account || c;
        const now = Date.now();
        if (account && accountStatus(account) !== "approved")
          return json({ ok: false, error: "account_pending" }, 403);
        if (holder.lockUntil > now)
          return json({
            ok: false,
            locked: true,
            error: "locked",
            retry: Math.ceil((holder.lockUntil - now) / 1e3)
          });
        if (String(b.pin) !== holder.pin) {
          failLogin(holder, now);
          await (account ? putAccount(env, account) : putClient(env, c));
          return json({
            ok: false,
            error: "wrong pin",
            locked: holder.lockUntil > now,
            retry: holder.lockUntil > now ? Math.ceil((holder.lockUntil - now) / 1e3) : 0
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
          at: ticket
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
      if (path === "/") {
        return new Response(LANDING_PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if (path === "/privacy" || path === "/privacy/") {
        return new Response(legalPage("Privacy Policy", PRIVACY_BODY), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      if (path === "/terms" || path === "/terms/") {
        return new Response(legalPage("Terms of Service", TERMS_BODY), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }
};
var LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SafeSight \u2014 Image Content Filter</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
  :root {
    --bg: #0f172a;
    --card: #1e293b;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --primary: #6366f1;
    --primary-hover: #4f46e5;
    --border: rgba(255,255,255,.08);
    --shadow: 0 20px 60px rgba(0,0,0,.4);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 80px 24px 60px;
    background: radial-gradient(ellipse at 50% 0%, rgba(99,102,241,.15) 0%, transparent 70%);
  }
  .logo {
    width: 72px;
    height: 72px;
    border-radius: 20px;
    background: linear-gradient(135deg, var(--primary), #a855f7);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 24px;
    box-shadow: 0 8px 32px rgba(99,102,241,.3);
  }
  .logo i {
    font-size: 32px;
    color: white;
  }
  h1 {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    margin-bottom: 12px;
  }
  .tagline {
    font-size: 1.15rem;
    color: var(--muted);
    max-width: 520px;
    margin-bottom: 36px;
  }
  .cta-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-radius: 12px;
    font-size: 1rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s;
    cursor: pointer;
    border: none;
  }
  .btn-primary {
    background: var(--primary);
    color: white;
    box-shadow: 0 4px 16px rgba(99,102,241,.3);
  }
  .btn-primary:hover {
    background: var(--primary-hover);
    transform: translateY(-1px);
  }
  .btn-outline {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }
  .btn-outline:hover {
    background: rgba(255,255,255,.05);
  }
  .features {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 20px;
    max-width: 1000px;
    margin: 60px auto;
    padding: 0 24px;
  }
  .feature-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 24px;
    text-align: left;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .feature-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow);
  }
  .feature-icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: rgba(99,102,241,.15);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
  }
  .feature-icon i {
    font-size: 20px;
    color: var(--primary);
  }
  .feature-card h3 {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .feature-card p {
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }
  .footer {
    text-align: center;
    padding: 40px 24px;
    color: var(--muted);
    font-size: 0.85rem;
    border-top: 1px solid var(--border);
    margin-top: 40px;
  }
  .footer a {
    color: var(--primary);
    text-decoration: none;
  }
  .footer a:hover { text-decoration: underline; }
</style>
</head>
<body>

<section class="hero">
  <div class="logo">
    <i class="fas fa-shield-halved"></i>
  </div>
  <h1>SafeSight</h1>
  <p class="tagline">Protect your family from inappropriate images online. Real-time content filtering that works across all your devices.</p>
  <div class="cta-row">
    <a href="https://chromewebstore.google.com/detail/safesight/placeholder" class="btn btn-primary" target="_blank" rel="noopener">
      <i class="fab fa-chrome"></i> Add to Chrome
    </a>
    <a href="https://addons.mozilla.org/firefox/addon/safesight/" class="btn btn-outline" target="_blank" rel="noopener">
      <i class="fab fa-firefox"></i> Add for Firefox
    </a>
  </div>
</section>

<section class="features">
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-ban"></i>
    </div>
    <h3>Block Inappropriate Images</h3>
    <p>AI-powered image filtering detects and blocks NSFW content in real time as you browse.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-brain"></i>
    </div>
    <h3>On-Device AI</h3>
    <p>Powered by TensorFlow Lite. All processing happens locally \u2014 no images are uploaded or shared.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-sync-alt"></i>
    </div>
    <h3>Sync Across Devices</h3>
    <p>Sign in with your Google account to sync your settings and blocklists across all your devices.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-sliders"></i>
    </div>
    <h3>Customizable Controls</h3>
    <p>Adjust filter sensitivity, enable blur mode, and manage blocked sites from one simple dashboard.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-eye"></i>
    </div>
    <h3>Skin Filter</h3>
    <p>Detects and covers skin pixels that may indicate inappropriate content, giving you an extra layer of protection.</p>
  </div>
  <div class="feature-card">
    <div class="feature-icon">
      <i class="fas fa-lock"></i>
    </div>
    <h3>Privacy First</h3>
    <p>Your data stays on your device. No tracking, no profiling, no cloud storage of your browsing activity.</p>
  </div>
</section>

<footer class="footer">
  <p>SafeSight &copy; 2026. Built with <a href="https://www.tensorflow.org/lite" target="_blank" rel="noopener">TensorFlow Lite</a>.</p>
  <p style="margin-top:8px;"><a href="https://github.com/yourusername/safesight" target="_blank" rel="noopener"><i class="fab fa-github"></i> View on GitHub</a></p>
  <p style="margin-top:8px;"><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p>
</footer>

</body>
</html>`;
function legalPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} \u2014 SafeSight</title>
<style>
  :root {
    --bg: #0f172a;
    --card: #1e293b;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --primary: #6366f1;
    --border: rgba(255,255,255,.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.65;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .wrap {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 24px 24px;
    flex: 1;
  }
  .back {
    display: inline-block;
    margin-bottom: 28px;
    font-size: .92rem;
    color: var(--primary);
    text-decoration: none;
  }
  .back:hover { text-decoration: underline; }
  h1 {
    font-size: 2.2rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    margin-bottom: 6px;
  }
  .updated { color: var(--muted); font-size: .9rem; margin-bottom: 36px; }
  h2 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 30px 0 10px;
    color: var(--text);
  }
  p, li { color: #cbd5e1; font-size: .98rem; }
  p { margin-bottom: 12px; }
  ul { margin: 0 0 14px 22px; }
  li { margin-bottom: 7px; }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer {
    text-align: center;
    padding: 32px 24px 44px;
    color: var(--muted);
    font-size: .85rem;
    border-top: 1px solid var(--border);
    margin-top: 44px;
  }
  .footer a { color: var(--primary); }
</style>
</head>
<body>

<main class="wrap">
  <a class="back" href="/">&larr; Back to SafeSight</a>
  <h1>${title}</h1>
  <p class="updated">Effective October 9, 2026</p>
  ${body}
</main>

<footer class="footer">
  <p>SafeSight &copy; 2026 &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p>
</footer>

</body>
</html>`;
}
__name(legalPage, "legalPage");
var PRIVACY_BODY = `
<p>SafeSight is an on-device content safety tool: it scores images locally, blocks
unwanted sites and apps, and syncs only account metadata. This policy explains what
we store, what we never see, and the little bit of data that does leave your device.</p>

<h2>What never leaves your device</h2>
<ul>
  <li><strong>Image pixels.</strong> Every image is drawn to a 224x224 canvas and scored by
      the LiteRT model on your own device. There is no upload path for image bytes.</li>
  <li><strong>Scores and verdicts.</strong> The 0-to-10 score and your sensitivity threshold
      stay local.</li>
  <li><strong>Browsing activity.</strong> SafeSight does not build a history of the pages or
      images you view. On Android, the DNS firewall answers DNS queries and does not proxy
      or log web traffic.</li>
</ul>

<h2>Information we store</h2>
<ul>
  <li><strong>Account details:</strong> your email address, and your name and profile photo
      if you sign in with Google. Held by Firebase Authentication.</li>
  <li><strong>PIN:</strong> your settings PIN is stored only as a salted hash, verified
      server-side so protected settings cannot be turned off without it.</li>
  <li><strong>Device name and counters:</strong> images scanned and blocked, tracked per
      device so your stats sync across your account.</li>
  <li><strong>Invite records:</strong> invite codes and account status used during
      registration.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To authenticate you and keep your settings, blocklists and statistics in sync.</li>
  <li>To verify your PIN when a protected setting is changed.</li>
  <li>To operate and improve the service. We do not sell your data or use it for
      advertising or profiling.</li>
</ul>

<h2>Sign-in and third parties</h2>
<p>Google Sign-In is provided through Google Firebase, which receives your email address,
name and profile picture \u2014 the only scopes we request. The service itself runs on
Cloudflare (edge worker and database) and Firebase (authentication and account data).
These providers process data only on our instructions and to run the service.</p>

<h2>Retention and deletion</h2>
<p>Your account data is kept while your account exists. You can delete your account and
its Firestore profile document at any time from your account, after which it is removed
from our active databases. Server logs may be retained briefly for security and abuse
prevention before being rolled off automatically.</p>

<h2>Children</h2>
<p>SafeSight is built for family use. Children should use it under the supervision of a
parent or guardian, and should not create an account on their own if they are under the
age of digital consent in their region.</p>

<h2>Changes</h2>
<p>If this policy changes in a material way, the effective date at the top of this page
will be updated and continued use of the service means you accept the revised policy.</p>

<h2>Contact</h2>
<p>Questions about this policy? Open an issue at
<a href="https://github.com/yourusername/safesight" target="_blank" rel="noopener">github.com/yourusername/safesight</a>
or use the support contact listed in the extension store listing.</p>
`;
var TERMS_BODY = `
<p>These Terms of Service govern your use of SafeSight. By creating an account or using
the extensions, apps or website, you agree to them.</p>

<h2>1. The service</h2>
<p>SafeSight provides on-device image filtering, site and app blocking, a DNS-based
firewall on Android, and optional account sync of settings and statistics. New features
may be added, changed or removed over time.</p>

<h2>2. Accounts and security</h2>
<ul>
  <li>One account covers one device, with additional devices available as a paid add-on.</li>
  <li>You are responsible for keeping your sign-in credentials and PIN safe. Anyone who
      has your PIN can change protected settings.</li>
  <li>Provide accurate registration information and tell us promptly if you believe your
      account has been compromised.</li>
</ul>

<h2>3. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
  <li>Do not misuse the service, attempt to disrupt it, or access it by means other than
      the interfaces we provide.</li>
  <li>Do not use the service to violate any law or the rights of others.</li>
</ul>

<h2>4. Filtering is best-effort</h2>
<p>SafeSight scores content with an on-device model and blocks known unwanted sites. It is
a helper, not a guarantee: no filter is perfect, the extension is designed to fail open
when the model cannot run, and DNS-based blocking can be escaped by apps using their own
resolver or DNS-over-HTTPS. SafeSight does not replace supervision, device-level parental
controls, or your own judgement.</p>

<h2>5. Your content</h2>
<p>Your images are processed on your own device and are never uploaded to us. You keep all
rights to anything you view or store on your devices.</p>

<h2>6. Paid features</h2>
<p>Some features, such as additional devices, may be offered for a fee. Charges, if any,
are disclosed before you buy, and paid features are non-refundable except where required
by law.</p>

<h2>7. No warranty</h2>
<p>The service is provided "as is" and "as available", without warranties of any kind,
express or implied, including fitness for a particular purpose, accuracy, and
uninterrupted or error-free operation.</p>

<h2>8. Limitation of liability</h2>
<p>To the maximum extent permitted by law, SafeSight and its developers will not be liable
for indirect, incidental, special, consequential or punitive damages, or any loss of
data, profits or goodwill, arising from your use of the service. Our total liability for
any claim is limited to the amount you paid us in the twelve months before the claim
arose, or $50 if you have paid nothing.</p>

<h2>9. Termination</h2>
<p>You may stop using the service and delete your account at any time. We may suspend or
terminate accounts that violate these terms, abuse the service, or create risk for other
users. Sections that by their nature should survive termination will survive.</p>

<h2>10. Changes to these terms</h2>
<p>We may update these terms from time to time. The effective date at the top of this page
will change when we do; continued use of the service after that means you accept the
updated terms.</p>

<h2>11. Contact</h2>
<p>Questions about these terms? Open an issue at
<a href="https://github.com/yourusername/safesight" target="_blank" rel="noopener">github.com/yourusername/safesight</a>
or use the support contact listed in the extension store listing.</p>
`;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-Dib4Qk/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Dib4Qk/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
