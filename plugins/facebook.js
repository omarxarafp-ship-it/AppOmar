
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
            const result = await fbvdl(url);
            
            if (!result || (!result.hdUrl && !result.sdUrl)) {
                throw new Error('فشل في جلب الفيديو');
            }

            const videoUrl = result.hdUrl || result.sdUrl;
            const duration = Math.round(result.durationInMs / 1000);
            
            await utils.react(sock, msg, '✅');
            
            await sock.sendMessage(remoteJid, {
                video: { url: videoUrl },
                caption: `📘 *Facebook Video*\n\n⏱️ المدة: ${duration} ثانية\n📺 الجودة: ${result.hdUrl ? 'HD' : 'SD'}\n\n${utils.poweredBy}`
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

async function fbvdl(fbVideoUrl) {
    const headers = {
        'sec-fetch-site': 'same-origin'
    };

    // Get redirect header to extract video ID
    const fr = await fetch(fbVideoUrl, {
        headers,
        method: 'HEAD',
        redirect: 'manual'
    });

    if (!fr.ok && fr.status !== 301 && fr.status !== 302) {
        throw new Error(`Failed to fetch redirect: ${fr.status} ${fr.statusText}`);
    }

    const videoId = fr.headers.get('link')?.match(/\/(\d+)\/>;/)?.[1];
    if (!videoId) {
        throw new Error('Video ID not found. Maybe the link is private or invalid.');
    }

    // Prepare body for Facebook GraphQL API
    const body_obj = {
        caller: 'TAHOE',
        entityNumber: 5,
        feedbackSource: 41,
        feedLocation: 'TAHOE',
        focusCommentID: null,
        isCrawler: false,
        isLoggedOut: true,
        privacySelectorRenderLocation: 'COMET_STREAM',
        renderLocation: 'video_home',
        scale: 1,
        useDefaultActor: false,
        videoID: videoId,
        videoIDStr: videoId,
        __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
        __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: false,
        __relay_internal__pv__IsWorkUserrelayprovider: false
    };

    const body = new URLSearchParams({
        variables: JSON.stringify(body_obj),
        doc_id: '23880857301547365'
    });

    const res = await fetch('https://www.facebook.com/api/graphql/', {
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            ...headers
        },
        body,
        method: 'POST'
    });

    const text = await res.text();
    const json = JSON.parse(text.split('\n')[0]);
    const media = json.data.video.story.attachments[0].media;

    return {
        sdUrl: media.videoDeliveryLegacyFields.browser_native_sd_url,
        hdUrl: media.videoDeliveryLegacyFields.browser_native_hd_url,
        audioUrl: json.extensions.all_video_dash_prefetch_representations[0].representations[2].base_url,
        thumbnailUrl: media.preferred_thumbnail.image.uri,
        sprites: media?.video_player_scrubber_preview_renderer?.video?.scrubber_preview_thumbnail_information?.sprite_uris || null,
        permalinkUrl: media.permalink_url,
        publishTime: media.publish_time,
        durationInMs: media.playable_duration_in_ms
    };
}
