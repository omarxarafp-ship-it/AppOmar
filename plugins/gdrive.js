import fetch from "node-fetch";

export default {
    name: 'Google Drive Downloader',
    patterns: [
        /drive\.google\.com/i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            const result = await drive(url);
            
            if (result.error) {
                throw new Error('فشل في جلب الملف');
            }

            await utils.react(sock, msg, '✅');

            const caption = `📁 *Google Drive*
📄 الاسم: ${result.fileName}
📊 الحجم: ${result.fileSize}
🗂️ النوع: ${result.mimetype}

${utils.poweredBy}`;

            await sock.sendMessage(remoteJid, {
                document: { url: result.downloadUrl },
                fileName: result.fileName,
                mimetype: result.mimetype,
                caption: caption
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('GDrive Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل ملف Google Drive\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

async function drive(url) {
    let res = { error: true };
    if (!url || !url.match(/drive\.google/i)) return res;

    try {
        const id = (url.match(/\/?id=([^&]+)/i) || url.match(/\/d\/(.*?)\//))?.[1];
        if (!id) throw "لم يتم العثور على ID الملف";

        const response = await fetch(`https://drive.google.com/uc?id=${id}&authuser=0&export=download`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "x-drive-first-party": "DriveWebUi",
                "x-json-requested": "true"
            },
            timeout: 30000
        });

        const text = await response.text();
        const { fileName, sizeBytes, downloadUrl } = JSON.parse(text.slice(4));
        
        if (!downloadUrl) throw "لا يمكن تحميل الملف";

        const fileData = await fetch(downloadUrl, { timeout: 15000 });
        if (fileData.status !== 200) throw fileData.statusText;

        return {
            downloadUrl,
            fileName,
            fileSize: formatSize(sizeBytes),
            mimetype: fileData.headers.get("content-type")
        };
    } catch (e) {
        console.error(e);
        return res;
    }
}

function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    let k = 1024,
        sizes = ["B", "KB", "MB", "GB", "TB"],
        i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}
