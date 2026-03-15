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
  addLabelBtn: null,
  addLabelDialog: null,
  addLabelForm: null,
  cancelAddBtn: null,
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
  elements.addLabelBtn = document.getElementById("add-label-btn");
  elements.addLabelDialog = document.getElementById("add-label-dialog");
  elements.addLabelForm = document.getElementById("add-label-form");
  elements.cancelAddBtn = document.getElementById("cancel-add-btn");
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
  // Sync button
  elements.syncBtn.addEventListener("click", handleSync);

  // Add label button
  elements.addLabelBtn.addEventListener("click", () => {
    elements.addLabelDialog.classList.remove("hidden");
    document.getElementById("label-name").focus();
  });

  // Add label form
  elements.addLabelForm.addEventListener("submit", handleAddLabel);

  // Cancel add button
  elements.cancelAddBtn.addEventListener("click", () => {
    elements.addLabelDialog.classList.add("hidden");
    elements.addLabelForm.reset();
    resetColorPicker();
  });

  // Close dialog on backdrop click
  elements.addLabelDialog.addEventListener("click", (e) => {
    if (e.target === elements.addLabelDialog) {
      elements.addLabelDialog.classList.add("hidden");
      elements.addLabelForm.reset();
      resetColorPicker();
    }
  });

  // Color picker buttons
  document.querySelectorAll(".color-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      document.getElementById("label-color").value = btn.dataset.color;
    });
  });

  // Settings changes
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
  elements.addLabelBtn.disabled = false;
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
    <div class="list-item" data-label-id="${label.id}">
      <div class="label-color" style="background: ${label.color || "#999"}"></div>
      <div class="name">${escapeHtml(label.displayName)}</div>
      <div class="actions">
        <button class="action-btn delete" data-action="delete" title="Delete">✕</button>
      </div>
    </div>
  `
    )
    .join("");

  // Add click handlers for delete
  elements.labelsList.querySelectorAll(".action-btn.delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const labelId = btn.closest(".list-item").dataset.labelId;
      handleDeleteLabel(labelId);
    });
  });
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
 * Handle add label form submit
 */
async function handleAddLabel(e) {
  e.preventDefault();

  const name = document.getElementById("label-name").value.trim();
  const color = document.getElementById("label-color").value;

  if (!name) return;

  try {
    const response = await browser.runtime.sendMessage({
      type: "CREATE_LABEL",
      accountId: currentAccountId,
      displayName: name,
      color: color,
    });

    if (response.success) {
      elements.addLabelDialog.classList.add("hidden");
      elements.addLabelForm.reset();
      resetColorPicker();
      await loadLabels(currentAccountId);
    } else {
      console.error("Failed to create label:", response.error);
    }
  } catch (error) {
    console.error("Error creating label:", error.message);
  }
}

/**
 * Handle delete label
 */
async function handleDeleteLabel(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;

  // Mark the item as "deleting" visually instead of using confirm()
  const listItem = document.querySelector(`[data-label-id="${labelId}"]`);
  if (listItem) {
    listItem.style.opacity = "0.5";
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: "DELETE_LABEL",
      accountId: currentAccountId,
      labelId: labelId,
    });

    if (response.success) {
      await loadLabels(currentAccountId);
    } else {
      if (listItem) listItem.style.opacity = "1";
      console.error("Failed to delete label:", response.error);
    }
  } catch (error) {
    if (listItem) listItem.style.opacity = "1";
    console.error("Error deleting label:", error.message);
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
 * Reset color picker to default
 */
function resetColorPicker() {
  document.querySelectorAll(".color-btn").forEach((b, i) => {
    b.classList.toggle("selected", i === 0);
  });
  document.getElementById("label-color").value = "#FF0000";
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
