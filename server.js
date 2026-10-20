const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '32kb' }));

/* ============================ active users counter ============================ */
const activeUsers = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, lastPing] of activeUsers.entries()) {
        if (now - lastPing > 20000) activeUsers.delete(id);
    }
}, 5000);

app.post('/ping', (req, res) => {
    const { deviceId } = req.body || {};
    if (deviceId) activeUsers.set(String(deviceId).slice(0, 64), Date.now());
    res.json({ onlineUsers: activeUsers.size });
});

/* ========================= Telegram join verification ========================= */
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const VERIFY_BOT_TOKEN = String(process.env.VERIFY_BOT_TOKEN || '').trim();
const CHANNEL = String(process.env.TG_CHANNEL || '@FALCON_KERNEL_PRO').trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || 'https://falcon-counter-server.onrender.com').replace(/\/+$/, '');
const SESSION_TTL = 15 * 60 * 1000;
const DEVICE_TTL = 24 * 60 * 60 * 1000;

const sessions = new Map();       // sid -> {created, deviceId, mode, status, code, tgId, checks}
const codes = new Map();          // code -> sid
const deviceVerified = new Map(); // deviceId -> timestamp
let VERIFY_BOT_USERNAME = '';

const WEBHOOK_PATH = VERIFY_BOT_TOKEN
    ? crypto.createHash('sha256').update(VERIFY_BOT_TOKEN + '|falcon-webhook').digest('hex').slice(0, 32)
    : 'disabled';
const WEBHOOK_SECRET = VERIFY_BOT_TOKEN
    ? crypto.createHash('sha256').update(VERIFY_BOT_TOKEN + '|falcon-secret').digest('hex')
    : 'disabled';

function sweep() {
    const now = Date.now();
    for (const [sid, s] of sessions.entries()) {
        if (now - s.created > SESSION_TTL) {
            sessions.delete(sid);
            if (s.code) codes.delete(s.code);
        }
    }
    for (const [dev, at] of deviceVerified.entries()) {
        if (now - at > DEVICE_TTL) deviceVerified.delete(dev);
    }
    for (const [ip, r] of rateHits.entries()) {
        if (now - r.at > 60000) rateHits.delete(ip);
    }
}
setInterval(sweep, 60000);

const rateHits = new Map();
function rateAllow(ip, max) {
    const now = Date.now();
    const r = rateHits.get(ip);
    if (!r || now - r.at > 60000) {
        rateHits.set(ip, { at: now, n: 1 });
        return true;
    }
    r.n += 1;
    return r.n <= max;
}

