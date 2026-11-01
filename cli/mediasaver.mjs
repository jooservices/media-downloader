import { parseDownloadArgs } from "./args.mjs";
import { installBridge, uninstallBridge } from "./edge.mjs";
import { showStatus } from "./status.mjs";
import { repairRootDownloads, finalizeRepairById } from "./repair.mjs";
import { launchAndMonitor, startDownload, resumeJob } from "./jobs.mjs";

const USAGE = [
  "Page Media Saver CLI",
  "",
  "  node cli/mediasaver.mjs install",
  "  node cli/mediasaver.mjs download <Instagram-Facebook-or-X-profile-or-post-URL> [--limit N | --unlimited]",
  "  node cli/mediasaver.mjs resume [job-id]",
  "  node cli/mediasaver.mjs repair-root",
  "  node cli/mediasaver.mjs finalize-repair <job-id>",
  "  node cli/mediasaver.mjs status [job-id]",
  "  node cli/mediasaver.mjs uninstall",
  "",
  "Downloads use the signed-in Edge profile and save to Downloads/<platform>/<account>.",
  "The CLI runs a local loopback bridge while it monitors the job; keep the CLI process open until completion.",
  "Instagram/Facebook grids and X timelines are supported by automatic scrolling; direct post URLs scan that post once.",
  ""
].join("\n");

const printUsage = () => process.stdout.write(USAGE);

function downloadCommand(args) {
  const { url, limit } = parseDownloadArgs(args);
  if (!url) {
    throw new Error("Provide an Instagram/Facebook/X profile URL or supported media post URL.");
  }
  return startDownload(url, limit);
}

const COMMANDS = {
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
