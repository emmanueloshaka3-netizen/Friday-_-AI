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

// ---------- Photo Studio: turn "make it black and white and crop it square" into edit steps ----------
const RATIO_NAMES = ["1:1", "4:5", "5:4", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const FILTER_NAMES = ["bw", "sepia", "vintage", "warm", "cool", "vivid", "fade", "dramatic", "invert", "none"];
const COLOR_NAMES = { white: "#ffffff", black: "#000000", yellow: "#ffd400", red: "#ff3b30", orange: "#ff8a3d", blue: "#2f7bff", green: "#2ecc71", pink: "#ff5fa2", purple: "#9b59ff" };
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
const goodColor = (c, d) => {
  if (typeof c !== "string") return d;
  const t = c.trim().toLowerCase();
  if (COLOR_NAMES[t]) return COLOR_NAMES[t];
  return /^#[0-9a-f]{6}$/.test(t) ? t : d;
};

function sanitizePlan(obj) {
  const ops = [];
  const list = obj && Array.isArray(obj.ops) ? obj.ops.slice(0, 12) : [];
  for (const o of list) {
    if (!o || typeof o.op !== "string") continue;
    if (o.op === "rotate") {
      const d = ((Math.round(Number(o.degrees)) % 360) + 360) % 360;
      if ([90, 180, 270].includes(d)) ops.push({ op: "rotate", degrees: d });
    } else if (o.op === "flip") {
      ops.push({ op: "flip", axis: o.axis === "v" ? "v" : "h" });
    } else if (o.op === "crop") {
      if (RATIO_NAMES.includes(o.ratio)) ops.push({ op: "crop", ratio: o.ratio });
      else if ([o.x, o.y, o.w, o.h].every((n) => Number.isFinite(Number(n)))) {
        const x = clampNum(o.x, 0, 0.95), y = clampNum(o.y, 0, 0.95);
        const w = clampNum(o.w, 0.05, 1 - x), h = clampNum(o.h, 0.05, 1 - y);
        ops.push({ op: "crop", x, y, w, h });
      }
    } else if (o.op === "resize") {
      if (Number.isFinite(Number(o.maxSize))) ops.push({ op: "resize", maxSize: Math.round(clampNum(o.maxSize, 100, 4000)) });
    } else if (o.op === "adjust") {
      const a = { op: "adjust" };
      for (const k of ["brightness", "contrast", "saturation"]) if (Number.isFinite(Number(o[k]))) a[k] = clampNum(o[k], -100, 100);
      if (Number.isFinite(Number(o.hue))) a.hue = clampNum(o.hue, -180, 180);
      if (Number.isFinite(Number(o.blur))) a.blur = clampNum(o.blur, 0, 20);
      if (Object.keys(a).length > 1) ops.push(a);
    } else if (o.op === "filter") {
      if (FILTER_NAMES.includes(o.name)) ops.push({ op: "filter", name: o.name });
    } else if (o.op === "text") {
      const text = String(o.text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
      if (text) {
        ops.push({
          op: "text", text,
          position: ["top", "center", "bottom"].includes(o.position) ? o.position : "bottom",
          size: Number.isFinite(Number(o.size)) ? clampNum(o.size, 3, 20) : 8,
          color: goodColor(o.color, "#ffffff"),
          stroke: o.stroke !== false,
        });
      }
    } else if (o.op === "border") {
      ops.push({ op: "border", width: Number.isFinite(Number(o.width)) ? clampNum(o.width, 1, 12) : 4, color: goodColor(o.color, "#ffffff") });
    } else if (o.op === "round") {
      ops.push({ op: "round", radius: Number.isFinite(Number(o.radius)) ? clampNum(o.radius, 0, 50) : 50 });
    }
  }
  const note = typeof (obj && obj.note) === "string" ? obj.note.replace(/[\u0000-\u001f]/g, " ").slice(0, 140) : "";
  return { ops, note };
}

const EDIT_SYSTEM = [
  "You turn a photo-editing request into JSON edit steps. Reply with JSON only, no other text.",
  'Format: {"ops":[...],"note":"short plain summary of what you did"}',
  "Available ops, applied in order:",
  '- {"op":"rotate","degrees":90|180|270}',
  '- {"op":"flip","axis":"h"|"v"}  (h = mirror left-right)',
  '- {"op":"crop","ratio":"1:1"|"4:5"|"5:4"|"3:2"|"2:3"|"4:3"|"3:4"|"16:9"|"9:16"}  (centered crop)',
  '- {"op":"crop","x":0-1,"y":0-1,"w":0-1,"h":0-1}  (a region as fractions of the image)',
  '- {"op":"resize","maxSize":pixels for the longest side}',
  '- {"op":"adjust","brightness":-100..100,"contrast":-100..100,"saturation":-100..100,"hue":-180..180,"blur":0..20}  (include only what changes; positive = more)',
  '- {"op":"filter","name":"bw"|"sepia"|"vintage"|"warm"|"cool"|"vivid"|"fade"|"dramatic"|"invert"|"none"}',
  '- {"op":"text","text":"...","position":"top"|"center"|"bottom","size":3-20,"color":"white|black|yellow|red|orange|blue|green|pink|purple or #rrggbb","stroke":true}',
  '- {"op":"border","width":1-12,"color":"white"}',
  '- {"op":"round","radius":0-50}  (50 = circle, good for profile pictures)',
  "Guidance: 'enhance' or 'make it look better' means a small boost, like contrast 10, saturation 15, brightness 5. 'a bit' means about 10-15, 'a lot' means 40-60.",
  "Profile picture or avatar means crop 1:1 then round 50. Instagram post means crop 4:5. Story or wallpaper means crop 9:16. YouTube thumbnail means crop 16:9.",
  "If the request cannot be done with these ops (for example removing an object or changing the background), return an empty ops list and put a short honest explanation in note.",
].join("\n");

// Body: { instruction: "make it black and white and crop it square" }
app.post("/edit-plan", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY is missing on Render." });
    const instruction = String(req.body.instruction || "").trim().slice(0, 400);
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const raw = await callGroq(MODEL, [
      { role: "system", content: EDIT_SYSTEM },
      { role: "user", content: instruction },
    ], 1200);
    const match = raw.match(/\{[\s\S]*\}/);
    const plan = match ? sanitizePlan(JSON.parse(match[0])) : { ops: [], note: raw.replace(/[\u0000-\u001f]/g, " ").slice(0, 140) };
    res.json(plan);
  } catch (err) {
    console.error("Edit plan error:", err.message);
    res.status(500).json({ error: "Couldn't plan that edit: " + err.message });
  }
});

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
