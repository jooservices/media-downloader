// A fake X profile with one video post (the real TweetDetail response captured from the site, see
// tests/fixtures/README.md) and one photo post. The video must be saved at its highest bitrate; the photo at name=orig.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendHtml, sendJson, serveMedia } from "../harness.mjs";

export const X_ACCOUNT = "NASA";
export const X_VIDEO_HOST = "video.twimg.com";
export const X_VIDEO_HOSTS = ["x.com", "www.x.com", "pbs.twimg.com", X_VIDEO_HOST];

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "x-tweetdetail-nasa-video.json"
);

export function xVideoRoutes() {
  return [
    serveMedia(X_VIDEO_HOST, new Set(X_VIDEO_HOSTS)),
    ({ host, url, response }) => {
      if (!["x.com", "www.x.com"].includes(host)) {
        return false;
      }
      if (url.pathname.startsWith("/i/api/graphql/")) {
        sendJson(response, JSON.parse(readFileSync(FIXTURE, "utf8")));
      } else if (url.pathname.toLowerCase().startsWith(`/${X_ACCOUNT.toLowerCase()}`)) {
        sendHtml(
          response,
          `<!doctype html><title>${X_ACCOUNT}</title><body style="height:3000px">
<article><a href="/${X_ACCOUNT}/status/2115779022722630042">video post</a><div data-testid="videoPlayer"><video></video></div></article>
<article><a href="/${X_ACCOUNT}/status/2115779022722630099">photo post</a><img src="https://pbs.twimg.com/media/nasaphoto?format=png&amp;name=small" width="600" height="600"></article>
<script>fetch("/i/api/graphql/abc/TweetDetail?variables=1")</script></body>`
        );
      } else {
        response.writeHead(404);
        response.end();
      }
      return true;
    }
  ];
}
