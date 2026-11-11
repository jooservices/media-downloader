// A fake Facebook: a profile whose Photos, Reels and Videos tabs each get their data from /api/graphql/, in the
// same shapes the real site uses (the photos tab's page items, a video's progressive URLs).
import { sendHtml, sendJson, serveMedia } from "../harness.mjs";

export const FB_MEDIA = "scontent.fbcdn.net";
export const FB_HOSTS = ["www.facebook.com", "facebook.com", FB_MEDIA];

const photo = (id, width = 1152, height = 1440) => ({
  node: {
    node: { __typename: "Photo", id, viewer_image: { height, width, uri: `https://${FB_MEDIA}/v/photo_${id}.jpg` } }
  }
});

const video = id => ({
  data: {
    video: {
      creation_story: {
        attachments: [
          {
            media: {
              __typename: "Video",
              id,
              owner: { __typename: "User", id: "100085192886036" },
              videoDeliveryResponseFragment: {
                videoDeliveryResponseResult: {
                  id,
                  progressive_urls: [
                    {
                      progressive_url: `https://${FB_MEDIA}/v/video_${id}_sd.mp4`,
                      failure_reason: null,
                      metadata: { quality: "SD" }
                    },
                    {
                      progressive_url: `https://${FB_MEDIA}/v/video_${id}_hd.mp4`,
                      failure_reason: null,
                      metadata: { quality: "HD" }
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    }
  }
});

const photosTab = ids => ({
  data: {
    node: {
      all_collections: {
        nodes: [{ style_renderer: { collection: { pageItems: { edges: ids.map(id => photo(id)) } } } }]
      }
    }
  }
});

// What each tab shows: the links that tell the extension which media ids belong to the page, and its data.
export const FB_TABS = {
  "": {
    links: ["/photo/?fbid=1000000000000000003", "/reel/2000000000000000001/"],
    data: () => photosTab(["1000000000000000003"])
  },
  photos: {
    links: ["/photo/?fbid=1000000000000000001", "/photo/?fbid=1000000000000000002"],
    data: () => photosTab(["1000000000000000001", "1000000000000000002"])
  },
  reels: { links: ["/reel/2000000000000000001/"], data: () => video("2000000000000000001") },
  videos: { links: ["/{account}/videos/2000000000000000002/"], data: () => video("2000000000000000002") }
};

function postTabForUrl(url, account) {
  const reel = /^\/(?:reel|video)\/(\d+)\/?$/i.exec(url.pathname);
  if (reel) {
    const kind = url.pathname.toLowerCase().startsWith("/reel/") ? "reel" : "video";
    return `${kind}:${reel[1]}`;
  }
  const ownerVideo = /^\/([^/]+)\/videos\/(\d+)\/?$/i.exec(url.pathname);
  if (ownerVideo && ownerVideo[1].toLowerCase() === account.toLowerCase()) {
    return `video:${ownerVideo[2]}`;
  }
  if (/^\/photo\/?$/i.test(url.pathname) && url.searchParams.has("fbid")) {
    return `photo:${url.searchParams.get("fbid")}`;
  }
  return null;
}

function dataForTab(tab) {
  const post = /^(reel|video):(\d+)$/.exec(tab);
  if (post) {
    return video(post[2]);
  }
  const photoId = /^photo:(\d+)$/.exec(tab);
  if (photoId) {
    return photosTab([photoId[1]]);
  }
  return FB_TABS[tab].data();
}

export function facebookRoutes(account) {
  return [
    serveMedia(FB_MEDIA, new Set(FB_HOSTS)),
    ({ host, url, response }) => {
      if (!["www.facebook.com", "facebook.com"].includes(host)) {
        return false;
      }
      if (url.pathname.startsWith("/api/graphql/")) {
        const tab = url.searchParams.get("tab") ?? "";
        sendJson(response, dataForTab(tab));
        return true;
      }
      const match = new RegExp(`^/${account}/?([a-z]*)/?$`, "i").exec(url.pathname);
      const postTab = postTabForUrl(url, account);
      if (postTab) {
        sendHtml(
          response,
          `<!doctype html><title>post</title><body><script>fetch("/api/graphql/?tab=${postTab}", { method: "POST", body: "q=1" })</script></body>`
        );
        return true;
      }
      if (!match) {
        response.writeHead(404);
        response.end();
        return true;
      }
      const tab = match[1];
      const links = FB_TABS[tab].links.map(href => `<a href="${href.replace("{account}", account)}">item</a>`).join("");
      sendHtml(
        response,
        `<!doctype html><title>${account}</title><body style="height:3000px"><main>${links}</main><script>fetch("/api/graphql/?tab=${tab}", { method: "POST", body: "q=1" })</script></body>`
      );
      return true;
    }
  ];
}
