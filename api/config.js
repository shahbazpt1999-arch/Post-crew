// GET /api/config — public settings the browser needs (safe to expose).
const { route, send, env, PLANS } = require("../lib/shared");

module.exports = route(["GET"], async (req, res) => {
  send(res, 200, {
    supabaseUrl: env("SUPABASE_URL"),
    supabaseAnonKey: env("SUPABASE_ANON_KEY"),
    plans: PLANS,
  });
});
