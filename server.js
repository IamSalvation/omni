require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const APP_NAME = process.env.APP_NAME || "Omni";

// ---- Key extraction (supports AQ. and AIza) ----
const rawKey = process.env.GEMINI_API_KEY || "";
const API_KEY = rawKey
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^GEMINI_API_KEY=/, "");

console.log(
    `[ENV CHECK] present: ${!!API_KEY} | ` +
    `length: ${API_KEY.length} | ` +
    `prefix: ${API_KEY ? API_KEY.slice(0, 8) + "..." : "MISSING"} | ` +
    `format: ${API_KEY.startsWith("AQ.") ? "NEW AQ." : "OTHER"}`
);

const MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite"
];

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function tryStream(model, contents, res, timeoutMs = 20000) {
    const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`;

    console.log(`[STREAM] Starting ${model}`);

    const upstream = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY
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
                const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
                if (text) {
                    sentAny = true;
                    res.write(text);
                }
            } catch { }
        }
    }

    return sentAny;
}

app.post("/chat", async (req, res) => {
    const { messages } = req.body;
    if (!messages || !messages.length) {
        return res.status(400).send("No messages provided.");
    }

    const contents = messages.map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }]
    }));

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    let lastError = null;

    for (const model of MODELS) {
        try {
            const sent = await tryStream(model, contents, res, 20000);
            if (sent) {
                res.end();
                return;
            }
            console.log(`[CHAT] ${model} returned no text`);
        } catch (err) {
            lastError = err;
            console.error(`[CHAT] ${model} failed:`, err.message);

            if (err.status === 404 || err.status === 429) continue;
            if (/timeout|aborted|fetch failed|network/i.test(err.message)) continue;
            break;
        }
    }

    if (!res.writableEnded) {
        res.write("Error: " + (lastError?.message || "All models failed"));
        res.end();
    }
});

app.get("/", (req, res) => {
    res.json({
        status: `${APP_NAME} backend is running`,
        geminiKeyLoaded: !!API_KEY
    });
});

const PORT = process.env.PORT || 4789;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`${APP_NAME} running on port ${PORT}`);
});