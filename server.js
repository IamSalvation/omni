require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const APP_NAME = process.env.APP_NAME || "Omni";

// ============================================================
// KEYS
// ============================================================
const DEEPSEEK_KEY = (process.env.DEEPSEEK_API_KEY || "").trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^GEMINI_API_KEY=/, "");

console.log(`[ENV] DeepSeek key: ${DEEPSEEK_KEY ? "present (" + DEEPSEEK_KEY.length + " chars)" : "MISSING"}`);
console.log(`[ENV] Gemini key: ${GEMINI_KEY ? "present (" + GEMINI_KEY.length + " chars)" : "MISSING"}`);

// ============================================================
// RATE LIMITER (in-memory)
// ============================================================
const RATE_LIMITS = {
    perIpPerHour: 20,
    perIpPerMinute: 4,
    globalPerDay: 300
};

const ipUsage = new Map();
let globalCount = 0;
let globalResetAt = Date.now() + 24 * 60 * 60 * 1000;

function getClientIp(req) {
    return (req.headers["x-forwarded-for"]?.split(",")[0].trim())
        || req.socket.remoteAddress
        || "unknown";
}

function checkRateLimit(ip) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneMinuteAgo = now - 60 * 1000;

    // Reset global counter after 24h
    if (now >= globalResetAt) {
        globalCount = 0;
        globalResetAt = now + 24 * 60 * 60 * 1000;
        console.log("[RATE] Global daily counter reset");
    }

    // Global cap
    if (globalCount >= RATE_LIMITS.globalPerDay) {
        return { ok: false, reason: "Daily server limit reached. Please try again tomorrow." };
    }

    // Per-IP tracking
    let usage = ipUsage.get(ip) || { timestamps: [] };
    usage.timestamps = usage.timestamps.filter(t => t > oneHourAgo);

    const lastMinute = usage.timestamps.filter(t => t > oneMinuteAgo);
    if (lastMinute.length >= RATE_LIMITS.perIpPerMinute) {
        ipUsage.set(ip, usage);
        return { ok: false, reason: "Slow down — too many messages per minute." };
    }

    if (usage.timestamps.length >= RATE_LIMITS.perIpPerHour) {
        ipUsage.set(ip, usage);
        return { ok: false, reason: "Hourly limit reached. Please wait a bit and try again." };
    }

    // Allow
    usage.timestamps.push(now);
    ipUsage.set(ip, usage);
    globalCount++;

    return { ok: true };
}

// Periodic cleanup — remove stale IP entries every 30 min
setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [ip, usage] of ipUsage.entries()) {
        usage.timestamps = usage.timestamps.filter(t => t > cutoff);
        if (usage.timestamps.length === 0) ipUsage.delete(ip);
    }
}, 30 * 60 * 1000);

// ============================================================
// DEEPSEEK (primary — OpenAI-compatible)
// ============================================================
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODELS = ["deepseek-flash"];

async function tryDeepSeek(model, messages, res, timeoutMs = 30000) {
    console.log(`[DEEPSEEK] Starting ${model}`);

    const upstream = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${DEEPSEEK_KEY}`
        },
        body: JSON.stringify({
            model,
            messages,
            stream: true
        }),
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (!upstream.ok) {
        const text = await upstream.text();
        let msg = `HTTP ${upstream.status}`;
        try {
            const j = JSON.parse(text);
            msg = j.error?.message || msg;
        } catch { }
        const err = new Error(msg);
        err.status = upstream.status;
        throw err;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentAny = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const json = trimmed.slice(5).trim();
            if (!json || json === "[DONE]") continue;

            try {
                const parsed = JSON.parse(json);
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                    sentAny = true;
                    res.write(text);
                }
            } catch { }
        }
    }

    return sentAny;
}

// ============================================================
// GEMINI (fallback)
// ============================================================
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite"
];

async function tryGemini(model, contents, res, timeoutMs = 20000) {
    console.log(`[GEMINI] Starting ${model}`);

    const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`;

    const upstream = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_KEY
        },
        body: JSON.stringify({ contents }),
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (!upstream.ok) {
        const text = await upstream.text();
        let msg = `HTTP ${upstream.status}`;
        try {
            const j = JSON.parse(text);
            msg = j.error?.message || msg;
        } catch { }
        const err = new Error(msg.split("\n")[0].replace(/^\[\d+\]\s*/, ""));
        err.status = upstream.status;
        throw err;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentAny = false;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const json = trimmed.slice(5).trim();
            if (!json || json === "[DONE]") continue;

            try {
                const parsed = JSON.parse(json);
                const text =
                    parsed.candidates?.[0]?.content?.parts
                        ?.map(p => p.text || "")
                        .join("") || "";
                if (text) {
                    sentAny = true;
                    res.write(text);
                }
            } catch { }
        }
    }

    return sentAny;
}

