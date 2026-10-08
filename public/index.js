/* =============================================================
   STATE
   ============================================================= */
let currentView = 'camera';
let frontStream = null;   // Kamera depan (hand detection)
let backStream = null;    // Kamera belakang (QR scan)
let isBlurred = false;
let isConnected = false;
let handDetectionReady = false;
let handsInstance = null;
let currentUser = null;   // { username, badge }
let authToken = null;
let ws = null;
let wsReconnectTimer = null;
let replyingTo = null;
let qrScanTimer = null;
let handLoopId = null;
let inviteCode = '';

/* =============================================================
   DOM REFS
   ============================================================= */
const $ = (id) => document.getElementById(id);
const cameraVideo    = $('camera-video');
const blurIndicator  = $('blur-indicator');
const gestureStatus  = $('gesture-status');
const manualBlurBtn  = $('manual-blur-btn');
const connFrames     = $('connection-frames');
const camFallback    = $('camera-fallback');
const senderVideo    = $('sender-video');
const receiverLabel  = $('receiver-label');
const scanVideo      = $('scan-video');
const qrCodeDisplay  = $('qr-code-display');
const inviteCodeText = $('invite-code-text');
const codeInput      = $('code-input');
const messagesList   = $('messages-list');
const chatInput      = $('chat-input');
const replyPreview   = $('reply-preview');
const replyAuthorEl  = $('reply-preview-author');
const replyTextEl    = $('reply-preview-text');
const userInfoEl     = $('user-info');
const usernameModal  = $('username-modal');
const usernameInput  = $('username-input');
const usernameError  = $('username-error');
const onlineCount    = $('online-count');
const qrScanCanvas   = $('qr-scan-canvas');

/* =============================================================
   TOAST
   ============================================================= */
function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    $('toast-container').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

/* =============================================================
   UTILITIES
   ============================================================= */
function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

/* =============================================================
   API HELPER
   ============================================================= */
async function api(endpoint, body = {}) {
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw data;
        return data;
    } catch (e) {
        throw e;
    }
}

/* =============================================================
   WEBSOCKET
   ============================================================= */
function connectWS() {
    if (ws && ws.readyState <= 1) return; // sudah connect/connecting

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;

    ws = new WebSocket(url);

    ws.onopen = () => {
        console.log('[WS] Connected');
        /* Auth jika sudah punya token */
        if (authToken) {
            ws.send(JSON.stringify({ type: 'auth', token: authToken }));
        }
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleWSMessage(msg);
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected');
        ws = null;
        /* Auto reconnect setiap 3 detik */
        wsReconnectTimer = setTimeout(connectWS, 3000);
    };

    ws.onerror = () => { /* onclose akan dipanggil */ };
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'auth_ok':
            console.log('[WS] Auth OK:', msg.user);
            break;

        case 'messages':
            /* Replace semua pesan */
            renderFullMessages(msg.messages);
            break;

        case 'message':
            appendMessage(msg.message);
            break;

        case 'bot':
            /* Bot message - hanya tampil untuk badge holder */
            appendBotMessage(msg.text);
            break;

        case 'user_joined':
            /* Seseorang join chat */
            break;

        case 'user_left':
            break;

        case 'online':
            updateOnline(msg.users);
            break;

        case 'partner_joined':
            handlePartnerJoined(msg.partner);
            break;

        case 'banned':
            showToast('IP Anda telah di-ban oleh admin', 'error');
            currentUser = null;
            authToken = null;
            localStorage.removeItem('ell_token');
            usernameModal.classList.add('visible');
            break;

        case 'error':
            showToast(msg.text, 'error');
            break;
    }
}

