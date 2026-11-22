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
    IDENTITY_MAP: "identityMap",
    SETTINGS: "settings",
  },

  // Default settings
  DEFAULT_SETTINGS: {
    autoSyncOnStartup: true,
    syncIntervalMinutes: 15,
    enabledAccounts: [], // Empty = all IMAP accounts
  },

  // Bounds of the periodic sync interval, in minutes (0 turns it off)
  SYNC_INTERVAL_MINUTES: { MIN: 0, MAX: 60 },

  /**
   * Sync interval in whole minutes within the bounds; anything that is not a
   * number turns periodic sync off.
   */
  normalizeSyncInterval(value) {
    const { MIN, MAX } = TWAKE_MAIL.SYNC_INTERVAL_MINUTES;
    const minutes = Math.round(Number(value));
    return Number.isFinite(minutes) ? Math.min(MAX, Math.max(MIN, minutes)) : MIN;
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
