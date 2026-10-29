// GET /api/me — the logged-in user's plan, usage, brand and recent content.
const { route, send, getUser, getProfile, usageOf, sb } = require("../lib/shared");

module.exports = route(["GET"], async (req, res) => {
  const user = await getUser(req);
  const profile = await getProfile(user);
  const [brands, generations] = await Promise.all([
    sb(`brands?user_id=eq.${user.id}&select=*`),
    sb(`generations?user_id=eq.${user.id}&select=id,input,posts,created_at&order=created_at.desc&limit=20`),
  ]);
  send(res, 200, {
    email: user.email,
    usage: usageOf(profile),
    hasBilling: Boolean(profile.stripe_customer_id),
    subscriptionStatus: profile.subscription_status || null,
    brand: (brands && brands[0]) || null,
    generations: generations || [],
  });
});