function wsSend(data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

/* =============================================================
   VIEW SWITCHING
   ============================================================= */
const viewNames = ['camera', 'qr-create', 'qr-scan', 'chat'];
const navBtns = {
    'camera': $('nav-camera'),
    'qr-create': $('nav-qr-create'),
    'qr-scan': $('nav-qr-scan'),
    'chat': $('nav-chat')
};

function switchView(view) {
    currentView = view;
    viewNames.forEach(v => {
        const el = $(`${v.replace('-', '-')}-view`);
        if (el) el.classList.toggle('active', v === view);
    });
    Object.entries(navBtns).forEach(([v, btn]) => {
        btn.classList.toggle('active', v === view);
    });

    if (view === 'camera') {
        ensureFrontCamera();
        startHandLoop();
    } else {
        stopHandLoop();
    }

    if (view === 'qr-scan') {
        ensureBackCamera();
        startQRScan();
    } else {
        stopQRScan();
    }

    /* Chat butuh login */
    if (view === 'chat' && !currentUser) {
        usernameModal.classList.add('visible');
        usernameInput.focus();
    }
}

/* =============================================================
   CAMERA MANAGEMENT
   ============================================================= */
async function ensureFrontCamera() {
    if (frontStream) {
        if (cameraVideo.srcObject !== frontStream) cameraVideo.srcObject = frontStream;
        return;
    }
    try {
        frontStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        cameraVideo.srcObject = frontStream;
        await cameraVideo.play();
        gestureStatus.textContent = 'Kamera aktif';
        camFallback.style.display = 'none';
        cameraVideo.style.display = '';
    } catch (e) {
        console.warn('Front camera error:', e);
        cameraVideo.style.display = 'none';
        camFallback.style.display = 'block';
        gestureStatus.textContent = 'Kamera depan tidak tersedia';
    }
}

async function ensureBackCamera() {
    if (backStream) {
        if (scanVideo.srcObject !== backStream) scanVideo.srcObject = backStream;
        return;
    }
    try {
        backStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        scanVideo.srcObject = backStream;
        await scanVideo.play();
    } catch (e) {
        console.warn('Back camera error:', e);
        /* Fallback: pakai front camera */
        try {
            backStream = await navigator.mediaDevices.getUserMedia({ video: true });
            scanVideo.srcObject = backStream;
            await scanVideo.play();
        } catch (e2) {
            showToast('Kamera tidak tersedia untuk scan', 'error');
        }
    }
}

/* =============================================================
   BLUR
   ============================================================= */
function setBlur(active) {
    if (isBlurred === active) return;
    isBlurred = active;
    cameraVideo.classList.toggle('blurred', active);
    blurIndicator.classList.toggle('visible', active);
    manualBlurBtn.classList.toggle('blurred', active);
}

manualBlurBtn.addEventListener('click', () => setBlur(!isBlurred));

/* =============================================================
   HAND DETECTION (MediaPipe)
   ============================================================= */
async function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.crossOrigin = 'anonymous';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function initHandDetection() {
    try {
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js');
        await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js');

        if (typeof Hands === 'undefined') throw new Error('Hands not loaded');

        const hands = new Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
        });
        hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.5
        });
        hands.onResults(onHandResults);
        handsInstance = hands;
        handDetectionReady = true;
        gestureStatus.textContent = 'Deteksi gestur aktif';
        showToast('Deteksi gestur siap', 'success');
    } catch (e) {
        console.warn('MediaPipe gagal:', e);
        handDetectionReady = false;
        gestureStatus.textContent = 'Gunakan tombol peace untuk blur';
        showToast('Deteksi gestur tidak tersedia', 'warning');
    }
}

function isPeaceSign(lm) {
    const indexUp   = lm[8].y < lm[6].y;
    const middleUp  = lm[12].y < lm[10].y;
    const ringDown  = lm[16].y > lm[14].y;
    const pinkyDown = lm[20].y > lm[18].y;
    return indexUp && middleUp && ringDown && pinkyDown;
}

function onHandResults(results) {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const lm = results.multiHandLandmarks[0];
        if (isPeaceSign(lm)) {
            setBlur(true);
            gestureStatus.textContent = 'Peace terdeteksi — Blur aktif';
        } else {
            setBlur(false);
            gestureStatus.textContent = 'Gestur terdeteksi — Tidak blur';
        }
    } else {
        setBlur(false);
        if (handDetectionReady) gestureStatus.textContent = 'Mendeteksi gestur...';
    }
}

function startHandLoop() {
    stopHandLoop();
    if (!handDetectionReady || !handsInstance) return;
    async function loop() {
        if (currentView === 'camera' && cameraVideo.readyState >= 2) {
            try { await handsInstance.send({ image: cameraVideo }); } catch (_) {}
        }
        handLoopId = requestAnimationFrame(loop);
    }
    loop();
}

function stopHandLoop() {
    if (handLoopId) { cancelAnimationFrame(handLoopId); handLoopId = null; }
}

/* =============================================================
   QR — BUAT (via server)
   ============================================================= */
