// Shared helpers for all API routes. No npm packages needed: everything
// talks to Supabase, Stripe and Anthropic with plain fetch.
const crypto = require("crypto");

const PLANS = {
  free: { name: "Free trial", limit: 3, maxPosts: 7 },
  starter: { name: "Starter", limit: 30, maxPosts: 14 },
  pro: { name: "Pro", limit: 150, maxPosts: 30 },
};

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw httpError(500, `Server is missing the ${name} setting.`);
  }
  return v;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Wrap a handler so thrown errors become clean JSON responses.
function route(methods, fn) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) throw httpError(405, "Method not allowed");
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message || "Something went wrong" });
    }
  };
}

async function readRaw(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRaw(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpError(400, "Invalid JSON body"); }
}

/* ---------------- Supabase ---------------- */

async function sb(path, { method = "GET", body, prefer } = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw httpError(500, `Database error: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Check the user's login token with Supabase Auth.
async function getUser(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw httpError(401, "Please log in.");
  const r = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: env("SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw httpError(401, "Your session has expired. Please log in again.");
  const u = await r.json();
  return { id: u.id, email: u.email };
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

async function getProfile(user) {
  const rows = await sb(`profiles?id=eq.${user.id}&select=*`);
  if (rows && rows[0]) {
    const p = rows[0];
    if (p.usage_month !== monthKey()) {
      const upd = await sb(`profiles?id=eq.${user.id}`, {
        method: "PATCH", prefer: "return=representation",
        body: { usage_month: monthKey(), usage_count: 0 },
      });
      return upd[0];
    }
    return p;
  }
  const created = await sb("profiles", {
    method: "POST", prefer: "return=representation,resolution=merge-duplicates",
    body: { id: user.id, email: user.email, plan: "free", usage_month: monthKey(), usage_count: 0 },
  });
  return created[0];
}

function usageOf(profile) {
  const plan = PLANS[profile.plan] || PLANS.free;
  return { plan: profile.plan in PLANS ? profile.plan : "free", planName: plan.name, used: profile.usage_count || 0, limit: plan.limit, maxPosts: plan.maxPosts };
}

/* ---------------- Stripe ---------------- */

function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

async function stripe(path, params, method = "POST") {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? formEncode(params) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw httpError(502, `Payment error: ${data.error && data.error.message}`);
  return data;
}

// Stripe webhook signature check (same algorithm as the official library).
function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()])
  );
  const sigs = header.split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function planFromPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId && priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  return null;
}

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}`;
}

module.exports = {
  PLANS, env, httpError, send, route, readRaw, readJson, sb, getUser, getProfile, usageOf, monthKey,
  stripe, formEncode, verifyStripeSignature, planFromPrice, siteUrl,
};
