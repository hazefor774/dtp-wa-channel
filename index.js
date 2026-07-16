
/**
 * dtp-wa-channel v0.2 — Datipay WhatsApp channel (DEMO conversation mode)
 * -----------------------------------------------------------------------
 * Zero-dependency Node.js (>=22). Entry point at repo root: `node index.js`.
 *
 * v0.2 replaces the echo with the DTP-WA-001 *demo lane*: a guided,
 * bilingual (FR/EN) conversation — menu, declare-a-contribution flow with
 * numbered demo receipts, group report, balance, STOP/START handling.
 * No ledger writes yet: every artifact is clearly labeled DEMO. The
 * dispatcher below is the seam where the Ledger Gateway attaches next.
 *
 * Env: WA_VERIFY_TOKEN, WA_APP_SECRET, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, PORT
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
const GRAPH_BASE = process.env.WA_GRAPH_BASE || "https://graph.facebook.com/v25.0";

function log(level, msg, extra) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) }) + "\n");
}
for (const [k, v] of Object.entries({ WA_VERIFY_TOKEN: VERIFY_TOKEN, WA_APP_SECRET: APP_SECRET, WA_ACCESS_TOKEN: ACCESS_TOKEN, WA_PHONE_NUMBER_ID: PHONE_NUMBER_ID })) {
  if (!v) log("warn", `env ${k} is not set`);
}

// ---------- dedupe ----------
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;
function alreadySeen(id) {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// ---------- sessions (in-memory; Gateway replaces with Redis later) ----------
const sessions = new Map(); // phone -> {lang, step, data, optOut, lastAt}
const SESSION_TTL_MS = 60 * 60 * 1000;
function session(from) {
  const now = Date.now();
  if (sessions.size > 5000) for (const [k, s] of sessions) if (now - s.lastAt > SESSION_TTL_MS) sessions.delete(k);
  let s = sessions.get(from);
  if (!s || now - s.lastAt > SESSION_TTL_MS) { s = { lang: "fr", step: "idle", data: {}, optOut: false, lastAt: now }; sessions.set(from, s); }
  s.lastAt = now;
  return s;
}

// ---------- demo receipt counter ----------
let rctSeq = 124; // continues the story the website started (…000123)
const fmtXAF = (n) => Number(n).toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ") + " XAF";

// ---------- copy (FR primary, EN mirror) ----------
const RAILS = { fr: ["MTN MoMo", "Orange Money", "Espèces (trésorier)", "Caisse populaire"], en: ["MTN MoMo", "Orange Money", "Cash (treasurer)", "Credit union"] };
const T = {
  fr: {
    menu: "Bienvenue chez Datipay 👋\n*Le carnet du trésorier, infaillible.*\n\n🔎 _Ceci est une DÉMO — groupe fictif « Njangi Unité Bamenda », cycle 4._\n\nRépondez avec un chiffre :\n1️⃣ Déclarer une cotisation\n2️⃣ Rapport du groupe\n3️⃣ Mon solde\n4️⃣ Aide · English\n\n_Répondez STOP pour ne plus recevoir de messages._",
    askAmount: "Quel montant avez-vous payé ?\n_(exemple : 25000)_",
    badAmount: "Je n'ai pas compris le montant. Envoyez seulement les chiffres, ex : *25000*",
    askRail: (amt) => `${fmtXAF(amt)} — par quelle voie ?\n\n1️⃣ MTN MoMo\n2️⃣ Orange Money\n3️⃣ Espèces (au trésorier)\n4️⃣ Caisse populaire`,
    badRail: "Répondez 1, 2, 3 ou 4 pour choisir la voie de paiement.",
    receipt: (amt, rail, ref) =>
      `✅ *Vérifié et enregistré — merci !*\n━━━━━━━━━━━━━━━\n*DATIPAY REÇU* _(DÉMO)_\n\n*${fmtXAF(amt)}*\n\nMembre : DTP-MBR-2026-0012\nVoie : ${rail}\nRéf : ${ref}\nCycle 4 · 13/18 payés\n\n*CONFIRMÉ* ✔\n━━━━━━━━━━━━━━━\n_Reçu partagé avec le bureau. Répondez MENU pour continuer._`,
    report: "📊 *Rapport — Njangi « Unité Bamenda »* _(DÉMO)_\nCycle 4 · bénéficiaire : Membre 07\n\nCotisations : *13/18 payées*\nCaisse du cycle : *325 000 XAF*\nAmendes en attente : 2 (4 000 XAF)\nCollecte solidarité (deuil) : 86 000 XAF\n\nEn retard : M-03, M-09, M-11, M-14, M-16\n_Rappels envoyés automatiquement hier à 18h._\n\nRépondez MENU pour continuer.",
    balance: "👤 *Votre situation* _(DÉMO)_\nMembre : DTP-MBR-2026-0012\n\nCycle 4 : *payé* ✔ (25 000 XAF)\nAmendes : aucune\nSolidarité versée : 5 000 XAF\nVotre tour de ramassage : cycle 7\n\nRépondez MENU pour continuer.",
    help: "ℹ️ *Aide Datipay*\nDatipay tient le registre de votre groupe sur WhatsApp : reçus numérotés, rappels, rapports.\nDatipay n'est pas une banque et ne détient pas votre argent.\n\nCommandes : *MENU* · *1* cotisation · *2* rapport · *3* solde · *STOP*\nFor English, reply *EN*.",
    stopped: "Vous ne recevrez plus de messages de Datipay. Répondez *START* pour reprendre. Merci 🙏",
    resumed: "Heureux de vous revoir 👋",
    fallback: "Je n'ai pas compris 🤔 Répondez *MENU* pour voir les options.",
  },
  en: {
    menu: "Welcome to Datipay 👋\n*The treasurer's notebook, made unforgettable.*\n\n🔎 _This is a DEMO — fictional group \"Njangi Unité Bamenda\", cycle 4._\n\nReply with a number:\n1️⃣ Declare a contribution\n2️⃣ Group report\n3️⃣ My balance\n4️⃣ Help · Français\n\n_Reply STOP to opt out._",
    askAmount: "How much did you pay?\n_(example: 25000)_",
    badAmount: "I didn't catch the amount. Send digits only, e.g. *25000*",
    askRail: (amt) => `${fmtXAF(amt)} — through which rail?\n\n1️⃣ MTN MoMo\n2️⃣ Orange Money\n3️⃣ Cash (to treasurer)\n4️⃣ Credit union`,
    badRail: "Reply 1, 2, 3 or 4 to choose the payment rail.",
    receipt: (amt, rail, ref) =>
      `✅ *Verified and recorded — thank you!*\n━━━━━━━━━━━━━━━\n*DATIPAY RECEIPT* _(DEMO)_\n\n*${fmtXAF(amt)}*\n\nMember: DTP-MBR-2026-0012\nRail: ${rail}\nRef: ${ref}\nCycle 4 · 13/18 paid\n\n*CONFIRMED* ✔\n━━━━━━━━━━━━━━━\n_Receipt shared with the bureau. Reply MENU to continue._`,
    report: "📊 *Report — Njangi \"Unité Bamenda\"* _(DEMO)_\nCycle 4 · beneficiary: Member 07\n\nContributions: *13/18 paid*\nCycle pot: *325,000 XAF*\nPending fines: 2 (4,000 XAF)\nSolidarity collection (bereavement): 86,000 XAF\n\nLate: M-03, M-09, M-11, M-14, M-16\n_Reminders sent automatically yesterday 6pm._\n\nReply MENU to continue.",
    balance: "👤 *Your standing* _(DEMO)_\nMember: DTP-MBR-2026-0012\n\nCycle 4: *paid* ✔ (25,000 XAF)\nFines: none\nSolidarity given: 5,000 XAF\nYour payout turn: cycle 7\n\nReply MENU to continue.",
    help: "ℹ️ *Datipay help*\nDatipay keeps your group's record on WhatsApp: numbered receipts, reminders, reports.\nDatipay is not a bank and does not hold your money.\n\nCommands: *MENU* · *1* contribute · *2* report · *3* balance · *STOP*\nPour le français, répondez *FR*.",
    stopped: "You will no longer receive Datipay messages. Reply *START* to resume. Thank you 🙏",
    resumed: "Good to see you again 👋",
    fallback: "I didn't understand 🤔 Reply *MENU* to see the options.",
  },
};

// ---------- conversation dispatcher (the Gateway seam) ----------
function detectLang(text, s) {
  const t = text.toLowerCase();
  if (/^(en|english)$/.test(t)) return "en";
  if (/^(fr|français|francais)$/.test(t)) return "fr";
  if (/\b(hello|hi|hey|balance|report|help)\b/.test(t)) return "en";
  if (/\b(bonjour|salut|payé|paye|rapport, aide|solde)\b/.test(t)) return "fr";
  return s.lang;
}

function reply(from, s, text) { return sendText(from, text).catch((e) => log("error", "send failed", { err: String(e) })); }

async function handleMessage(msg, contactName) {
  const from = msg.from;
  const s = session(from);
  if (msg.type !== "text") {
    log("info", "inbound non-text", { from, type: msg.type });
    return reply(from, s, s.lang === "fr" ? "Pour la démo, envoyez un message texte 🙂 (*MENU*)" : "For the demo, please send a text message 🙂 (*MENU*)");
  }
  const raw = (msg.text?.body ?? "").trim();
  const text = raw.toLowerCase();
  log("info", "inbound text", { from, name: contactName, text: raw, step: s.step });

  // language + opt-out first
  s.lang = detectLang(raw, s);
  const t = T[s.lang];
  if (/^stop$/i.test(text)) { s.optOut = true; s.step = "idle"; return reply(from, s, t.stopped); }
  if (s.optOut) {
    if (/^start$/i.test(text)) { s.optOut = false; s.step = "idle"; await reply(from, s, t.resumed); return reply(from, s, t.menu); }
    return; // honor opt-out silently
  }
  if (/^(en|english|fr|français|francais)$/i.test(text)) { s.step = "idle"; return reply(from, s, T[s.lang].menu); }

  // state machine
  if (s.step === "await_amount") {
    const amt = Number((raw.match(/[\d][\d\s.,]*/) || [""])[0].replace(/[\s.,]/g, ""));
    if (!amt || amt < 100 || amt > 100000000) return reply(from, s, t.badAmount);
    s.data.amount = amt; s.step = "await_rail";
    return reply(from, s, t.askRail(amt));
  }
  if (s.step === "await_rail") {
    const m = text.match(/^[1-4]$/);
    if (!m) return reply(from, s, t.badRail);
    const rail = RAILS[s.lang][Number(m[0]) - 1];
    const ref = `DTP-RCT-2026-${String(rctSeq++).padStart(6, "0")} (DEMO)`;
    s.step = "idle"; const amt = s.data.amount; s.data = {};
    log("info", "demo receipt issued", { from, amt, rail, ref });
    return reply(from, s, t.receipt(amt, rail, ref));
  }

  // idle commands
  if (/^(menu|bonjour|salut|hello|hi|hey|start)\b/.test(text)) { s.step = "idle"; return reply(from, s, t.menu); }
  if (/^1$/.test(text) || /\b(pay[ée]|cotis|contribut)/.test(text)) { s.step = "await_amount"; return reply(from, s, t.askAmount); }
  if (/^2$/.test(text) || /\b(rapport|report)\b/.test(text)) return reply(from, s, t.report);
  if (/^3$/.test(text) || /\b(solde|balance)\b/.test(text)) return reply(from, s, t.balance);
  if (/^4$/.test(text) || /\b(aide|help)\b/.test(text)) return reply(from, s, t.help);
  return reply(from, s, t.fallback);
}

