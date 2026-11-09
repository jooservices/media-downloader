// `watch add <url>` puts accounts on the list that `serve` rescans; `watch` alone is `serve`, which also reads that list as an inbox.
import { serve } from "./serve.mjs";
import { DEFAULT_WATCH, addWatch } from "./watchlist.mjs";

export { DEFAULT_WATCH };

export async function addToWatch(urls) {
  if (!urls.length) {
    throw new Error("Give at least one profile URL: node cli/mediasaver.mjs watch add <url> [<url>...]");
  }
  const { added, existing } = await addWatch(urls);
  process.stdout.write(`Watching ${added.length} new page(s); ${existing.length} already on the list.\n`);
  for (const page of added) {
    process.stdout.write(`  ${page}\n`);
  }
}

export function watch() {
  return serve({ inbox: DEFAULT_WATCH });
}
