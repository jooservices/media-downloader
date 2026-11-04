// The queue engine lives in lib/supervisor.js, shared with the extension; the CLI supplies its ports.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const {
  ACK_TIMEOUT_MS,
  STALE_RUNNING_MS,
  SIGN_IN_RECHECK_MS,
  shouldRetry,
  recoverInterrupted,
  createSupervisor
} = require("../lib/supervisor.js");
