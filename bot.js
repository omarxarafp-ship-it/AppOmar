import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import gplay from 'google-play-scraper';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;
import { request } from 'undici';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    console.log('📁 تخلق المجلد ديال التحميلات');
}

function cleanupOldDownloads() {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const now = Date.now();
        const maxAge = 30 * 60 * 1000;

        for (const file of files) {
            const filePath = path.join(DOWNLOADS_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ تحيد ملف قديم: ${file}`);
            }
        }
    } catch (error) {
        console.error('غلطة فتنقية الملفات القديمة:', error.message);
    }
}

setInterval(cleanupOldDownloads, 10 * 60 * 1000);

const logger = pino({ 
    level: 'silent',
    serializers: {
        err: pino.stdSerializers.err
    }
});

const DEVELOPER_PHONES = ['212718938088', '234905250308102'];
const BOT_PROFILE_IMAGE_URL = 'https://i.postimg.cc/TPgStdfc/Screenshot-2025-11-25-08-24-05-916-com-openai-chatgpt-edit.jpg';
const INSTAGRAM_URL = 'https://www.instagram.com/omarxarafp';
const POWERED_BY = '\n\n> © من طرف AppOmar';
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

const ZARCHIVER_PACKAGE = 'ru.zdevs.zarchiver';
function getZArchiverTutorial(fileName) {
    const appName = fileName.replace(/\.(xapk|apk)$/i, '');
    return `\n*طريقة تثبيت XAPK:*

1️⃣ حل الملف ب ZArchiver
2️⃣ غادي تشوف الملفات ديال التطبيق - رجع للوراء
3️⃣ غادي تلقى التطبيق بالاسم "${appName}"
4️⃣ ضغط عليه مطولا  غادي يبان Install أو تثبيت
5️⃣ مبروك! شكراً لأنك كتستعمل AppOmar`;
}

const ZARCHIVER_TUTORIAL_BASIC = `*طريقة تثبيت XAPK:*

1️⃣ حل الملف ب ZArchiver
2️⃣ غادي تشوف الملفات ديال التطبيق - رجع للوراء
3️⃣ غادي تلقى التطبيق بالاسم
4️⃣ ضغط عليه مطولا  غادي يبان Install أو تثبيت
5️⃣ مبروك! شكراً لأنك كتستعمل AppOmar

باش تنزّل ZArchiver صيفط: zarchiver`;

let pool = null;
let dbEnabled = false;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
    });
}

const userSessions = new Map();
const requestQueue = new Map();
const blockedNumbers = new Set();
const vipUsers = new Set();
const hourlyMessageTracker = new Map();
const downloadMessageTracker = new Map();
const groupMetadataCache = new Map();
const messageStore = new Map();
const lidToPhoneMap = new Map();
const VIP_PASSWORD = 'Omar';
let botPresenceMode = 'unavailable'; // 'unavailable' or 'available'
let presenceInterval = null;
let pairingCodeRequested = false;
let globalSock = null;
let botImageBuffer = null;
let xapkInstallerBuffer = null;
let xapkInstallerInfo = null;

function getRandomDelay(min = 1000, max = 3000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getTypingDuration(textLength) {
    return 0;
}

async function humanDelay() {
    const delay = getRandomDelay(1000, 3000);
    await new Promise(r => setTimeout(r, delay));
}

async function getCachedGroupMetadata(sock, jid) {
    if (groupMetadataCache.has(jid)) {
        const cached = groupMetadataCache.get(jid);
        if (Date.now() - cached.timestamp < 300000) {
            return cached.data;
        }
    }
    try {
        const metadata = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data: metadata, timestamp: Date.now() });
        return metadata;
    } catch (error) {
        console.error('مشكيل فجيبان ديال المجموعة:', error.message);
        return null;
    }
}

function storeMessage(key, message) {
    if (!key || !key.id) return;
    const storeKey = `${key.remoteJid}_${key.id}`;
    messageStore.set(storeKey, message);
    if (messageStore.size > 1000) {
        const keysToDelete = Array.from(messageStore.keys()).slice(0, 200);
        keysToDelete.forEach(k => messageStore.delete(k));
    }
}

function getStoredMessage(key) {
    if (!key || !key.id) return { conversation: '' };
    const storeKey = `${key.remoteJid}_${key.id}`;
    return messageStore.get(storeKey) || { conversation: '' };
}

async function initDatabase() {
    if (!process.env.DATABASE_URL) {
        console.log('⚠️  ما لقيتش DATABASE_URL - البوت خدام بلا قاعدة بيانات');
        dbEnabled = false;
        return;
    }
    try {
        console.log('🗄️  كنراجع قاعدة البيانات...');
        const client = await pool.connect();
        const schemaPath = path.join(__dirname, 'database', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await client.query(schema);
            console.log('✅ تأكدت من الجداول فقاعدة البيانات');
        }
        await client.query('SELECT 1');
        client.release();
        dbEnabled = true;
        console.log('✅ قاعدة البيانات تّصلات بنجاح!');
    } catch (error) {
        dbEnabled = false;
        console.error('❌ مشكل فتّاصل مع قاعدة البيانات:', error.message);
        console.log('⚠️  البوت خدام بلا قاعدة بيانات');
    }
}

async function simulateTyping(sock, remoteJid, textLength = 50) {
}

async function sendBotMessage(sock, remoteJid, content, originalMsg = null, options = {}) {
    await humanDelay();

    const messageContent = { ...content };

    if (options.forward) {
        messageContent.contextInfo = {
            ...(messageContent.contextInfo || {}),
            isForwarded: true,
            forwardingScore: 1
        };
    }

    const sendOptions = {};
    if (originalMsg) {
        sendOptions.quoted = originalMsg;
    }

    const sentMsg = await sock.sendMessage(remoteJid, messageContent, sendOptions);
    if (sentMsg && sentMsg.key) {
        storeMessage(sentMsg.key, sentMsg.message);
    }
    return sentMsg;
}

async function downloadBotProfileImage() {
    try {
        if (botImageBuffer) return botImageBuffer;
        console.log('📥 كننزّل صورة البروفايل من URL...');
        const { statusCode, body } = await request(BOT_PROFILE_IMAGE_URL, {
            method: 'GET',
            headersTimeout: 15000,
            bodyTimeout: 15000
        });
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        botImageBuffer = Buffer.from(await body.arrayBuffer());
        return botImageBuffer;
    } catch (error) {
        console.error('❌ مشكل فتحميل صورة البوت:', error.message);
        return null;
    }
}

async function downloadXapkInstaller() {
    try {
        if (xapkInstallerBuffer && xapkInstallerInfo) {
            return { buffer: xapkInstallerBuffer, info: xapkInstallerInfo };
        }

        console.log('📥 كننزّل المثبّت ديال XAPK (ZArchiver)...');
        const API_URL = process.env.API_URL || 'http://localhost:8000';

        const { statusCode, headers, body } = await request(`${API_URL}/download/${ZARCHIVER_PACKAGE}`, {
            method: 'GET',
            headersTimeout: 300000,
            bodyTimeout: 300000
        });

        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

        const fileType = headers['x-file-type'] || 'apk';
        const data = Buffer.from(await body.arrayBuffer());
        const fileSize = data.length;

        xapkInstallerBuffer = data;
        xapkInstallerInfo = {
            filename: `ZArchiver.${fileType}`,
            size: fileSize,
            fileType: fileType
        };

        console.log(`✅ تّحمل المثبّت: ${formatFileSize(fileSize)}`);
        return { buffer: xapkInstallerBuffer, info: xapkInstallerInfo };
    } catch (error) {
        console.error('❌ مشكل فتنزيل المثبّت ديال XAPK:', error.message);
        return null;
    }
}

async function setBotProfile(sock) {
    try {
        const imageBuffer = await downloadBotProfileImage();
        if (imageBuffer) {
            await sock.updateProfilePicture(sock.user.id, imageBuffer);
            console.log('✅ تتحدّث صورة البروفايل');
        }
    } catch (error) {
        console.error('⚠️ مشكل فتحديث صورة البروفايل:', error.message);
    }
}

async function getUserProfileInfo(sock, jid, senderPhone, userName) {
    const userInfo = {
        name: userName || 'مستخدم',
        phone: senderPhone,
        profilePic: null,
        status: null,
        about: null
    };

    try {
        // Try to get profile picture
        try {
            const ppUrl = await sock.profilePictureUrl(jid, 'image');
            if (ppUrl) {
                const { statusCode, body } = await request(ppUrl, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    userInfo.profilePic = Buffer.from(await body.arrayBuffer());
                }
            }
        } catch (ppError) {
            console.log('⚠️ ماقدّنش نجيب صورة المستخدم:', ppError.message);
        }

        // Try to get user status/about
        try {
            const status = await sock.fetchStatus(jid);
            if (status && status.status) {
                userInfo.status = status.status;
            }
        } catch (statusError) {
            console.log('⚠️ ماقدّنش نجيب الحالة ديال المستخدم:', statusError.message);
        }

    } catch (error) {
        console.log('⚠️ مشكل فجلب معلومات المستخدم:', error.message);
    }

    return userInfo;
}

function decodeJid(jid) {
    if (!jid) return null;
    try {
        const decoded = jidDecode(jid);
        return decoded;
    } catch (error) {
        return null;
    }
}

function isLidFormat(jid) {
    if (!jid) return false;
    return jid.endsWith('@lid') || jid.includes('@lid');
}

function getSenderPhone(remoteJid, participant, altJid = null) {
    let jid = remoteJid;
    if (remoteJid.endsWith('@g.us') && participant) {
        jid = participant;
    }

    const decoded = decodeJid(jid);
    if (!decoded) {
        return jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
    }

    if (decoded.server === 'lid') {
        if (altJid) {
            const altDecoded = decodeJid(altJid);
            if (altDecoded && altDecoded.server === 's.whatsapp.net') {
                lidToPhoneMap.set(jid, altDecoded.user);
                return altDecoded.user;
            }
        }
        if (lidToPhoneMap.has(jid)) {
            return lidToPhoneMap.get(jid);
        }
        return decoded.user;
    }

    return decoded.user || jid.replace('@s.whatsapp.net', '').replace(/@.*$/, '');
}

function isValidPhoneNumber(phone) {
    if (!phone) return false;
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15 && /^\d+$/.test(cleaned);
}

function getUserId(remoteJid, participant) {
    if (remoteJid.endsWith('@g.us') && participant) {
        return participant;
    }
    return remoteJid;
}

function extractPhoneFromMessage(msg) {
    const remoteJid = msg.key?.remoteJid;
    const participant = msg.key?.participant;
    const remoteJidAlt = msg.key?.remoteJidAlt;
    const participantAlt = msg.key?.participantAlt;

    let altJid = null;
    if (remoteJid?.endsWith('@g.us') && participantAlt) {
        altJid = participantAlt;
    } else if (remoteJidAlt) {
        altJid = remoteJidAlt;
    }

    return getSenderPhone(remoteJid, participant, altJid);
}

function isDeveloper(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    return DEVELOPER_PHONES.some(devPhone => cleanPhone === devPhone || cleanPhone.endsWith(devPhone));
}

async function checkBlacklist(phone) {
    if (blockedNumbers.has(phone)) return true;
    if (!dbEnabled) return false;
    try {
        const result = await pool.query('SELECT * FROM blacklist WHERE phone_number = $1', [phone]);
        if (result.rows.length > 0) {
            blockedNumbers.add(phone);
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function blockUser(phone, reason, sock = null) {
    blockedNumbers.add(phone);
    console.log(`🚫 تبلوكى: ${phone} - السبب: ${reason}`);

    // Use Baileys to actually block the user on WhatsApp
    const socketToUse = sock || globalSock;
    if (socketToUse) {
        try {
            const jid = `${phone}@s.whatsapp.net`;
            await socketToUse.updateBlockStatus(jid, 'block');
            console.log(`✅ تبلوكى الرقم فواتساب: ${phone}`);
        } catch (blockError) {
            console.error('❌ مشكل فتبلوكى الرقم فواتساب:', blockError.message);
        }
    }

    if (!dbEnabled) return;
    try {
        await pool.query('INSERT INTO blacklist (phone_number, reason) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING', [phone, reason]);
    } catch (error) {
        console.error('خطأ فإضافة للبلوك ليست:', error);
    }
}

async function unblockUser(phone, sock = null) {
    blockedNumbers.delete(phone);
    console.log(`✅ تفتح البلوك: ${phone}`);

    // Use Baileys to actually unblock the user on WhatsApp
    const socketToUse = sock || globalSock;
    if (socketToUse) {
        try {
            const jid = `${phone}@s.whatsapp.net`;
            await socketToUse.updateBlockStatus(jid, 'unblock');
            console.log(`✅ تفتح البلوك فواتساب: ${phone}`);
        } catch (unblockError) {
            console.error('❌ مشكل فتفتح البلوك فواتساب:', unblockError.message);
        }
    }

    if (!dbEnabled) return true;
    try {
        await pool.query('DELETE FROM blacklist WHERE phone_number = $1', [phone]);
        return true;
    } catch (error) {
        return false;
    }
}

async function updateUserActivity(phone, userName) {
    if (!dbEnabled) return;
    if (!isValidPhoneNumber(phone)) {
        console.log(`⚠️  ما حفظتش رقم ما صالح: ${phone}`);
        return;
    }
    try {
        await pool.query(
            'INSERT INTO users (phone_number, username, last_activity) VALUES ($1, $2, NOW()) ON CONFLICT (phone_number) DO UPDATE SET last_activity = NOW(), username = $2',
            [phone, userName]
        );
    } catch (error) {}
}

function checkHourlySpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let tracker = hourlyMessageTracker.get(phone);
    if (!tracker) {
        tracker = { messages: [] };
        hourlyMessageTracker.set(phone, tracker);
    }
    tracker.messages = tracker.messages.filter(t => now - t < oneHour);
    tracker.messages.push(now);
    if (tracker.messages.length > 25) {
        return 'block';
    }
    return 'ok';
}

function checkDownloadSpam(phone) {
    if (isDeveloper(phone)) return 'ok';
    if (vipUsers.has(phone)) return 'ok';
    let tracker = downloadMessageTracker.get(phone);
    if (!tracker) return 'ok';
    if (tracker.count >= 5) {
        return 'block';
    }
    tracker.count++;
    downloadMessageTracker.set(phone, tracker);
    return 'ok';
}

function startDownloadTracking(phone) {
    downloadMessageTracker.set(phone, { count: 0 });
}

function stopDownloadTracking(phone) {
    downloadMessageTracker.delete(phone);
}

async function logDownload(userPhone, appId, appName, fileType, fileSize) {
    if (!dbEnabled) return;
    if (!isValidPhoneNumber(userPhone)) return;
    try {
        await pool.query(
            'INSERT INTO downloads (user_phone, app_id, app_name, file_type, file_size) VALUES ($1, $2, $3, $4, $5)',
            [userPhone, appId, appName, fileType, fileSize]
        );
        await pool.query('UPDATE users SET total_downloads = total_downloads + 1 WHERE phone_number = $1', [userPhone]);
    } catch (error) {}
}

async function getStats() {
    if (!dbEnabled) return null;
    try {
        const usersResult = await pool.query('SELECT COUNT(*) as total FROM users');
        const downloadsResult = await pool.query('SELECT COUNT(*) as total, SUM(file_size) as total_size FROM downloads');
        const todayDownloads = await pool.query("SELECT COUNT(*) as total FROM downloads WHERE created_at >= CURRENT_DATE");
        const topApps = await pool.query('SELECT app_name, COUNT(*) as count FROM downloads GROUP BY app_name ORDER BY count DESC LIMIT 5');
        const blockedResult = await pool.query('SELECT COUNT(*) as total FROM blacklist');
        return {
            totalUsers: usersResult.rows[0].total,
            totalDownloads: downloadsResult.rows[0].total,
            totalSize: downloadsResult.rows[0].total_size || 0,
            todayDownloads: todayDownloads.rows[0].total,
            topApps: topApps.rows,
            blockedUsers: blockedResult.rows[0].total
        };
    } catch (error) {
        return null;
    }
}

async function broadcastMessage(sock, message) {
    if (!dbEnabled) return { success: 0, failed: 0 };
    try {
        const users = await pool.query('SELECT phone_number FROM users');
        let success = 0, failed = 0;
        for (const user of users.rows) {
            try {
                if (!isValidPhoneNumber(user.phone_number)) {
                    failed++;
                    continue;
                }
                const jid = `${user.phone_number}@s.whatsapp.net`;
                await sock.sendMessage(jid, { text: `📢 *مساج من المطور*\n\n${message}${POWERED_BY}` });
                success++;
                await new Promise(r => setTimeout(r, 100));
            } catch { failed++; }
        }
        return { success, failed };
    } catch (error) {
        return { success: 0, failed: 0 };
    }
}

async function getUserHistory(phone) {
    if (!dbEnabled) return [];
    try {
        const result = await pool.query('SELECT app_name, file_type, created_at FROM downloads WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 10', [phone]);
        return result.rows;
    } catch (error) {
        return [];
    }
}

function formatFileSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    } else if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${bytes} bytes`;
}

function formatAppInfo(appDetails, fileType, fileSize) {
    return `📱 *${appDetails.title}*

◄ النوع: ${fileType.toUpperCase()}
◄ الحجم: ${formatFileSize(fileSize)}
◄ التحميلات: ${appDetails.installs || 'ما معروفش'}`;
}

function formatSearchResults(results) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let text = `🔍 *نّتـائج البحث*\n\n`;

    results.forEach((app, index) => {
        const emoji = numberEmojis[index] || `${index + 1}◄`;
        text += `${emoji} ◄ ${app.title}\n`;
    });

    text += `\n📝 صيفط رقم التطبيق (1-${results.length})`;

    return text;
}

async function handleZArchiverDownload(sock, remoteJid, userId, senderPhone, msg, session) {
    session.isDownloading = true;
    startDownloadTracking(senderPhone);
    userSessions.set(userId, session);

    console.log(`✅ تنزيل ZArchiver (APK)`);

    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

    try {
        // جلب معلومات التطبيق من Google Play
        const appDetails = await gplay.app({ appId: ZARCHIVER_PACKAGE });

        // إرسال الأيقونة كاستيكر
        if (appDetails.icon) {
            try {
                const { statusCode, body } = await request(appDetails.icon, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    const iconData = Buffer.from(await body.arrayBuffer());
                    const stickerBuffer = await sharp(iconData)
                        .resize(512, 512, {
                            fit: 'contain',
                            background: { r: 255, g: 255, b: 255, alpha: 0 }
                        })
                        .webp()
                        .toBuffer();
                    await sendBotMessage(sock, remoteJid, {
                        sticker: stickerBuffer
                    }, msg);
                }
            } catch (iconError) {
                console.log('⚠️ فشل إرسال الأيقونة:', iconError.message);
            }
        }

        await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });

        // تنزيل ZArchiver كـ APK مباشرة (فرض APK وليس XAPK)
        const API_URL = process.env.API_URL || 'http://localhost:8000';

        console.log(`📥 كننزّل ZArchiver كـ APK...`);

        // استخدام endpoint مخصص يفرض APK
        const { statusCode, headers, body } = await request(`${API_URL}/download/${ZARCHIVER_PACKAGE}`, {
            method: 'GET',
            headersTimeout: 600000,
            bodyTimeout: 600000
        });

        if (statusCode !== 200) {
            throw new Error(`HTTP ${statusCode}`);
        }

        const chunks = [];
        for await (const chunk of body) {
            chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        const fileSize = buffer.length;

        // فرض نوع الملف كـ APK
        const fileType = 'apk';
        const filename = `ZArchiver.${fileType}`;

        console.log(`✅ تّحمل ZArchiver: ${formatFileSize(fileSize)}`);

        if (buffer.length < 100000) {
            throw new Error('الملف المحمل صغير بزاف');
        }

        await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

        await logDownload(senderPhone, ZARCHIVER_PACKAGE, 'ZArchiver', fileType, fileSize);

        let caption = formatAppInfo(appDetails, fileType, fileSize);
        caption += `\n◄ اسم الملف: ${filename}`;
        caption += `\n\n💡 هذا تطبيق APK عادي، مايحتاجش ZArchiver باش تثبتو`;
        caption += POWERED_BY;

        await sendBotMessage(sock, remoteJid, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: filename,
            caption: caption
        }, msg, { forward: true });

        await sendBotMessage(sock, remoteJid, { 
            text: ` تابعني ف انستاگرام:\n${INSTAGRAM_URL}${POWERED_BY}` 
        }, msg, { forward: true });

        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);

    } catch (error) {
        console.error('❌ مشكل فتنزيل ZArchiver:', error);
        await sendBotMessage(sock, remoteJid, { 
            text: `❌ وقع مشكل فتنزيل ZArchiver. عاود المحاولة.${POWERED_BY}` 
        }, msg);
        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    }
}

