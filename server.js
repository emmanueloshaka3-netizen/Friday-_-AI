const express = require("express");
const path = require("path");
const { FRIDAY_PROMPT } = require("./friday");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.MODEL || "llama-3.3-70b-versatile";

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
        max_tokens: 1024,
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
