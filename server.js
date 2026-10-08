const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

/* ===========================================================
   DATABASE (JSON file persistence)
   =========================================================== */
class Database {
    constructor() {
        this.file = path.join(__dirname, 'data', 'db.json');
        this.data = this._load();
        this._nextMsgId = this.data.messages.length > 0
            ? Math.max(...this.data.messages.map(m => m.id)) + 1
            : 1;
        /* Simpan otomatis setiap 5 detik jika ada perubahan */
        this._dirty = false;
        this._timer = setInterval(() => { if (this._dirty) this._save(); }, 5000);
    }

    _load() {
        try {
            if (fs.existsSync(this.file)) {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                /* Pastikan semua field ada */
                return {
                    users: raw.users || [],
                    bannedIPs: raw.bannedIPs || [],
                    invites: raw.invites || [],
                    messages: raw.messages || []
                };
            }
        } catch (e) { console.error('DB load error:', e); }
        return { users: [], bannedIPs: [], invites: [], messages: [] };
    }

    _save() {
        try {
            const dir = path.dirname(this.file);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
            this._dirty = false;
        } catch (e) { console.error('DB save error:', e); }
    }

    markDirty() { this._dirty = true; }

    /* ----- Badge ----- */
    static getBadge(username) {
        const u = username.toLowerCase();
        if (u === 'ellnihdek') return { text: 'Dev Ganteng', cls: 'badge-dev' };
        if (['amaa', 'ama', 'salma', 'nathania'].includes(u)) return { text: 'Si Cantik', cls: 'badge-cute' };
        return null;
    }

    /* ----- User ----- */
    addUser(username, ip) {
        const token = crypto.randomBytes(32).toString('hex');
        const user = {
            id: crypto.randomUUID(),
            username,
            token,
            ip,
            badge: Database.getBadge(username),
            createdAt: new Date().toISOString()
        };
        this.data.users.push(user);
        this.markDirty();
        return user;
    }

    findByToken(token) { return this.data.users.find(u => u.token === token) || null; }
    findByUsername(username) { return this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null; }
    findAllUsers() { return this.data.users; }

    /* ----- Ban ----- */
    isIPBanned(ip) { return this.data.bannedIPs.some(b => b.ip === ip); }
    banIP(ip, by) {
        if (!this.isIPBanned(ip)) {
            this.data.bannedIPs.push({ ip, bannedBy: by, bannedAt: new Date().toISOString() });
            this.markDirty();
        }
    }
    unbanIP(ip) {
        this.data.bannedIPs = this.data.bannedIPs.filter(b => b.ip !== ip);
        this.markDirty();
    }

    /* ----- Invite ----- */
    createInvite(userId) {
        let code;
        do { code = 'ell-' + String(Math.floor(1000 + Math.random() * 9000)); }
        while (this.data.invites.find(i => i.code === code && !i.usedBy));
        const invite = { code, createdBy: userId, usedBy: null, createdAt: new Date().toISOString() };
        this.data.invites.push(invite);
        this.markDirty();
        return invite;
    }

    useInvite(code, userId) {
        const invite = this.data.invites.find(i => i.code === code && !i.usedBy);
        if (!invite) return null;
        invite.usedBy = userId;
        invite.usedAt = new Date().toISOString();
        this.markDirty();
        return invite;
    }

    findInviteByCode(code) { return this.data.invites.find(i => i.code === code && !i.usedBy) || null; }

    /* ----- Messages ----- */
    addMessage(username, text, badge, replyToId) {
        let replyTo = null;
        if (replyToId) {
            const found = this.data.messages.find(m => m.id === replyToId);
            if (found) {
                replyTo = {
                    id: found.id,
                    username: found.username,
                    text: found.text.length > 60 ? found.text.slice(0, 60) + '...' : found.text
                };
            }
        }
        const msg = {
            id: this._nextMsgId++,
            username, text, badge, replyTo,
            timestamp: new Date().toISOString()
        };
        this.data.messages.push(msg);
        if (this.data.messages.length > 500) this.data.messages = this.data.messages.slice(-500);
        this.markDirty();
        return msg;
    }

    getMessages(limit = 100) { return this.data.messages.slice(-limit); }
}

const db = new Database();

/* ===========================================================
   HELPERS
   =========================================================== */
function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
}

/* Simple rate limiter */
const rateLimits = {};
function rateLimit(ip, limit = 10, windowMs = 60000) {
    const now = Date.now();
    if (!rateLimits[ip]) rateLimits[ip] = [];
    rateLimits[ip] = rateLimits[ip].filter(t => now - t < windowMs);
    if (rateLimits[ip].length >= limit) return false;
    rateLimits[ip].push(now);
    return true;
}

