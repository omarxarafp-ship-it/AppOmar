import axios from 'axios';
import FormData from 'form-data';

export default {
    name: 'YouTube Downloader',
    patterns: [
        /youtube\.com\/watch/i,
        /youtu\.be\//i,
        /youtube\.com\/shorts\//i
    ],
    
    async handler(sock, remoteJid, url, msg, utils) {
        try {
            await utils.react(sock, msg, '⏳');
            
            const result = await downloadYouTubeVideo(url);
            
            if (!result.success) {
                throw new Error(result.error || 'فشل التحميل');
            }

            await utils.react(sock, msg, '✅');
            
            await sock.sendMessage(remoteJid, {
                video: { url: result.downloadUrl },
                caption: `🎬 *YouTube*\n${result.title}\n⏱️ المدة: ${result.duration}\n\n${utils.poweredBy}`
            }, { quoted: msg });

            return true;
        } catch (error) {
            console.error('YouTube Error:', error.message);
            await utils.react(sock, msg, '❌');
            await sock.sendMessage(remoteJid, {
                text: `❌ فشل تحميل فيديو YouTube\n${utils.poweredBy}`
            }, { quoted: msg });
            return false;
        }
    }
};

async function downloadYouTubeVideo(url) {
    const baseURL = 'https://backand-ytdl.siputzx.my.id/api';
    const headers = {
        'authority': 'backand-ytdl.siputzx.my.id',
        'accept': '*/*',
        'origin': 'https://yuyuyu.siputzx.my.id',
        'referer': 'https://yuyuyu.siputzx.my.id/',
        'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'
    };

    try {
        const formData1 = new FormData();
        formData1.append('url', url);

        const infoResponse = await axios.post(`${baseURL}/get-info`, formData1, {
            headers: { ...headers, ...formData1.getHeaders() },
            timeout: 30000
        });

        const videoInfo = infoResponse.data;

        const formData2 = new FormData();
        formData2.append('id', videoInfo.id);
        formData2.append('format', 'mp4');
        formData2.append('video_format_id', '18');
        formData2.append('audio_format_id', '251');
        formData2.append('info', JSON.stringify(videoInfo));

        const jobResponse = await axios.post(`${baseURL}/create_job`, formData2, {
            headers: { ...headers, ...formData2.getHeaders() },
            timeout: 30000
        });

        const jobId = jobResponse.data.job_id;

        let attempts = 0;
        while (attempts < 60) {
            const statusResponse = await axios.get(`${baseURL}/check_job/${jobId}`, { headers });
            const status = statusResponse.data;

            if (status.status === 'completed') {
                return {
                    success: true,
                    title: videoInfo.title,
                    duration: videoInfo.duration,
                    thumbnail: videoInfo.thumbnail,
                    downloadUrl: `https://backand-ytdl.siputzx.my.id${status.download_url}`
                };
            }

            if (status.status === 'failed' || status.error_message) {
                return { success: false, error: status.error_message || 'فشل في إنشاء الرابط' };
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        return { success: false, error: 'انتهى الوقت' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
