// The queue's settings (workers per site, pause between accounts, retries, files per profile), stored
// as the user entered them and always read back through the shared validator.
const QUEUE_SETTINGS_KEY = "queueSettings";
const QUEUE_PAUSED_KEY = "queuePaused";

function createQueueSettings(area) {
  const parse = PageMediaLib.config.parseConfig;
  return {
    async load() {
      const stored = await area.get({ [QUEUE_SETTINGS_KEY]: null });
      return parse(stored[QUEUE_SETTINGS_KEY]);
    },

    // Rejects with the validator's own message, so the options page can show it as it is.
    async save(raw) {
      const valid = parse(raw);
      await area.set({ [QUEUE_SETTINGS_KEY]: valid });
      return valid;
    },

    async isPaused() {
      return Boolean((await area.get({ [QUEUE_PAUSED_KEY]: false }))[QUEUE_PAUSED_KEY]);
    },

    setPaused: paused => area.set({ [QUEUE_PAUSED_KEY]: Boolean(paused) })
  };
}
