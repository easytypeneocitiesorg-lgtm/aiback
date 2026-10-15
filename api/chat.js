// Tabspace AI backend for Vercel. Lives at /api/chat.
// Add OPENROUTER_API_KEY in Vercel: Project > Settings > Environment Variables.
// Optional: add ALLOWED_ORIGIN (your Wasmer site URL, no trailing slash) so only your site can use this.

const MODEL = "anthropic/claude-haiku-5.5";
const SYSTEM_PROMPT = "You are Tabspace AI, a helpful, concise assistant. Use markdown for formatting and code blocks for code.";
const MAX_TOKENS = 4096;
const RATE_LIMIT = 20, RATE_WINDOW = 60000;   // 20 messages per visitor per minute (best effort on serverless)

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  const hit = recent.length >= RATE_LIMIT;
  if (!hit) recent.push(now);
  hits.set(ip, recent);
  return hit;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const fail = (status, message) => res.status(status).json({ error: { message } });

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return fail(405, "Use POST.");

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return fail(500, "Server is missing the OPENROUTER_API_KEY environment variable.");

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (limited(ip)) return fail(429, "Too many requests. Wait a moment and try again.");

  let msgs;
  try {
    let body = req.body;                                   // text/plain arrives as a string
    if (Buffer.isBuffer(body)) body = body.toString("utf8");
    if (typeof body === "string") body = JSON.parse(body);
    msgs = body.messages.slice(-60)
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
    if (!msgs.length) throw new Error("no messages");
  } catch (e) {
    return fail(400, "Bad request: " + e.message);
  }

  let up;
  try {
    up = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "Tabspace AI" },
      body: JSON.stringify({
        model: MODEL,                                      // fixed here, visitors can't change it
        stream: true,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...msgs]
      })
    });
  } catch (e) {
    return fail(502, "Could not reach the AI provider.");
  }

  if (!up.ok) {
    let msg = "";
    try { msg = (await up.json()).error.message; } catch (e) {}
    return fail(up.status === 401 ? 502 : up.status, msg || "The AI provider returned an error.");
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const reader = up.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {}));  // visitor pressed stop / left
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (e) { /* stream ended early */ }
  res.end();
};
