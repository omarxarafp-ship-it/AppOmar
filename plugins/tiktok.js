import axios from 'axios';

export default {
    name: 'TikTok Downloader',
    patterns: [
        /tiktok\.com/i,
        /vm\.tiktok\.com/i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            const encodedParams = new URLSearchParams();
            encodedParams.set("url", url);
            encodedParams.set("hd", "1");

            const response = await axios({
                method: "POST",
                url: "https://tikwm.com/api/",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    Cookie: "current_language=en",
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
                },
                data: encodedParams,
                timeout: 30000
            });

            const res = response.data.data;
            
            if (!res || !res.play) {
                throw new Error('فشل في جلب الفيديو');
            }

            await utils.react(sock, msg, '✅');
            
            await sock.sendMessage(remoteJid, {
                video: { url: res.play },
                caption: `🎬 *TikTok*\n${res.title || ''}\n\n${utils.poweredBy}`
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('TikTok Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل فيديو TikTok\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};
