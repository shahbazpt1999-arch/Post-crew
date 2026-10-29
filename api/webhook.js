// POST /api/webhook — Stripe tells us when a subscription starts, changes or ends.
const { send, readRaw, sb, env, verifyStripeSignature, planFromPrice } = require("../lib/shared");

async function setFromSubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const plan = planFromPrice(item && item.price && item.price.id);
  const active = ["active", "trialing", "past_due"].includes(sub.status);
  const body = {
    plan: active && plan ? plan : "free",
    subscription_status: sub.status,
    stripe_subscription_id: sub.status === "canceled" ? null : sub.id,
    stripe_customer_id: sub.customer,
  };
  const userId = sub.metadata && sub.metadata.user_id;
  const filter = userId ? `id=eq.${userId}` : `stripe_customer_id=eq.${sub.customer}`;
  await sb(`profiles?${filter}`, { method: "PATCH", body });
}

async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  try {
    const raw = await readRaw(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], env("STRIPE_WEBHOOK_SECRET"))) {
      return send(res, 400, { error: "Bad signature" });
    }
    const event = JSON.parse(raw);
    const obj = event.data && event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
        if (obj.client_reference_id && obj.customer) {
          await sb(`profiles?id=eq.${obj.client_reference_id}`, { method: "PATCH", body: { stripe_customer_id: obj.customer } });
        }
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await setFromSubscription(obj);
        break;
    }
    send(res, 200, { received: true });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Webhook failed" });
  }
}

module.exports = handler;
// Stripe needs the exact raw body to check the signature.
module.exports.config = { api: { bodyParser: false } };
