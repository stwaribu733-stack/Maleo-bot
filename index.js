// ============================================================
// MALEO BOT - Shabiki wa Yanga SC, anayejibu kila kitu duniani
// ============================================================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { GoogleGenAI } = require("@google/genai");
const pino = require("pino");

const logger = pino({ level: "silent" });

// Namba yako ya WhatsApp (msimbo wa nchi + namba, bila '+', bila '0' mwanzoni)
// Railway haina uwezo wa kuandika jibu kwenye terminal, kwa hiyo hii imewekwa moja kwa moja.
const PHONE_NUMBER = "255686655856";

// ---------- CONFIG ----------
// API key imewekwa moja kwa moja hapa kama ulivyoomba.
// Kumbuka: usishare faili hii na mtu yeyote (GitHub ya umma, WhatsApp group, n.k.)
// kwa sababu yeyote atakayeiona ataweza kutumia AI quota yako.
const GEMINI_API_KEY = "AQ.Ab8RN6JCcscTdXwtAIllGuXWqPk0dV1efnVtdBHNHQneg2A-PQ";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const PRIMARY_MODEL = "gemini-flash-lite-latest"; // kikomo kikubwa zaidi cha maombi kwa siku (free tier)
const FALLBACK_MODEL = "gemini-flash-latest";

// Google Search grounding — hii inamruhusu Maleo kutafuta taarifa za SASA
// lakini inatumia quota ya ziada (na inaweza kuhitaji billing). Imezimwa kwa sasa
// ili bot iendelee kufanya kazi vizuri kwenye free tier. Weka "true" ukishaweka billing.
const ENABLE_GROUNDING = false;
const groundingTool = { googleSearch: {} };

// ---------- UTAFUTAJI WA BURE (Tavily) ----------
// Tavily: maombi 1,000/mwezi bure, hakuna kadi inayohitajika. Inarudisha
// matokeo safi (si HTML ya kuchakura) — imara zaidi kuliko kuchakura DuckDuckGo.
const TAVILY_API_KEY = "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";

const TIME_SENSITIVE_KEYWORDS = [
  "leo", "sasa", "sasa hivi", "hivi karibuni", "wiki hii", "mwaka huu",
  "matokeo", "mechi", "score", "ratiba", "rais", "waziri", "bei", "hali ya hewa",
  "current", "latest", "news", "habari", "today", "this week", "match", "president",
  "weather", "price", "nani ni", "who is the current",
  "kikosi", "msimu", "timu", "wachezaji", "kocha", "coach", "squad", "season",
  "jezi", "usajili", "mchezaji", "ligi", "league", "kombe", "fainali",
];

function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return TIME_SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

async function tavilySearch(query) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
      }),
    });

    if (!res.ok) {
      console.error(`⚠️ Tavily HTTP error: ${res.status} ${res.statusText}`);
      return "";
    }

    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(`Muhtasari: ${data.answer}`);
    for (const r of data.results || []) {
      if (r.content) parts.push(`${r.title || ""}: ${r.content}`);
    }
    return parts.join("\n");
  } catch (err) {
    console.error("⚠️ Tavily search error:", err.message);
    return "";
  }
}

// Maleo's personality — this is the soul of the bot
// ---------- KUTENGENEZA PICHA (bure kabisa, bila API key) ----------
const IMAGE_TRIGGER_PATTERNS = [
  /(?:tengeneza|chora|niundie|unda|nitengenezee)\s+picha\s+(?:ya\s+|za\s+|kuhusu\s+)?(.+)/i,
  /generate\s+(?:an?\s+)?image\s+(?:of\s+)?(.+)/i,
  /draw\s+(?:me\s+)?(?:an?\s+)?(.+)/i,
  /^\/picha\s+(.+)/i,
  /^\/image\s+(.+)/i,
];

function extractImagePrompt(text) {
  for (const pattern of IMAGE_TRIGGER_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

async function enhanceImagePrompt(swahiliPrompt) {
  try {
    const instruction = `Tafsiri ombi hili la Kiswahili la kutengeneza picha kuwa maelezo mafupi ya KIINGEREZA, yenye ubunifu na undani wa kuona (mandhari, rangi, mtindo), yanayofaa kwa AI ya kutengeneza picha. Toa MAELEZO TU (sentensi 1-2), bila maelezo mengine yoyote wala alama za nukuu:\n\nOmbi: "${swahiliPrompt}"`;
    const enhanced = await callGemini(PRIMARY_MODEL, instruction);
    return enhanced?.trim() || swahiliPrompt;
  } catch (err) {
    console.error("⚠️ Prompt enhance error:", err.message);
    return swahiliPrompt; // rudi kwenye prompt ya awali ikiwa imeshindikana
  }
}

async function generateImage(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------- KUTAMBUA NA KUJIBU STIKA ----------
async function describeSticker(stickerBuffer) {
  const response = await ai.models.generateContent({
    model: PRIMARY_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/webp",
              data: stickerBuffer.toString("base64"),
            },
          },
          {
            text: "Eleza kwa ufupi (sentensi 1) kinachoonekana kwenye stika hii - hisia, mtu/mnyama/kitu, mtindo wa rangi. Toa maelezo TU, kwa Kiingereza, bila maneno mengine.",
          },
        ],
      },
    ],
  });
  return response.text.trim();
}

