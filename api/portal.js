// POST /api/portal — open Stripe's billing portal (change plan, card, cancel, invoices).
const { route, send, getUser, getProfile, stripe, httpError, siteUrl } = require("../lib/shared");

module.exports = route(["POST"], async (req, res) => {
  const user = await getUser(req);
  const profile = await getProfile(user);
  if (!profile.stripe_customer_id) throw httpError(400, "You don't have a subscription yet.");
  const s = await stripe("billing_portal/sessions", {
    customer: profile.stripe_customer_id,
    return_url: `${siteUrl(req)}/app.html`,
  });
  send(res, 200, { url: s.url });
});