/* ===========================================================
   EXPRESS
   =========================================================== */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* Register */
app.post('/api/register', (req, res) => {
    const ip = getClientIP(req);
    if (!rateLimit(ip, 5, 60000)) return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi nanti.' });
    if (db.isIPBanned(ip)) return res.status(403).json({ error: 'IP Anda telah di-ban.', banned: true });

    const { username } = req.body;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Username wajib diisi.' });
    const trimmed = username.trim().slice(0, 20);
    if (!trimmed) return res.status(400).json({ error: 'Username tidak valid.' });
    if (db.findByUsername(trimmed)) return res.status(409).json({ error: 'Username sudah dipakai.' });

    const user = db.addUser(trimmed, ip);
    console.log(`[REGISTER] ${trimmed} (${ip})`);
    res.json({ token: user.token, user: { username: user.username, badge: user.badge } });
});

/* Verify token (untuk auto-login saat refresh) */
app.post('/api/verify', (req, res) => {
    const ip = getClientIP(req);
    if (db.isIPBanned(ip)) return res.status(403).json({ error: 'IP Anda telah di-ban.', banned: true });

    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token diperlukan.' });
    const user = db.findByToken(token);
    if (!user) return res.status(401).json({ error: 'Token tidak valid.' });

    /* Update IP terbaru */
    user.ip = ip;
    db.markDirty();
    res.json({ user: { username: user.username, badge: user.badge } });
});

/* Create invite */
app.post('/api/invite', (req, res) => {
    const { token } = req.body;
    const user = db.findByToken(token);
    if (!user) return res.status(401).json({ error: 'Token tidak valid.' });

    const invite = db.createInvite(user.id);
    res.json({ code: invite.code });
});

/* Join via invite code */
app.post('/api/join', (req, res) => {
    const ip = getClientIP(req);
    if (db.isIPBanned(ip)) return res.status(403).json({ error: 'IP Anda telah di-ban.', banned: true });

    const { token, code } = req.body;
    const user = db.findByToken(token);
    if (!user) return res.status(401).json({ error: 'Token tidak valid.' });
    if (!code || !/^ell-\d{4}$/.test(code)) return res.status(400).json({ error: 'Kode tidak valid. Format: ell-XXXX' });

    const invite = db.useInvite(code, user.id);
    if (!invite) return res.status(404).json({ error: 'Kode invite tidak ditemukan atau sudah dipakai.' });

    /* Cari creator */
    const creator = db.data.users.find(u => u.id === invite.createdBy);
    res.json({
        success: true,
        partner: creator ? creator.username : 'Unknown',
        code: invite.code
    });
});

/* Fallback: serve index.html untuk SPA */
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ===========================================================
   HTTP SERVER + WEBSOCKET
   =========================================================== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map(); // ws => { user, ip }

function broadcast(data, excludeWs, badgeOnly = false) {
    const json = JSON.stringify(data);
    for (const [ws, client] of clients) {
        if (ws === excludeWs) continue;
        if (ws.readyState !== 1) continue;
        if (badgeOnly && !client.user.badge) continue;
        ws.send(json);
    }
}

function findWSByUserId(userId) {
    for (const [ws, client] of clients) {
        if (client.user.id === userId) return ws;
    }
    return null;
}

function getOnlineUsers() {
    const seen = new Set();
    const list = [];
    for (const [, client] of clients) {
        if (!seen.has(client.user.id)) {
            seen.add(client.user.id);
            list.push({ username: client.user.username, badge: client.user.badge });
        }
    }
    return list;
}

wss.on('connection', (ws, req) => {
    const ip = getClientIP(req);

    if (db.isIPBanned(ip)) {
        ws.send(JSON.stringify({ type: 'banned' }));
        ws.close();
        return;
    }

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'auth': handleAuth(ws, msg, ip); break;
            case 'message': handleChatMessage(ws, msg); break;
            default: break;
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client) {
            console.log(`[WS CLOSED] ${client.user.username}`);
            broadcast({ type: 'user_left', username: client.user.username }, ws);
            broadcast({ type: 'online', users: getOnlineUsers() });
            clients.delete(ws);
        }
    });

    ws.on('error', () => { clients.delete(ws); });
});

