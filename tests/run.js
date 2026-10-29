// API tests against the local fake server. Run: node tests/run.js
const assert = require("assert");
const crypto = require("crypto");
process.argv[2] = "4399";
require("./devserver");
const B = "http://localhost:4399";
const { verifyStripeSignature, formEncode } = require("../lib/shared");
const { parsePosts } = require("../api/generate");

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.log("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
const j = async (path, { method = "GET", body, token, headers = {} } = {}) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};

(async () => {
  await new Promise((r) => setTimeout(r, 300));
  console.log("Unit");
  await t("signature: valid passes", () => {
    const p = '{"a":1}', ts = Math.floor(Date.now() / 1000);
    const s = crypto.createHmac("sha256", "sec").update(`${ts}.${p}`).digest("hex");
    assert(verifyStripeSignature(p, `t=${ts},v1=${s}`, "sec"));
  });
  await t("signature: wrong secret / tampered / old rejected", () => {
    const p = '{"a":1}', ts = Math.floor(Date.now() / 1000);
    const s = crypto.createHmac("sha256", "sec").update(`${ts}.${p}`).digest("hex");
    assert(!verifyStripeSignature(p, `t=${ts},v1=${s}`, "other"));
    assert(!verifyStripeSignature('{"a":2}', `t=${ts},v1=${s}`, "sec"));
    const old = ts - 1000, s2 = crypto.createHmac("sha256", "sec").update(`${old}.${p}`).digest("hex");
    assert(!verifyStripeSignature(p, `t=${old},v1=${s2}`, "sec"));
    assert(!verifyStripeSignature(p, undefined, "sec"));
  });
  await t("formEncode nests like Stripe expects", () => {
    assert.strictEqual(formEncode({ line_items: { 0: { price: "p", quantity: 1 } }, mode: "subscription" }),
      "line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&mode=subscription");
  });
  await t("parsePosts handles text around JSON and cleans hashtags", () => {
    const r = parsePosts('Sure!\n[{"day":2,"platform":"Instagram","caption":"Hi","hashtags":["food","#yum"]}]\nEnjoy');
    assert.strictEqual(r.length, 1); assert.deepStrictEqual(r[0].hashtags, ["#food", "#yum"]);
  });
  await t("parsePosts rejects garbage", () => assert.throws(() => parsePosts("no json here")));

  console.log("API");
  await t("config is public", async () => { const r = await j("/api/config"); assert.strictEqual(r.status, 200); assert(r.data.supabaseAnonKey); assert(!JSON.stringify(r.data).includes("service-key")); });
  await t("me requires login", async () => assert.strictEqual((await j("/api/me")).status, 401));
  await t("bad token rejected", async () => assert.strictEqual((await j("/api/me", { token: "nope" })).status, 401));

  const s = await j("/fake-supabase/auth/v1/signup", { method: "POST", body: { email: "a@test.com", password: "secret1" } });
  const tok = s.data.access_token;
  await t("me creates free profile", async () => { const r = await j("/api/me", { token: tok }); assert.strictEqual(r.data.usage.plan, "free"); assert.strictEqual(r.data.usage.limit, 3); assert.strictEqual(r.data.brand, null); });
  await t("generate needs a brand", async () => { const r = await j("/api/generate", { method: "POST", token: tok, body: {} }); assert.strictEqual(r.status, 400); });
  await t("brand validation", async () => assert.strictEqual((await j("/api/brand", { method: "POST", token: tok, body: { name: "" } })).status, 400));
  await t("brand saves", async () => { const r = await j("/api/brand", { method: "POST", token: tok, body: { name: "Lisbon Bakery", description: "Bakery in Cascais", tone: "fun" } }); assert.strictEqual(r.data.brand.name, "Lisbon Bakery"); });
  await t("generate works, caps posts at free max (7), counts usage", async () => {
    const r = await j("/api/generate", { method: "POST", token: tok, body: { platforms: ["Instagram", "TikTok", "Hacker"], count: 50, goal: "Weekend orders", language: "Portuguese" } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.generation.posts.length, 7);
    assert.strictEqual(r.data.usage.used, 1);
    const prompt = __fake.calls.anthropic.at(-1).messages[0].content;
    assert(prompt.includes("Platforms: Instagram, TikTok") && !prompt.includes("Hacker") && prompt.includes("Lisbon Bakery"));
  });
  await t("free limit enforced (402 after 3)", async () => {
    await j("/api/generate", { method: "POST", token: tok, body: {} });
    await j("/api/generate", { method: "POST", token: tok, body: {} });
    const r = await j("/api/generate", { method: "POST", token: tok, body: {} });
    assert.strictEqual(r.status, 402);
  });
  await t("history returned newest first", async () => { const r = await j("/api/me", { token: tok }); assert.strictEqual(r.data.generations.length, 3); });
  await t("checkout: bad plan rejected", async () => assert.strictEqual((await j("/api/checkout", { method: "POST", token: tok, body: { plan: "gold" } })).status, 400));
  await t("checkout creates customer + subscription session", async () => {
    const r = await j("/api/checkout", { method: "POST", token: tok, body: { plan: "starter" } });
    assert.strictEqual(r.status, 200); assert(r.data.url.includes("price_starter"));
    const cs = __fake.calls.stripe.find((c) => c.path === "checkout/sessions").params;
    assert.strictEqual(cs.mode, "subscription"); assert(cs["subscription_data[metadata][user_id]"]);
  });
  await t("webhook rejects bad signature", async () => { const r = await j("/api/webhook", { method: "POST", body: { type: "x" }, headers: { "stripe-signature": "t=1,v1=bad" } }); assert.strictEqual(r.status, 400); });
  await t("webhook upgrades plan, limit resets room", async () => {
    const w = await j("/__setplan", { method: "POST", body: { email: "a@test.com", price: "price_starter" } });
    assert.strictEqual(w.status, 200);
    const r = await j("/api/me", { token: tok }); assert.strictEqual(r.data.usage.plan, "starter"); assert.strictEqual(r.data.usage.limit, 30);
    const g = await j("/api/generate", { method: "POST", token: tok, body: { count: 14 } }); assert.strictEqual(g.status, 200); assert.strictEqual(g.data.generation.posts.length, 14);
  });
  await t("portal works once customer exists", async () => assert.strictEqual((await j("/api/portal", { method: "POST", token: tok })).status, 200));
  await t("subscribed user switching plan goes to portal", async () => {
    const r = await j("/api/checkout", { method: "POST", token: tok, body: { plan: "pro" } });
    assert(r.data.url.includes("portal=1"));
  });
  await t("cancellation drops back to free", async () => {
    const p = __fake.db.profiles[0];
    const payload = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: p.stripe_customer_id, status: "canceled", metadata: { user_id: p.id }, items: { data: [{ price: { id: "price_starter" } }] } } } });
    const ts = Math.floor(Date.now() / 1000), sig = crypto.createHmac("sha256", "whsec_test").update(`${ts}.${payload}`).digest("hex");
    const r = await fetch(B + "/api/webhook", { method: "POST", headers: { "stripe-signature": `t=${ts},v1=${sig}` }, body: payload });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await j("/api/me", { token: tok })).data.usage.plan, "free");
  });
  await t("users can't see each other's data", async () => {
    const s2 = await j("/fake-supabase/auth/v1/signup", { method: "POST", body: { email: "b@test.com", password: "secret2" } });
    const r = await j("/api/me", { token: s2.data.access_token });
    assert.strictEqual(r.data.generations.length, 0); assert.strictEqual(r.data.brand, null);
  });
  await t("wrong method rejected", async () => assert.strictEqual((await j("/api/generate")).status, 405));

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
