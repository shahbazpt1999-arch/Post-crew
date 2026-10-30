// POST /api/generate — the social media agent.
// Takes the user's saved brand + a goal, asks Claude for a content plan,
// saves it, and counts it against the monthly plan limit.
const { route, send, readJson, getUser, getProfile, usageOf, sb, env, httpError } = require("../lib/shared");

const PLATFORMS = ["Instagram", "Facebook", "TikTok", "LinkedIn", "X", "Threads"];
const clean = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);

function buildPrompt(brand, req) {
  return `You are an expert social media manager. Create a ready-to-post content plan.

BRAND
- Name: ${brand.name}
- What they do: ${brand.description}
- Audience: ${brand.audience || "not specified"}
- Tone of voice: ${brand.tone || "friendly and professional"}

REQUEST
- Platforms: ${req.platforms.join(", ")}
- Number of posts: ${req.count}
- Goal: ${req.goal}
- Language for all post text: ${req.language}
${req.extra ? `- Extra instructions: ${req.extra}` : ""}

RULES
- Spread posts across the requested platforms and fit each platform's style and length.
- Mix formats (tips, behind the scenes, offers, questions, stories, carousels, short videos).
- Captions must be complete and ready to copy, with emojis only where natural.
- Never invent prices, discounts, awards, statistics or customer quotes the brand did not give.
- Number days from 1 and spread them over about ${Math.max(req.count, 7)} days.

Reply with ONLY a JSON array, no other text. Each item:
{"day": number, "platform": string, "format": string, "hook": string, "caption": string, "hashtags": [string], "visual": string, "best_time": string}
"visual" is a short description of the photo or video to make. "best_time" is like "Tue 18:00".`;
}

function parsePosts(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw httpError(502, "The AI reply could not be read. Please try again.");
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { throw httpError(502, "The AI reply could not be read. Please try again."); }
  if (!Array.isArray(arr) || !arr.length) throw httpError(502, "The AI returned no posts. Please try again.");
  return arr.slice(0, 30).map((p, i) => ({
    day: Number(p.day) || i + 1,
    platform: clean(p.platform, 30),
    format: clean(p.format, 40),
    hook: clean(p.hook, 200),
    caption: String(p.caption || "").trim().slice(0, 3000),
    hashtags: (Array.isArray(p.hashtags) ? p.hashtags : []).map((h) => clean(h, 40).replace(/^#?/, "#")).filter((h) => h.length > 1).slice(0, 15),
    visual: clean(p.visual, 300),
    best_time: clean(p.best_time, 30),
  }));
}

async function callGemini(prompt) {
  const model = env("GEMINI_MODEL", "gemini-flash-latest");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8000 },
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Gemini error", data);
    throw httpError(502, "The AI service is busy. Please try again in a minute.");
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || "").join("");
}

// Demo mode: no AI key set yet. Builds sample posts so the rest of the app can be tested.
const DEMO_FORMATS = ["Photo post", "Reel / short video", "Carousel", "Story", "Question post", "Behind the scenes", "Offer post"];
const DEMO_TIMES = ["Mon 12:30", "Tue 18:00", "Wed 19:30", "Thu 13:00", "Fri 18:30", "Sat 11:00", "Sun 17:00"];
function demoPosts(brand, req) {
  return Array.from({ length: req.count }, (_, i) => {
    const platform = req.platforms[i % req.platforms.length];
    const format = DEMO_FORMATS[i % DEMO_FORMATS.length];
    return {
      day: i + 1, platform, format,
      hook: `[DEMO] ${brand.name}: idea ${i + 1} for "${req.goal}"`,
      caption: `[DEMO POST — add an AI key to get real captions]\n\nThis is where your agent writes a complete ${format.toLowerCase()} caption for ${platform}, in ${req.language}, in a ${brand.tone || "friendly"} tone, about: ${brand.description}`,
      hashtags: ["#" + brand.name.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase(), "#demo"],
      visual: `Demo visual idea for a ${format.toLowerCase()}`,
      best_time: DEMO_TIMES[i % DEMO_TIMES.length],
    };
  });
}

function aiProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "demo";
}

async function callClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env("ANTHROPIC_MODEL", "claude-haiku-5-5"),
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Anthropic error", data);
    throw httpError(502, "The AI service is busy. Please try again in a minute.");
  }
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

module.exports = route(["POST"], async (req, res) => {
  const user = await getUser(req);
  const profile = await getProfile(user);
  const usage = usageOf(profile);
  if (usage.used >= usage.limit) {
    throw httpError(402, usage.plan === "free"
      ? "You've used your free plans. Upgrade to keep creating content."
      : "You've reached this month's limit. Upgrade or wait until next month.");
  }

  const brands = await sb(`brands?user_id=eq.${user.id}&select=*`);
  const brand = brands && brands[0];
  if (!brand || !brand.name || !brand.description) throw httpError(400, "Please fill in your brand profile first.");

  const body = await readJson(req);
  const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter((p) => PLATFORMS.includes(p));
  const request = {
    platforms: platforms.length ? platforms : ["Instagram"],
    count: Math.min(Math.max(parseInt(body.count, 10) || 7, 1), usage.maxPosts),
    goal: clean(body.goal, 300) || "Grow engagement and followers",
    language: clean(body.language, 30) || "English",
    extra: clean(body.extra, 500),
  };

  const provider = aiProvider();
  let posts;
  if (provider === "demo") posts = demoPosts(brand, request);
  else {
    const prompt = buildPrompt(brand, request);
    const text = provider === "claude" ? await callClaude(prompt) : await callGemini(prompt);
    posts = parsePosts(text).sort((a, b) => a.day - b.day);
  }
  request.ai = provider;

  const saved = await sb("generations", {
    method: "POST", prefer: "return=representation",
    body: { user_id: user.id, input: request, posts },
  });
  const upd = await sb(`profiles?id=eq.${user.id}`, {
    method: "PATCH", prefer: "return=representation",
    body: { usage_count: usage.used + 1 },
  });

  send(res, 200, { generation: saved[0], usage: usageOf(upd[0]) });
});

module.exports.buildPrompt = buildPrompt;
module.exports.parsePosts = parsePosts;
