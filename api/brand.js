// POST /api/brand — save the user's brand profile.
const { route, send, readJson, getUser, getProfile, sb, httpError } = require("../lib/shared");

const clean = (v, max) => String(v || "").trim().slice(0, max);

module.exports = route(["POST"], async (req, res) => {
  const user = await getUser(req);
  await getProfile(user); // makes sure the profile row exists
  const b = await readJson(req);
  const brand = {
    user_id: user.id,
    name: clean(b.name, 80),
    description: clean(b.description, 1000),
    audience: clean(b.audience, 300),
    tone: clean(b.tone, 100),
    updated_at: new Date().toISOString(),
  };
  if (!brand.name || !brand.description) throw httpError(400, "Brand name and description are required.");
  const rows = await sb("brands", {
    method: "POST", prefer: "return=representation,resolution=merge-duplicates", body: brand,
  });
  send(res, 200, { brand: rows[0] });
});
