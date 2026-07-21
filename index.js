/**
 * dtp-wa-channel v0.9 — Datipay WhatsApp channel (onboarding U0 · PIN auth · RBAC · dual-signature payouts)
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
const COLLECT_MOMO = process.env.WA_COLLECT_MOMO || "670 000 001";   // demo trésorier MTN number
const COLLECT_OM = process.env.WA_COLLECT_OM || "690 000 001";       // demo trésorier OM number
const PAY_MODE = process.env.DTP_PAY_MODE || "sim";                    // sim | real
const PAY_BASE = process.env.DTP_PAY_BASE || "";                       // NsengNkap engine API base
const PAY_TOKEN = process.env.DTP_PAY_TOKEN || "";
const PAY_SIM_MS = Number(process.env.DTP_PAY_SIM_MS || 6000);
const RENDER_BASE = process.env.DTP_RENDER_BASE || "http://dtp-render.datipay.svc.cluster.local";
const OFFICIAL_NUMBER = process.env.WA_OFFICIAL_NUMBER || "+1 (555) 181-1569";
const PRESIDENTS = (process.env.WA_PRESIDENT_NUMBERS || "").split(",").map(x=>x.trim()).filter(Boolean);
const roles = { president: new Set(PRESIDENTS), tresorier: new Set(TRESORIERS) };
const profiles = new Map(); // wa_id -> {name,ville,pinHash,salt,seal,consentAt,attempts,lockedUntil}  [B1: -> Postgres]
function prof(from){ let p=profiles.get(from); if(!p){p={attempts:0,lockedUntil:0}; profiles.set(from,p);} return p; }
function pinHash(pin,salt){ return crypto.scryptSync(pin,salt,32).toString("hex"); }
function setPin(p,pin){ p.salt=crypto.randomBytes(8).toString("hex"); p.pinHash=pinHash(pin,p.salt); }
function checkPin(p,pin){ if(Date.now()<p.lockedUntil) return "LOCKED";
  if(p.pinHash && pinHash(pin,p.salt)===p.pinHash){ p.attempts=0; return "OK"; }
  p.attempts=(p.attempts||0)+1; if(p.attempts>=5){ p.lockedUntil=Date.now()+30*60*1000; p.attempts=0; return "LOCKED"; }
  return "BAD"; }
function isRole(from,r){ return roles[r] && roles[r].has(from); }
let paySeq=1; const payouts=new Map(); // pid->{amt,initiator,status}
const audit=[]; let auditPrev="genesis";
function auditLog(actor,action,target,detail){ const e={at:new Date().toISOString(),actor,action,target,detail,prev:auditPrev};
  auditPrev=crypto.createHash("sha256").update(auditPrev+JSON.stringify(e)).digest("hex").slice(0,16); e.hash=auditPrev; audit.push(e); if(audit.length>5000)audit.shift();
  log("info","AUDIT",{actor,action,target,hash:e.hash}); }
const SEAL_ICONS = ["Kola","Tam-tam","Calebasse","Palmier","Étoile","Masque","Cauri","Soleil","Montagne","Coq","Pirogue","Tortue","Lion","Plantain","Gong","Poisson","Case","Lune","Maïs","Rivière"];

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
    payAsk: (amt, rail) => `Prêt à payer *${fmtXAF(amt)}* par *${rail}* — sans quitter WhatsApp ?`,
    bPayNow: "✅ Payer maintenant", bPayUssd: "📲 Par USSD moi-même",
    paying: (rail) => `⏳ *Paiement en cours via ${rail}...*\n_Si votre téléphone affiche une demande de confirmation, validez avec votre PIN._`,
    payFailed: "❌ Le paiement n'a pas abouti. Réessayez, ou payez par USSD (*MENU* → Cotiser).",
    railAuto: (rail, ref) => `Rail ${rail} · Réf ${ref}`,
    tresoFyi: (name, amt, rub, rail, ref) => `💰 *Paiement reçu — auto-vérifié* _(DÉMO)_\n\n*${name}* : *${fmtXAF(amt)}* · ${rub}\nVoie : ${rail}\nRéf rail : ${ref}\n\n_Aucune action requise — enregistré au registre._`,
    ussdMTN: (amt) => `📲 *Payez par MTN MoMo* _(DÉMO)_\n\nComposez sur votre téléphone :\n\`\`\`*126#\`\`\`\npuis suivez :\n1️⃣ Transfert d'argent\n👤 Numéro du trésorier : *${COLLECT_MOMO}*\n💰 Montant : *${fmtXAF(amt)}*\n🔐 Confirmez avec votre code PIN MoMo\n\nVous recevrez un SMS de MTN avec la *référence de transaction* — envoyez-la ici.`,
    ussdOM: (amt) => `📲 *Payez par Orange Money* _(DÉMO)_\n\nComposez sur votre téléphone :\n\`\`\`#150#\`\`\`\npuis suivez :\n1️⃣ Transfert d'argent\n👤 Numéro du trésorier : *${COLLECT_OM}*\n💰 Montant : *${fmtXAF(amt)}*\n🔐 Confirmez avec votre code secret\n\nVous recevrez un SMS d'Orange avec la *référence* — envoyez-la ici.`,
    cashGuide: (amt) => `🤝 *Espèces au trésorier* _(DÉMO)_\n\nRemettez *${fmtXAF(amt)}* en mains propres au trésorier.\nEnvoyez ensuite une note (ex : « remis à la réunion ») — ou passez.`,
    cuGuide: (amt) => `🏦 *Caisse populaire* _(DÉMO)_\n\nDéposez *${fmtXAF(amt)}* sur le compte du groupe et gardez le bordereau.\nEnvoyez le numéro du bordereau — ou passez.`,
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
    payAsk: (amt, rail) => `Prêt à payer *${fmtXAF(amt)}* par *${rail}* — sans quitter WhatsApp ?`,
    bPayNow: "✅ Payer maintenant", bPayUssd: "📲 Par USSD moi-même",
    paying: (rail) => `⏳ *Paiement en cours via ${rail}...*\n_Si votre téléphone affiche une demande de confirmation, validez avec votre PIN._`,
    payFailed: "❌ Le paiement n'a pas abouti. Réessayez, ou payez par USSD (*MENU* → Cotiser).",
    railAuto: (rail, ref) => `Rail ${rail} · Réf ${ref}`,
    tresoFyi: (name, amt, rub, rail, ref) => `💰 *Paiement reçu — auto-vérifié* _(DÉMO)_\n\n*${name}* : *${fmtXAF(amt)}* · ${rub}\nVoie : ${rail}\nRéf rail : ${ref}\n\n_Aucune action requise — enregistré au registre._`,
    payAsk: (amt, rail) => `Ready to pay *${fmtXAF(amt)}* via *${rail}* — without leaving WhatsApp?`,
    bPayNow: "✅ Pay now", bPayUssd: "📲 USSD myself",
    paying: (rail) => `⏳ *Payment in progress via ${rail}...*\n_If your phone shows a confirmation prompt, approve with your PIN._`,
    payFailed: "❌ The payment did not complete. Try again, or pay by USSD (*MENU* → Contribute).",
    railAuto: (rail, ref) => `Rail ${rail} · Ref ${ref}`,
    tresoFyi: (name, amt, rub, rail, ref) => `💰 *Payment received — auto-verified* _(DEMO)_\n\n*${name}*: *${fmtXAF(amt)}* · ${rub}\nRail: ${rail}\nRail ref: ${ref}\n\n_No action required — recorded in the ledger._`,
    ussdMTN: (amt) => `📲 *Pay with MTN MoMo* _(DEMO)_\n\nDial on your phone:\n\`\`\`*126#\`\`\`\nthen follow:\n1️⃣ Transfer money\n👤 Treasurer's number: *${COLLECT_MOMO}*\n💰 Amount: *${fmtXAF(amt)}*\n🔐 Confirm with your MoMo PIN\n\nMTN will SMS you a *transaction reference* — send it here.`,
    ussdOM: (amt) => `📲 *Pay with Orange Money* _(DEMO)_\n\nDial on your phone:\n\`\`\`#150#\`\`\`\nthen follow:\n1️⃣ Transfer money\n👤 Treasurer's number: *${COLLECT_OM}*\n💰 Amount: *${fmtXAF(amt)}*\n🔐 Confirm with your secret code\n\nOrange will SMS you a *reference* — send it here.`,
    cashGuide: (amt) => `🤝 *Cash to the treasurer* _(DEMO)_\n\nHand *${fmtXAF(amt)}* to the treasurer in person.\nThen send a note (e.g. "handed over at the meeting") — or skip.`,
    cuGuide: (amt) => `🏦 *Credit union* _(DEMO)_\n\nDeposit *${fmtXAF(amt)}* to the group's account and keep the slip.\nSend the deposit-slip number — or skip.`,
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
      const railIdx = Number(id.split("_")[1]);
      s.data.rail = RAILS[s.lang][railIdx - 1];
      if (railIdx <= 2) { // MoMo / OM: in-chat execution
        s.step = "await_pay";
        return replyI(from, s, btns(t.payAsk(s.data.amount, s.data.rail), [["pay_now", t.bPayNow], ["pay_ussd", t.bPayUssd]]));
      }
      s.step = "await_ref";
      const guides = [null, null, t.cashGuide, t.cuGuide];
      await reply(from, s, guides[railIdx - 1](s.data.amount));
      return replyI(from, s, btns(t.askRef, [["ref_skip", t.bSkipRef]]));
    }
    case id === "pay_now": {
      if (s.step !== "await_pay" || !s.data.amount) return sendMenu(from, s);
      const { amount, rail } = s.data; const rub = s.data.rub || RUB.rub_cot[s.lang];
      s.step = "idle"; s.data = {};
      await reply(from, s, t.paying(rail));
      const result = await payExecute({ amount, rail, memberWa: from });
      if (result.status !== "COMPLETED") {
        log("warn", "payment failed", { from, amount, rail, error: result.error });
        return reply(from, s, t.payFailed);
      }
      const ref = `DTP-RCT-2026-${String(rctSeq++).padStart(6, "0")} (DEMO)`;
      log("info", "payment COMPLETED via rail", { from, amount, rail, railRef: result.ref, ref });
      const okImg = await sendImageReceipt(from, receiptRenderData(amount, rub, rail, ref, "CONFIRMED", t.railAuto(rail, result.ref), s),
        s.lang === "fr" ? `✅ Reçu confirmé — ${fmtXAF(amount)} · ${rub}` : `✅ Confirmed receipt — ${fmtXAF(amount)} · ${rub}`);
      if (!okImg) await reply(from, s, t.receipt(amount, rub, rail, ref, t.railAuto(rail, result.ref)));
      for (const tres of TRESORIERS) {
        if (tres === from) continue;
        await sendText(tres, t.tresoFyi(s.name || from, amount, rub, rail, result.ref)).catch(() => {});
      }
      return;
    }
    case id === "pay_ussd": {
      if (s.step !== "await_pay" || !s.data.amount) return sendMenu(from, s);
      s.step = "await_ref";
      const idx = RAILS[s.lang].indexOf(s.data.rail);
      await reply(from, s, (idx === 1 ? t.ussdOM : t.ussdMTN)(s.data.amount));
      return replyI(from, s, btns(t.askRef, [["ref_skip", t.bSkipRef]]));
    }
    case id === "ref_skip": {
      if (s.step !== "await_ref") return sendMenu(from, s);
      return submitDeclaration(from, s, null);
    }
    case id.startsWith("conf_") || id.startsWith("rej_"): {
      return handleTresorier(from, s, id);
    }
    case id === "ob_keepname": { const p=prof(from); p.name = s.name || "Membre"; s.step="ob_ville"; return reply(from, s, s.lang==="fr"?"Votre ville / quartier ?":"Your city / neighborhood?"); }
    case id === "ob_typename": { s.step="ob_name_type"; return reply(from, s, s.lang==="fr"?"Tapez votre nom d'affichage :":"Type your display name:"); }
    case id.startsWith("obsp_"): { return sendSealPage(from, s, Number(id.slice(5)) || 0); }
    case id.startsWith("obsi_"): { s.data.sealIcon = id.slice(5); s.step="ob_seal_word"; return reply(from, s, s.lang==="fr"?`Icône : ${s.data.sealIcon}. Maintenant votre *mot secret* (jamais partagé) :`:`Icon: ${s.data.sealIcon}. Now your *secret word* (never shared):`); }
    case id === "ob_consent_yes": { const p=prof(from); p.consentAt=Date.now(); s.step="idle"; auditLog(from,"CONSENT","self",{});
      await reply(from, s, s.lang==="fr"?`🪪 Profil créé — ${p.name||""} · ${p.ville||""}\nSceau : • ${p.seal} •\nVos actions sensibles exigeront votre PIN.`:`🪪 Profile created — ${p.name||""} · ${p.ville||""}\nSeal: • ${p.seal} •\nSensitive actions will require your PIN.`);
      return sendMenu(from, s); }
    case id.startsWith("cosign_"): {
      if (!isRole(from,"president")) { auditLog(from,"DENY","payout.cosign",{}); return; }
      s.pinCtx={action:"payout.cosign",payload:{pid:id.slice(7)}}; s.step="await_pin";
      return reply(from, s, s.lang==="fr"?"🔐 Entrez votre PIN pour contre-signer.":"🔐 Enter your PIN to co-sign."); }
    case id.startsWith("rejpay_"): { if(!isRole(from,"president"))return; const pid=id.slice(7); payouts.delete(pid); auditLog(from,"PAYOUT_REJECTED",pid,{}); return reply(from,s,s.lang==="fr"?`Dossier ${pid} rejeté.`:`Case ${pid} rejected.`); }
    case id.startsWith("raccept_"): { s.pinCtx={action:"role.accept",payload:{role:id.slice(8)}}; s.step="await_pin";
      return reply(from, s, s.lang==="fr"?"🔐 Entrez votre PIN pour accepter la fonction.":"🔐 Enter your PIN to accept the role."); }
    case id.startsWith("rrefuse_"): { auditLog(from,"ROLE_REFUSED",id.slice(8),{}); return reply(from,s,s.lang==="fr"?"Fonction refusée.":"Role refused."); }
    default: return sendMenu(from, s);
  }
}

async function submitDeclaration(from, s, refTxt) {
  const t = T[s.lang];
  const amt = s.data.amount, rub = s.data.rub || RUB.rub_cot[s.lang], rail = s.data.rail;
  s.step = "idle"; s.data = {};
  if (!amt || !rail) return sendMenu(from, s);
  const pid = `DTP-PND-${String(pendSeq++).padStart(4, "0")}`;
  const rec = { from, name: s.name || from, amt, rub, rail, refTxt, lang: s.lang, seal: s.seal || null, at: Date.now() };
  if (!TRESORIERS.length) {
    // honest demo fallback: label the auto-confirmation as such
    const ref = `DTP-RCT-2026-${String(rctSeq++).padStart(6, "0")} (DEMO)`;
    log("info", "receipt auto-confirmed (no tresorier configured)", { from, amt, rub, rail, ref });
    await reply(from, s, t.receipt(amt, rub, rail, ref, "AUTO"));
    return reply(from, s, t.noTreso);
  }
  pendings.set(pid, rec);
  log("info", "declaration pending", { pid, from, amt, rub, rail, refTxt });
  const okP = await sendImageReceipt(from, receiptRenderData(amt, rub, rail, pid, "PENDING", s.lang === "fr" ? "En attente du trésorier" : "Awaiting treasurer", s),
    s.lang === "fr" ? `⏳ Déclaration ${pid} — en attente de vérification` : `⏳ Declaration ${pid} — awaiting verification`);
  if (!okP) await reply(from, s, t.pending(amt, rub, rail, pid));
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
    const okImg = await sendImageReceipt(rec.from, receiptRenderData(rec.amt, rec.rub, rec.rail, ref, "CONFIRMED", mt.confirmedByTreso, rec),
      rec.lang === "fr" ? `✅ Reçu confirmé — ${fmtXAF(rec.amt)} · ${rec.rub}` : `✅ Confirmed receipt — ${fmtXAF(rec.amt)} · ${rec.rub}`);
    if (!okImg) await sendText(rec.from, mt.receipt(rec.amt, rec.rub, rec.rail, ref, mt.confirmedByTreso)).catch(() => {});
    return reply(from, s, t.tresoDone(pid));
  }
  log("info", "declaration REJECTED by tresorier", { pid, by: from });
  await sendText(rec.from, mt.rejected(pid)).catch(() => {});
  return reply(from, s, t.tresoRejDone(pid));
}

async function sendSealPage(from, s, page) {
  const fr = s.lang === "fr";
  const per = 9;
  const slice = SEAL_ICONS.slice(page * per, page * per + per);
  const rows = slice.map((n) => ({ id: "obsi_" + n, title: n }));
  if ((page + 1) * per < SEAL_ICONS.length) rows.push({ id: "obsp_" + (page + 1), title: fr ? "➡️ Plus d'icônes" : "➡️ More icons" });
  return replyI(from, s, { type: "list", body: { text: fr ? `Choisissez votre *icône de sceau* (${page + 1}/${Math.ceil(SEAL_ICONS.length / per)}) — anti-fraude, elle apparaîtra sur vos cartes.` : `Choose your *seal icon* (${page + 1}/${Math.ceil(SEAL_ICONS.length / per)}) — anti-fraud, it will appear on your cards.` },
    action: { button: fr ? "Choisir" : "Choose", sections: [{ title: "Datipay", rows }] } });
}

async function onboarding(from, s, p, raw, text, contactName) {
  const fr = s.lang === "fr";
  switch (s.step) {
    case "idle": case "ob_start": default: {
      s.step = "ob_name";
      await reply(from, s, fr ? "👋 Bienvenue chez Datipay — créons votre profil en 60 secondes." : "👋 Welcome to Datipay — let's create your profile in 60 seconds.");
      return replyI(from, s, btns(fr ? `Votre nom d'affichage : *${contactName || "?"}* — le garder ?` : `Your display name: *${contactName || "?"}* — keep it?`, [["ob_keepname", fr ? "✅ Garder" : "✅ Keep"], ["ob_typename", fr ? "✏️ Autre nom" : "✏️ Other name"]]));
    }
    case "ob_name_type": p.name = raw.slice(0, 40); s.step = "ob_ville"; return reply(from, s, fr ? "Votre ville / quartier ?" : "Your city / neighborhood?");
    case "ob_ville": p.ville = raw.slice(0, 40); s.step = "ob_pin";
      return reply(from, s, fr ? "Choisissez un *PIN à 4-6 chiffres* (pour signer les actions sensibles).\n_⚠ Mode démo : saisi dans le chat — supprimez votre message après envoi. Les formulaires chiffrés arrivent._" : "Choose a *4-6 digit PIN* (to sign sensitive actions).\n_⚠ Demo mode: typed in chat — delete your message after sending. Encrypted forms are coming._");
    case "ob_pin": { const pin = raw.replace(/\D/g, ""); if (!/^\d{4,6}$/.test(pin)) return reply(from, s, fr ? "4 à 6 chiffres svp." : "4-6 digits please.");
      s.data.pin1 = pin; s.step = "ob_pin2"; return reply(from, s, fr ? "Confirmez le PIN." : "Confirm the PIN."); }
    case "ob_pin2": { const pin = raw.replace(/\D/g, ""); if (pin !== s.data.pin1) { s.step = "ob_pin"; s.data = {}; return reply(from, s, fr ? "Les PIN ne correspondent pas — recommencez." : "PINs don't match — try again."); }
      setPin(p, pin); s.data = {}; s.step = "ob_seal_icon"; auditLog(from, "PIN_SET", "self", {});
      return sendSealPage(from, s, 0); }
    case "ob_seal_word": { const w = raw.trim().slice(0, 20); if (w.length < 2) return reply(from, s, fr ? "Un mot d'au moins 2 lettres." : "A word of at least 2 letters.");
      s.seal = (s.data.sealIcon || "KOLA").toUpperCase() + " + " + w.toUpperCase(); p.seal = s.seal; s.data = {}; s.step = "ob_consent";
      return replyI(from, s, btns(fr ? `Sceau : • ${s.seal} •\n\nDatipay est un service de registre (pas une banque). Vos données servent uniquement au fonctionnement du service. Politique : datipay.com/privacy` : `Seal: • ${s.seal} •\n\nDatipay is a record-keeping service (not a bank). Your data is used only to run the service. Policy: datipay.com/privacy`, [["ob_consent_yes", fr ? "✅ J'accepte" : "✅ I agree"]])); }
    default2: break;
  }
  return null;
}

async function dispatchPrivileged(from, s, ctx) {
  const fr = s.lang === "fr"; const p = prof(from);
  if (ctx.action === "payout.initiate") {
    const pid = "DTP-PAYOUT-" + String(paySeq++).padStart(4, "0");
    payouts.set(pid, { amt: ctx.payload.amt, initiator: from, initiatorName: p.name || from, status: "AWAITING_COSIGN" });
    auditLog(from, "PAYOUT_INITIATED", pid, { amt: ctx.payload.amt });
    await reply(from, s, fr ? `✍️ 1re signature apposée. En attente de la contre-signature du président — dossier ${pid}.` : `✍️ 1st signature applied. Awaiting the president's co-signature — case ${pid}.`);
    for (const pres of roles.president) {
      await sendInteractive(pres, btns((fr ? `🖋 *Contre-signature requise*\n\nRamassage ${fmtXAF(ctx.payload.amt)}\nInitié par le trésorier · PIN ✓\nDossier ${pid}` : `🖋 *Co-signature required*\n\nPayout ${fmtXAF(ctx.payload.amt)}\nInitiated by treasurer · PIN ✓\nCase ${pid}`), [["cosign_" + pid, fr ? "✍️ Contre-signer" : "✍️ Co-sign"], ["rejpay_" + pid, "❌"]])).catch(() => {});
    }
    return;
  }
  if (ctx.action === "payout.cosign") {
    const rec = payouts.get(ctx.payload.pid);
    if (!rec || rec.status !== "AWAITING_COSIGN") return reply(from, s, fr ? "Dossier introuvable ou déjà traité." : "Case not found or already handled.");
    rec.status = "EXECUTING"; auditLog(from, "PAYOUT_COSIGNED", ctx.payload.pid, {});
    await reply(from, s, fr ? "✍️ Contre-signature apposée — exécution via le gateway..." : "✍️ Co-signed — executing via the gateway...");
    const result = await payExecute({ amount: rec.amt, rail: "MTN MoMo", memberWa: rec.initiator });
    rec.status = result.status;
    const vb = (fr ? "Double signature : Trésorier ✓ · Président ✓ · Réf " : "Dual signature: Treasurer ✓ · President ✓ · Ref ") + (result.ref || "—");
    const capt = fr ? `🏆 Certificat de ramassage — ${fmtXAF(rec.amt)}` : `🏆 Payout certificate — ${fmtXAF(rec.amt)}`;
    for (const to of new Set([rec.initiator, from])) {
      const ok = await sendImageReceipt(to, { amount: fmtXAF(rec.amt), rubrique: fr ? "Ramassage — Bénéficiaire Membre 07" : "Payout — Beneficiary Member 07", rail: "MTN MoMo", member: ctx.payload.pid, ref: ctx.payload.pid, paidLine: "Cycle 4 · 18/18", status: "CONFIRMED", verifiedBy: vb, sealWord: sessions.get(to)?.seal || prof(to).seal || null, demo: true }, capt);
      if (!ok) await sendText(to, capt + "\n" + vb).catch(() => {});
    }
    auditLog("system", "PAYOUT_" + result.status, ctx.payload.pid, { ref: result.ref });
    return;
  }
  if (ctx.action === "role.appoint") {
    const { role, target } = ctx.payload;
    auditLog(from, "ROLE_OFFERED", target, { role });
    await reply(from, s, fr ? `Invitation envoyée à ${target} pour la fonction de ${role} — en attente de son acceptation (PIN).` : `Invitation sent to ${target} for the ${role} role — awaiting their acceptance (PIN).`);
    await sendInteractive(target, btns((fr ? `🎖 Le président vous nomme *${role}*. Acceptez-vous cette fonction et ses responsabilités ?` : `🎖 The president appoints you *${role}*. Do you accept this role and its duties?`), [["raccept_" + role, fr ? "✅ Accepter" : "✅ Accept"], ["rrefuse_" + role, "❌"]])).catch(() => {});
    return;
  }
  if (ctx.action === "role.accept") {
    roles[ctx.payload.role].add(from);
    auditLog(from, "ROLE_ACCEPTED", ctx.payload.role, {});
    return reply(from, s, fr ? `🎖 Fonction *${ctx.payload.role}* activée. Vos actions sont signées et journalisées.` : `🎖 Role *${ctx.payload.role}* active. Your actions are signed and audit-logged.`);
  }
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
  log("info", "inbound text", { from, name: contactName, text: (s.step && (s.step.includes("pin") || s.step === "await_pin")) ? "***" : raw, step: s.step });

  s.lang = detectLang(raw, s);
  const t = T[s.lang];
  const p = prof(from);
  const fr = s.lang === "fr";
  if (/^stop$/i.test(text)) { s.optOut = true; s.step = "idle"; return reply(from, s, t.stopped); }

  // ---- PIN step-up interception (never echo, hash immediately) ----
  if (s.step === "await_pin") {
    const pin = raw.replace(/\D/g, "");
    s.step = "idle";
    if (!/^\d{4,6}$/.test(pin)) return reply(from, s, fr ? "PIN invalide (4-6 chiffres). Action annulée — recommencez." : "Invalid PIN (4-6 digits). Action cancelled — try again.");
    const res = checkPin(p, pin);
    if (res === "LOCKED") { auditLog(from,"PIN_LOCKED",s.pinCtx?.action,{}); return reply(from, s, fr ? "🔒 Compte verrouillé 30 min après échecs répétés." : "🔒 Locked 30 min after repeated failures."); }
    if (res === "BAD") { auditLog(from,"PIN_FAIL",s.pinCtx?.action,{}); return reply(from, s, fr ? `PIN incorrect (${p.attempts}/5).` : `Wrong PIN (${p.attempts}/5).`); }
    const ctx = s.pinCtx; s.pinCtx = null;
    auditLog(from, "PIN_OK", ctx.action, {});
    return dispatchPrivileged(from, s, ctx);
  }

  // ---- Onboarding U0 ----
  if (!p.consentAt || s.step.startsWith("ob_")) {
    return onboarding(from, s, p, raw, text, contactName);
  }

  // ---- Officer commands (RBAC-guarded, PIN step-up) ----
  const mRam = text.match(/^(ramassage|payout)\s+(\d[\d\s]*)$/);
  if (mRam) {
    if (!isRole(from, "tresorier")) { auditLog(from,"DENY","payout.initiate",{}); return reply(from, s, fr ? "⛔ Réservé au trésorier." : "⛔ Treasurer only."); }
    const amt = Number(mRam[2].replace(/\s/g, ""));
    s.pinCtx = { action: "payout.initiate", payload: { amt } }; s.step = "await_pin";
    return reply(from, s, fr ? `🔐 Ramassage de ${fmtXAF(amt)} — entrez votre PIN pour signer (1re signature).` : `🔐 Payout of ${fmtXAF(amt)} — enter your PIN to sign (1st signature).`);
  }
  const mNom = text.match(/^(nommer|appoint)\s+(tresorier|president)\s+(\d{8,15})$/);
  if (mNom) {
    if (!isRole(from, "president")) { auditLog(from,"DENY","role.appoint",{}); return reply(from, s, fr ? "⛔ Réservé au président." : "⛔ President only."); }
    s.pinCtx = { action: "role.appoint", payload: { role: mNom[2], target: mNom[3] } }; s.step = "await_pin";
    return reply(from, s, fr ? `🔐 Nomination ${mNom[2]} → ${mNom[3]} — entrez votre PIN.` : `🔐 Appoint ${mNom[2]} → ${mNom[3]} — enter your PIN.`);
  }
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

  // SEAL setup: "SCEAU Tam-tam KOLA" / "SEAL Drum KOLA"
  const mSeal = raw.match(/^(sceau|seal)\s+(\S+)\s+(\S{2,20})$/i);
  if (mSeal) {
    const icon = SEAL_ICONS.find(x => x.toLowerCase() === mSeal[2].toLowerCase());
    if (!icon) return reply(from, s, (s.lang === "fr" ? "Icône inconnue. Choisissez : " : "Unknown icon. Choose: ") + SEAL_ICONS.join(" · "));
    s.seal = icon.toUpperCase() + " + " + mSeal[3].toUpperCase();
    log("info", "seal set", { from });
    return reply(from, s, s.lang === "fr"
      ? `🔏 Sceau enregistré : • ${s.seal} • — il apparaîtra sur chaque carte qui vous est destinée. Ne le partagez jamais.`
      : `🔏 Seal saved: • ${s.seal} • — it will appear on every card sent to you. Never share it.`);
  }
  if (/^(securite|sécurité|security)$/i.test(text)) {
    return reply(from, s, s.lang === "fr"
      ? `🛡 *Sécurité Datipay*\nNuméro officiel : ${OFFICIAL_NUMBER}\nVotre sceau : ${s.seal ? "• " + s.seal + " •" : "non défini — envoyez SCEAU <icône> <mot>"}\nDatipay ne demande JAMAIS votre PIN ni votre sceau.\nVérifiez tout reçu via son QR → datipay.com`
      : `🛡 *Datipay Security*\nOfficial number: ${OFFICIAL_NUMBER}\nYour seal: ${s.seal ? "• " + s.seal + " •" : "not set — send SEAL <icon> <word>"}\nDatipay NEVER asks for your PIN or seal.\nVerify any receipt via its QR → datipay.com`);
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
// ---------- dtp-pay: NsengNkap payments engine contract (DTP-PAY-001 Tier B) ----------
async function payExecute({ amount, rail, memberWa }) {
  if (PAY_MODE === "sim") {
    await new Promise((r) => setTimeout(r, PAY_SIM_MS));
    const ref = (rail.startsWith("MTN") ? "MT" : "OM") + String(Math.floor(100000000 + Math.random() * 899999999));
    return { status: "COMPLETED", ref, sim: true };
  }
  try {
    const res = await fetch(`${PAY_BASE}/payments/deposit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to_number: memberWa, amount, product_type: "SAVINGS_DEPOSIT", product_id: "njangi_group_demo", metadata: { rail, source: "whatsapp" } }),
    });
    const j = await res.json();
    if (!res.ok) return { status: "FAILED", error: j?.message || res.status };
    const txid = j.transaction_id;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`${PAY_BASE}/payments/transactions/${txid}`, { headers: { Authorization: `Bearer ${PAY_TOKEN}` } }).then((r) => r.json()).catch(() => null);
      if (st?.status === "COMPLETED") return { status: "COMPLETED", ref: st.mtn_reference || txid };
      if (st?.status === "FAILED") return { status: "FAILED", error: "gateway reported failure" };
    }
    return { status: "FAILED", error: "timeout" };
  } catch (e) { return { status: "FAILED", error: String(e) }; }
}

async function sendImageReceipt(to, data, caption) {
  try {
    const rres = await fetch(`${RENDER_BASE}/render/receipt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!rres.ok) throw new Error("render " + rres.status);
    const verifyUrl = rres.headers.get("x-verify-url") || "";
    const png = Buffer.from(await rres.arrayBuffer());
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/png");
    form.append("file", new Blob([png], { type: "image/png" }), "datipay-receipt.png");
    const ures = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/media`, { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: form });
    const uj = await ures.json().catch(() => ({}));
    if (!ures.ok || !uj.id) throw new Error("media upload " + ures.status + " " + (uj.error?.message || ""));
    const cap = caption + (verifyUrl ? `\n🔎 ${verifyUrl}` : "");
    const sres = await fetch(`${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`, { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "image", image: { id: uj.id, caption: cap } }) });
    const sj = await sres.json().catch(() => ({}));
    if (!sres.ok) throw new Error("image send " + sres.status);
    log("info", "image receipt sent", { to, mediaId: uj.id, verifyUrl, msgId: sj.messages?.[0]?.id });
    return true;
  } catch (e) { log("warn", "image receipt failed, falling back to text", { err: String(e) }); return false; }
}

function receiptRenderData(amtNum, rub, rail, ref, status, verifiedBy, s) {
  return { amount: fmtXAF(amtNum), rubrique: rub, rail, member: "DTP-MBR-2026-0012", ref,
    paidLine: "Cycle 4 · 14/18 payés", status, verifiedBy, demo: true,
    sealWord: s && s.seal ? s.seal : null };
}

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
    return res.end(JSON.stringify({ ok: true, service: "dtp-wa-channel", v: "0.9.1" }));
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

server.listen(PORT, "0.0.0.0", () => log("info", `dtp-wa-channel v0.9.1 listening on :${PORT}`));
process.on("SIGTERM", () => { log("info", "SIGTERM"); server.close(() => process.exit(0)); });
