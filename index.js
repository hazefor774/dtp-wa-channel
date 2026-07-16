
/**
 * dtp-wa-channel v0.4 — Datipay WhatsApp channel (trésorier verification loop: PENDING → CONFIRMED)
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
const TRESORIERS = (process.env.WA_TRESORIER_NUMBERS || "").split(",").map(x => x.trim()).filter(Boolean);

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
let pendSeq = 1;
const pendings = new Map(); // pid -> {from, name, amt, rub, rail, refTxt, ref, at}
const fmtXAF = (n) => Number(n).toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ") + " XAF";

// ---------- copy (FR primary, EN mirror) ----------
const RAILS = { fr: ["MTN MoMo", "Orange Money", "Espèces (trésorier)", "Caisse populaire"], en: ["MTN MoMo", "Orange Money", "Cash (treasurer)", "Credit union"] };
const T = {
  fr: {
    menuBody: "Bienvenue chez Datipay 👋\n*Le carnet du trésorier, infaillible.*\n\n🔎 _DÉMO — groupe fictif « Njangi Unité Bamenda », cycle 4._",
    menuFooter: "STOP pour ne plus recevoir de messages",
    bCotiser: "✅ Cotiser", bRapport: "📊 Rapport", bPlus: "☰ Plus",
    moreTitle: "Autres options", moreBtn: "Choisir",
    moreRows: [["m_balance","👤 Mon solde","Votre situation dans le groupe"],["m_help","ℹ️ Aide","Commandes et informations"],["m_lang","🌐 English","Switch to English"]],
    rubBody: "Pour quelle rubrique ?", rubBtn: "Choisir la rubrique",
    rubRows: [["rub_cot","Cotisation principale","Cycle 4 · 25 000 XAF attendus"],["rub_sol","Solidarité","Deuil · naissance · mariage"],["rub_amende","Amende","Régler une pénalité"],["rub_epargne","Épargne libre","Dépôt volontaire"]],
    amtBody: (rub) => `${rub} — quel montant ?`,
    bAmtExpected: "25 000 (attendu)", bAmtOther: "Autre montant",
    railBody: (amt) => `${fmtXAF(amt)} — par quelle voie ?`, railBtn: "Choisir la voie",
    railRows: [["rail_1","MTN MoMo",""],["rail_2","Orange Money",""],["rail_3","Espèces","Remis au trésorier"],["rail_4","Caisse populaire","Bordereau de dépôt"]],
    askRef: "Envoyez la référence de la transaction (ex : reçu MoMo) — ou passez.",
    bSkipRef: "Passer",
    pending: (amt, rub, rail, pid) => `⏳ *Déclaration reçue — en attente de vérification*\n━━━━━━━━━━━━━━━\n*DATIPAY* _(DÉMO)_\n\n*${fmtXAF(amt)}*\nRubrique : ${rub}\nVoie : ${rail}\nDossier : ${pid}\n\n*EN ATTENTE* ⏳\n━━━━━━━━━━━━━━━\n_Le trésorier a été notifié. Vous recevrez votre reçu confirmé._`,
    tresoAsk: (name, from, amt, rub, rail, refTxt, pid) => `🔔 *Vérification requise* _(DÉMO)_\n\n*${name || from}* déclare :\n*${fmtXAF(amt)}* · ${rub}\nVoie : ${rail}\nRéf : ${refTxt || "—"}\nDossier : ${pid}`,
    bConfirm: "✅ Confirmer", bReject: "❌ Rejeter",
    confirmedByTreso: "Vérifié par le trésorier",
    rejected: (pid) => `❌ Votre déclaration ${pid} n'a pas été confirmée par le trésorier. Contactez votre bureau ou réessayez (*MENU*).`,
    tresoDone: (pid) => `Dossier ${pid} confirmé ✔ — reçu envoyé au membre.`,
    tresoRejDone: (pid) => `Dossier ${pid} rejeté — le membre a été notifié.`,
    noTreso: "_(Mode démo sans trésorier configuré — confirmation automatique.)_",
    askAmount: "Quel montant avez-vous payé ?\n_(exemple : 25000)_",
    badAmount: "Je n'ai pas compris le montant. Envoyez seulement les chiffres, ex : *25000*",
    askRail: (amt) => `${fmtXAF(amt)} — par quelle voie ?\n\n1️⃣ MTN MoMo\n2️⃣ Orange Money\n3️⃣ Espèces (au trésorier)\n4️⃣ Caisse populaire`,
    badRail: "Répondez 1, 2, 3 ou 4 pour choisir la voie de paiement.",
    receipt: (amt, rub, rail, ref, by) =>
      `✅ *Vérifié et enregistré — merci !*\n━━━━━━━━━━━━━━━\n*DATIPAY REÇU* _(DÉMO)_\n\n*${fmtXAF(amt)}*\n\nMembre : DTP-MBR-2026-0012\nRubrique : ${rub}\nVoie : ${rail}\nRéf : ${ref}\nCycle 4 · 13/18 payés\n\n*CONFIRMÉ* ✔ · ${by}\n━━━━━━━━━━━━━━━\n_Reçu partagé avec le bureau. Répondez MENU pour continuer._`,
    report: "📊 *Rapport — Njangi « Unité Bamenda »* _(DÉMO)_\nCycle 4 · bénéficiaire : Membre 07\n\nCotisations : *13/18 payées*\nCaisse du cycle : *325 000 XAF*\nAmendes en attente : 2 (4 000 XAF)\nCollecte solidarité (deuil) : 86 000 XAF\n\nEn retard : M-03, M-09, M-11, M-14, M-16\n_Rappels envoyés automatiquement hier à 18h._\n\nRépondez MENU pour continuer.",
    balance: "👤 *Votre situation* _(DÉMO)_\nMembre : DTP-MBR-2026-0012\n\nCycle 4 : *payé* ✔ (25 000 XAF)\nAmendes : aucune\nSolidarité versée : 5 000 XAF\nVotre tour de ramassage : cycle 7\n\nRépondez MENU pour continuer.",
    help: "ℹ️ *Aide Datipay*\nDatipay tient le registre de votre groupe sur WhatsApp : reçus numérotés, rappels, rapports.\nDatipay n'est pas une banque et ne détient pas votre argent.\n\nCommandes : *MENU* · *1* cotisation · *2* rapport · *3* solde · *STOP*\nFor English, reply *EN*.",
    stopped: "Vous ne recevrez plus de messages de Datipay. Répondez *START* pour reprendre. Merci 🙏",
    resumed: "Heureux de vous revoir 👋",
    fallback: "Je n'ai pas compris 🤔 Répondez *MENU* pour voir les options.",
  },
  en: {
    menuBody: "Welcome to Datipay 👋\n*The treasurer's notebook, made unforgettable.*\n\n🔎 _DEMO — fictional group \"Njangi Unité Bamenda\", cycle 4._",
    menuFooter: "Reply STOP to opt out",
    bCotiser: "✅ Contribute", bRapport: "📊 Report", bPlus: "☰ More",
    moreTitle: "More options", moreBtn: "Choose",
    moreRows: [["m_balance","👤 My balance","Your standing in the group"],["m_help","ℹ️ Help","Commands and info"],["m_lang","🌐 Français","Passer en français"]],
    rubBody: "Which category?", rubBtn: "Choose category",
    rubRows: [["rub_cot","Main contribution","Cycle 4 · 25,000 XAF expected"],["rub_sol","Solidarity","Bereavement · birth · wedding"],["rub_amende","Fine","Settle a penalty"],["rub_epargne","Free savings","Voluntary deposit"]],
    amtBody: (rub) => `${rub} — how much?`,
    bAmtExpected: "25,000 (expected)", bAmtOther: "Other amount",
    railBody: (amt) => `${fmtXAF(amt)} — through which rail?`, railBtn: "Choose rail",
    railRows: [["rail_1","MTN MoMo",""],["rail_2","Orange Money",""],["rail_3","Cash","Handed to treasurer"],["rail_4","Credit union","Deposit slip"]],
    askRef: "Send the transaction reference (e.g. MoMo receipt) — or skip.",
    bSkipRef: "Skip",
    pending: (amt, rub, rail, pid) => `⏳ *Declaration received — awaiting verification*\n━━━━━━━━━━━━━━━\n*DATIPAY* _(DEMO)_\n\n*${fmtXAF(amt)}*\nCategory: ${rub}\nRail: ${rail}\nCase: ${pid}\n\n*PENDING* ⏳\n━━━━━━━━━━━━━━━\n_The treasurer has been notified. Your confirmed receipt will follow._`,
    tresoAsk: (name, from, amt, rub, rail, refTxt, pid) => `🔔 *Verification required* _(DEMO)_\n\n*${name || from}* declares:\n*${fmtXAF(amt)}* · ${rub}\nRail: ${rail}\nRef: ${refTxt || "—"}\nCase: ${pid}`,
    bConfirm: "✅ Confirm", bReject: "❌ Reject",
    confirmedByTreso: "Verified by the treasurer",
    rejected: (pid) => `❌ Your declaration ${pid} was not confirmed by the treasurer. Contact your bureau or try again (*MENU*).`,
    tresoDone: (pid) => `Case ${pid} confirmed ✔ — receipt sent to the member.`,
    tresoRejDone: (pid) => `Case ${pid} rejected — the member has been notified.`,
    noTreso: "_(Demo mode without a configured treasurer — auto-confirmed.)_",
    askAmount: "How much did you pay?\n_(example: 25000)_",
    badAmount: "I didn't catch the amount. Send digits only, e.g. *25000*",
    askRail: (amt) => `${fmtXAF(amt)} — through which rail?\n\n1️⃣ MTN MoMo\n2️⃣ Orange Money\n3️⃣ Cash (to treasurer)\n4️⃣ Credit union`,
    badRail: "Reply 1, 2, 3 or 4 to choose the payment rail.",
    receipt: (amt, rub, rail, ref, by) =>
      `✅ *Verified and recorded — thank you!*\n━━━━━━━━━━━━━━━\n*DATIPAY RECEIPT* _(DEMO)_\n\n*${fmtXAF(amt)}*\n\nMember: DTP-MBR-2026-0012\nCategory: ${rub}\nRail: ${rail}\nRef: ${ref}\nCycle 4 · 13/18 paid\n\n*CONFIRMED* ✔ · ${by}\n━━━━━━━━━━━━━━━\n_Receipt shared with the bureau. Reply MENU to continue._`,
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
function replyI(from, s, payload) { return sendInteractive(from, payload).catch((e) => log("error", "send failed", { err: String(e) })); }
const RUB = { rub_cot: { fr: "Cotisation principale", en: "Main contribution" }, rub_sol: { fr: "Solidarité", en: "Solidarity" }, rub_amende: { fr: "Amende", en: "Fine" }, rub_epargne: { fr: "Épargne libre", en: "Free savings" } };

function sendMenu(from, s) {
  const t = T[s.lang];
  return replyI(from, s, btns(t.menuBody, [["act_cotiser", t.bCotiser], ["act_rapport", t.bRapport], ["act_more", t.bPlus]], t.menuFooter));
}

async function handleAction(from, s, id) {
  const t = T[s.lang];
  switch (true) {
    case id === "act_cotiser":
      s.step = "await_rub";
      return replyI(from, s, list(t.rubBody, t.rubBtn, t.rubRows));
    case id === "act_rapport": s.step = "idle"; return reply(from, s, t.report);
    case id === "act_more":
      return replyI(from, s, list(t.moreTitle, t.moreBtn, t.moreRows));
    case id === "m_balance": s.step = "idle"; return reply(from, s, t.balance);
    case id === "m_help": s.step = "idle"; return reply(from, s, t.help);
    case id === "m_lang": s.lang = s.lang === "fr" ? "en" : "fr"; s.step = "idle"; return sendMenu(from, s);
    case id.startsWith("rub_"): {
      s.data.rub = RUB[id][s.lang]; s.step = "await_amount";
      return replyI(from, s, btns(T[s.lang].amtBody(s.data.rub), [["amt_expected", T[s.lang].bAmtExpected], ["amt_other", T[s.lang].bAmtOther]]));
    }
    case id === "amt_expected": s.data.amount = 25000; s.step = "await_rail";
      return replyI(from, s, list(t.railBody(25000), t.railBtn, t.railRows));
    case id === "amt_other": s.step = "await_amount_text"; return reply(from, s, t.askAmount);
    case id.startsWith("rail_"): {
      if (!s.data.amount) { s.step = "idle"; return sendMenu(from, s); }
      s.data.rail = RAILS[s.lang][Number(id.split("_")[1]) - 1];
      s.step = "await_ref";
      return replyI(from, s, btns(t.askRef, [["ref_skip", t.bSkipRef]]));
    }
    case id === "ref_skip": {
      if (s.step !== "await_ref") return sendMenu(from, s);
      return submitDeclaration(from, s, null);
    }
    case id.startsWith("conf_") || id.startsWith("rej_"): {
      return handleTresorier(from, s, id);
    }
    default: return sendMenu(from, s);
  }
}

async function submitDeclaration(from, s, refTxt) {
  const t = T[s.lang];
  const amt = s.data.amount, rub = s.data.rub || RUB.rub_cot[s.lang], rail = s.data.rail;
  s.step = "idle"; s.data = {};
  if (!amt || !rail) return sendMenu(from, s);
  const pid = `DTP-PND-${String(pendSeq++).padStart(4, "0")}`;
  const rec = { from, name: s.name || from, amt, rub, rail, refTxt, lang: s.lang, at: Date.now() };
  if (!TRESORIERS.length) {
    // honest demo fallback: label the auto-confirmation as such
    const ref = `DTP-RCT-2026-${String(rctSeq++).padStart(6, "0")} (DEMO)`;
    log("info", "receipt auto-confirmed (no tresorier configured)", { from, amt, rub, rail, ref });
    await reply(from, s, t.receipt(amt, rub, rail, ref, "AUTO"));
    return reply(from, s, t.noTreso);
  }
  pendings.set(pid, rec);
  log("info", "declaration pending", { pid, from, amt, rub, rail, refTxt });
  await reply(from, s, t.pending(amt, rub, rail, pid));
  for (const tres of TRESORIERS) {
    const tt = T[s.lang];
    await sendInteractive(tres, btns(tt.tresoAsk(rec.name, from, amt, rub, rail, refTxt, pid),
      [[`conf_${pid}`, tt.bConfirm], [`rej_${pid}`, tt.bReject]])).catch((e) => log("error", "treso notify failed", { err: String(e) }));
  }
}

async function handleTresorier(from, s, id) {
  const isConfirm = id.startsWith("conf_");
  const pid = id.slice(isConfirm ? 5 : 4);
  const rec = pendings.get(pid);
  const t = T[s.lang];
  if (!TRESORIERS.includes(from)) { log("warn", "non-tresorier tapped verify button", { from, id }); return; }
  if (!rec) return reply(from, s, s.lang === "fr" ? `Dossier ${pid} introuvable ou déjà traité.` : `Case ${pid} not found or already handled.`);
  pendings.delete(pid);
  const mt = T[rec.lang];
  if (isConfirm) {
    const ref = `DTP-RCT-2026-${String(rctSeq++).padStart(6, "0")} (DEMO)`;
    log("info", "declaration CONFIRMED by tresorier", { pid, by: from, ref });
    await sendText(rec.from, mt.receipt(rec.amt, rec.rub, rec.rail, ref, mt.confirmedByTreso)).catch(() => {});
    return reply(from, s, t.tresoDone(pid));
  }
  log("info", "declaration REJECTED by tresorier", { pid, by: from });
  await sendText(rec.from, mt.rejected(pid)).catch(() => {});
  return reply(from, s, t.tresoRejDone(pid));
}

async function handleMessage(msg, contactName) {
  const from = msg.from;
  const s = session(from);
  // interactive replies (button/list taps)
  if (contactName) s.name = contactName;
  if (msg.type === "interactive") {
    const id = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    log("info", "inbound tap", { from, name: contactName, id, step: s.step });
    if (!id) return;
    if (s.optOut) return;
    return handleAction(from, s, id);
  }
  if (msg.type !== "text") {
    log("info", "inbound non-text", { from, type: msg.type });
    return reply(from, s, s.lang === "fr" ? "Pour la démo, envoyez un message texte 🙂" : "For the demo, please send a text message 🙂");
  }
  const raw = (msg.text?.body ?? "").trim();
  const text = raw.toLowerCase();
  log("info", "inbound text", { from, name: contactName, text: raw, step: s.step });

  s.lang = detectLang(raw, s);
  const t = T[s.lang];
  if (/^stop$/i.test(text)) { s.optOut = true; s.step = "idle"; return reply(from, s, t.stopped); }
  if (s.optOut) {
    if (/^start$/i.test(text)) { s.optOut = false; s.step = "idle"; await reply(from, s, t.resumed); return sendMenu(from, s); }
    return;
  }
  if (/^(en|english|fr|français|francais)$/i.test(text)) { s.step = "idle"; return sendMenu(from, s); }

  if (s.step === "await_ref") {
    return submitDeclaration(from, s, raw.slice(0, 60));
  }
  if (s.step === "await_amount_text" || s.step === "await_amount") {
    const amt = Number((raw.match(/[\d][\d\s.,]*/) || [""])[0].replace(/[\s.,]/g, ""));
    if (!amt || amt < 100 || amt > 100000000) return reply(from, s, t.badAmount);
    s.data.amount = amt; s.step = "await_rail";
    return replyI(from, s, list(t.railBody(amt), t.railBtn, t.railRows));
  }

  // legacy numeric shortcuts still work; everything routes to actions
  if (/^(menu|bonjour|salut|hello|hi|hey|start)\b/.test(text)) { s.step = "idle"; return sendMenu(from, s); }
  if (/^1$/.test(text) || /\b(pay[ée]|cotis|contribut)/.test(text)) return handleAction(from, s, "act_cotiser");
  if (/^2$/.test(text) || /\b(rapport|report)\b/.test(text)) return handleAction(from, s, "act_rapport");
  if (/^3$/.test(text) || /\b(solde|balance)\b/.test(text)) return handleAction(from, s, "m_balance");
  if (/^4$/.test(text) || /\b(aide|help)\b/.test(text)) return handleAction(from, s, "m_help");
  return sendMenu(from, s);
}

