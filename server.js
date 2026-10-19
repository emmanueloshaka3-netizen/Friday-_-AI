const express = require("express");
const path = require("path");
const { FRIDAY_PROMPT } = require("./friday");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Serve only these files from the main folder (keeps server.js private)
const PUBLIC_FILES = ["manifest.json", "sw.js", "icon-192.png", "icon-512.png"];
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
PUBLIC_FILES.forEach((f) => {
  app.get("/" + f, (req, res) => res.sendFile(path.join(__dirname, f)));
});

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.MODEL || "openai/gpt-oss-120b";
// Groq's built-in web search system. Used only when a question needs live info.
const SEARCH_MODEL = process.env.SEARCH_MODEL || "groq/compound";

// Words that suggest the question needs fresh, real-world information
const LIVE = /\b(today|tonight|now|current|currently|latest|recent|recently|news|weather|rate|price|prices|score|scores|stock|stocks|trending|search|google|look up|who won|exchange|dollar|naira|bitcoin|crypto|update|updates|this week|this month|this year|2026)\b/i;

app.get("/health", (req, res) => {
  res.json({ status: "online", name: "Friday" });
});

async function callGroq(model, messages) {
  const body = { model, max_tokens: 2048, messages };
  if (model.includes("gpt-oss")) body.reasoning_effort = "low";
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const why = (data && data.error && data.error.message) || "status " + r.status;
    throw new Error(why);
  }
  return data.choices[0].message.content;
}

// Body: { messages: [{ role: "user" | "assistant", content: "text" }, ...] }
app.post("/chat", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY is missing on Render. Add it under Environment." });
    }
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const full = [{ role: "system", content: FRIDAY_PROMPT }, ...messages];
    const last = messages[messages.length - 1].content || "";
    const wantsSearch = LIVE.test(last);

    let reply;
    let searched = false;
    if (wantsSearch) {
      try {
        reply = await callGroq(SEARCH_MODEL, full);
        searched = true;
      } catch (e) {
        console.error("Search model failed, falling back:", e.message);
      }
    }
    if (!reply) reply = await callGroq(MODEL, full);

    res.json({ reply, searched });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Groq says: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Friday online on port ${PORT}`));