// ============================================================
// MESSAGE CONVERTERS
// ============================================================
function toDeepSeekMessages(messages) {
    const result = [];
    for (const m of messages) {
        const role = m.role === "user" ? "user" : "assistant";
        const content = String(m.text || "");
        if (result.length && result[result.length - 1].role === role) {
            result[result.length - 1].content += "\n\n" + content;
        } else {
            result.push({ role, content });
        }
    }
    return result;
}

function toGeminiContents(messages) {
    return messages.map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: String(m.text || "") }]
    }));
}

// ============================================================
// CHAT — DeepSeek first, Gemini fallback
// ============================================================
app.post("/chat", async (req, res) => {
    const { messages } = req.body;
    if (!messages || !messages.length) {
        return res.status(400).send("No messages provided.");
    }

    // ---- Rate limit ----
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip);
    if (!limit.ok) {
        console.log(`[RATE LIMIT] Blocked ${ip}: ${limit.reason}`);
        return res.status(429).send("Rate limit: " + limit.reason);
    }
    // --------------------

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    let lastError = null;

    // ---- Try DeepSeek first ----
    if (DEEPSEEK_KEY) {
        const dsMessages = toDeepSeekMessages(messages);
        for (const model of DEEPSEEK_MODELS) {
            try {
                const sent = await tryDeepSeek(model, dsMessages, res);
                if (sent) {
                    console.log(`[CHAT] DeepSeek ${model} streamed successfully`);
                    res.end();
                    return;
                }
                console.log(`[CHAT] DeepSeek ${model} returned no text`);
            } catch (err) {
                lastError = err;
                console.error(`[CHAT] DeepSeek ${model} failed:`, err.message);
                break;
            }
        }
    } else {
        console.log("[CHAT] No DeepSeek key — skipping to Gemini");
    }

    // ---- Fallback: Gemini ----
    if (GEMINI_KEY) {
        const geminiContents = toGeminiContents(messages);
        for (const model of GEMINI_MODELS) {
            try {
                const sent = await tryGemini(model, geminiContents, res);
                if (sent) {
                    console.log(`[CHAT] Gemini ${model} streamed successfully`);
                    res.end();
                    return;
                }
                console.log(`[CHAT] Gemini ${model} returned no text`);
            } catch (err) {
                lastError = err;
                console.error(`[CHAT] Gemini ${model} failed:`, err.message);
                if (err.status === 404 || err.status === 429) continue;
                if (/timeout|aborted|fetch failed|network/i.test(err.message)) continue;
                break;
            }
        }
    } else {
        console.log("[CHAT] No Gemini key either");
    }

    if (!res.writableEnded) {
        res.write("Error: " + (lastError?.message || "All models failed"));
        res.end();
    }
});

// ============================================================
// ROOT
// ============================================================
app.get("/", (req, res) => {
    res.json({
        status: `${APP_NAME} backend is running`,
        deepseekKeyLoaded: !!DEEPSEEK_KEY,
        geminiKeyLoaded: !!GEMINI_KEY,
        rateLimits: RATE_LIMITS
    });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 4789;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`${APP_NAME} running on port ${PORT}`);
    console.log(`[RATE] Limits: ${RATE_LIMITS.perIpPerHour}/hr per IP, ${RATE_LIMITS.perIpPerMinute}/min per IP, ${RATE_LIMITS.globalPerDay}/day global`);
});