async function downloadAPKWithUndici(packageName, appTitle) {
    const API_URL = process.env.API_URL || 'http://localhost:8000';

    console.log(`📥 كننزّل باستعمال Undici (أسرع 3x)...`);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`   محاولة ${attempt + 1}/3...`);

            const { statusCode, headers, body } = await request(`${API_URL}/download/${packageName}`, {
                method: 'GET',
                headersTimeout: 600000,
                bodyTimeout: 600000
            });

            if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

            const fileType = headers['x-file-type'] || 'apk';
            const source = headers['x-source'] || 'apkpure';
            const contentLength = parseInt(headers['content-length'] || '0');

            // Check file size BEFORE downloading
            if (contentLength > MAX_FILE_SIZE) {
                console.log(`\n❌ الملف كبير بزاف: ${formatFileSize(contentLength)}`);
                // Close the body stream without reading it
                await body.dump();
                throw new Error(`FILE_TOO_LARGE:${contentLength}`);
            }

            const chunks = [];
            let downloadedBytes = 0;
            const startTime = Date.now();

            for await (const chunk of body) {
                chunks.push(chunk);
                downloadedBytes += chunk.length;
                if (contentLength > 0) {
                    const progress = ((downloadedBytes / contentLength) * 100).toFixed(0);
                    process.stdout.write(`\r   ⬇️  ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(contentLength / 1024 / 1024).toFixed(1)}MB (${progress}%)`);
                } else {
                    process.stdout.write(`\r   ⬇️  ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB تم تحميله...`);
                }
            }

            const buffer = Buffer.concat(chunks);
            const fileSize = buffer.length;
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            const speed = (fileSize / 1024 / 1024 / parseFloat(elapsedTime)).toFixed(2);

            const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
            const filename = `${safeTitle}.${fileType}`;

            console.log(`\n✅ تّحمل من ${source}: ${formatFileSize(fileSize)} | السرعة: ${speed} MB/s`);

            if (buffer.length > 100000) {
    return { buffer, filename, size: fileSize, fileType };
            }

            throw new Error('الملف المحمل صغير بزاف');

        } catch (error) {
            console.log(`\n   ❌ المحاولة ${attempt + 1} فشلات: ${error.message}`);
            if (error.message.startsWith('FILE_TOO_LARGE')) {
                // If file is too large, no need to retry
                break;
            }
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    console.log(`📥 غادي نستعمل طريقة بديلة (cloudscraper)...`);
    return await downloadAPKStreamFallback(packageName, appTitle);
}