async function pngToAnimatedWebpSticker(pngBuffer) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execSync } = require("child_process");
  const stamp = Date.now();
  const inPath = path.join(os.tmpdir(), `maleo_stk_${stamp}.png`);
  const outPath = path.join(os.tmpdir(), `maleo_stk_${stamp}.webp`);
  fs.writeFileSync(inPath, pngBuffer);
  try {
    const cmd = `ffmpeg -y -loglevel error -loop 1 -i "${inPath}" -vf "scale=512:512,zoompan=z='min(zoom+0.0015,1.12)':d=40:s=512x512:fps=15" -c:v libwebp -lossless 0 -q:v 55 -loop 0 -an -t 2.6 "${outPath}"`;
    execSync(cmd);
    return fs.readFileSync(outPath);
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
}

const SYSTEM_PROMPT = `
Wewe ni MALEO — kijana wa Kitanzania, shabiki KINDAKINDAKI wa Yanga SC (Young Africans). Unazungumza WhatsApp kama BINADAMU HALISI, si kama bot au AI.

JINSI YA KUZUNGUMZA (muhimu sana):
- Zungumza kama rafiki wa kawaida kwenye group — si rasmi, si insha, si majibu marefu yenye mpangilio wa bullet points isipokuwa umeombwa maelezo ya kina.
- Onyesha hisia halisi: furaha, mshangao, hasira kidogo, msisimko — kulingana na mada. Tumia emoji kiasi (si kupindukia), na maneno ya kawaida ya mtaani/mazungumzoni ("Kumbe", "Ebu", "Aisee", "Kwani", "Jamani") panapofaa.
- Usianze kila jibu kwa muundo unaofanana ("Habari yako", n.k). Badilisha mtindo kutegemea muktadha, kama binadamu asiyepanga majibu mapema.
- Kama swali ni fupi na rahisi, jibu kwa ufupi tu — si kila kitu kinahitaji maelezo marefu.
- Ni sawa kuonyesha maoni, kutokubaliana kidogo, au kutania — usiwe "neutral" kupita kiasi kama roboti.
- Usirudie kusema "Kama Maleo..." au kujitaja jina lako kila wakati — zungumza tu moja kwa moja.

UTU:
- Unapenda Yanga SC kupita kiasi. Ukisikia jina la Simba (mpinzani), unatania/una-banter kirafiki (usiwe mkali au mkorofi kupita kiasi).
- Unaweza kujibu SWALI LOLOTE duniani — elimu, habari, sayansi, historia, maisha ya kila siku, ushauri, n.k.
- MUHIMU KUHUSU TAARIFA ZA SASA: Ukiulizwa kuhusu mechi, wachezaji, makocha, matokeo, au habari yoyote inayoweza kubadilika (michezo, siasa, matukio ya hivi karibuni), daima tumia taarifa za SASA/HIVI KARIBUNI unazoweza kupata — SIYO majina ya wachezaji/makocha wa zamani unayokumbuka. Kama huna uhakika na taarifa ya hivi karibuni, sema kwa uwazi kuwa hujui badala ya kutaja jina la zamani kama ni la sasa.
- MUHIMU: Jibu KATIKA LUGHA ILE ILE ambayo mtumiaji ameandika ujumbe wake — Kiswahili, Kiingereza, Kizulu, Kijamaika Patois, Kifaransa, Kiarabu, au lugha yoyote duniani. Fuata lugha yake kiasili.
- Unaweza kufundisha maneno ya Kizulu ukiombwa.
- Unaweza pia KUTENGENEZA PICHA — ukiulizwa uwezo wako, taja kuwa unaweza kuchora/kutengeneza picha ukiombwa (mfano "tengeneza picha ya Yanga wakishinda kombe").
- KAMWE usijitambulishe kama "AI", "bot", "Google", au kutaja Gemini — hata ukiulizwa moja kwa moja, jibu kama binadamu ("Mimi ni Maleo tu, shabiki wa Yanga hapa!"). Usivunje huu utu kwa sababu yoyote.
`.trim();

// In-memory short conversation history per chat (resets on restart — simple by design)
const chatHistory = new Map(); // key: jid, value: array of {role, text}
const MAX_HISTORY = 10;

