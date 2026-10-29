// POST /api/checkout — start a Stripe subscription checkout for a plan.
const { route, send, readJson, getUser, getProfile, sb, stripe, env, httpError, siteUrl } = require("../lib/shared");

module.exports = route(["POST"], async (req, res) => {
  const user = await getUser(req);
  const profile = await getProfile(user);
  const { plan } = await readJson(req);
  const price = plan === "pro" ? env("STRIPE_PRICE_PRO") : plan === "starter" ? env("STRIPE_PRICE_STARTER") : null;
  if (!price) throw httpError(400, "Unknown plan.");
  if (profile.plan === plan && ["active", "trialing"].includes(profile.subscription_status)) {
    throw httpError(400, "You're already on this plan. Use Manage billing to make changes.");
  }

  let customer = profile.stripe_customer_id;
  if (!customer) {
    const c = await stripe("customers", { email: user.email, metadata: { user_id: user.id } });
    customer = c.id;
    await sb(`profiles?id=eq.${user.id}`, { method: "PATCH", body: { stripe_customer_id: customer } });
  }

  // Already subscribed to another plan: send them to the billing portal to switch.
  if (profile.stripe_subscription_id && ["active", "trialing", "past_due"].includes(profile.subscription_status)) {
    const portal = await stripe("billing_portal/sessions", { customer, return_url: `${siteUrl(req)}/app.html` });
    return send(res, 200, { url: portal.url });
  }

  const base = siteUrl(req);
  const session = await stripe("checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: { 0: { price, quantity: 1 } },
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: "true",
    success_url: `${base}/app.html?checkout=success`,
    cancel_url: `${base}/app.html?checkout=cancelled`,
  });
  send(res, 200, { url: session.url });
});