async function downloadAPKStreamFallback(packageName, appTitle) {
    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, 'scrap.py');
        const pythonProcess = spawn('python3', [pythonScript, packageName]);
        let output = '', error = '';
        pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { error += data.toString(); });
        pythonProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const filePath = output.trim();
                if (fs.existsSync(filePath)) {
                    const buffer = fs.readFileSync(filePath);
                    const filename = path.basename(filePath);
                    const fileSize = fs.statSync(filePath).size;
                    fs.unlinkSync(filePath);
                    const fileType = filename.toLowerCase().endsWith('.xapk') ? 'xapk' : 'apk';
                    const safeTitle = appTitle.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim();
                    resolve({ buffer, filename: `${safeTitle}.${fileType}`, size: fileSize, fileType });
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
        pythonProcess.on('error', () => resolve(null));
    });
}

async function processRequest(sock, from, task) {
    let queue = requestQueue.get(from);
    if (!queue) {
        queue = { processing: false, tasks: [] };
        requestQueue.set(from, queue);
    }
    queue.tasks.push(task);
    if (queue.processing) return;
    queue.processing = true;
    while (queue.tasks.length > 0) {
        const currentTask = queue.tasks.shift();
        try { await currentTask(); } catch (error) { console.error('غلطة فمعالجة الطلب:', error); }
    }
    queue.processing = false;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('session');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'fatal' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
        printQRCode: false,
        shouldIgnoreJid: () => false,
        cachedGroupMetadata: async (jid) => {
            const cached = groupMetadataCache.get(jid);
            if (cached && Date.now() - cached.timestamp < 300000) {
                return cached.data;
            }
            return null;
        },
        getMessage: async (key) => {
            return getStoredMessage(key);
        }
    });

    globalSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (msg.key && msg.message) {
                storeMessage(msg.key, msg.message);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('❌ الاتصال تقطع');
            if (shouldReconnect) {
                pairingCodeRequested = false;
                const reconnectDelay = 3000;
                console.log(`⏳ نعاود نحاول من بعد 3 ثانية...`);
                setTimeout(() => connectToWhatsApp(), reconnectDelay);
            }
        } else if (connection === 'open') {
            console.log('✅ تّصلت بواتساب بنجاح!');
            console.log('🤖 بوت AppOmar واجد');
            console.log(`👨‍💻 نمرة المطور: ${DEVELOPER_PHONES.join(', ')}`);
            pairingCodeRequested = false;
            
            // Set initial presence based on botPresenceMode
            try { await sock.sendPresenceUpdate(botPresenceMode); } catch {}

            // Start periodic presence updates if in offline mode
            if (botPresenceMode === 'unavailable') {
                if (presenceInterval) clearInterval(presenceInterval);
                presenceInterval = setInterval(async () => {
                    try { await sock.sendPresenceUpdate('unavailable'); } catch {}
                }, 30000); // Update every 30 seconds
            }

            await new Promise(r => setTimeout(r, 1000));
            await setBotProfile(sock);
        } else if (connection === 'connecting') {
            console.log('🔗 كنحاول نتصل بواتساب...');
            if (!sock.authState.creds.registered && !pairingCodeRequested) {
                pairingCodeRequested = true;
                const phoneNumber = process.env.PHONE_NUMBER;
                if (!phoneNumber) {
                    console.log('⚠️  ماعنديش PHONE_NUMBER - ماغاديش نطلب كود الاقتران');
                    pairingCodeRequested = false;
                    return;
                }
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log('\n📱 كود الاقتران ديالك:');
                        console.log(`        ${code}        \n`);
                    } catch (error) {
                        console.error('❌ مشكل فطلب كود الاقتران:', error.message);
                        pairingCodeRequested = false;
                    }
                }, 3000);
            }
        }
    });

    sock.ev.on('call', async (callData) => {
        for (const call of callData) {
            if (call.status === 'offer') {
                const callerPhone = getSenderPhone(call.from, null);
                if (isDeveloper(callerPhone)) {
                    console.log(`📞 مكالمة من المطور - ما غاديش نبلوك`);
                    return;
                }
                console.log(`📞 مكالمة جاية من: ${callerPhone} - غادي نبلوك`);
                try {
                    await sock.rejectCall(call.id, call.from);
                    await blockUser(callerPhone, 'بلوك أوتوماتيكي بسبب المكالمة', sock);
                    await sendBotMessage(sock, call.from, {
                        text: `⛔ *تحبست نهائياً*\n\nالمكالمات ممنوعة.\n\nباش تتاصل بالمطور:\n${INSTAGRAM_URL}${POWERED_BY}`
                    });
                } catch (error) {
                    console.error('❌ مشكل فرفض المكالمة:', error.message);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const messageType = Object.keys(msg.message)[0];
        if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

        const remoteJid = msg.key.remoteJid;
        const participant = msg.key.participant;
        const userId = getUserId(remoteJid, participant);
        const senderPhone = extractPhoneFromMessage(msg);
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!text) return;

        const userName = msg.pushName || 'مستخدم';
        const isAdmin = isDeveloper(senderPhone);

        console.log(`📨 رسالة من: ${senderPhone} | مطور: ${isAdmin} | النص: ${text.substring(0, 50)}`);

        const isBlacklisted = await checkBlacklist(senderPhone);
        if (isBlacklisted && !isAdmin) return;

        let session = userSessions.get(userId);
        if (session && session.isDownloading && !isAdmin) {
            const downloadSpamStatus = checkDownloadSpam(senderPhone);
            if (downloadSpamStatus === 'block') {
                stopDownloadTracking(senderPhone);
                await blockUser(senderPhone, 'بلوك بسبب تجاوز حد التنزيلات السريعة (10)', sock);
                await sendBotMessage(sock, remoteJid, { 
                    text: `⛔ *تحظرّت نهائياً*\n\n❌ تجاوزت الحد ديال التنزيلات المتزامنة\n📊 الحد: 10 تحميلات متتابعة\n\n💡 نصيحة: صيفط الطلب شوية بمسافة باش نتعامل معاه مزيان${POWERED_BY}`
                }, msg);
                return;
            }
            await sendBotMessage(sock, remoteJid, { 
                text: `⏳ شوية صبر، غانرسل ليك التطبيق...${POWERED_BY}`
            }, msg);
            return;
        }

        if (!isAdmin) {
            const hourlyStatus = checkHourlySpam(senderPhone);
            if (hourlyStatus === 'block') {
                await blockUser(senderPhone, 'بلوك بسبب تجاوز حد الرسائل (25/ساعة)', sock);
                await sendBotMessage(sock, remoteJid, { 
                    text: `⛔ *تحظرّت نهائياً*\n\n❌ رسائل كثيرة فالساعة\n📊 الحد: 25 رسالة فالساعة\n\nإلى بغيتي توضح راسك، تاصل بالمطور${POWERED_BY}`
                }, msg);
                return;
            }
        }

        await updateUserActivity(senderPhone, userName);

        await processRequest(sock, userId, async () => {
            try {
                await new Promise(r => setTimeout(r, 50));
                await handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin);
            } catch (error) {
                console.error('❌ مشكل فمعالجة الرسالة:', error);
                await sendBotMessage(sock, remoteJid, { text: `❌ وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg);
            }
        });
    });

    return sock;
}

async function handleMessage(sock, remoteJid, userId, senderPhone, text, msg, userName, isAdmin) {
    let session = userSessions.get(userId);
    const isNewUser = !session;
    if (!session) {
        session = { state: 'idle', searchResults: [], isDownloading: false, lastListMessageKey: null, firstTime: true };
        userSessions.set(userId, session);
    }

    const lowerText = text.toLowerCase().trim();

    if (text === VIP_PASSWORD) {
        vipUsers.add(senderPhone);
        stopDownloadTracking(senderPhone);
        await sendBotMessage(sock, remoteJid, { 
            text: `🌟 *VIP تَفَعّل*

◄ تنزيلات بلا حدود
◄ سرعة مزيانة
◄ أولوية فالطلبات${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === 'zarchiver' || lowerText === 'زارشيفر') {
        session.state = 'waiting_for_selection';
        session.searchResults = [{ title: 'ZArchiver', appId: ZARCHIVER_PACKAGE, developer: 'ZDevs', score: 4.5, index: 1 }];
        userSessions.set(userId, session);

        await sendBotMessage(sock, remoteJid, { 
            text: `📦 كننزّل ZArchiver...${POWERED_BY}`
        }, msg);

        // تنزيل ZArchiver مباشرة كـ APK (وليس XAPK)
        await handleZArchiverDownload(sock, remoteJid, userId, senderPhone, msg, session);
        return;
    }

    if (isNewUser && session.firstTime) {
        session.firstTime = false;

        // Fetch user profile info
        const userInfo = await getUserProfileInfo(sock, remoteJid, senderPhone, userName);

        const welcomeText = `*بوت AppOmar*

مرحبا ${userInfo.name}
النمرة: +${userInfo.phone}${userInfo.status ? `\nالحالة: ${userInfo.status}` : ''}

كيفاش تخدم بالبوت:
1️⃣ صيفط اسم التطبيق (بالانجليزية)
2️⃣ ختار رقم التطبيق من القائمة 
3️⃣ وتسنى التحميل والإرسال

قواعد الحماية:
◄ ماشي كثر من 25 رسالة فالساعة
◄ ماشي كثر من 10 تنزيلات متتابعات
◄ المكالمات = بلوك أوتوماتيكي
◄ السبيام = بلوك نهائي

ملاحظة:
باش تحصل على تنزيلات لامحدودة تاصل بالمطور وخد كود VIP

${INSTAGRAM_URL}${POWERED_BY}`;

        // Send user profile picture if available
        if (userInfo.profilePic) {
            try {
                await sendBotMessage(sock, remoteJid, {
                    image: userInfo.profilePic,
                    caption: welcomeText
                }, msg);
            } catch (imgError) {
                await sendBotMessage(sock, remoteJid, { text: welcomeText }, msg);
            }
        } else {
            await sendBotMessage(sock, remoteJid, { text: welcomeText }, msg);
        }

        // Don't search on first message - just show welcome
        return;
    }

    if (isAdmin) {
        console.log(`🔧 أمر المطور: ${text}`);

        if (text === '/stats' || text.startsWith('/stats')) {
            const stats = await getStats();
            if (stats) {
                let statsMsg = `📊 *احصائيات البوت*

◄ المستخدمين: ${stats.totalUsers}
◄ التنزيلات: ${stats.totalDownloads}
◄ تنزيلات اليوم: ${stats.todayDownloads}
◄ الحجم الكلي: ${(stats.totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB
◄ المحظورين: ${stats.blockedUsers}

🔥 *أكثر التطبيقات تنزيلاً:*`;
                stats.topApps.forEach((app, i) => { statsMsg += `\n${i + 1}◄ ${app.app_name} (${app.count})`; });
                statsMsg += POWERED_BY;
                await sendBotMessage(sock, remoteJid, { text: statsMsg }, msg);
            } else {
                await sendBotMessage(sock, remoteJid, { text: `❌ قاعدة البيانات مش موصولة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text.startsWith('/broadcast ')) {
            if (!dbEnabled) { 
                await sendBotMessage(sock, remoteJid, { text: `❌ قاعدة البيانات مش موصولة${POWERED_BY}` }, msg); 
                return; 
            }
            const message = text.replace('/broadcast ', '').trim();
            if (message) {
                await sendBotMessage(sock, remoteJid, { text: `📤 كنرسِل الرسالة...${POWERED_BY}` }, msg);
                const result = await broadcastMessage(sock, message);
                await sendBotMessage(sock, remoteJid, { text: `✅ تْرسلات\n\n✓ نجح: ${result.success}\n✗ فشل: ${result.failed}${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text.startsWith('/unblock ')) {
            const numberToUnblock = text.replace('/unblock ', '').trim();
            const success = await unblockUser(numberToUnblock, sock);
            await sendBotMessage(sock, remoteJid, { text: success ? `✅ تحيّد البلوك على ${numberToUnblock}${POWERED_BY}` : `❌ ماقدّيتش نحيد البلوك${POWERED_BY}` }, msg);
            return;
        }

        if (text.startsWith('/block ')) {
            const numberToBlock = text.replace('/block ', '').trim();
            await blockUser(numberToBlock, 'بلوك يدوي من المطور', sock);
            await sendBotMessage(sock, remoteJid, { text: `✅ تبلوكى ${numberToBlock}${POWERED_BY}` }, msg);
            return;
        }

        if (text === '/offline') {
            botPresenceMode = 'unavailable';
            try { 
                await sock.sendPresenceUpdate(botPresenceMode); 
                await sendBotMessage(sock, remoteJid, { text: `🔴 *البوت ولى Offline*\n\nدابا البوت مش متصل ظاهرياً${POWERED_BY}` }, msg);
                
                // Start periodic updates if not already running
                if (!presenceInterval) {
                    presenceInterval = setInterval(async () => {
                        try { await sock.sendPresenceUpdate('unavailable'); } catch {}
                    }, 30000); // Update every 30 seconds
                }
            } catch (error) {
                await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فتغيير الحالة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text === '/online') {
            botPresenceMode = 'available';
            try { 
                await sock.sendPresenceUpdate(botPresenceMode); 
                await sendBotMessage(sock, remoteJid, { text: `🟢 *البوت ولى Online*\n\nدابا البوت متصل${POWERED_BY}` }, msg);
                
                // Clear periodic updates
                if (presenceInterval) {
                    clearInterval(presenceInterval);
                    presenceInterval = null;
                }
            } catch (error) {
                await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فتغيير الحالة${POWERED_BY}` }, msg);
            }
            return;
        }

        if (text === '/admin') {
            const adminHelp = `🔧 *أوامر المطور*

◄ /stats - احصائيات البوت
◄ /broadcast [رسالة] - ارسال لمجموعة
◄ /block [رقم] - بلوك
◄ /unblock [رقم] - رفع البلوك
◄ /offline - البوت يبان offline
◄ /online - البوت يبان online${POWERED_BY}`;
            await sendBotMessage(sock, remoteJid, { text: adminHelp }, msg);
            return;
        }
    }

    // Handle /cancel command to reset search state
    if (lowerText === '/cancel' || lowerText === 'الغاء' || lowerText === 'إلغاء') {
        if (session.lastListMessageKey) {
            try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
            session.lastListMessageKey = null;
        }
        session.state = 'idle';
        session.searchResults = [];
        userSessions.set(userId, session);

        await sendBotMessage(sock, remoteJid, { 
            text: `تم إلغاء البحث. صيفط اسم التطبيق${POWERED_BY}`
        }, msg);
        return;
    }

    // Handle messages starting with "." - tell user to send app name only
    if (text.startsWith('.')) {
        await sendBotMessage(sock, remoteJid, { 
            text: `صيفط غير اسم التطبيق بلا أوامر
مثال اصاحبي : WhatsApp${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === '/help' || lowerText === 'مساعدة' || lowerText === 'help') {
        const helpText = `*المساعدة*

كيف كانخدم:
1. صيفط اسم التطبيق لي بغيتي
2. اختار رقم من القائمة 
3. تسنى حتى نصيفطلك التطبيق 

الأوامر:
/help /commands /history /ping /info /dev
zarchiver - باش تثبت XAPK

نصائح:
• قلب بالانجليزية
• XAPK خاصو ZArchiver${POWERED_BY}`;

        await sendBotMessage(sock, remoteJid, { text: helpText }, msg);
        return;
    }

    if (lowerText === '/commands' || lowerText === 'الاوامر' || lowerText === 'اوامر') {
        const commandsText = `*الأوامر*

/help • مساعدة
/commands • لائحة الأوامر
/history • السجل
/ping • اختبار البوت
/info • معلومات
/dev • المطور
/cancel • إلغاء البحث
zarchiver • تنزّل زارشيفر

أمثلة:
WhatsApp, Minecraft, Free Fire${POWERED_BY}`;

        await sendBotMessage(sock, remoteJid, { text: commandsText }, msg);
        return;
    }

    if (lowerText === '/ping' || lowerText === 'بينج') {
        const startTime = Date.now();
        await sendBotMessage(sock, remoteJid, { 
            text: `PONG! ${Date.now() - startTime}ms${POWERED_BY}`
        }, msg);
        return;
    }

    if (lowerText === '/info' || lowerText === 'معلومات') {
        const infoText = `*معلومات البوت*
AppOmar Bot v3.0
المصدر: APKPure
كيّساند APK و XAPK${POWERED_BY}`;
        await sendBotMessage(sock, remoteJid, { text: infoText }, msg);
        return;
    }

    if (lowerText === '/dev' || lowerText === 'المطور' || lowerText === 'تواصل') {
        await sendBotMessage(sock, remoteJid, { text: `المطور: ${INSTAGRAM_URL}${POWERED_BY}` }, msg);
        return;
    }

    if (lowerText === '/history' || lowerText === 'سجلي' || lowerText === 'history') {
        const history = await getUserHistory(senderPhone);
        if (history.length === 0) {
            await sendBotMessage(sock, remoteJid, { 
                text: `📭 *ماعندك حتى سجل*

مازال مجبدتي حتى تطبيق 
صيفط اسم باش نبحثلك${POWERED_BY}`
            }, msg);
        } else {
            let historyText = `📜 *سجل التنزيلات ديالك*\n`;
            history.forEach((item, i) => {
                const date = new Date(item.created_at).toLocaleDateString('ar-EG');
                historyText += `\n${i + 1}◄ ${item.app_name} (${item.file_type.toUpperCase()})`;
            });
            historyText += POWERED_BY;
            await sendBotMessage(sock, remoteJid, { text: historyText }, msg);
        }
        return;
    }

    if (session.state === 'idle' || session.state === 'waiting_for_search') {
        await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
        session.state = 'waiting_for_search';
        userSessions.set(userId, session);

        try {
            const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
            let results;
            if (isPackageName) {
                try {
                    const appDetails = await gplay.app({ appId: text.trim() });
                    results = [appDetails];
                } catch { 
                    results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' }); 
                }
            } else {
                results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' });
            }

            if (results.length === 0) {
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ *ماكاينش نتائج*

ماعنديش نتائج على "${text}"

💡 جرّب تكتب بالانجليزية${POWERED_BY}`
                }, msg);
                return;
            }

            const cleanResults = results.map((app, idx) => ({
                title: app.title,
                appId: app.appId || app.id || app.packageName,
                developer: app.developer || '',
                score: app.score || 0,
                icon: app.icon || null,
                index: idx + 1
            }));

            session.searchResults = [...cleanResults];
            session.state = 'waiting_for_selection';

            const resultText = formatSearchResults(cleanResults) + POWERED_BY;

            const imageBuffer = await downloadBotProfileImage();
            let sentMsg;
            if (imageBuffer) {
                sentMsg = await sendBotMessage(sock, remoteJid, { image: imageBuffer, caption: resultText }, msg);
            } else {
                sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg);
            }
            session.lastListMessageKey = sentMsg?.key;
            userSessions.set(userId, session);

        } catch (error) {
            console.error('❌ مشكل فالبحث:', error);
            await sendBotMessage(sock, remoteJid, { text: `❌ وقع مشكل فالبحث. عاود المحاولة.${POWERED_BY}` }, msg);
        }

    } else if (session.state === 'waiting_for_selection') {
        const selection = parseInt(text.trim());
        const resultsCount = session.searchResults?.length || 0;

        if (isNaN(selection) || selection < 1 || selection > resultsCount) {
            // User entered text instead of a number - treat as new search
            // Delete the old list message
            if (session.lastListMessageKey) {
                try { 
                    await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); 
                } catch {}
                session.lastListMessageKey = null;
            }

            // Reset state and start new search
            session.state = 'idle';
            session.searchResults = [];
            userSessions.set(userId, session);

            // Trigger new search with the text
            await sock.sendMessage(remoteJid, { react: { text: '🔍', key: msg.key } });
            session.state = 'waiting_for_search';
            userSessions.set(userId, session);

            try {
                const isPackageName = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(text.trim());
                let results;
                if (isPackageName) {
                    try {
                        const appDetails = await gplay.app({ appId: text.trim() });
                        results = [appDetails];
                    } catch { 
                        results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' }); 
                    }
                } else {
                    results = await gplay.search({ term: text, num: 10, country: 'us', language: 'en' });
                }

                if (results.length === 0) {
                    await sendBotMessage(sock, remoteJid, { 
                        text: `❌ *ماكاينش نتائج*

ماعنديش نتائج على "${text}"

💡 جرب تكتب بالانجليزية${POWERED_BY}`
                    }, msg);
                    return;
                }

                const cleanResults = results.map((app, idx) => ({
                    title: app.title,
                    appId: app.appId || app.id || app.packageName,
                    developer: app.developer || '',
                    score: app.score || 0,
                    icon: app.icon || null,
                    index: idx + 1
                }));

                session.searchResults = [...cleanResults];
                session.state = 'waiting_for_selection';

                const resultText = formatSearchResults(cleanResults) + POWERED_BY;

                const imageBuffer = await downloadBotProfileImage();
                let sentMsg;
                if (imageBuffer) {
                    sentMsg = await sendBotMessage(sock, remoteJid, { image: imageBuffer, caption: resultText }, msg);
                } else {
                    sentMsg = await sendBotMessage(sock, remoteJid, { text: resultText }, msg);
                }
                session.lastListMessageKey = sentMsg?.key;
                userSessions.set(userId, session);

            } catch (error) {
                console.error('❌ مشكل فالبحث:', error);
                await sendBotMessage(sock, remoteJid, { text: `❌ وقع مشكل فالبحث. عاود المحاولة.${POWERED_BY}` }, msg);
            }
            return;
        }

        const selectedApp = session.searchResults[selection - 1];
        await handleAppDownload(sock, remoteJid, userId, senderPhone, msg, selectedApp.appId, selectedApp.title, session);
    }
}

async function handleAppDownload(sock, remoteJid, userId, senderPhone, msg, appId, appTitle, session) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    const selection = session.searchResults.findIndex(app => app.appId === appId) + 1;
    const emoji = numberEmojis[selection - 1] || '📱';
    await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } });

    if (session.lastListMessageKey) {
        try { await sock.sendMessage(remoteJid, { delete: session.lastListMessageKey }); } catch {}
        session.lastListMessageKey = null;
    }

    session.isDownloading = true;
    startDownloadTracking(senderPhone);
    userSessions.set(userId, session);

    console.log(`✅ تختار: ${appTitle} (${appId})`);

    if (!appId) {
        await sendBotMessage(sock, remoteJid, { text: `❌ مشكل فالتطبيق. ختار واحد آخر.${POWERED_BY}` }, msg);
        session.isDownloading = false;
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
        return;
    }

    await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

    try {
        const appDetails = await gplay.app({ appId: appId });

        if (appDetails.icon) {
            try {
                const { statusCode, body } = await request(appDetails.icon, {
                    method: 'GET',
                    headersTimeout: 10000,
                    bodyTimeout: 10000
                });
                if (statusCode === 200) {
                    const iconData = Buffer.from(await body.arrayBuffer());
                    const stickerBuffer = await sharp(iconData)
                        .resize(512, 512, {
                            fit: 'contain',
                            background: { r: 255, g: 255, b: 255, alpha: 0 }
                        })
                        .webp()
                        .toBuffer();
                    await sendBotMessage(sock, remoteJid, {
                        sticker: stickerBuffer
                    }, msg);
                }
            } catch (iconError) {
                console.log('⚠️ فشل نرسل الأيقونة كاستيكرز:', iconError.message);
            }
        }

        await sock.sendMessage(remoteJid, { react: { text: '📥', key: msg.key } });

        const apkStream = await downloadAPKWithUndici(appDetails.appId, appDetails.title);

        if (apkStream) {
            if (apkStream.size > MAX_FILE_SIZE) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sendBotMessage(sock, remoteJid, { 
                    text: `❌ *حجم كبير بزاف*

◄ حجم التطبيق: ${formatFileSize(apkStream.size)}
◄ الحد: 2 GB

💡 جرب ابليكاسيون آخر${POWERED_BY}`
                }, msg);
                session.state = 'waiting_for_search';
                session.isDownloading = false;
                session.searchResults = [];
                stopDownloadTracking(senderPhone);
                userSessions.set(userId, session);
                return;
            }

            await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });

            const isXapk = apkStream.fileType === 'xapk';
            await logDownload(senderPhone, appDetails.appId, appDetails.title, apkStream.fileType, apkStream.size);

            let caption = formatAppInfo(appDetails, apkStream.fileType, apkStream.size);
            caption += `\n◄ اسم الملف: ${apkStream.filename}`;

            if (isXapk) {
                caption += `\n\n${getZArchiverTutorial(apkStream.filename)}`;
            }

            caption += POWERED_BY;

            await sendBotMessage(sock, remoteJid, {
                document: apkStream.buffer,
                mimetype: isXapk ? 'application/octet-stream' : 'application/vnd.android.package-archive',
                fileName: apkStream.filename,
                caption: caption
            }, msg, { forward: true });

            await sendBotMessage(sock, remoteJid, { 
                text: ` تابعني ف انستاگرام:\n${INSTAGRAM_URL}${POWERED_BY}` 
            }, msg, { forward: true });

        } else {
            await sendBotMessage(sock, remoteJid, { text: `❌ ماقدّيتش نحمل. جرّب ابليكاسيون آخر.${POWERED_BY}` }, msg);
        }

        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    } catch (error) {
        console.error('❌ مشكل:', error);
        await sendBotMessage(sock, remoteJid, { text: `❌ وقع مشكل. عاود المحاولة.${POWERED_BY}` }, msg);
        session.state = 'waiting_for_search';
        session.isDownloading = false;
        session.searchResults = [];
        stopDownloadTracking(senderPhone);
        userSessions.set(userId, session);
    }
}

console.log('🤖 بوت AppOmar المحترف');
console.log('🚀 كنطلق البوت...\n');

await initDatabase();
await downloadBotProfileImage();

connectToWhatsApp().catch(err => {
    console.error('❌ مشكل خطير:', err);
    process.exit(1);
});