function handleAuth(ws, msg, ip) {
    const user = db.findByToken(msg.token);
    if (!user) {
        ws.send(JSON.stringify({ type: 'error', text: 'Token tidak valid' }));
        return;
    }

    user.ip = ip;
    db.markDirty();
    clients.set(ws, { user, ip });

    ws.send(JSON.stringify({
        type: 'auth_ok',
        user: { username: user.username, badge: user.badge }
    }));

    /* Kirim history pesan */
    ws.send(JSON.stringify({ type: 'messages', messages: db.getMessages() }));

    /* Kirim daftar online */
    ws.send(JSON.stringify({ type: 'online', users: getOnlineUsers() }));

    /* Notify semua */
    broadcast({ type: 'user_joined', username: user.username }, ws);
    broadcast({ type: 'online', users: getOnlineUsers() });

    console.log(`[WS AUTH] ${user.username} (${ip})`);
}

function handleChatMessage(ws, msg) {
    const client = clients.get(ws);
    if (!client) return;
    const { user } = client;

    const text = (msg.text || '').trim().slice(0, 500);
    if (!text) return;

    /* Command (hanya untuk badge holder) */
    if (text.startsWith('/') && user.badge) {
        handleCommand(ws, text, user);
        return;
    }

    /* Pesan biasa */
    const message = db.addMessage(user.username, text, user.badge, msg.replyTo || null);
    broadcast({ type: 'message', message }, null);
}

function handleCommand(ws, text, user) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
        case '/listip': {
            const users = db.findAllUsers();
            let response = '=== DAFTAR IP ===\n';
            users.forEach(u => {
                response += `${u.username} → ${u.ip}\n`;
            });
            response += `=== Total: ${users.length} user ===`;
            ws.send(JSON.stringify({ type: 'bot', text: response }));
            break;
        }

        case '/ban': {
            if (!arg) {
                ws.send(JSON.stringify({ type: 'bot', text: 'Penggunaan: /ban <username>' }));
                return;
            }
            const target = db.findByUsername(arg);
            if (!target) {
                ws.send(JSON.stringify({ type: 'bot', text: `User "${arg}" tidak ditemukan` }));
                return;
            }
            if (target.badge?.cls === 'badge-dev') {
                ws.send(JSON.stringify({ type: 'bot', text: 'Tidak bisa ban developer.' }));
                return;
            }
            if (db.isIPBanned(target.ip)) {
                ws.send(JSON.stringify({ type: 'bot', text: `User "${target.username}" sudah di-ban.` }));
                return;
            }
            db.banIP(target.ip, user.username);
            /* Disconnect semua klien dari IP itu */
            for (const [clientWs, clientData] of clients) {
                if (clientData.ip === target.ip) {
                    clientWs.send(JSON.stringify({ type: 'banned' }));
                    clientWs.close();
                }
            }
            ws.send(JSON.stringify({ type: 'bot', text: `User "${target.username}" (IP: ${target.ip}) telah di-BAN.` }));
            console.log(`[BAN] ${target.username} (${target.ip}) by ${user.username}`);
            break;
        }

        case '/unban': {
            if (!arg) {
                ws.send(JSON.stringify({ type: 'bot', text: 'Penggunaan: /unban <username>' }));
                return;
            }
            const target = db.findByUsername(arg);
            if (!target) {
                ws.send(JSON.stringify({ type: 'bot', text: `User "${arg}" tidak ditemukan` }));
                return;
            }
            if (!db.isIPBanned(target.ip)) {
                ws.send(JSON.stringify({ type: 'bot', text: `User "${target.username}" tidak dalam status ban.` }));
                return;
            }
            db.unbanIP(target.ip);
            ws.send(JSON.stringify({ type: 'bot', text: `User "${target.username}" (IP: ${target.ip}) telah di-UNBAN.` }));
            console.log(`[UNBAN] ${target.username} (${target.ip}) by ${user.username}`);
            break;
        }

        case '/help': {
            ws.send(JSON.stringify({ type: 'bot', text: '=== COMMANDS ===\n/listip - Lihat daftar IP semua user\n/ban <username> - Ban user berdasarkan IP\n/unban <username> - Unban user\n/help - Bantuan' }));
            break;
        }

        default:
            ws.send(JSON.stringify({ type: 'bot', text: `Command "${cmd}" tidak dikenali. Ketik /help` }));
    }
}

/* ===========================================================
   START
   =========================================================== */
server.listen(PORT, () => {
    console.log(`\n  Ell - Blur Server\n  ==================\n  URL  : http://localhost:${PORT}\n  WS   : ws://localhost:${PORT}/ws\n\n`);
});
