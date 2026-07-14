/**
 * dtp-wa-channel v0 — Datipay WhatsApp channel service (echo milestone, DTP-016)
 * -----------------------------------------------------------------------------
 * Zero-dependency Node.js (>=22). No npm install required.
 *
 * Responsibilities in v0:
 *   1. GET  /webhook  — Meta webhook verification handshake (hub.challenge)
 *   2. POST /webhook  — receive events, verify X-Hub-Signature-256, ACK fast
 *   3. Echo inbound text messages back to the sender via the Graph API
 *   4. GET  /health   — liveness/readiness for Kubernetes
 *
 * Environment:
 *   WA_VERIFY_TOKEN      — any string you choose; must match what you enter in Meta webhook config
 *   WA_APP_SECRET        — Meta App Settings > Basic > App Secret (signature verification)
 *   WA_ACCESS_TOKEN      — WhatsApp access token (temporary token for v0; system-user token later)
 *   WA_PHONE_NUMBER_ID   — from the WhatsApp API Setup page
 *   PORT                 — default 8080
 *
 * Design notes for what comes next (per DTP-WA-001 / DTP-ARCH-002):
 *   - handleMessage() is the single seam where the conversation state machine attaches.
 *   - Every outbound send returns the Graph message id; v1 persists it with an
 *     idempotency key before sending (same discipline as the Ledger Gateway).
 *   - ACK-first: Meta retries deliveries that take >~10s, so we respond 200
 *     immediately and process async. Dedupe by message id prevents double-handling.
 */

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

// ---------- config ----------
const PORT = Number(process.env.PORT || 8080);
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WA_APP_SECRET || "";
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || "";
const GRAPH_BASE = process.env.WA_GRAPH_BASE || "https://graph.facebook.com/v21.0";

for (const [k, v] of Object.entries({ WA_VERIFY_TOKEN: VERIFY_TOKEN, WA_APP_SECRET: APP_SECRET, WA_ACCESS_TOKEN: ACCESS_TOKEN, WA_PHONE_NUMBER_ID: PHONE_NUMBER_ID })) {
  if (!v) log("warn", `env ${k} is not set — service will run but the related function will fail`);
}

// ---------- tiny utils ----------
function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  process.stdout.write(JSON.stringify(line) + "\n");
}

/** In-memory dedupe of processed message ids (v1 moves this to Redis). */
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;
function alreadySeen(id) {
  const now = Date.now();
  // opportunistic cleanup
  if (seen.size > 5000) {
    for (const [k, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const theirs = Buffer.from(signatureHeader.slice(7), "hex");
  const ours = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest();
  return theirs.length === ours.length && crypto.timingSafeEqual(theirs, ours);
}

async function sendText(to, body) {
  const res = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    log("error", "graph send failed", { status: res.status, to, error: json.error?.message });
    return null;
  }
  const msgId = json.messages?.[0]?.id || null;
  log("info", "sent", { to, msgId });
  return msgId;
}

// ---------- domain seam ----------
/**
 * v0 behavior: echo text; acknowledge non-text politely.
 * v1 replaces this with the DTP-WA-001 state machine dispatcher.
 */
async function handleMessage(msg, contactName) {
  const from = msg.from;
  if (msg.type === "text") {
    const text = msg.text?.body ?? "";
    log("info", "inbound text", { from, name: contactName, text });
    await sendText(from, `Datipay echo \u2713\n${text}`);
  } else {
    log("info", "inbound non-text", { from, type: msg.type });
    await sendText(from, `Datipay v0 re\u00e7oit les messages "${msg.type}" bient\u00f4t. / "${msg.type}" support coming soon.`);
  }
}

function processWebhook(payload) {
  // WhatsApp Cloud API envelope: entry[].changes[].value.{messages,statuses,contacts}
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const msg of value.messages || []) {
        if (!msg.id || alreadySeen(msg.id)) {
          log("info", "duplicate delivery ignored", { id: msg.id });
          continue;
        }
        const name = contacts.find((c) => c.wa_id === msg.from)?.profile?.name;
        handleMessage(msg, name).catch((e) => log("error", "handleMessage failed", { err: String(e) }));
      }
      for (const st of value.statuses || []) {
        log("info", "status", { id: st.id, status: st.status, to: st.recipient_id });
      }
    }
  }
}

// ---------- http server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "dtp-wa-channel", v: "0.1.0" }));
  }

  if (req.method === "GET" && url.pathname === "/webhook") {
    // Meta verification handshake
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      log("info", "webhook verified by Meta");
      res.writeHead(200);
      return res.end(challenge);
    }
    log("warn", "webhook verification rejected", { mode });
    res.writeHead(403);
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) req.destroy(); // 1MB guard
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers["x-hub-signature-256"])) {
        log("warn", "signature verification FAILED — dropping payload");
        res.writeHead(401);
        return res.end();
      }
      // ACK immediately; process async
      res.writeHead(200);
      res.end();
      try {
        processWebhook(JSON.parse(raw.toString("utf8")));
      } catch (e) {
        log("error", "payload parse/process failed", { err: String(e) });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => log("info", `dtp-wa-channel listening on :${PORT}`));

process.on("SIGTERM", () => {
  log("info", "SIGTERM — closing");
  server.close(() => process.exit(0));
});
