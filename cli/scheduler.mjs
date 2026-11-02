// The scheduling rules live in lib/scheduler.js, shared with the extension.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { pickJobsToOpen } = require("../lib/scheduler.js");
