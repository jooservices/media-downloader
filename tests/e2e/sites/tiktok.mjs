// A fake TikTok: a profile whose video list arrives from /api/post/item_list, with two videos and a photo post.
import { sendHtml, sendJson, serveMedia } from "../harness.mjs";

export const TIKTOK_VIDEO_HOST = "v16-webapp.tiktokcdn.com";
export const TIKTOK_IMAGE_HOST = "p16-sign.tiktokcdn.com";
export const TIKTOK_HOSTS = ["www.tiktok.com", "tiktok.com", TIKTOK_VIDEO_HOST, TIKTOK_IMAGE_HOST];

const video = (id, account, extra = {}) => ({
  id,
  author: { uniqueId: account },
  video: {
    width: 576,
    height: 1024,
    duration: 12,
    cover: `https://${TIKTOK_IMAGE_HOST}/cover/${id}.jpg`,
    playAddr: `https://${TIKTOK_VIDEO_HOST}/play/${id}_small.mp4`,
    downloadAddr: `https://${TIKTOK_VIDEO_HOST}/play/${id}_download.mp4`,
    bitrateInfo: [
      {
        Bitrate: 400000,
        Width: 576,
        Height: 1024,
        PlayAddr: { UrlList: [`https://${TIKTOK_VIDEO_HOST}/play/${id}_low.mp4`] }
      },
      {
        Bitrate: 1200000,
        Width: 720,
        Height: 1280,
        PlayAddr: { UrlList: [`https://${TIKTOK_VIDEO_HOST}/play/${id}_high.mp4`] }
      }
    ]
  },
  ...extra
});

export function tiktokItems(account) {
  return {
    itemList: [
      video("7100000000000000001", account),
      video("7100000000000000002", account),
      video("7100000000000000003", account, {
        imagePost: {
          images: [
            {
              imageURL: { urlList: [`https://${TIKTOK_IMAGE_HOST}/slide/7100000000000000003_a_large.jpg`] },
              imageWidth: 1080,
              imageHeight: 1920
            },
            {
              imageURL: { urlList: [`https://${TIKTOK_IMAGE_HOST}/slide/7100000000000000003_b_large.jpg`] },
              imageWidth: 1080,
              imageHeight: 1920
            }
          ]
        }
      })
    ]
  };
}

export function tiktokRoutes(account) {
  return [
    serveMedia(TIKTOK_VIDEO_HOST, new Set(TIKTOK_HOSTS)),
    serveMedia(TIKTOK_IMAGE_HOST, new Set(TIKTOK_HOSTS)),
    ({ host, url, response }) => {
      if (!["www.tiktok.com", "tiktok.com"].includes(host)) {
        return false;
      }
      if (url.pathname.startsWith("/api/post/item_list")) {
        sendJson(response, tiktokItems(account));
      } else if (url.pathname.toLowerCase().startsWith(`/@${account}`)) {
        const links = ["7100000000000000001", "7100000000000000002"]
          .map(id => `<a href="/@${account}/video/${id}">v</a>`)
          .join("");
        sendHtml(
          response,
          `<!doctype html><title>${account}</title><body style="height:3000px"><main>${links}</main><script>fetch("/api/post/item_list/?aid=1988&secUid=x")</script></body>`
        );
      } else {
        response.writeHead(404);
        response.end();
      }
      return true;
    }
  ];
}