async function createInvite() {
    if (!authToken) {
        showToast('Masuk ke chat dulu untuk membuat invite', 'warning');
        return;
    }
    try {
        const data = await api('/api/invite', { token: authToken });
        inviteCode = data.code;
        inviteCodeText.textContent = inviteCode;
        qrCodeDisplay.innerHTML = '';
        new QRCode(qrCodeDisplay, {
            text: inviteCode,
            width: 180, height: 180,
            colorDark: '#111118', colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    } catch (e) {
        showToast(e.error || 'Gagal membuat invite', 'error');
    }
}

 $('copy-code-btn').addEventListener('click', () => {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode)
        .then(() => showToast('Kode disalin', 'success'))
        .catch(() => showToast('Gagal menyalin', 'error'));
});

/* =============================================================
   QR — SCAN (kamera belakang)
   ============================================================= */
function startQRScan() {
    stopQRScan();
    const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
    qrScanTimer = setInterval(() => {
        if (!scanVideo.srcObject || scanVideo.readyState < 2) return;
        qrScanCanvas.width  = scanVideo.videoWidth;
        qrScanCanvas.height = scanVideo.videoHeight;
        ctx.drawImage(scanVideo, 0, 0);
        const imgData = ctx.getImageData(0, 0, qrScanCanvas.width, qrScanCanvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if (code && /^ell-\d{4}$/.test(code.data)) {
            handleQRFound(code.data);
        }
    }, 250);
}

function stopQRScan() {
    if (qrScanTimer) { clearInterval(qrScanTimer); qrScanTimer = null; }
}

async function handleQRFound(code) {
    stopQRScan();
    showToast(`QR terdeteksi: ${code}`, 'success');
    await joinWithCode(code);
}

/* =============================================================
   JOIN VIA KODE
   ============================================================= */
async function joinWithCode(code) {
    if (!authToken) {
        showToast('Masuk ke chat dulu sebelum bergabung', 'warning');
        return;
    }
    if (isConnected) {
        showToast('Sudah terhubung', 'warning');
        return;
    }
    try {
        const data = await api('/api/join', { token: authToken, code });
        if (data.success) {
            isConnected = true;
            showToast(`Terhubung dengan ${data.partner}`, 'success');
            /* Tampilkan bingkai */
            if (frontStream) senderVideo.srcObject = frontStream;
            receiverLabel.textContent = data.partner;
            connFrames.classList.add('visible');
            switchView('camera');
        }
    } catch (e) {
        showToast(e.error || 'Gagal bergabung', 'error');
    }
}

 $('join-btn').addEventListener('click', () => {
    const digits = codeInput.value.trim();
    if (!/^\d{4}$/.test(digits)) {
        showToast('Masukkan 4 digit angka', 'error');
        return;
    }
    joinWithCode(`ell-${digits}`);
});

codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
});

/* Enter di input kode */
codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
});

/* =============================================================
   CHAT — REGISTER / LOGIN
   ============================================================= */
async function registerUser(username) {
    try {
        const data = await api('/api/register', { username });
        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('ell_token', authToken);
        onLoginSuccess();
        return true;
    } catch (e) {
        if (e.banned) {
            usernameError.textContent = 'Perangkat Anda di-ban. Hubungi admin.';
            showToast('Perangkat di-ban', 'error');
        } else {
            usernameError.textContent = e.error || 'Gagal mendaftar';
        }
        return false;
    }
}

async function verifyToken(token) {
    try {
        const data = await api('/api/verify', { token });
        currentUser = data.user;
        authToken = token;
        onLoginSuccess();
        return true;
    } catch (e) {
        localStorage.removeItem('ell_token');
        authToken = null;
        if (e.banned) {
            showToast('Perangkat Anda di-ban', 'error');
        }
        return false;
    }
}

function onLoginSuccess() {
    renderUserInfo();
    usernameModal.classList.remove('visible');
    usernameError.textContent = '';
    showToast(`Selamat datang, ${currentUser.username}`, 'success');
    /* Auth WS */
    wsSend({ type: 'auth', token: authToken });
}

function renderUserInfo() {
    if (!currentUser) { userInfoEl.innerHTML = ''; return; }
    let html = `<span class="user-name">${escapeHtml(currentUser.username)}</span>`;
    if (currentUser.badge) {
        html += `<span class="badge ${currentUser.badge.cls}">${currentUser.badge.text}</span>`;
    }
    userInfoEl.innerHTML = html;
}

 $('username-submit').addEventListener('click', async () => {
    const name = usernameInput.value.trim();
    if (!name) { usernameError.textContent = 'Username wajib diisi'; return; }
    $('username-submit').disabled = true;
    await registerUser(name);
    $('username-submit').disabled = false;
});

usernameInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        const name = usernameInput.value.trim();
        if (!name) return;
        $('username-submit').disabled = true;
        await registerUser(name);
        $('username-submit').disabled = false;
    }
});

