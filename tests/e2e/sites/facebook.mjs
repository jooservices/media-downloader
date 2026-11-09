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

export function facebookRoutes(account) {
  return [
    serveMedia(FB_MEDIA, new Set(FB_HOSTS)),
    ({ host, url, response }) => {
      if (!["www.facebook.com", "facebook.com"].includes(host)) {
        return false;
      }
      if (url.pathname.startsWith("/api/graphql/")) {
        sendJson(response, FB_TABS[url.searchParams.get("tab") ?? ""].data());
        return true;
      }
      const match = new RegExp(`^/${account}/?([a-z]*)/?$`, "i").exec(url.pathname);
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
