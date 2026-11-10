import { parseDownloadArgs } from "./args.mjs";
import { installBridge, uninstallBridge } from "./edge.mjs";
import { showStatus } from "./status.mjs";
import { repairRootDownloads, finalizeRepairById } from "./repair.mjs";
import { launchAndMonitor, startDownload, resumeJob } from "./jobs.mjs";
import { addCommand, addUrls, moveCommand, runningServer, serve, DEFAULT_INBOX } from "./serve.mjs";
import { installService, removeService } from "./service.mjs";
import { browserCommand } from "./browser.mjs";
import { runMcp } from "./mcp.mjs";
import { addToWatch, watch } from "./watch.mjs";
import { rotateApiToken } from "./store.mjs";

const USAGE = [
  "Page Media Saver",
  "",
  "  install [edge|chrome|firefox]     remember which browser has the extension",
  "  download <profile-url>            save that account (stories, photos, reels)",
  "  service install                   start the queue at sign-in and open the API",
  "  status                            see the latest jobs",
  "  mcp                               MCP server on stdin/stdout for AI assistants",
  "  api-token rotate                 replace the REST API bearer token",
  "  browser setup|login|status        a browser profile owned by the queue, for unattended runs",
  "",
  "Also: add, serve, move, resume, repair-root, uninstall, help.",
  "A Facebook link also scans Photos, Reels and Videos. Files go to <download folder>/<Site>/<account>.",
  "Works with Edge, Chrome and Firefox on Windows, macOS and Linux. Load the unpacked extension first.",
  ""
].join("\n");

const printUsage = () => process.stdout.write(USAGE);

async function downloadCommand(args) {
  const { url, limit } = parseDownloadArgs(args);
  if (!url) {
    throw new Error("Add a profile link, for example: download https://www.instagram.com/name/");
  }
  // While `serve` owns the bridge, a second process cannot open it, so hand the URL to the queue.
  if (await runningServer()) {
    const { created, skipped } = await addUrls([url], { limit, force: true });
    process.stdout.write(
      created.length
        ? `“serve” is running, so ${created[0].platform}/${created[0].account} was added to its queue.\n`
        : `Not queued: ${skipped[0]?.reason}\n`
    );
    return undefined;
  }
  return startDownload(url, limit);
}

function serviceCommand(args) {
  if (args[0] === "remove") {
    return removeService();
  }
  if (!args[0] || args[0] === "install") {
    return installService();
  }
  throw new Error("Use: service install    or    service remove");
}

function serveCommand(args) {
  const at = args.indexOf("--inbox");
  const inbox = at >= 0 ? args[at + 1] : DEFAULT_INBOX;
  if (at >= 0 && !inbox) {
    throw new Error("--inbox needs a file path.");
  }
  return serve({ inbox, once: args.includes("--once") });
}

async function apiTokenCommand(args) {
  if (args[0] !== "rotate" || args.length !== 1) {
    throw new Error("Use: api-token rotate");
  }
  await rotateApiToken();
  process.stdout.write(
    "API token rotated. Restart serve or the installed service; API clients must reread api-token.\n"
  );
}

const COMMANDS = {
  add: addCommand,
  watch: args => (args[0] === "add" ? addToWatch(args.slice(1)) : watch()),
  serve: serveCommand,
  service: serviceCommand,
  mcp: () => runMcp(),
  "api-token": apiTokenCommand,
  browser: browserCommand,
  move: moveCommand,
  help: printUsage,
  "--help": printUsage,
  "-h": printUsage,
  install: args => installBridge(args[0]),
  uninstall: () => uninstallBridge(),
  status: args => showStatus(args[0]),
  resume: args => resumeJob(args[0]),
  "repair-root": () => repairRootDownloads(launchAndMonitor),
  "finalize-repair": args => finalizeRepairById(args[0]),
  download: downloadCommand
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    printUsage();
  } else if (command.startsWith("https://")) {
    await downloadCommand([command, ...args]);
  } else if (Object.hasOwn(COMMANDS, command)) {
    await COMMANDS[command](args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch(error => {
  process.stderr.write(`${error?.message || String(error)}\n\n`);
  printUsage();
  process.exitCode = 1;
});
