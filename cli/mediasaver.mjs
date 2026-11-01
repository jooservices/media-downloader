import { parseDownloadArgs } from "./args.mjs";
import { installBridge, uninstallBridge } from "./edge.mjs";
import { showStatus } from "./status.mjs";
import { repairRootDownloads, finalizeRepairById } from "./repair.mjs";
import { launchAndMonitor, startDownload, resumeJob } from "./jobs.mjs";

function printUsage() {
  process.stdout.write([
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
  ].join("\n"));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") return printUsage();
  if (command === "install") return installBridge();
  if (command === "uninstall") return uninstallBridge();
  if (command === "status") return showStatus(args[0]);
  if (command === "resume") return resumeJob(args[0]);
  if (command === "repair-root") return repairRootDownloads(launchAndMonitor);
  if (command === "finalize-repair") return finalizeRepairById(args[0]);
  if (command === "download") {
    const { url, limit } = parseDownloadArgs(args);
    if (!url) throw new Error("Provide an Instagram/Facebook/X profile URL or supported media post URL.");
    return startDownload(url, limit);
  }
  if (command.startsWith("https://")) {
    const parsed = parseDownloadArgs([command, ...args]);
    return startDownload(parsed.url, parsed.limit);
  }
  throw new Error(`Unknown command: ${command}`);
}


main().catch(error => {
  process.stderr.write(`${error?.message || String(error)}\n\n`);
  printUsage();
  process.exitCode = 1;
});
