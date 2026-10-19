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

app.get("/health", (req, res) => {
  res.json({ status: "online", name: "Friday" });
});

// Body: { messages: [{ role: "user" | "assistant", content: "text" }, ...] }
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        ...(MODEL.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "system", content: FRIDAY_PROMPT }, ...messages],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Groq error:", JSON.stringify(data));
      return res.status(500).json({ error: "Friday hit a snag. Check server logs." });
    }

    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Friday hit a snag. Check server logs." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Friday online on port ${PORT}`));
