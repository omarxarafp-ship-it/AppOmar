import fetch from 'node-fetch';

export default {
    name: 'Facebook Downloader',
    patterns: [
        /facebook\.com\/.*\/videos\//i,
        /facebook\.com\/watch/i,
        /facebook\.com\/share/i,
        /fb\.watch/i,
        /fb\.com/i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            console.log(`📘 محاولة تحميل فيديو Facebook: ${url}`);
            const result = await fb(url);
            
            console.log(`📘 النتيجة:`, JSON.stringify(result, null, 2));
            
            if (!result || !result.success || !result.links) {
                throw new Error('فشل في جلب الفيديو - API رجع بيانات فارغة');
            }

            const videoUrl = result.links['Download High Quality'] || result.links['Download Low Quality'];
            
            if (!videoUrl) {
                throw new Error('لم يتم العثور على رابط التحميل');
            }

            await utils.react(sock, msg, '✅');
            
            await sock.sendMessage(remoteJid, {
                video: { url: videoUrl },
                caption: `📘 *Facebook*\n${result.title || ''}\n\n${utils.poweredBy}`
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('Facebook Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل فيديو Facebook\n\n💡 السبب: روابط facebook.com/share غير مدعومة حاليا\nجرب رابط الفيديو العادي (facebook.com/watch أو facebook.com/.../videos/)\n\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

async function fb(vid_url) {
    try {
        const searchParams = new URLSearchParams();
        searchParams.append('url', vid_url);
        
        const response = await fetch('https://facebook-video-downloader.fly.dev/app/main.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: searchParams.toString(),
            timeout: 30000
        });
        
        return await response.json();
    } catch (e) {
        return null;
    }
}
