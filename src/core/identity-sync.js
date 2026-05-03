/**
 * Twake Mail for Thunderbird - Identity Synchronization Service
 *
 * Synchronizes Twake Mail custom identities (mayDelete: true) from IMAP METADATA
 * into Thunderbird identities via the browser.identities WebExtension API.
 *
 * Matching strategy:
 *   - Primary key: server identity UUID stored in _identityMap (accountId → UUID → tbIdentityId)
 *   - First-sync fallback: match by email address among unmapped TB identities
 *   - If no match: create a new TB identity
 */

const IdentitySyncService = {
  _initialized: false,

  // accountId -> Map(serverIdentityId -> { serverIdentity, tbIdentityId })
  _identityMap: new Map(),

  async init() {
    if (this._initialized) return;
    await this._loadState();
    this._initialized = true;
    console.log("Twake Mail: Identity sync service initialized");
  },

  async _loadState() {
    try {
      const data = await browser.storage.local.get(
        TWAKE_MAIL.STORAGE_KEYS.IDENTITY_MAP
      );
      const saved = data[TWAKE_MAIL.STORAGE_KEYS.IDENTITY_MAP];
      if (saved) {
        for (const [accountId, entries] of Object.entries(saved)) {
          this._identityMap.set(accountId, new Map(Object.entries(entries)));
        }
      }
    } catch (error) {
      console.error("Twake Mail: Failed to load identity state", error);
    }
  },

  async _saveState() {
    try {
      const obj = {};
      for (const [accountId, entries] of this._identityMap) {
        obj[accountId] = Object.fromEntries(entries);
      }
      await browser.storage.local.set({
        [TWAKE_MAIL.STORAGE_KEYS.IDENTITY_MAP]: obj,
      });
    } catch (error) {
      console.error("Twake Mail: Failed to save identity state", error);
    }
  },

  async syncAll() {
    const accounts = await browser.imapMetadata.getImapAccounts();
    for (const account of accounts) {
      await this.syncAccount(account.id);
    }
  },

  async syncAccount(accountId) {
    console.log("Twake Mail: Syncing identities for account", accountId);

    const result = await browser.imapMetadata.getIdentities(accountId);
    if (!result.success) {
      console.warn("Twake Mail: Failed to fetch identities for account", accountId, result.error);
      return;
    }

    // Only sync custom identities (mayDelete: true)
    const serverIdentities = (result.identities || []).filter(
      (i) => i.mayDelete === true
    );
    console.log("Twake Mail: Found", serverIdentities.length, "custom identities on server");

    const tbIdentities = await browser.identities.list(accountId);
    const tbById = new Map(tbIdentities.map((i) => [i.id, i]));

    if (!this._identityMap.has(accountId)) {
      this._identityMap.set(accountId, new Map());
    }
    const accountMap = this._identityMap.get(accountId);

    // Build set of already-mapped TB identity IDs so fallback matching skips them
    const mappedTbIds = new Set(
      Array.from(accountMap.values()).map((e) => e.tbIdentityId)
    );

    for (const serverIdentity of serverIdentities) {
      await this._syncIdentity(
        accountId, serverIdentity, accountMap, tbById, tbIdentities, mappedTbIds
      );
    }

    // Remove TB identities whose server counterpart no longer exists
    const serverIds = new Set(serverIdentities.map((i) => i.id));
    for (const [serverId, entry] of accountMap) {
      if (!serverIds.has(serverId)) {
        try {
          await browser.identities.delete(entry.tbIdentityId);
          console.log("Twake Mail: Deleted identity", entry.tbIdentityId);
        } catch (e) {
          console.warn("Twake Mail: Could not delete identity", entry.tbIdentityId, e);
        }
        accountMap.delete(serverId);
      }
    }

    await this._saveState();
  },

  async _syncIdentity(accountId, serverIdentity, accountMap, tbById, tbIdentities, mappedTbIds) {
    const details = this._buildDetails(serverIdentity);
    const existing = accountMap.get(serverIdentity.id);

    if (existing && tbById.has(existing.tbIdentityId)) {
      // Known mapping → update
      try {
        await browser.identities.update(existing.tbIdentityId, details);
        existing.serverIdentity = serverIdentity;
        console.log("Twake Mail: Updated identity", existing.tbIdentityId, serverIdentity.displayName);
      } catch (e) {
        console.warn("Twake Mail: Could not update identity", existing.tbIdentityId, e);
      }
      return;
    }

    // First-sync fallback: find a TB identity with the same email that isn't already mapped
    const matchByEmail = tbIdentities.find(
      (i) => i.email === serverIdentity.email && !mappedTbIds.has(i.id)
    );
    if (matchByEmail) {
      try {
        await browser.identities.update(matchByEmail.id, details);
        accountMap.set(serverIdentity.id, {
          serverIdentity,
          tbIdentityId: matchByEmail.id,
        });
        mappedTbIds.add(matchByEmail.id);
        console.log("Twake Mail: Matched identity by email", matchByEmail.id, serverIdentity.displayName);
      } catch (e) {
        console.warn("Twake Mail: Could not update matched identity", matchByEmail.id, e);
      }
      return;
    }

    // Create new TB identity
    try {
      const created = await browser.identities.create(accountId, details);
      accountMap.set(serverIdentity.id, {
        serverIdentity,
        tbIdentityId: created.id,
      });
      mappedTbIds.add(created.id);
      console.log("Twake Mail: Created identity", created.id, serverIdentity.displayName);
    } catch (e) {
      console.error("Twake Mail: Could not create identity", serverIdentity.displayName, e);
    }
  },

  _buildDetails(serverIdentity) {
    const details = {
      name: serverIdentity.displayName,
      email: serverIdentity.email,
    };
    // TB identities API uses a single `signature` field; signatureIsPlainText
    // controls whether it's rendered as HTML or plain text.
    if (serverIdentity.htmlSignature) {
      details.signature = serverIdentity.htmlSignature;
      details.signatureIsPlainText = false;
    } else if (serverIdentity.textSignature) {
      details.signature = serverIdentity.textSignature;
      details.signatureIsPlainText = true;
    }
    if (serverIdentity.replyTo) details.replyTo = serverIdentity.replyTo;
    if (serverIdentity.bcc) details.bcc = serverIdentity.bcc;
    return details;
  },

  getIdentities(accountId) {
    const accountMap = this._identityMap.get(accountId);
    if (!accountMap) return [];
    return Array.from(accountMap.values())
      .map((e) => e.serverIdentity)
      .filter(Boolean)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  },
};
