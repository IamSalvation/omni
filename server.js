require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const APP_NAME = process.env.APP_NAME || "Omni";

// ============================================================
// GEMINI API KEY
// ============================================================

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

if (!API_KEY) {
    console.error("FATAL: GEMINI_API_KEY is missing.");
}

// ============================================================
// MODELS
// ============================================================

const MODELS = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite"
];

const GEMINI_BASE =
    "https://generativelanguage.googleapis.com/v1beta/models";

// ============================================================
// REQUEST HEADERS
// ============================================================

function geminiHeaders() {
    return {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
        "x-goog-api-client": "Omni/1.0"
    };
}

// ============================================================
// SIMPLE NON-STREAMING TEST
// ============================================================

async function testGemini(model) {
    const url = `${GEMINI_BASE}/${model}:generateContent`;

    console.log(`[GEMINI TEST] Testing ${model}`);

    const response = await fetch(url, {
        method: "POST",
        headers: geminiHeaders(),
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [{ text: "Reply with exactly: OK" }]
                }
            ]
        }),
        signal: AbortSignal.timeout(15000)
    });

    const body = await response.text();

    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const json = JSON.parse(body);
            message = json.error?.message || json.error?.status || message;
        } catch { }

        const error = new Error(message);
        error.status = response.status;

        console.error(
            `[GEMINI TEST] ${model} FAILED: ${response.status} ${message}`
        );
        throw error;
    }

    let json;
    try {
        json = JSON.parse(body);
    } catch {
        throw new Error("Gemini returned invalid JSON.");
    }

    const text =
        json.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("") || "";

    console.log(`[GEMINI TEST] ${model} SUCCESS: ${JSON.stringify(text)}`);
    return text;
}

// ============================================================
// DEBUG ENDPOINT
// ============================================================

app.get("/debug/gemini", async (req, res) => {
    if (!API_KEY) {
        return res.status(500).json({
            ok: false,
            error: "GEMINI_API_KEY is missing"
        });
    }

    const results = [];

    for (const model of MODELS) {
        try {
            const text = await testGemini(model);
            results.push({
                model,
                ok: true,
                response: text
            });
            break; // one success is enough
        } catch (error) {
            results.push({
                model,
                ok: false,
                status: error.status || null,
                error: error.message
            });

            // Stop on hard auth/config errors
            if (
                error.status &&
                error.status !== 404 &&
                error.status !== 429
            ) {
                break;
            }
        }
    }

    const success = results.some(r => r.ok);

    return res.status(success ? 200 : 502).json({
        ok: success,
        keyLoaded: !!API_KEY,
        keyLength: API_KEY.length,
        keyFormat: API_KEY.startsWith("AQ.") ? "AQ." : "OTHER",
        results
    });
});

// ============================================================
// CHAT (non-streaming for now)
// ============================================================

app.post("/chat", async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ reply: "No messages provided." });
    }

    if (!API_KEY) {
        return res.status(500).json({ reply: "Gemini API key is not configured." });
    }

    const contents = messages.map(message => ({
        role: message.role === "user" ? "user" : "model",
        parts: [{ text: String(message.text || "") }]
    }));

    let lastError = null;

    for (const model of MODELS) {
        try {
            console.log(`[CHAT] Trying ${model}`);

            const url = `${GEMINI_BASE}/${model}:generateContent`;

            const response = await fetch(url, {
                method: "POST",
                headers: geminiHeaders(),
                body: JSON.stringify({ contents }),
                signal: AbortSignal.timeout(20000)
            });

            const body = await response.text();

            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    const json = JSON.parse(body);
                    message = json.error?.message || json.error?.status || message;
                } catch { }

                const error = new Error(
                    message.split("\n")[0].replace(/^\[\d+\]\s*/, "")
                );
                error.status = response.status;
                throw error;
            }

            const json = JSON.parse(body);
            const reply =
                json.candidates?.[0]?.content?.parts
                    ?.map(part => part.text || "")
                    .join("") || "(no reply)";

            console.log(`[CHAT] ${model} SUCCESS`);
            return res.json({ reply });

        } catch (error) {
            lastError = error;
            console.error(`[CHAT] ${model} failed:`, error.message);

            // Try next model on quota/model-unavailable
            if (error.status === 404 || error.status === 429) {
                continue;
            }

            // Try next model on timeout/network
            if (/timeout|aborted|fetch failed|network/i.test(error.message)) {
                console.log(`[CHAT] Network/timeout on ${model}, trying next...`);
                continue;
            }

            // Real config/auth error — stop
            break;
        }
    }

    res.status(500).json({
        reply: "Error: " + (lastError?.message || "All Gemini models failed.")
    });
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
    res.json({
        status: `${APP_NAME} backend is running`,
        geminiKeyLoaded: !!API_KEY
    });
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 4789;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`${APP_NAME} running on port ${PORT}`);
});