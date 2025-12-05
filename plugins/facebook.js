import axios from 'axios';
import * as cheerio from 'cheerio';

export default {
    name: 'Facebook Downloader',
    patterns: [
        /facebook\.com\/.*\/videos\//i,
        /facebook\.com\/watch/i,
        /facebook\.com\/share/i,
        /facebook\.com\/reel/i,
        /fb\.watch/i,
        /fb\.com/i
    ],

    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');

            console.log(`📘 محاولة تحميل فيديو Facebook: ${url}`);
            const result = await fsaverDownload(url);

            if (!result || !result.video) {
                throw new Error('فشل في جلب الفيديو');
            }

            await utils.react(sock, msg, '✅');

            await sock.sendMessage(remoteJid, {
                video: { url: result.video },
                caption: `📘 *Facebook Video*\n\n${utils.poweredBy}`
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('Facebook Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل فيديو Facebook\n\n💡 تأكد من أن:\n- الرابط عام وليس خاص\n- الفيديو متاح للمشاهدة\n\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

async function fsaverDownload(url) {
    const fetchUrl = `https://fsaver.net/download/?url=${encodeURIComponent(url)}`;
    const headers = {
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"'
    };

    try {
        const response = await axios.get(fetchUrl, { 
            headers,
            timeout: 30000
        });

        const html = response.data;
        const $ = cheerio.load(html);
        const videoSrc = $('.video__item').attr('src');

        if (!videoSrc) {
            throw new Error('Video not found.');
        }

        const baseUrl = 'https://fsaver.net';
        return { video: baseUrl + videoSrc };
    } catch (error) {
        throw new Error(error.message || 'Failed to download video');
    }
}