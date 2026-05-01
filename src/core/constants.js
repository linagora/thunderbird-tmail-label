/**
 * Twake Mail for Thunderbird - Constants
 */

const TWAKE_MAIL = {
  // IMAP METADATA path prefix for Twake Mail labels
  METADATA_PATH: "/private/vendor/tmail/labels",

  // Storage keys
  STORAGE_KEYS: {
    LAST_SYNC: "lastSyncTime",
    LABEL_MAP: "labelMap",
    SETTINGS: "settings",
  },

  // Default settings
  DEFAULT_SETTINGS: {
    autoSyncOnStartup: true,
    syncIntervalMinutes: 15,
    enabledAccounts: [], // Empty = all IMAP accounts
  },

  // Default colors for labels (used when server doesn't provide one)
  DEFAULT_COLORS: [
    "#FF0000", // Red
    "#FF9900", // Orange
    "#009900", // Green
    "#3333FF", // Blue
    "#993399", // Purple
    "#00CCCC", // Cyan
    "#FF6666", // Light red
    "#FFCC00", // Yellow
  ],

  // Sync status
  SYNC_STATUS: {
    IDLE: "idle",
    SYNCING: "syncing",
    SUCCESS: "success",
    ERROR: "error",
  },
};
