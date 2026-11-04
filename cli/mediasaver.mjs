import { parseDownloadArgs } from "./args.mjs";
import { installBridge, uninstallBridge } from "./edge.mjs";
import { showStatus } from "./status.mjs";
import { repairRootDownloads, finalizeRepairById } from "./repair.mjs";
import { launchAndMonitor, startDownload, resumeJob } from "./jobs.mjs";
import { addCommand, addUrls, moveCommand, runningServer, serve, DEFAULT_INBOX } from "./serve.mjs";

const USAGE = [
  "Page Media Saver CLI",
  "",
  "  node cli/mediasaver.mjs install",
  "  node cli/mediasaver.mjs download <Instagram-Facebook-or-X-profile-or-post-URL> [--limit N | --unlimited]",
  "  node cli/mediasaver.mjs add <url> [<url>...] [--again]      queue profiles for `serve`",
  "  node cli/mediasaver.mjs serve [--inbox <file>] [--once]     work through the queue until stopped",
  "  node cli/mediasaver.mjs move                                move finished files to downloadDir once",
  "  node cli/mediasaver.mjs resume [job-id]",
  "  node cli/mediasaver.mjs repair-root",
  "  node cli/mediasaver.mjs finalize-repair <job-id>",
  "  node cli/mediasaver.mjs status [job-id]",
  "  node cli/mediasaver.mjs uninstall",
  "",
  "Downloads use the signed-in Edge profile and save to Downloads/<platform>/<account>.",
  "`serve` reads %LOCALAPPDATA%\\PageMediaSaver\\config.json: workers per site, the pause between accounts",
  "and downloadDir, the folder finished files are moved to. See the README, “Configuration”.",
  "The CLI runs a local loopback bridge while it monitors the job; keep the CLI process open until completion.",
  "Instagram/Facebook grids and X timelines are supported by automatic scrolling; direct post URLs scan that post once.",
  ""
].join("\n");

const printUsage = () => process.stdout.write(USAGE);

async function downloadCommand(args) {
  const { url, limit } = parseDownloadArgs(args);
  if (!url) {
    throw new Error("Provide an Instagram/Facebook/X profile URL or supported media post URL.");
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

function serveCommand(args) {
  const at = args.indexOf("--inbox");
  const inbox = at >= 0 ? args[at + 1] : DEFAULT_INBOX;
  if (at >= 0 && !inbox) {
    throw new Error("--inbox needs a file path.");
  }
  return serve({ inbox, once: args.includes("--once") });
}

const COMMANDS = {
  add: addCommand,
  serve: serveCommand,
  move: moveCommand,
  help: printUsage,
  "--help": printUsage,
  "-h": printUsage,
  install: () => installBridge(),
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
