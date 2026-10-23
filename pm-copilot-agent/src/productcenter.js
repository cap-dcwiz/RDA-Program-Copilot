"use strict";
/* Identity comes from the AI-factory Product Center (https://ai-factory.demo.rda.ai), not from
   this agent. One account, one password, one place to revoke someone.

   We verify its JWT by *asking it* (`GET /api/me` with the token) instead of holding a copy of
   its signing secret. That costs one in-cluster HTTP hop per request — cut to almost nothing by
   the short cache below — and buys three things: no secret to copy or rotate in two places, a
   token disabled there stops working here within `cacheSeconds`, and Product Center can change
   its algorithm or claims without this file knowing.

   This module answers only "who is this?". What they may then do is this agent's own decision —
   see permissions.js and auth.js. */
const crypto = require("crypto");
const cfg = require("./config");

const err = (status, message) => Object.assign(new Error(message), { status });
const key = (token) => crypto.createHash("sha256").update(token).digest("hex");

/* token hash -> { at, user }. Keyed by hash so a live token is never held in memory in clear. */
const cache = new Map();

function cached(token) {
  const k = key(token);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < cfg.productCenter.cacheSeconds * 1000) return hit.user;
  if (hit) cache.delete(k);
  return null;
}

function remember(token, user) {
  if (cache.size > 500) cache.clear(); // bounded; everything re-verifies on the next request
  cache.set(key(token), { at: Date.now(), user });
}

/* Product Center's own shape: { username, display_name, email, roles, role_names, ... }.
   `role_names` is its id->label dictionary; keeping it means the Roles & Access page can list
   every Product Center role to map, instead of only the ones already mapped. */
const normalise = (u) => ({
  username: String(u.username || "").toLowerCase(),
  displayName: u.display_name || u.username || "",
  email: (u.email || "").toLowerCase() || null,
  pcRoles: Array.isArray(u.roles) ? u.roles : [],
  pcRoleNames: u.role_names && typeof u.role_names === "object" ? u.role_names : null,
});

async function call(path, init = {}) {
  const url = cfg.productCenter.url + path;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    // A Product Center that cannot be reached must not read as "wrong password" or "signed out",
    // or everyone spends the outage hunting for their own mistake.
    throw err(503, `Cannot reach the Product Center sign-in service at ${cfg.productCenter.url} (${e.message})`);
  }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  return { res, body, text };
}

/** Sign in with Product Center credentials. Returns its JWT plus the identity it carries. */
async function login(username, password) {
  if (!username || !password) throw err(400, "Username and password are required");
  const { res, body } = await call("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: String(username).trim(), password: String(password) }),
  });
  if (res.status === 401) throw err(401, "Wrong username or password");
  if (!res.ok) throw err(res.status === 429 ? 429 : 502, body.detail || `Product Center sign-in failed (HTTP ${res.status})`);
  const token = body.access_token;
  if (!token || !body.user) throw err(502, "Product Center returned no token");
  const user = normalise(body.user);
  remember(token, user);
  return { token, user };
}

/** Verify a bearer token. Returns the identity, or null if the token is not (or no longer) valid. */
async function verify(token) {
  if (!token) return null;
  const hit = cached(token);
  if (hit) return hit;
  const { res, body } = await call("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw err(502, body.detail || `Product Center rejected the token check (HTTP ${res.status})`);
  const user = normalise(body);
  remember(token, user);
  return user;
}

/** Drop a token from the cache so a sign-out takes effect here immediately. */
const forget = (token) => { if (token) cache.delete(key(token)); };

module.exports = { login, verify, forget, baseUrl: () => cfg.productCenter.url };