function telegramJson(token, method, params) {
    return new Promise((resolve, reject) => {
        if (!token) return reject(new Error('no_bot_token'));
        const body = JSON.stringify(params || {});
        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + token + '/' + method,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 20000
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('telegram_timeout')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function checkMember(userId) {
    const token = BOT_TOKEN || VERIFY_BOT_TOKEN;
    if (!token) throw new Error('no_bot_token');
    const r = await telegramJson(token, 'getChatMember', {
        chat_id: CHANNEL,
        user_id: userId
    });
    if (!r.ok) {
        const desc = String(r.description || '');
        if (/user not found|participant_id_invalid|user_id_invalid|invalid user identifier/i.test(desc)) {
            return { member: false, status: 'not_found' };
        }
        throw new Error(desc || 'telegram_error');
    }
    const st = r.result && r.result.status;
    const member = st === 'creator' || st === 'administrator' || st === 'member' ||
        (st === 'restricted' && r.result.is_member === true);
    const u = (r.result && r.result.user) || {};
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    return { member, status: st || 'unknown', name };
}

async function sendMessage(token, chatId, text, keyboard) {
    const payload = {
        chat_id: chatId,
        text: text,
        disable_web_page_preview: true
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    try { return await telegramJson(token, 'sendMessage', payload); }
    catch (e) { return null; }
}

function joinKeyboard(code) {
    const rows = [
        [{ text: '📢 انضم إلى قناة FALCON', url: 'https://t.me/FALCON_KERNEL_PRO' }]
    ];
    if (code) rows.push([{ text: '✅ تحقّق من الانضمام', callback_data: 'check:' + code }]);
    return rows;
}

/* ------------------------------- API: start ------------------------------- */
app.post('/tg/start', (req, res) => {
    if (!rateAllow(req.ip || 'x', 12)) {
        return res.status(429).json({ ok: false, error: 'rate_limit' });
    }
    const deviceId = String((req.body && req.body.deviceId) || '').slice(0, 64);
    if (!deviceId) return res.json({ ok: false, error: 'bad_device' });

    if (!BOT_TOKEN && !VERIFY_BOT_TOKEN) {
        return res.json({ ok: false, error: 'verify_not_configured' });
    }

    const now = Date.now();
    const dv = deviceVerified.get(deviceId);
    if (dv && now - dv < DEVICE_TTL) {
        return res.json({ ok: true, status: 'verified', mode: 'verified' });
    }

    const sid = crypto.randomBytes(16).toString('hex');
    let mode = 'id';
    let code = null;
    let deepLink = null;

    if (VERIFY_BOT_TOKEN && VERIFY_BOT_USERNAME) {
        mode = 'bot';
        code = crypto.randomBytes(5).toString('hex');
        deepLink = 'https://t.me/' + VERIFY_BOT_USERNAME + '?start=' + code;
        codes.set(code, sid);
    }

    sessions.set(sid, {
        created: now,
        deviceId: deviceId,
        mode: mode,
        status: 'pending',
        code: code,
        tgId: null,
        checks: 0
    });

    res.json({
        ok: true,
        sid: sid,
        mode: mode,
        deepLink: deepLink,
        bot: VERIFY_BOT_USERNAME || null,
        ttl: Math.floor(SESSION_TTL / 1000)
    });
});

/* ------------------------------- API: check ------------------------------- */
app.post('/tg/check', async (req, res) => {
    if (!rateAllow(req.ip || 'x', 30)) {
        return res.status(429).json({ ok: false, error: 'rate_limit' });
    }
    const sid = String((req.body && req.body.sid) || '');
    const tg = String((req.body && req.body.tg) || '').trim();
    const s = sessions.get(sid);
    if (!s) return res.json({ ok: false, error: 'expired' });
    if (Date.now() - s.created > SESSION_TTL) {
        sessions.delete(sid);
        if (s.code) codes.delete(s.code);
        return res.json({ ok: false, error: 'expired' });
    }
    if (s.status === 'verified') {
        return res.json({ ok: true, member: true, status: 'verified' });
    }
    s.checks = (s.checks || 0) + 1;
    if (s.checks > 12) {
        return res.status(429).json({ ok: false, error: 'too_many' });
    }

    let uid = null;
    if (/^[0-9]{1,15}$/.test(tg)) {
        uid = Number(tg);
    } else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(tg)) {
        const token = BOT_TOKEN || VERIFY_BOT_TOKEN;
        try {
            const r = await telegramJson(token, 'getChat', {
                chat_id: '@' + tg.replace(/^@/, '')
            });
            if (r.ok && r.result && r.result.type === 'private') uid = r.result.id;
        } catch (e) {}
        if (!uid) {
            return res.json({ ok: true, member: false, error: 'need_id', status: 'unknown' });
        }
    } else {
        return res.json({ ok: false, error: 'bad_id' });
    }

    try {
        const m = await checkMember(uid);
        if (m.member) {
            s.status = 'verified';
            s.tgId = uid;
            deviceVerified.set(s.deviceId, Date.now());
            if (s.code) codes.delete(s.code);
            return res.json({ ok: true, member: true, status: m.status, name: m.name });
        }
        return res.json({ ok: true, member: false, status: m.status });
    } catch (e) {
        return res.status(502).json({
            ok: false,
            error: 'telegram_error',
            detail: String(e.message || e).slice(0, 120)
        });
    }
});

/* ------------------------------- API: status ------------------------------ */
app.get('/tg/status', (req, res) => {
    const sid = String(req.query.sid || '');
    const s = sessions.get(sid);
    if (!s) return res.json({ ok: false, error: 'expired' });
    if (Date.now() - s.created > SESSION_TTL) {
        sessions.delete(sid);
        if (s.code) codes.delete(s.code);
        return res.json({ ok: false, error: 'expired' });
    }
    res.json({ ok: true, status: s.status, mode: s.mode });
});

/* ---------------------------- API: health -------------------------------- */
app.get('/tg/health', (req, res) => {
    res.json({
        ok: true,
        counter: true,
        verify: !!(BOT_TOKEN || VERIFY_BOT_TOKEN),
        botMode: !!(VERIFY_BOT_TOKEN && VERIFY_BOT_USERNAME),
        channel: CHANNEL
    });
});

/* --------------------------- Telegram webhook ----------------------------- */
async function processUpdate(update) {
    if (!update || !VERIFY_BOT_TOKEN) return;

    if (update.callback_query) {
        const cq = update.callback_query;
        const data = String(cq.data || '');
        if (data.indexOf('check:') !== 0) {
            await telegramJson(VERIFY_BOT_TOKEN, 'answerCallbackQuery', {
                callback_query_id: cq.id,
                text: 'استخدم زر التحقق من الرسالة.'
            });
            return;
        }
        const code = data.slice(6);
        const sid = codes.get(code);
        const s = sid ? sessions.get(sid) : null;
        const uid = cq.from && cq.from.id;
        if (!s || !uid || Date.now() - s.created > SESSION_TTL) {
            await telegramJson(VERIFY_BOT_TOKEN, 'answerCallbackQuery', {
                callback_query_id: cq.id,
                text: 'انتهت صلاحية التحقق — افتح الواجهة وأعد المحاولة.'
            });
            return;
        }
        try {
            const m = await checkMember(uid);
            if (m.member) {
                s.status = 'verified';
                s.tgId = uid;
                deviceVerified.set(s.deviceId, Date.now());
                codes.delete(code);
                await telegramJson(VERIFY_BOT_TOKEN, 'answerCallbackQuery', {
                    callback_query_id: cq.id,
                    text: '✅ تم التحقق — ارجع إلى الواجهة.'
                });
                await telegramJson(VERIFY_BOT_TOKEN, 'editMessageText', {
                    chat_id: cq.message && cq.message.chat && cq.message.chat.id,
                    message_id: cq.message && cq.message.message_id,
                    text: '✅ تم التحقق من عضويتك في قناة FALCON.\nارجع الآن إلى واجهة FALCON TRICKY — ستُفتح تلقائياً.',
                    disable_web_page_preview: true
                });
            } else {
                await telegramJson(VERIFY_BOT_TOKEN, 'answerCallbackQuery', {
                    callback_query_id: cq.id,
                    text: '❌ لم نجد عضويتك بعد — اضغط «انضم» أولاً ثم أعد التحقق.',
                    show_alert: true
                });
            }
        } catch (e) {
            await telegramJson(VERIFY_BOT_TOKEN, 'answerCallbackQuery', {
                callback_query_id: cq.id,
                text: '⚠️ تعذّر التحقق الآن — أعد المحاولة.',
                show_alert: true
            });
        }
        return;
    }

    const msg = update.message;
    if (!msg || !msg.text) return;
    const text = String(msg.text).trim();
    if (text.indexOf('/start') !== 0) return;
    const parts = text.split(/\s+/);
    const code = parts[1] || '';
    const uid = msg.from && msg.from.id;
    if (!uid) return;

    if (!code) {
        await sendMessage(VERIFY_BOT_TOKEN, msg.chat.id,
            'مرحباً بك في بوت التحقق من قناة FALCON.\n\n' +
            '1) اضغط «انضم إلى قناة FALCON» ثم «انضمام / Join».\n' +
            '2) ارجع إلى الواجهة (FALCON TRICKY) وأكمل التحقق.',
            joinKeyboard(null));
        return;
    }

    const sid = codes.get(code);
    const s = sid ? sessions.get(sid) : null;
    if (!s || Date.now() - s.created > SESSION_TTL) {
        await sendMessage(VERIFY_BOT_TOKEN, msg.chat.id,
            '⚠️ انتهت صلاحية رابط التحقق. افتح واجهة FALCON TRICKY وأعد المحاولة.',
            joinKeyboard(null));
        return;
    }

    try {
        const m = await checkMember(uid);
        if (m.member) {
            s.status = 'verified';
            s.tgId = uid;
            deviceVerified.set(s.deviceId, Date.now());
            codes.delete(code);
            await sendMessage(VERIFY_BOT_TOKEN, msg.chat.id,
                '✅ تم التحقق من عضويتك في قناة FALCON.\nارجع الآن إلى واجهة FALCON TRICKY — ستُفتح تلقائياً.',
                null);
        } else {
            await sendMessage(VERIFY_BOT_TOKEN, msg.chat.id,
                '❌ لم نجد عضويتك في القناة بعد.\nاضغط «انضم إلى قناة FALCON» أولاً، ثم اضغط «تحقّق من الانضمام».',
                joinKeyboard(code));
        }
    } catch (e) {
        await sendMessage(VERIFY_BOT_TOKEN, msg.chat.id,
            '⚠️ تعذّر التحقق الآن. تأكد من أن بوت التحقق مشرف في القناة ثم أعد المحاولة.',
            joinKeyboard(code));
    }
}

app.post('/tg/webhook/' + WEBHOOK_PATH, (req, res) => {
    if (!VERIFY_BOT_TOKEN) return res.status(404).json({ ok: false });
    const secret = req.get('x-telegram-bot-api-secret-token') || '';
    if (secret !== WEBHOOK_SECRET) return res.status(403).json({ ok: false });
    res.sendStatus(200);
    processUpdate(req.body).catch(() => {});
});

/* ------------------------------- health root ------------------------------ */
app.get('/', (req, res) => {
    res.send('Falcon Counter Server is running.');
});

/* ------------------------------- startup ---------------------------------- */
async function setupTelegram() {
    const memberToken = BOT_TOKEN || VERIFY_BOT_TOKEN;
    if (memberToken) {
        try {
            const me = await telegramJson(memberToken, 'getMe');
            if (me.ok) {
                console.log('membership bot: @' + me.result.username + ' | channel: ' + CHANNEL);
            } else {
                console.log('membership bot getMe failed: ' + (me.description || 'unknown'));
            }
        } catch (e) {
            console.log('membership bot getMe error: ' + String(e.message || e));
        }
    } else {
        console.log('No BOT_TOKEN/VERIFY_BOT_TOKEN: join verification disabled.');
    }

    if (VERIFY_BOT_TOKEN) {
        try {
            const me = await telegramJson(VERIFY_BOT_TOKEN, 'getMe');
            if (me.ok) {
                VERIFY_BOT_USERNAME = me.result.username || '';
                const botId = me.result.id;
                const gm = await telegramJson(VERIFY_BOT_TOKEN, 'getChatMember', {
                    chat_id: CHANNEL,
                    user_id: botId
                });
                if (gm.ok && (gm.result.status === 'administrator' || gm.result.status === 'creator')) {
                    console.log('verify bot is admin in ' + CHANNEL);
                } else {
                    console.log('WARNING: verify bot is NOT admin in ' + CHANNEL);
                }
                if (/^https:\/\//i.test(PUBLIC_URL)) {
                    const wh = await telegramJson(VERIFY_BOT_TOKEN, 'setWebhook', {
                        url: PUBLIC_URL + '/tg/webhook/' + WEBHOOK_PATH,
                        secret_token: WEBHOOK_SECRET,
                        allowed_updates: ['message', 'callback_query'],
                        drop_pending_updates: false
                    });
                    console.log('setWebhook: ' + (wh.ok ? 'OK' : (wh.description || 'failed')));
                }
            }
        } catch (e) {
            console.log('verify bot setup error: ' + String(e.message || e));
        }
    }
}

app.get('/', (req, res) => {
    res.send('Falcon Counter + Verification Server is running.');
});
app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'falcon-counter-server', verify: !!(BOT_TOKEN || VERIFY_BOT_TOKEN) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    setupTelegram().catch(() => {});
});
