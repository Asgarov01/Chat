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

const users = new Map();
const waiting = new Set();
const blocks = new Map();
const reports = new Map();
const bans = new Map();
const logs = new Map();
const snaps = [];

const html = fs.readFileSync(path.join(__dirname, "index.html"));

function verify(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const sig = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return null;
  try { return String(JSON.parse(p.get("user")).id); } catch { return null; }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.end("ok"); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/ws") return socket.destroy();
  const uid = verify(u.searchParams.get("d"));
  if (!uid) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, uid));
});

const send = (s, o) => { if (s.ws.readyState === 1) s.ws.send(JSON.stringify(o)); };

function onConnect(ws, uid) {
  const old = users.get(uid);
  if (old) { leave(old); try { old.ws.close(4000); } catch {} users.delete(uid); }

  const ban = bans.get(uid);
  if (ban && ban > Date.now()) {
    ws.send(JSON.stringify({ t: "banned", until: ban }));
    return ws.close(4003);
  }
  const s = { ws, uid, nick: "Gizli Dost #" + (1000 + Math.floor(Math.random() * 9000)),
              status: "idle", peer: null, room: null, times: [] };
  users.set(uid, s);
  send(s, { t: "hello", nick: s.nick, online: users.size });

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (d) => { try { handle(s, JSON.parse(d)); } catch {} });
  ws.on("close", () => { if (users.get(uid) === s) { leave(s); users.delete(uid); } });
  ws.on("error", () => {});
}

function leave(s, notify = true) {
  waiting.delete(s);
  if (s.status === "chat" && s.peer) {
    const p = s.peer;
    if (p.peer === s) {
      p.status = "idle"; p.peer = null; p.room = null;
      if (notify) send(p, { t: "left" });
    }
    if (s.room) { const r = s.room; setTimeout(() => logs.delete(r), 60000); }
  }
  s.status = "idle"; s.peer = null; s.room = null;
}

function find(s) {
  if (s.status === "chat") leave(s);
  waiting.delete(s);
  const mine = blocks.get(s.uid) || new Set();
  for (const o of waiting) {
    if (o === s || o.ws.readyState !== 1) continue;
    if (mine.has(o.uid) || (blocks.get(o.uid) || new Set()).has(s.uid)) continue;
    waiting.delete(o);
    const room = crypto.randomUUID().slice(0, 8);
    s.status = o.status = "chat";
    s.peer = o; o.peer = s;
    s.room = o.room = room;
    logs.set(room, []);
    send(s, { t: "matched", nick: o.nick });
    send(o, { t: "matched", nick: s.nick });
    return;
  }
  s.status = "waiting";
  waiting.add(s);
  send(s, { t: "waiting" });
}

function handle(s, m) {
  switch (m.t) {
    case "ping": return;
    case "find": return find(s);
    case "stop":
      if (s.status === "waiting") { waiting.delete(s); s.status = "idle"; }
      return;
    case "next": leave(s); return find(s);
    case "typing":
      if (s.status === "chat" && s.peer) send(s.peer, { t: "typing" });
      return;

    case "msg": {
      if (s.status !== "chat" || !s.peer) return;
      const text = String(m.text || "").trim().slice(0, MAX_LEN);
      if (!text) return;
      const now = Date.now();
      s.times = s.times.filter((x) => now - x < 5000);
      if (s.times.length >= 5) return send(s, { t: "warn", text: "Çox sürətli yazırsan, bir az gözlə." });
      if (LINK_RE.test(text)) return send(s, { t: "warn", text: "Link və istifadəçi adları göndərmək qadağandır." });
      s.times.push(now);
      send(s.peer, { t: "msg", text });
      const log = logs.get(s.room);
      if (log) { log.push({ from: s.uid, text, at: now }); if (log.length > 30) log.shift(); }
      return;
    }

    case "report": {
      if (s.status !== "chat" || !s.peer) return;
      const p = s.peer;
      const set = reports.get(p.uid) || new Set();
      set.add(s.uid);
      reports.set(p.uid, set);
      snaps.push({ at: Date.now(), reporter: s.uid, target: p.uid, log: logs.get(s.room) || [] });
      if (snaps.length > 200) snaps.shift();
      if (set.size >= REPORTS_TO_BAN) {
        const until = Date.now() + BAN_MS;
        bans.set(p.uid, until);
        reports.delete(p.uid);
        send(p, { t: "banned", until });
        p.ws.close(4003);
      }
      leave(s);
      return send(s, { t: "reported" });
    }

    case "block": {
      if (s.status !== "chat" || !s.peer) return;
      const set = blocks.get(s.uid) || new Set();
      set.add(s.peer.uid);
      blocks.set(s.uid, set);
      leave(s);
      return send(s, { t: "blocked" });
    }
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log("İşləyir:", PORT));
