// A fake Instagram: the same shapes of data the real site sends (a profile timeline over XHR, a story tray), with
// photos, a reel, a carousel and stories in it.
import { sendHtml, sendJson, serveMedia } from "../harness.mjs";

export const IG_MEDIA = "scontent.cdninstagram.com";
export const IG_HOSTS = ["www.instagram.com", "instagram.com", IG_MEDIA];

const ownerOf = name => ({ username: name, pk: "79870991603", id: "79870991603" });
const igImages = (code, big = 1440) => ({
  candidates: [
    { width: big, height: Math.round(big * 1.33), url: `https://${IG_MEDIA}/v/${code}_big.jpg` },
    { width: 640, height: 853, url: `https://${IG_MEDIA}/v/${code}_small.jpg` }
  ]
});
const igVideos = code => [
  { type: 101, width: 720, height: 1280, url: `https://${IG_MEDIA}/v/${code}_hd.mp4` },
  { type: 102, width: 360, height: 640, url: `https://${IG_MEDIA}/v/${code}_sd.mp4` }
];

// The shape of Instagram's profile timeline response (captured from the real site), with our own posts in it.
function igTimeline(account) {
  const user = ownerOf(account);
  const base = (code, extra) => ({
    code,
    pk: `39${code.length}${code.charCodeAt(0)}`,
    id: `${code}_79870991603`,
    taken_at: 1781271096,
    user,
    ...extra
  });
  return {
    data: {
      xdt_api__v1__feed__user_timeline_graphql_connection: {
        edges: [
          {
            node: base("IGPHOTOONE1", {
              media_type: 1,
              product_type: "feed",
              image_versions2: igImages("IGPHOTOONE1"),
              video_versions: null
            })
          },
          {
            node: base("IGREELONE01", {
              media_type: 2,
              product_type: "clips",
              video_versions: igVideos("IGREELONE01"),
              image_versions2: igImages("IGREELONE01_poster")
            })
          },
          {
            node: base("IGCAROUSEL1", {
              media_type: 8,
              product_type: "carousel_container",
              image_versions2: igImages("IGCAROUSEL1"),
              carousel_media: [
                { id: "c1", pk: "c1", media_type: 1, image_versions2: igImages("IGCAROUSEL1_a") },
                {
                  id: "c2",
                  pk: "c2",
                  media_type: 2,
                  video_versions: igVideos("IGCAROUSEL1_b"),
                  image_versions2: igImages("IGCAROUSEL1_b_poster")
                },
                { id: "c3", pk: "c3", media_type: 1, image_versions2: igImages("IGCAROUSEL1_c") }
              ]
            })
          }
        ]
      }
    }
  };
}

function igStories(account) {
  const user = ownerOf(account);
  return {
    reels_media: [
      {
        id: user.pk,
        user,
        items: [
          {
            pk: "3917000000000000001",
            id: "3917000000000000001_79870991603",
            product_type: "story",
            media_type: 1,
            taken_at: 1781271000,
            user,
            image_versions2: igImages("IGSTORYPHOTO")
          },
          {
            pk: "3917000000000000002",
            id: "3917000000000000002_79870991603",
            product_type: "story",
            media_type: 2,
            taken_at: 1781271001,
            user,
            video_versions: igVideos("IGSTORYVIDEO"),
            image_versions2: igImages("IGSTORYVIDEO_poster")
          }
        ]
      }
    ]
  };
}

const requestScript = (method, url) =>
  `<script>var x = new XMLHttpRequest(); x.open("${method}", "${url}"); x.setRequestHeader("content-type", "application/x-www-form-urlencoded"); x.send("q=1");</script>`;

// The profile grid links to every post, which is how the extension knows which posts to ask the cache for.
function gridLinks() {
  return [
    ["p", "IGPHOTOONE1"],
    ["reel", "IGREELONE01"],
    ["p", "IGCAROUSEL1"]
  ]
    .map(([kind, code]) => `<a href="/${kind}/${code}/">post</a>`)
    .join("");
}

// Like the real site, opening the story tray does not reload the page: the address changes and the data is fetched.
function storyLink(account) {
  const open = [
    "event.preventDefault()",
    `history.pushState({}, '', '/stories/${account}/')`,
    "var s = new XMLHttpRequest()",
    "s.open('GET', '/api/v1/feed/reels_media/?reel_ids=79870991603')",
    "s.send()"
  ].join(";");
  return `<a href="/stories/${account}/" onclick="${open}">story</a>`;
}

export function instagramRoutes(account) {
  const media = serveMedia(IG_MEDIA, new Set(IG_HOSTS));
  return [
    media,
    ({ host, url, request, response }) => {
      if (!["www.instagram.com", "instagram.com"].includes(host)) {
        return false;
      }
      if (request.method === "POST" && url.pathname === "/api/graphql") {
        sendJson(response, igTimeline(account));
      } else if (url.pathname.startsWith("/api/v1/feed/reels_media")) {
        sendJson(response, igStories(account));
      } else if (url.pathname.toLowerCase().startsWith(`/stories/${account}`)) {
        sendHtml(
          response,
          `<!doctype html><title>story</title><body>${requestScript("GET", "/api/v1/feed/reels_media/?reel_ids=79870991603")}</body>`
        );
      } else if (url.pathname.toLowerCase().startsWith(`/${account}`)) {
        sendHtml(
          response,
          `<!doctype html><title>${account}</title><body style="height:3000px"><header>${storyLink(account)}</header><main>${gridLinks()}</main>${requestScript("POST", "/api/graphql")}</body>`
        );
      } else {
        response.writeHead(404);
        response.end();
      }
      return true;
    }
  ];
}
