import * as cheerio from "cheerio";
import fetch from "node-fetch";

export default {
    name: 'Mediafire Downloader',
    patterns: [
        /mediafire\.com\/(file|folder)\//i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            const result = await mediafire(url);
            
            if (!result || !result.download) {
                throw new Error('فشل في جلب الملف');
            }

            await utils.react(sock, msg, '✅');

            const caption = `📦 *Mediafire*
📄 الاسم: ${result.filename}
📊 الحجم: ${result.sizeReadable}
🗂️ النوع: ${result.filetype || result.ext}

${utils.poweredBy}`;

            await sock.sendMessage(remoteJid, {
                document: { url: result.download },
                fileName: result.filename,
                mimetype: result.mimetype || 'application/octet-stream',
                caption: caption
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('Mediafire Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل ملف Mediafire\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

const mediaRegex = /https?:\/\/(www\.)?mediafire\.com\/(file|folder)\/(\w+)/;

async function mediafire(url) {
    const match = mediaRegex.exec(url);
    if (!match) throw new Error("رابط غير صالح");

    const id = match[3];

    const response = await fetch(url, { timeout: 30000 });
    if (!response.ok) throw new Error(`فشل الاتصال: ${response.status}`);
    
    const html = await response.text();
    const $ = cheerio.load(html);

    const download = $("a#downloadButton").attr("href");
    if (!download) throw new Error("فشل في جلب رابط التحميل");

    const infoResponse = await fetch(
        `https://www.mediafire.com/api/1.5/file/get_info.php?response_format=json&quick_key=${id}`,
        { timeout: 15000 }
    );
    
    if (!infoResponse.ok) throw new Error(`فشل API: ${infoResponse.status}`);
    
    const json = await infoResponse.json();
    if (json.response.result !== "Success") throw new Error("فشل في جلب معلومات الملف");
    
    const info = json.response.file_info;
    const size = parseInt(info.size);
    const ext = info.filename.split(".").pop() || 'bin';

    return {
        filename: info.filename,
        ext: ext,
        size: size,
        sizeReadable: formatBytes(size),
        download: download,
        filetype: info.filetype,
        mimetype: info.mimetype || `application/${ext}`,
        privacy: info.privacy,
        owner_name: info.owner_name,
    };
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
