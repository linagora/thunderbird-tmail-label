/**
 * TMail Labels Sync - Label Synchronization Service
 *
 * This service manages the synchronization between TMail server labels
 * and Thunderbird native tags. It maintains a mapping between:
 * - TMail label ID → Thunderbird tag key
 * - TMail keyword (UUID) → IMAP keyword used on messages
 */

const LabelSyncService = {
  // State
  _initialized: false,
  _syncing: false,
  _syncStatus: TMAIL_LABELS.SYNC_STATUS.IDLE,
  _lastSyncTime: null,

  // Label mapping: accountId -> { labelId -> { tmailLabel, tbTagKey } }
  _labelMap: new Map(),

  // Color assignment tracking
  _colorIndex: 0,

  /**
   * Initialize the sync service
   */
  async init() {
    if (this._initialized) return;

    console.log("TMail Labels: Initializing sync service");

    // Load saved state
    await this._loadState();

    // Listen for Thunderbird tag changes to sync back to server
    this._setupTagListeners();

    this._initialized = true;
    console.log("TMail Labels: Sync service initialized");
  },

  /**
   * Load saved state from storage
   */
  async _loadState() {
    try {
      const data = await browser.storage.local.get([
        TMAIL_LABELS.STORAGE_KEYS.LAST_SYNC,
        TMAIL_LABELS.STORAGE_KEYS.LABEL_MAP,
        TMAIL_LABELS.STORAGE_KEYS.SETTINGS,
      ]);

      this._lastSyncTime = data[TMAIL_LABELS.STORAGE_KEYS.LAST_SYNC] || null;

      // Restore label map
      const savedMap = data[TMAIL_LABELS.STORAGE_KEYS.LABEL_MAP];
      if (savedMap) {
        for (const [accountId, labels] of Object.entries(savedMap)) {
          this._labelMap.set(accountId, new Map(Object.entries(labels)));
        }
      }

      console.log("TMail Labels: Loaded state, last sync:", this._lastSyncTime);
    } catch (error) {
      console.error("TMail Labels: Failed to load state", error);
    }
  },

  /**
   * Save state to storage
   */
  async _saveState() {
    try {
      // Convert Maps to plain objects for storage
      const labelMapObj = {};
      for (const [accountId, labels] of this._labelMap) {
        labelMapObj[accountId] = Object.fromEntries(labels);
      }

      await browser.storage.local.set({
        [TMAIL_LABELS.STORAGE_KEYS.LAST_SYNC]: this._lastSyncTime,
        [TMAIL_LABELS.STORAGE_KEYS.LABEL_MAP]: labelMapObj,
      });
    } catch (error) {
      console.error("TMail Labels: Failed to save state", error);
    }
  },

  /**
   * Setup listeners for Thunderbird tag changes
   * Labels are read-only: we only listen to keep the local mapping consistent
   * when tags are removed externally. No writes are sent to the server.
   */
  _setupTagListeners() {
    if (browser.messages.tags.onDeleted) {
      browser.messages.tags.onDeleted.addListener((key) => {
        // Remove the local mapping entry so it gets re-created on next sync
        for (const [, labels] of this._labelMap) {
          for (const [labelId, mapping] of labels) {
            if (mapping.tbTagKey === key) {
              labels.delete(labelId);
              this._saveState();
              return;
            }
          }
        }
      });
    }
  },

  /**
   * Sync labels for all accounts
   */
  async syncAll() {
    if (this._syncing) {
      console.log("TMail Labels: Sync already in progress");
      return;
    }

    this._syncing = true;
    this._syncStatus = TMAIL_LABELS.SYNC_STATUS.SYNCING;

    try {
      const accounts = await browser.imapMetadata.getImapAccounts();
      console.log("TMail Labels: Syncing", accounts.length, "IMAP accounts");

      for (const account of accounts) {
        await this.syncAccount(account.id);
      }

      this._lastSyncTime = Date.now();
      this._syncStatus = TMAIL_LABELS.SYNC_STATUS.SUCCESS;
      await this._saveState();

      console.log("TMail Labels: Sync completed successfully");
    } catch (error) {
      console.error("TMail Labels: Sync failed", error);
      this._syncStatus = TMAIL_LABELS.SYNC_STATUS.ERROR;
      throw error;
    } finally {
      this._syncing = false;
    }
  },

  /**
   * Sync labels for a specific account
   */
  async syncAccount(accountId) {
    console.log("TMail Labels: Syncing account", accountId);

    // Fetch labels from TMail server
    const result = await browser.imapMetadata.getLabels(accountId);

    if (!result.success) {
      console.warn(
        "TMail Labels: Failed to fetch labels for account",
        accountId,
        result.error
      );
      return;
    }

    const serverLabels = result.labels || [];
    console.log("TMail Labels: Found", serverLabels.length, "labels on server");

    // Get current Thunderbird tags
    const tbTags = await browser.messages.tags.list();
    const tbTagsByKey = new Map(tbTags.map((t) => [t.key, t]));

    // Get or create label map for this account
    if (!this._labelMap.has(accountId)) {
      this._labelMap.set(accountId, new Map());
    }
    const accountLabels = this._labelMap.get(accountId);

    // Sync each server label to Thunderbird (in order, mapping to $label1-5)
    for (let i = 0; i < serverLabels.length; i++) {
      await this._syncLabelToThunderbird(
        accountId,
        serverLabels[i],
        accountLabels,
        tbTagsByKey,
        i
      );
    }

    // Remove labels that no longer exist on server
    // BUT never delete native Thunderbird tags ($labelX)
    const serverLabelIds = new Set(serverLabels.map((l) => l.id));
    for (const [labelId, mapping] of accountLabels) {
      if (!serverLabelIds.has(labelId)) {
        // Only delete if it's not a native TB tag
        const isNativeTag = mapping.tbTagKey.startsWith("$label");
        if (!isNativeTag) {
          try {
            await browser.messages.tags.delete(mapping.tbTagKey);
            console.log("TMail Labels: Removed deleted label", labelId);
          } catch (error) {
            console.warn("TMail Labels: Failed to delete orphaned tag", error);
          }
        }
        accountLabels.delete(labelId);
      }
    }

    await this._saveState();
  },

  /**
   * Sync a single TMail label to Thunderbird
   * Maps TMail labels to native TB tags ($label1-5) based on order
   */
  async _syncLabelToThunderbird(accountId, label, accountLabels, tbTagsByKey, labelIndex) {
    console.log("TMail Labels: Syncing label", label.id, label.displayName, "index:", labelIndex);

    // Use native TB tag keys for first 5 labels
    const nativeKeys = ["$label1", "$label2", "$label3", "$label4", "$label5"];
    const tbTagKey = labelIndex < 5 ? nativeKeys[labelIndex] : `tmail_${labelIndex}`;

    // Check if we already have a mapping for this label
    const existingMapping = accountLabels.get(label.id);

    if (existingMapping && existingMapping.tbTagKey === tbTagKey) {
      // Update existing tag if needed
      const existingTag = tbTagsByKey.get(tbTagKey);
      if (existingTag) {
        let needsUpdate = false;
        const updates = {};

        if (existingTag.tag !== label.displayName) {
          updates.tag = label.displayName;
          needsUpdate = true;
        }

        if (label.color && existingTag.color !== label.color.toUpperCase()) {
          updates.color = label.color;
          needsUpdate = true;
        }

        if (needsUpdate) {
          try {
            await browser.messages.tags.update(tbTagKey, updates);
            console.log("TMail Labels: Updated tag", tbTagKey, updates);
          } catch (e) {
            console.warn("TMail Labels: Could not update tag", e);
          }
        }
      }

      existingMapping.tmailLabel = label;
      return;
    }

    // Check if the tag exists
    let existingTag = tbTagsByKey.get(tbTagKey);
    const color = label.color || this._getNextColor();

    if (existingTag) {
      // Tag exists, update it with TMail label info
      try {
        await browser.messages.tags.update(tbTagKey, {
          tag: label.displayName,
          color: color,
        });
        console.log("TMail Labels: Updated existing tag", tbTagKey, "to", label.displayName);
      } catch (e) {
        console.warn("TMail Labels: Could not update tag", tbTagKey, e);
      }

      accountLabels.set(label.id, {
        tmailLabel: label,
        tbTagKey: tbTagKey,
      });
    } else {
      // Create new tag
      try {
        const newKey = await browser.messages.tags.create(
          tbTagKey,
          label.displayName,
          color
        );

        accountLabels.set(label.id, {
          tmailLabel: label,
          tbTagKey: newKey,
        });

        console.log("TMail Labels: Created tag", newKey, label.displayName);
      } catch (error) {
        console.error("TMail Labels: Failed to create tag", tbTagKey, error);
      }
    }
  },

  /**
   * Convert TMail keyword (UUID) to Thunderbird tag key format
   * TB tag keys must be lowercase and alphanumeric
   */
  _keywordToTagKey(keyword) {
    // Remove dashes and make lowercase
    return keyword.replace(/-/g, "").toLowerCase();
  },

  /**
   * Get next color from the palette
   */
  _getNextColor() {
    const color =
      TMAIL_LABELS.DEFAULT_COLORS[
        this._colorIndex % TMAIL_LABELS.DEFAULT_COLORS.length
      ];
    this._colorIndex++;
    return color;
  },

  /**
   * Get all labels for an account
   */
  async getLabels(accountId) {
    const accountLabels = this._labelMap.get(accountId);
    if (!accountLabels) return [];

    return Array.from(accountLabels.values()).map((m) => m.tmailLabel);
  },

  /**
   * Get sync status
   */
  getStatus() {
    return {
      syncing: this._syncing,
      status: this._syncStatus,
      lastSyncTime: this._lastSyncTime,
    };
  },
};
