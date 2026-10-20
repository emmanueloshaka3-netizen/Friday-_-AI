const express = require("express");
const path = require("path");
const { FRIDAY_PROMPT } = require("./friday");

const app = express();
app.use(express.json({ limit: "12mb" })); // room for photos

// Serve only these files from the main folder (keeps server.js private)
const PUBLIC_FILES = ["manifest.json", "sw.js"];
// any app icon in the main folder, e.g. icon-192.png or icon-192-2.png
app.get(/^\/(icon[\w-]*\.png)$/, (req, res) => res.sendFile(path.join(__dirname, req.params[0])));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
PUBLIC_FILES.forEach((f) => {
  app.get("/" + f, (req, res) => res.sendFile(path.join(__dirname, f)));
});

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.MODEL || "openai/gpt-oss-120b";
// Groq's built-in web search system. Used only when a question needs live info.
const SEARCH_MODEL = process.env.SEARCH_MODEL || "groq/compound";
// Used only when the user sends a photo or screenshot.
const VISION_MODEL = process.env.VISION_MODEL || "qwen/qwen3.8-27b";

// Words that suggest the question needs fresh, real-world information
const LIVE = /\b(today|tonight|now|current|currently|latest|recent|recently|news|weather|rate|price|prices|score|scores|stock|stocks|trending|search|google|look up|who won|exchange|dollar|naira|bitcoin|crypto|update|updates|this week|this month|this year|2026)\b/i;

// Coding or building requests: give longer answers and never route them to web search
const CODE = /\b(code|script|function|html|css|javascript|python|node|json|bug|error|fix|file|files|website|project|api|app|repo|github|render|build|deploy|server|endpoint|database|component|stage)\b/i;

app.get("/health", (req, res) => {
  res.json({ status: "online", name: "Friday" });
});

async function callGroq(model, messages, maxTokens = 2048) {
  const body = { model, max_tokens: maxTokens, messages };
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
  const text = (data.choices[0].message.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) throw new Error("the model returned an empty answer");
  return text;
}

// Turn the app's messages into Groq messages: attach document text, and photos as image parts.
function buildMessages(messages) {
  let imageCount = 0;
  const out = messages.slice(-20).map((m) => {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    let text = String((m && m.content) || "").slice(0, 6000);
    if (role === "user" && m.doc && typeof m.doc.text === "string") {
      const name = String(m.doc.name || "document").slice(0, 80);
      text += `\n\n[Attached document: ${name}]\n${m.doc.text.slice(0, 12000)}`;
    }
    const imgs = role === "user" && Array.isArray(m.images)
      ? m.images.filter((u) => typeof u === "string" && u.startsWith("data:image/") && u.length < 6000000).slice(0, 3)
      : [];
    if (imgs.length) {
      imageCount += imgs.length;
      return {
        role,
        content: [{ type: "text", text }, ...imgs.map((u) => ({ type: "image_url", image_url: { url: u } }))],
      };
    }
    return { role, content: text };
  });
  return { out, imageCount };
}

function cleanMemory(m) {
  if (!Array.isArray(m)) return [];
  return m
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => x.trim().slice(0, 200))
    .slice(0, 60);
}

function cleanRecent(r) {
  if (!Array.isArray(r)) return [];
  return r
    .filter((c) => c && typeof c.user === "string")
    .slice(0, 5)
    .map((c) => ({
      title: String(c.title || "Chat").slice(0, 60),
      user: c.user.slice(0, 160),
      reply: String(c.reply || "").slice(0, 200),
    }));
}

// Text to speech with Groq Orpheus. Body: { text }. Returns WAV audio.
const TTS_MODEL = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
const TTS_VOICE = process.env.TTS_VOICE || "troy"; // male options: troy, daniel, austin
app.post("/speak", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY is missing" });
    const text = String(req.body.text || "").trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: "text required" });
    const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "wav" }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("Speak error:", r.status, t.slice(0, 300));
      return res.status(502).json({ error: "Voice failed: " + t.slice(0, 200) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "audio/wav");
    res.send(buf);
  } catch (err) {
    console.error("Speak error:", err.message);
    res.status(500).json({ error: "Voice error: " + err.message });
  }
});