/* =============================================================
   CHAT — RENDER PESAN
   ============================================================= */
function renderFullMessages(msgs) {
    messagesList.innerHTML = '';
    msgs.forEach(m => appendMessage(m, false));
    messagesList.scrollTop = messagesList.scrollHeight;
}

function appendMessage(msg, scroll = true) {
    const isOwn = currentUser && msg.username === currentUser.username;
    let replyHtml = '';
    if (msg.replyTo) {
        const rText = msg.replyTo.text || '';
        replyHtml = `<div class="msg-reply-ref"><i class="fa-solid fa-reply" style="margin-right:4px;font-size:9px;"></i>@${escapeHtml(msg.replyTo.username)}: ${escapeHtml(rText)}</div>`;
    }
    let badgeHtml = '';
    if (msg.badge) badgeHtml = `<span class="badge ${msg.badge.cls}">${msg.badge.text}</span>`;

    const div = document.createElement('div');
    div.className = `message${isOwn ? ' own' : ''}`;
    div.dataset.id = msg.id;
    div.innerHTML = `
        ${replyHtml}
        <div class="msg-header">
            <span class="msg-author">${escapeHtml(msg.username)}</span>
            ${badgeHtml}
            <span class="msg-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="msg-text">${escapeHtml(msg.text)}</div>
        <button class="msg-reply-btn" title="Balas">
            <i class="fa-solid fa-reply"></i>
        </button>
    `;
    div.querySelector('.msg-reply-btn').addEventListener('click', () => setReply(msg));
    messagesList.appendChild(div);
    if (scroll) messagesList.scrollTop = messagesList.scrollHeight;
}

function appendBotMessage(text) {
    if (!currentUser || !currentUser.badge) return; // Hanya badge holder
    const div = document.createElement('div');
    div.className = 'message bot-msg';
    div.innerHTML = `
        <div class="msg-header">
            <span class="msg-author" style="color:var(--warning);"><i class="fa-solid fa-robot" style="margin-right:4px;"></i>Bot</span>
        </div>
        <div class="msg-text">${escapeHtml(text)}</div>
    `;
    messagesList.appendChild(div);
    messagesList.scrollTop = messagesList.scrollHeight;
}

/* =============================================================
   CHAT — REPLY
   ============================================================= */
function setReply(msg) {
    replyingTo = msg;
    replyAuthorEl.textContent = `@${msg.username}`;
    replyTextEl.textContent = msg.text.length > 60 ? msg.text.slice(0, 60) + '...' : msg.text;
    replyPreview.classList.remove('hidden');
    chatInput.focus();
}

 $('cancel-reply-btn').addEventListener('click', () => {
    replyingTo = null;
    replyPreview.classList.add('hidden');
});

/* =============================================================
   CHAT — KIRIM PESAN
   ============================================================= */
function sendMessage() {
    if (!currentUser) { showToast('Masukkan username dulu', 'warning'); return; }
    const text = chatInput.value.trim();
    if (!text) return;

    wsSend({
        type: 'message',
        text,
        replyTo: replyingTo ? replyingTo.id : null
    });

    chatInput.value = '';
    replyingTo = null;
    replyPreview.classList.add('hidden');
}

 $('send-btn').addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendMessage(); });

/* =============================================================
   CHAT — ONLINE COUNT
   ============================================================= */
function updateOnline(users) {
    onlineCount.textContent = `${users.length} online`;
}

/* =============================================================
   NAVIGATION
   ============================================================= */
 $('nav-camera').addEventListener('click', () => switchView('camera'));
 $('nav-qr-create').addEventListener('click', async () => {
    await createInvite();
    switchView('qr-create');
});
 $('nav-qr-scan').addEventListener('click', () => switchView('qr-scan'));
 $('nav-chat').addEventListener('click', () => switchView('chat'));

/* =============================================================
   INITIALIZATION
   ============================================================= */
async function init() {
    /* Coba auto-login dari token tersimpan */
    const savedToken = localStorage.getItem('ell_token');
    if (savedToken) {
        const ok = await verifyToken(savedToken);
        if (!ok) {
            /* Token invalid, tampilkan modal login saat buka chat */
        }
    }

    /* Start WebSocket */
    connectWS();

    /* Start front camera */
    await ensureFrontCamera();

    /* Load hand detection (async, non-blocking) */
    initHandDetection();

    /* Remove loading screen */
    setTimeout(() => {
        const ls = $('loading-screen');
        ls.classList.add('fade-out');
        setTimeout(() => ls.remove(), 500);
    }, 600);
}

init();
