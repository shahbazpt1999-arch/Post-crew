// Local test server: serves the site, runs the real /api handlers, and fakes
// Supabase, Stripe and Anthropic so the whole app can be tested offline.
// Usage: node tests/devserver.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.argv[2] || process.env.PORT || 4321);
const BASE = `http://localhost:${PORT}`;
Object.assign(process.env, {
  SUPABASE_URL: `${BASE}/fake-supabase`,
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ANTHROPIC_API_KEY: "sk-ant-test",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  SITE_URL: BASE,
});

/* ---------- in-memory fake state ---------- */
const db = { profiles: [], brands: [], generations: [] };
const users = {}; // email -> {id,email,password}
const tokens = {}; // token -> userId
const calls = { anthropic: [], stripe: [] };
global.__fake = { db, users, calls };
const PK = { profiles: "id", brands: "user_id", generations: "id" };

function applyFilters(rows, q) {
  for (const [k, v] of q.entries()) {
    if (["select", "order", "limit"].includes(k)) continue;
    if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
  }
  return rows;
}

function fakeRest(req, res, table, q, body) {
  const rows = db[table];
  if (!rows) return out(res, 404, { message: "no table" });
  if (req.method === "GET") {
    let r = applyFilters(rows, q);
    if (q.get("order")) { const [f, dir] = q.get("order").split("."); r = [...r].sort((a, b) => (a[f] > b[f] ? 1 : -1) * (dir === "desc" ? -1 : 1)); }
    if (q.get("limit")) r = r.slice(0, Number(q.get("limit")));
    return out(res, 200, r);
  }
  if (req.method === "POST") {
    const pk = PK[table];
    const row = { ...body };
    if (table === "generations") { row.id = crypto.randomUUID(); row.created_at = new Date().toISOString(); }
    const i = rows.findIndex((r) => r[pk] === row[pk]);
    if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
    return out(res, 201, [i >= 0 ? rows[i] : row]);
  }
  if (req.method === "PATCH") {
    const hit = applyFilters(rows, q);
    hit.forEach((r) => Object.assign(r, body));
    return out(res, 200, hit);
  }
  out(res, 405, {});
}

function issue(user) {
  const t = "tok_" + crypto.randomBytes(8).toString("hex");
  tokens[t] = user.id;
  return { access_token: t, refresh_token: "ref_" + t, expires_in: 3600, user: { id: user.id, email: user.email } };
}

function fakeAuth(req, res, sub, q, body) {
  if (sub === "signup") {
    if (users[body.email]) return out(res, 400, { msg: "User already registered" });
    const u = { id: crypto.randomUUID(), email: body.email, password: body.password };
    users[body.email] = u;
    return out(res, 200, issue(u));
  }
  if (sub === "token" && q.get("grant_type") === "password") {
    const u = users[body.email];
    if (!u || u.password !== body.password) return out(res, 400, { error_description: "Invalid login credentials" });
    return out(res, 200, issue(u));
  }
  if (sub === "token" && q.get("grant_type") === "refresh_token") {
    const old = String(body.refresh_token).replace(/^ref_/, "");
    const id = tokens[old];
    const u = Object.values(users).find((x) => x.id === id);
    return u ? out(res, 200, issue(u)) : out(res, 400, { error_description: "bad refresh" });
  }
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  if (sub === "user") {
    const id = tokens[tok];
    const u = Object.values(users).find((x) => x.id === id);
    if (!u) return out(res, 401, { msg: "invalid token" });
    if (req.method === "PUT" && body.password) u.password = body.password;
    return out(res, 200, { id: u.id, email: u.email });
  }
  if (sub === "logout") { delete tokens[tok]; return out(res, 204, null); }
  if (sub === "recover") return out(res, 200, {});
  out(res, 404, {});
}

/* ---------- fake external APIs via fetch override ---------- */
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://api.anthropic.com")) {
    const b = JSON.parse(opts.body);
    calls.anthropic.push(b);
    const n = Number((b.messages[0].content.match(/Number of posts: (\d+)/) || [])[1] || 3);
    const plats = (b.messages[0].content.match(/Platforms: (.*)/) || [])[1].split(", ");
    const posts = Array.from({ length: n }, (_, i) => ({
      day: i + 1, platform: plats[i % plats.length], format: i % 2 ? "Reel" : "Photo post",
      hook: `Hook number ${i + 1} <b>not html</b>`, caption: `Caption ${i + 1} for the brand.\nSecond line.`,
      hashtags: ["cascais", "#bakery"], visual: "Close-up of fresh pastries", best_time: "Fri 18:00",
    }));
    const text = "Here you go:\n```json\n" + JSON.stringify(posts) + "\n```";
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
  }
  if (url.startsWith("https://api.stripe.com")) {
    const p = url.replace("https://api.stripe.com/v1/", "");
    const params = Object.fromEntries(new URLSearchParams(opts.body || ""));
    calls.stripe.push({ path: p, params });
    if (p === "customers") return new Response(JSON.stringify({ id: "cus_" + crypto.randomBytes(4).toString("hex") }));
    if (p === "checkout/sessions") return new Response(JSON.stringify({ id: "cs_1", url: `${BASE}/app.html?checkout=success&fake_price=${params["line_items[0][price]"]}` }));
    if (p === "billing_portal/sessions") return new Response(JSON.stringify({ url: `${BASE}/app.html?portal=1` }));
    return new Response(JSON.stringify({ error: { message: "unknown" } }), { status: 400 });
  }
  return realFetch(url, opts);
};

/* ---------- http ---------- */
function out(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === null ? "" : JSON.stringify(body));
}
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname.startsWith("/fake-supabase/") || u.pathname.startsWith("/__")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
    if (u.pathname === "/__state") return out(res, 200, { db, calls });
    if (u.pathname === "/__setplan") { // simulate a Stripe webhook arriving
      const p = db.profiles.find((x) => x.email === body.email);
      const sub = { id: "sub_1", customer: p.stripe_customer_id, status: "active", metadata: { user_id: p.id }, items: { data: [{ price: { id: body.price } }] } };
      const payload = JSON.stringify({ type: "customer.subscription.created", data: { object: sub } });
      const t = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
      const r = await realFetch(`${BASE}/api/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: payload });
      return out(res, r.status, await r.json());
    }
    const rest = u.pathname.replace("/fake-supabase/", "");
    if (rest.startsWith("rest/v1/")) return fakeRest(req, res, rest.slice(8), u.searchParams, body);
    if (rest.startsWith("auth/v1/")) return fakeAuth(req, res, rest.slice(8), u.searchParams, body);
    return out(res, 404, {});
  }
  if (u.pathname.startsWith("/api/")) {
    const name = u.pathname.slice(5).replace(/[^a-z]/g, "");
    const file = path.join(__dirname, "..", "api", name + ".js");
    if (!fs.existsSync(file)) return out(res, 404, { error: "not found" });
    // Mimic Vercel: parse JSON bodies unless the route turns bodyParser off.
    const handler = require(file);
    if (!(handler.config && handler.config.api && handler.config.api.bodyParser === false) && req.method !== "GET") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
    }
    return handler(req, res);
  }
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(__dirname, "..", "public", path.normalize(p));
  if (!file.startsWith(path.join(__dirname, "..", "public")) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT, () => console.log("dev server on " + BASE));