// ---------- graph send ----------
async function sendText(to, body) {
  const res = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { log("error", "graph send failed", { status: res.status, to, error: json.error?.message }); return null; }
  const msgId = json.messages?.[0]?.id || null;
  log("info", "sent", { to, msgId });
  return msgId;
}

// ---------- webhook plumbing (unchanged from v0.1) ----------
function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const theirs = Buffer.from(signatureHeader.slice(7), "hex");
  const ours = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest();
  return theirs.length === ours.length && crypto.timingSafeEqual(theirs, ours);
}

function processWebhook(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const msg of value.messages || []) {
        if (!msg.id || alreadySeen(msg.id)) { log("info", "duplicate ignored", { id: msg.id }); continue; }
        const name = contacts.find((c) => c.wa_id === msg.from)?.profile?.name;
        handleMessage(msg, name).catch((e) => log("error", "handleMessage failed", { err: String(e) }));
      }
      for (const st of value.statuses || []) log("info", "status", { id: st.id, status: st.status, to: st.recipient_id });
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "dtp-wa-channel", v: "0.2.0" }));
  }
  if (req.method === "GET" && url.pathname === "/webhook") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      log("info", "webhook verified by Meta");
      res.writeHead(200); return res.end(challenge);
    }
    log("warn", "webhook verification rejected", { mode });
    res.writeHead(403); return res.end();
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      if (!verifySignature(rawBody, req.headers["x-hub-signature-256"])) {
        log("warn", "signature verification FAILED");
        res.writeHead(401); return res.end();
      }
      res.writeHead(200); res.end();
      try { processWebhook(JSON.parse(rawBody.toString("utf8"))); } catch (e) { log("error", "process failed", { err: String(e) }); }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, "0.0.0.0", () => log("info", `dtp-wa-channel v0.2 listening on :${PORT}`));
process.on("SIGTERM", () => { log("info", "SIGTERM"); server.close(() => process.exit(0)); });
