# Real-site fixtures

These files are subsets of responses captured from the live sites in a signed-in Edge on 2026-11-01. Values are unchanged. What was removed:

- Everything the parsers do not read (siblings of the nodes on the path from the response root to the video).
- Query strings and fragments on every URL (signed CDN tokens such as `oh=` and `oe=`).
- Free text (captions, bios, locations) is not kept.

| File | Source | Captured from |
|---|---|---|
| `x-tweetdetail-nasa-video.json` | X `TweetDetail` GraphQL response | a public video post by @NASA |
| `instagram-reel-embedded.json` | `<script type="application/json">` block in the reel page HTML | a public reel |
| `facebook-reel-embedded.json` | `<script type="application/json">` block in the reel page HTML | a public reel |
| `instagram-carousel-embedded.json` | `<script type="application/json">` block in a photo/video carousel page | the first 5 of a public post's 16+ items (video, photo, video, video, photo); each photo keeps its two largest renditions, each video's poster one |
| `facebook-photos-tab.json` | the photos tab's first batch (`data.node.all_collections...pageItems.edges`) | two photos; the outer `require`/`__bbox` wrapper levels above `data` were dropped |

Refresh them when a site changes its response shape; the tests then show what broke.
