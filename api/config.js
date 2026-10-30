// GET /api/config — public settings the browser needs (safe to expose).
const { route, send, env, PLANS } = require("../lib/shared");

module.exports = route(["GET"], async (req, res) => {
  send(res, 200, {
    supabaseUrl: env("SUPABASE_URL"),
    supabaseAnonKey: env("SUPABASE_ANON_KEY"),
    plans: PLANS,
    aiMode: process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GEMINI_API_KEY ? "gemini" : "demo",
  });
});