// Body: { message: "latest user message", memory: ["fact", ...] }
// Returns the updated memory list.
app.post("/remember", async (req, res) => {
  const memory = cleanMemory(req.body.memory);
  try {
    const message = String(req.body.message || "").slice(0, 1500);
    if (!process.env.GROQ_API_KEY || message.trim().length < 8) {
      return res.json({ memory });
    }

    const numbered = memory.length
      ? memory.map((m, i) => `${i + 1}. ${m}`).join("\n")
      : "(nothing yet)";
    const prompt = [
      {
        role: "system",
        content:
          "You maintain a short memory list about a user. Read their latest message and decide what to change.\n" +
          "Add only durable facts about the user: name, nickname, where they live, work, projects, skills, interests, goals, and preferences about how the assistant should talk to them.\n" +
          "Never store passwords, API keys, card or bank numbers, ID numbers, or one-off requests and questions.\n" +
          "Write each fact as a short third-person sentence, like \"Name is Emmanuel\" or \"Builds games from his phone\".\n" +
          "If a new fact replaces an old one (moved city, changed project), put the old item's number in remove.\n" +
          "If the user asks you to forget something, remove it.\n" +
          'Reply with JSON only, exactly like {"add":["..."],"remove":[3]}. Use empty arrays when nothing changes.',
      },
      { role: "user", content: `Current memory:\n${numbered}\n\nLatest message from the user:\n${message}` },
    ];

    const raw = await callGroq(MODEL, prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    const out = match ? JSON.parse(match[0]) : {};
    const remove = new Set((Array.isArray(out.remove) ? out.remove : []).map((n) => Number(n) - 1));
    let next = memory.filter((_, i) => !remove.has(i));
    const have = new Set(next.map((m) => m.toLowerCase()));
    (Array.isArray(out.add) ? out.add : []).forEach((f) => {
      if (typeof f !== "string") return;
      const t = f.trim().slice(0, 200);
      if (t && !have.has(t.toLowerCase())) {
        next.push(t);
        have.add(t.toLowerCase());
      }
    });
    res.json({ memory: next.slice(-60) });
  } catch (err) {
    console.error("Remember error:", err.message);
    res.json({ memory });
  }
});

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

    const memory = cleanMemory(req.body.memory);
    const memoryBlock = memory.length
      ? "\n\nThings you know about the user (use them naturally, never list them back unless asked):\n" +
        memory.map((m) => "- " + m).join("\n")
      : "";
    const recent = cleanRecent(req.body.recent);
    const recentBlock = recent.length
      ? "\n\nEarlier conversations with the user, most recent first. Use them for continuity and mention them only when relevant:\n" +
        recent.map((c) => `- "${c.title}": user said "${c.user}"` + (c.reply ? `; you replied "${c.reply}"` : "")).join("\n")
      : "";
    const built = buildMessages(messages);
    const full = [{ role: "system", content: FRIDAY_PROMPT + memoryBlock + recentBlock }, ...built.out];
    const lastMsg = messages[messages.length - 1] || {};
    const last = String(lastMsg.content || "");
    const coding = CODE.test(last);
    const wantsSearch = LIVE.test(last) && !coding && !lastMsg.doc && built.imageCount === 0;
    const tokens = coding ? 4096 : 2048;

    if (built.imageCount > 0) {
      const reply = await callGroq(VISION_MODEL, full, 4096);
      return res.json({ reply, searched: false });
    }

    let reply;
    let searched = false;
    if (wantsSearch) {
      try {
        reply = await callGroq(SEARCH_MODEL, full, tokens);
        searched = true;
      } catch (e) {
        console.error("Search model failed, falling back:", e.message);
      }
    }
    if (!reply) reply = await callGroq(MODEL, full, tokens);

    res.json({ reply, searched });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Groq says: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Friday online on port ${PORT}`));