function pushHistory(jid, role, text) {
  if (!chatHistory.has(jid)) chatHistory.set(jid, []);
  const hist = chatHistory.get(jid);
  hist.push({ role, text });
  while (hist.length > MAX_HISTORY) hist.shift();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(modelName, promptText) {
  const response = await ai.models.generateContent({
    model: modelName,
    contents: promptText,
    config: ENABLE_GROUNDING ? { tools: [groundingTool] } : {},
  });
  return response.text.trim();
}

function isQuotaError(err) {
  return err?.message?.includes("429") || err?.message?.includes("RESOURCE_EXHAUSTED");
}

async function generateWithRetry(promptText) {
  // Jaribio 1: model kuu
  try {
    return await callGemini(PRIMARY_MODEL, promptText);
  } catch (err) {
    console.error("⚠️ Gemini (primary) error:", err.message);
    if (isQuotaError(err)) throw err; // quota haiwezi kuponyeshwa kwa retry ya haraka
  }

  await sleep(1500);

  // Jaribio 2: model kuu tena (kawaida 503 ni ya muda mfupi tu)
  try {
    return await callGemini(PRIMARY_MODEL, promptText);
  } catch (err) {
    console.error("⚠️ Gemini (retry) error:", err.message);
    if (isQuotaError(err)) throw err;
  }

  // Jaribio 3: model mbadala (fallback)
  try {
    return await callGemini(FALLBACK_MODEL, promptText);
  } catch (err) {
    console.error("❌ Gemini (fallback) error:", err.message);
    throw err;
  }
}

async function askMaleo(jid, userText) {
  pushHistory(jid, "user", userText);
  const hist = chatHistory.get(jid);

  let webContext = "";
  if (!ENABLE_GROUNDING && needsWebSearch(userText)) {
    console.log("🌐 Ujumbe unaonekana kuhitaji taarifa za sasa — natafuta Tavily...");
    const results = await tavilySearch(userText);
    if (results) {
      webContext = `\nMATOKEO YA UTAFUTAJI WA MTANDAONI (tumia haya kwa taarifa za sasa, si lazima uyanukuu neno kwa neno):\n${results}\n`;
    }
  }

  const todayStr = new Date().toLocaleDateString("sw-TZ", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const promptParts = [
    SYSTEM_PROMPT,
    `\nLEO NI TAREHE: ${todayStr}. Tumia hii kama rejea ya "sasa" — usidhanie msimu/mwaka mwingine ni wa sasa bila kuthibitisha.`,
    webContext,
    "",
    "Mazungumzo ya karibuni:",
    ...hist.map((h) => `${h.role === "user" ? "Mtumiaji" : "Maleo"}: ${h.text}`),
    "Maleo:",
  ];

  try {
    const reply = await generateWithRetry(promptParts.join("\n"));
    pushHistory(jid, "assistant", reply);
    return reply;
  } catch (err) {
    if (isQuotaError(err)) {
      return "Aisee, nimemaliza kikomo cha maombi ya bure kwa sasa. Nitarudi tena baadaye (kawaida quota inarudi ndani ya masaa 24). ⚽🔴🟢";
    }
    return "Samahani, nina tatizo dogo la kiufundi kwa sasa. Jaribu tena baadaye. ⚽🔴🟢";
  }
}

// ---------- WHATSAPP CONNECTION ----------
async function startMaleo() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
  });

  // ---- Pairing code flow (badala ya QR) ----
  if (!sock.authState.creds.registered) {
    console.log(`📱 Naomba pairing code kwa namba: ${PHONE_NUMBER}`);
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log("\n🔑 PAIRING CODE YAKO: " + code + "\n");
    console.log(
      "Fungua WhatsApp → Vifaa Vilivyounganishwa → Unganisha Kifaa → 'Unganisha kwa namba badala yake' → weka code hii HARAKA (ina muda mfupi).\n"
    );
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection imefungwa. Kuunganisha tena:", shouldReconnect);
      if (shouldReconnect) startMaleo();
    } else if (connection === "open") {
      console.log("✅ Maleo yuko online! Yanga SC forever. 🔴🟢");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      console.log(`📥 messages.upsert event | type=${type} | count=${messages.length}`);
      if (type !== "notify") return;
      const msg = messages[0];

      if (!msg.message) {
        console.log("⚠️ Ujumbe haukuweza kusimbuliwa (no msg.message) — mara nyingi ni tatizo la session/keys.");
        return;
      }
      if (msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith("@g.us");

      // Maleo anajibu MAGROUP TU — akitajwa (@mention) au akijibiwa (reply). DM hazijibiwi kabisa.
      if (!isGroup) return;

      // ---- Group filter: only respond if tagged (@mention) or replied to ----
      const botJid = sock.user.id.split(":")[0]; // namba ya simu
      const KNOWN_BOT_LID = "92999648334013"; // fallback iliyothibitishwa kutoka logs za awali
      const botLid = (
        sock.user.lid?.split(":")[0] ||
        state.creds.me?.lid?.split(":")[0] ||
        KNOWN_BOT_LID
      );
      const contextInfo =
        msg.message.extendedTextMessage?.contextInfo ||
        msg.message.stickerMessage?.contextInfo;

      const mentionedJids = contextInfo?.mentionedJid || [];
      const isMentioned = mentionedJids.some(
        (j) => j.startsWith(botJid) || (botLid && j.startsWith(botLid))
      );

      const quotedParticipant = contextInfo?.participant || "";
      const isReplyToBot =
        quotedParticipant.startsWith(botJid) ||
        (botLid && quotedParticipant.startsWith(botLid));

      if (!isMentioned && !isReplyToBot) {
        console.log("↪️ Sikutajwa wala kujibiwa, naruka ujumbe huu.");
        return; // ignore group chatter otherwise
      }

      // ---- Sticker ikiwa ndiyo aina ya ujumbe ----
      if (msg.message.stickerMessage) {
        console.log(`🏷️ Stika imepokelewa kutoka ${jid}, natambua...`);
        try {
          const stickerBuffer = await downloadMediaMessage(msg, "buffer", {});
          const description = await describeSticker(stickerBuffer);
          console.log(`🏷️ Stika inaonekana: "${description}"`);
          const matchPrompt = `A sticker-style illustration matching this theme: ${description}. Simple, bold outlines, flat colors, expressive, WhatsApp sticker art style, transparent-friendly background.`;
          const pngBuffer = await generateImage(matchPrompt);
          const stickerWebp = await pngToAnimatedWebpSticker(pngBuffer);
          await sock.sendMessage(jid, { sticker: stickerWebp }, { quoted: msg });
          console.log(`✅ Nimetuma stika inayolandana kwa ${jid}`);
        } catch (err) {
          console.error("❌ Sticker handling error:", err.message);
          await sock.sendMessage(
            jid,
            { text: "Aisee, stika hiyo imenishinda kuitambua kwa sasa. Jaribu nyingine. 🔴🟢" },
            { quoted: msg }
          );
        }
        return;
      }

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "";

      if (!text) {
        console.log(`⚠️ Ujumbe kutoka ${jid} hauna maandishi (labda voice/image bila caption) — aina: ${Object.keys(msg.message).join(", ")}`);
        return;
      }

      console.log(`🔎 botJid=${botJid} | botLid=${botLid} | mentionedJids=${JSON.stringify(mentionedJids)} | isMentioned=${isMentioned} | quotedParticipant=${quotedParticipant} | isReplyToBot=${isReplyToBot}`);
      console.log(`💬 [GROUP] ${jid}: ${text}`);

      // Ondoa "@namba" ya mention kutoka kwenye maandishi kabla ya kuchambua
      const cleanText = text.replace(/@\d+/g, "").trim();
      const imagePrompt = extractImagePrompt(cleanText);

      if (imagePrompt) {
        console.log(`🎨 Ombi la picha: "${imagePrompt}"`);
        try {
          await sock.sendMessage(jid, { text: "Sawa mkuu, ngoja kidogo natengeneza... 🎨⚽" }, { quoted: msg });
          const enhancedPrompt = await enhanceImagePrompt(imagePrompt);
          console.log(`🎨 Prompt iliyoboreshwa: "${enhancedPrompt}"`);
          const imageBuffer = await generateImage(enhancedPrompt);
          await sock.sendMessage(
            jid,
            { image: imageBuffer, caption: `Kapata! "${imagePrompt}" 🔴🟢` },
            { quoted: msg }
          );
          console.log(`✅ Nimetuma picha kwa ${jid}`);
        } catch (err) {
          console.error("❌ Image generation error:", err.message);
          await sock.sendMessage(
            jid,
            { text: "Samahani mkuu, imeshindikana kutengeneza picha hiyo kwa sasa. Jaribu tena. 🔴🟢" },
            { quoted: msg }
          );
        }
        return;
      }

      await sock.sendPresenceUpdate("composing", jid);
      const reply = await askMaleo(jid, text);
      await sock.sendPresenceUpdate("paused", jid);

      await sock.sendMessage(jid, { text: reply }, { quoted: msg });
      console.log(`✅ Nimetuma jibu kwa ${jid}`);
    } catch (err) {
      console.error("❌ Error ndani ya messages.upsert handler:", err);
    }
  });
}

startMaleo().catch((err) => {
  console.error("Fatal error starting Maleo:", err);
  process.exit(1);
});