// ---------- graph send ----------
async function sendInteractive(to, payload) {
  const res = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { log("error", "graph interactive failed", { status: res.status, to, error: json.error?.message }); return null; }
  log("info", "sent interactive", { to, kind: payload.type, msgId: json.messages?.[0]?.id });
  return json.messages?.[0]?.id || null;
}
function btns(body, buttons, footer) {
  return { type: "button", body: { text: body }, ...(footer ? { footer: { text: footer } } : {}),
    action: { buttons: buttons.map(([id, title]) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } })) } };
}
function list(body, buttonLabel, rows, footer) {
  return { type: "list", body: { text: body }, ...(footer ? { footer: { text: footer } } : {}),
    action: { button: buttonLabel.slice(0, 20), sections: [{ title: "Datipay", rows: rows.map(([id, title, desc]) => ({ id, title: title.slice(0, 24), ...(desc ? { description: desc.slice(0, 72) } : {}) })) }] } };
}
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
    return res.end(JSON.stringify({ ok: true, service: "dtp-wa-channel", v: "0.4.0" }));
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

server.listen(PORT, "0.0.0.0", () => log("info", `dtp-wa-channel v0.4 listening on :${PORT}`));
process.on("SIGTERM", () => { log("info", "SIGTERM"); server.close(() => process.exit(0)); });
