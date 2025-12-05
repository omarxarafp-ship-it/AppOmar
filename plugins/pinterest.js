import axios from 'axios';
import * as cheerio from 'cheerio';

export default {
    name: 'Pinterest Downloader',
    patterns: [
        /pinterest\.com\/pin\//i,
        /pin\.it\//i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            const result = await snappinDownload(url);
            
            if (!result.status) {
                throw new Error(result.message || 'فشل التحميل');
            }

            await utils.react(sock, msg, '✅');

            if (result.video) {
                await sock.sendMessage(remoteJid, {
                    video: { url: result.video },
                    caption: `📌 *Pinterest*\n\n${utils.poweredBy}`
                }, { quoted: msg });
            } else if (result.image) {
                await sock.sendMessage(remoteJid, {
                    image: { url: result.image },
                    caption: `📌 *Pinterest*\n\n${utils.poweredBy}`
                }, { quoted: msg });
            } else {
                throw new Error('لم يتم العثور على محتوى');
            }

            return true;
        } catch (error) {
            console.error('Pinterest Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل محتوى Pinterest\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

async function snappinDownload(pinterestUrl) {
    try {
        const { csrfToken, cookies } = await getSnappinToken();

        const postRes = await axios.post(
            'https://snappin.app/',
            { url: pinterestUrl },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: cookies,
                    Referer: 'https://snappin.app',
                    Origin: 'https://snappin.app',
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 30000
            }
        );

        const $ = cheerio.load(postRes.data);
        const thumb = $('img').attr('src');

        const downloadLinks = $('a.button.is-success')
            .map((_, el) => $(el).attr('href'))
            .get();

        let videoUrl = null;
        let imageUrl = null;

        for (const link of downloadLinks) {
            const fullLink = link.startsWith('http') ? link : 'https://snappin.app' + link;

            const head = await axios.head(fullLink).catch(() => null);
            const contentType = head?.headers?.['content-type'] || '';

            if (link.includes('/download-file/')) {
                if (contentType.includes('video')) {
                    videoUrl = fullLink;
                } else if (contentType.includes('image')) {
                    imageUrl = fullLink;
                }
            } else if (link.includes('/download-image/')) {
                imageUrl = fullLink;
            }
        }

        return {
            status: true,
            thumb,
            video: videoUrl,
            image: videoUrl ? null : imageUrl
        };
    } catch (err) {
        return {
            status: false,
            message: err?.response?.data?.message || err.message || 'خطأ غير معروف'
        };
    }
}

async function getSnappinToken() {
    const { headers, data } = await axios.get('https://snappin.app/', { timeout: 15000 });
    const cookies = headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    const $ = cheerio.load(data);
    const csrfToken = $('meta[name="csrf-token"]').attr('content');
    return { csrfToken, cookies };
}
