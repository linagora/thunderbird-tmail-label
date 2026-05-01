/**
 * TMail Labels Popup Script
 */

// State
let currentAccountId = null;
let accounts = [];
let labels = [];
let settings = {};

// Elements
const elements = {
  syncStatus: null,
  statusText: null,
  accountsList: null,
  labelsList: null,
  syncBtn: null,
  autoSync: null,
  syncInterval: null,
};

/**
 * Initialize the popup
 */
async function init() {
  // Get element references
  elements.syncStatus = document.getElementById("sync-status");
  elements.statusText = document.getElementById("status-text");
  elements.accountsList = document.getElementById("accounts-list");
  elements.labelsList = document.getElementById("labels-list");
  elements.syncBtn = document.getElementById("sync-btn");
  elements.autoSync = document.getElementById("auto-sync");
  elements.syncInterval = document.getElementById("sync-interval");

  // Setup event listeners
  setupEventListeners();

  // Localize UI
  localizeUI();

  // Load data
  await loadAccounts();
  await loadSettings();
  await updateStatus();
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  elements.syncBtn.addEventListener("click", handleSync);
  elements.autoSync.addEventListener("change", handleSettingsChange);
  elements.syncInterval.addEventListener("change", handleSettingsChange);
}

/**
 * Localize UI elements
 */
function localizeUI() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const message = browser.i18n.getMessage(key);
    if (message) {
      el.textContent = message;
    }
  });
}

/**
 * Load accounts
 */
async function loadAccounts() {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_ACCOUNTS" });

    if (response.success) {
      accounts = response.accounts;
      renderAccounts();

      // Select first account if any
      if (accounts.length > 0 && !currentAccountId) {
        selectAccount(accounts[0].id);
      }
    } else {
      elements.accountsList.innerHTML = `<div class="placeholder">${response.error || "Failed to load accounts"}</div>`;
    }
  } catch (error) {
    console.error("Failed to load accounts", error);
    elements.accountsList.innerHTML = '<div class="placeholder">Error loading accounts</div>';
  }
}

/**
 * Render accounts list
 */
function renderAccounts() {
  if (accounts.length === 0) {
    elements.accountsList.innerHTML =
      '<div class="placeholder">No IMAP accounts found</div>';
    return;
  }

  elements.accountsList.innerHTML = accounts
    .map(
      (account) => `
    <div class="list-item ${account.id === currentAccountId ? "selected" : ""}"
         data-account-id="${account.id}">
      <div class="icon">📧</div>
      <div class="name">${escapeHtml(account.name)}</div>
      <div class="meta">${escapeHtml(account.serverHost)}</div>
    </div>
  `
    )
    .join("");

  // Add click handlers
  elements.accountsList.querySelectorAll(".list-item").forEach((item) => {
    item.addEventListener("click", () => {
      selectAccount(item.dataset.accountId);
    });
  });
}

/**
 * Select an account
 */
async function selectAccount(accountId) {
  currentAccountId = accountId;
  renderAccounts();
  await loadLabels(accountId);
}

/**
 * Load labels for an account
 */
async function loadLabels(accountId) {
  elements.labelsList.innerHTML =
    '<div class="loading">Loading labels...</div>';

  try {
    const response = await browser.runtime.sendMessage({
      type: "GET_LABELS",
      accountId: accountId,
    });

    if (response.success) {
      labels = response.labels;
      renderLabels();
    } else {
      elements.labelsList.innerHTML = `<div class="placeholder">${response.error || "Failed to load labels"}</div>`;
    }
  } catch (error) {
    console.error("Failed to load labels", error);
    elements.labelsList.innerHTML =
      '<div class="placeholder">Error loading labels</div>';
  }
}

/**
 * Render labels list
 */
function renderLabels() {
  if (labels.length === 0) {
    elements.labelsList.innerHTML = `<div class="placeholder">${browser.i18n.getMessage("noLabels") || "No labels found on server"}</div>`;
    return;
  }

  elements.labelsList.innerHTML = labels
    .map(
      (label) => `
    <div class="list-item">
      <div class="label-color" style="background: ${label.color || "#999"}"></div>
      <div class="name">${escapeHtml(label.displayName)}</div>
    </div>
  `
    )
    .join("");
}

/**
 * Handle sync button click
 */
async function handleSync() {
  elements.syncBtn.disabled = true;
  elements.syncBtn.classList.add("syncing");
  setStatus("syncing", browser.i18n.getMessage("syncing") || "Syncing...");

  try {
    const response = await browser.runtime.sendMessage({ type: "SYNC_ALL" });

    if (response.success) {
      setStatus("success", browser.i18n.getMessage("syncSuccess") || "Sync complete");

      // Reload labels for current account
      if (currentAccountId) {
        await loadLabels(currentAccountId);
      }
    } else {
      setStatus(
        "error",
        browser.i18n.getMessage("syncError", response.error) ||
          `Error: ${response.error}`
      );
    }
  } catch (error) {
    setStatus("error", `Error: ${error.message}`);
  } finally {
    elements.syncBtn.disabled = false;
    elements.syncBtn.classList.remove("syncing");
  }
}

/**
 * Handle settings change
 */
async function handleSettingsChange() {
  settings.autoSyncOnStartup = elements.autoSync.checked;
  settings.syncIntervalMinutes = parseInt(elements.syncInterval.value, 10) || 0;

  try {
    await browser.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: settings,
    });
  } catch (error) {
    console.error("Failed to save settings", error);
  }
}

/**
 * Load settings
 */
async function loadSettings() {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_SETTINGS" });

    if (response.success) {
      settings = response.settings;
      elements.autoSync.checked = settings.autoSyncOnStartup;
      elements.syncInterval.value = settings.syncIntervalMinutes;
    }
  } catch (error) {
    console.error("Failed to load settings", error);
  }
}

/**
 * Update sync status
 */
async function updateStatus() {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_STATUS" });

    if (response.success) {
      const status = response.syncing ? "syncing" : response.status;
      let text;

      if (response.lastSyncTime) {
        const date = new Date(response.lastSyncTime);
        text =
          browser.i18n.getMessage("lastSync", date.toLocaleTimeString()) ||
          `Last sync: ${date.toLocaleTimeString()}`;
      } else {
        text = browser.i18n.getMessage("neverSynced") || "Never synced";
      }

      setStatus(status, text);
    }
  } catch (error) {
    console.error("Failed to get status", error);
  }
}

/**
 * Set status display
 */
function setStatus(status, text) {
  elements.syncStatus.className = `status ${status}`;
  elements.statusText.textContent = text;
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", init);
