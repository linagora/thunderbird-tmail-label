/**
 * Twake Mail for Thunderbird - Background Script
 *
 * Main entry point for the extension. Handles:
 * - Initialization and auto-sync on startup
 * - Message handling from popup and content scripts
 * - Periodic sync scheduling
 */

// Sync interval timer
let syncIntervalId = null;

/**
 * Initialize the extension
 */
async function init() {
  console.log("Twake Mail: Extension starting");

  // Initialize the sync service
  await LabelSyncService.init();

  // Load settings
  const settings = await loadSettings();

  // Auto-sync on startup if enabled
  if (settings.autoSyncOnStartup) {
    console.log("Twake Mail: Running auto-sync on startup");
    try {
      await LabelSyncService.syncAll();
    } catch (error) {
      console.error("Twake Mail: Auto-sync failed", error);
    }
  }

  // Setup periodic sync if interval > 0
  if (settings.syncIntervalMinutes > 0) {
    setupPeriodicSync(settings.syncIntervalMinutes);
  }

  console.log("Twake Mail: Extension initialized");
}

/**
 * Load settings from storage
 */
async function loadSettings() {
  try {
    const data = await browser.storage.local.get(
      TWAKE_MAIL.STORAGE_KEYS.SETTINGS
    );
    return {
      ...TWAKE_MAIL.DEFAULT_SETTINGS,
      ...(data[TWAKE_MAIL.STORAGE_KEYS.SETTINGS] || {}),
    };
  } catch (error) {
    console.error("Twake Mail: Failed to load settings", error);
    return TWAKE_MAIL.DEFAULT_SETTINGS;
  }
}

/**
 * Save settings to storage
 */
async function saveSettings(settings) {
  await browser.storage.local.set({
    [TWAKE_MAIL.STORAGE_KEYS.SETTINGS]: settings,
  });
}

/**
 * Setup periodic sync
 */
function setupPeriodicSync(intervalMinutes) {
  // Clear existing interval
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
  }

  if (intervalMinutes <= 0) return;

  const intervalMs = intervalMinutes * 60 * 1000;
  syncIntervalId = setInterval(async () => {
    console.log("Twake Mail: Running periodic sync");
    try {
      await LabelSyncService.syncAll();
    } catch (error) {
      console.error("Twake Mail: Periodic sync failed", error);
    }
  }, intervalMs);

  console.log("Twake Mail: Periodic sync set to", intervalMinutes, "minutes");
}

/**
 * Handle messages from popup and content scripts
 */
browser.runtime.onMessage.addListener(async (message, sender) => {
  console.log("Twake Mail: Received message", message.type);

  switch (message.type) {
    case "SYNC_ALL":
      return handleSyncAll();

    case "SYNC_ACCOUNT":
      return handleSyncAccount(message.accountId);

    case "GET_STATUS":
      return handleGetStatus();

    case "GET_ACCOUNTS":
      return handleGetAccounts();

    case "GET_LABELS":
      return handleGetLabels(message.accountId);

    case "GET_SETTINGS":
      return handleGetSettings();

    case "SAVE_SETTINGS":
      return handleSaveSettings(message.settings);

    case "TEST_CONNECTION":
      return handleTestConnection(message.accountId);

    default:
      console.warn("Twake Mail: Unknown message type", message.type);
      return { success: false, error: "Unknown message type" };
  }
});

/**
 * Message handlers
 */

async function handleSyncAll() {
  try {
    await LabelSyncService.syncAll();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleSyncAccount(accountId) {
  try {
    await LabelSyncService.syncAccount(accountId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleGetStatus() {
  const status = LabelSyncService.getStatus();
  return { success: true, ...status };
}

async function handleGetAccounts() {
  try {
    const accounts = await browser.imapMetadata.getImapAccounts();
    return { success: true, accounts };
  } catch (error) {
    return { success: false, error: error.message, accounts: [] };
  }
}

async function handleGetLabels(accountId) {
  try {
    const labels = await LabelSyncService.getLabels(accountId);
    return { success: true, labels };
  } catch (error) {
    return { success: false, error: error.message, labels: [] };
  }
}

async function handleGetSettings() {
  const settings = await loadSettings();
  return { success: true, settings };
}

async function handleSaveSettings(settings) {
  try {
    await saveSettings(settings);

    // Update periodic sync if interval changed
    if (settings.syncIntervalMinutes !== undefined) {
      setupPeriodicSync(settings.syncIntervalMinutes);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleTestConnection(accountId) {
  try {
    const result = await browser.imapMetadata.testConnection(accountId);
    return { success: true, supported: result.supported, error: result.error };
  } catch (error) {
    return { success: false, supported: false, error: error.message };
  }
}

// Start the extension
init().catch((error) => {
  console.error("Twake Mail: Failed to initialize", error);
});
