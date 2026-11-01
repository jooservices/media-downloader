// Command-line options for `download`.
export const DEFAULT_LIMIT = 10;

const LIMIT_OPTION = /^--limit=(.*)$/;

function parseLimit(raw) {
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit needs a whole number of at least 1, got “${raw ?? ""}”. Use --unlimited for no limit.`);
  }
  return limit;
}

// `download <url> [--limit N | --unlimited]`: a scan stops after it has started N files
// (photos and videos together). Without either option N is DEFAULT_LIMIT; `limit: null`
// means no limit. The CLI never reads the extension's own popup setting.
export function parseDownloadArgs(args) {
  const parsed = { url: null, limit: DEFAULT_LIMIT };
  let limitGiven = false;
  // The value is read only after the "given twice" check, so that error always wins.
  const setLimit = readValue => {
    if (limitGiven) {
      throw new Error("Use only one of --limit and --unlimited, once.");
    }
    limitGiven = true;
    parsed.limit = readValue();
  };

  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const inline = LIMIT_OPTION.exec(arg);
    if (arg === "--unlimited") {
      setLimit(() => null);
    } else if (inline) {
      setLimit(() => parseLimit(inline[1]));
    } else if (arg === "--limit") {
      i += 1;
      setLimit(() => parseLimit(args[i]));
    } else if (parsed.url === null) {
      parsed.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return parsed;
}
