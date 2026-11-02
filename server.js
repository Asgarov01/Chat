const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const MAX_LEN = 500;
const BAN_MS = 24 * 3600 * 1000;
const REPORTS_TO_BAN = 3;
const LINK_RE = /(https?:\/\/|www\.|t\.me|@\w{3,})/i;

// Yaddaşda saxlanılır (server yenidən başlayanda sıfırlanır)
const users = new Map();   // uid -> state
const waiting = new Set(); // gözləyənlər
const blocks = new Map();  // uid -> Set(uid)
const reports = new Map(); // target -> Set(reporter)
const bans = new Map();    // uid -> until
const logs = new Map();    // room -> son mesajlar
const snaps = [];          // şikayət snapshotları

const html = fs.readFileSync(path.join(__dirname, "index.html"));
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
const SECRET = crypto.createHash("sha256").update(BOT_TOKEN || "x").digest("hex").slice(0, 24);

async function tgApi(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { console.log("Telegram xətası:", e.message); }
}

function onUpdate(u) {
  const m = u.message;
