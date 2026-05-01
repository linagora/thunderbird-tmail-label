/* global ExtensionAPI, ExtensionCommon, Services, Cc, Ci, ChromeUtils */

"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

/**
 * TMail Labels IMAP Metadata Experiment API
 *
 * Provides access to IMAP METADATA extension (RFC 5464) for reading
 * TMail labels stored at /private/vendor/tmail/labels/
 *
 * IMPORTANT: Labels are READ-ONLY. This API only reads labels via IMAP METADATA.
 *
 * TMail labels structure:
 *   /private/vendor/tmail/labels/{labelId}/keyword -> UUID keyword
 *   /private/vendor/tmail/labels/{labelId}/displayname -> Human-readable name
 *   /private/vendor/tmail/labels/{labelId}/color -> (optional) Color hex code
 */
var imapMetadata = class extends ExtensionAPI {
  getAPI(context) {
    const self = this;

    // Store event listeners
    if (!imapMetadata._eventListeners) {
      imapMetadata._eventListeners = new Map();
    }

    return {
      imapMetadata: {
        /**
         * Get all IMAP accounts that could support TMail labels
         */
        async getImapAccounts() {
          const accounts = [];
          const accountManager = Cc[
            "@mozilla.org/messenger/account-manager;1"
          ].getService(Ci.nsIMsgAccountManager);

          for (const account of accountManager.accounts) {
            const server = account.incomingServer;

            // Only include IMAP accounts
            if (server && server.type === "imap") {
              accounts.push({
                id: account.key,
                name: server.prettyName || server.hostName,
                serverHost: server.hostName,
                username: server.username,
              });
            }
          }

          return accounts;
        },

        /**
         * Fetch TMail labels from IMAP METADATA
         */
        async getLabels(accountId, folderPath = "INBOX") {
          try {
            const { server, folder } = self.getServerAndFolder(
              accountId,
              folderPath
            );

            // Send GETMETADATA command and parse response
            const labels = await self.fetchLabelsViaMetadata(server, folder);

            return {
              success: true,
              labels: labels,
            };
          } catch (error) {
            console.error("TMail Labels: getLabels error", error);
            return {
              success: false,
              error: error.message || String(error),
            };
          }
        },

        /**
         * Test if an account supports TMail METADATA labels
         */
        async testConnection(accountId) {
          try {
            const { server, folder } = self.getServerAndFolder(
              accountId,
              "INBOX"
            );

            // Try to fetch metadata - if it works, the server supports it
            await self.fetchLabelsViaMetadata(server, folder);

            return { supported: true };
          } catch (error) {
            console.error("TMail Labels: testConnection error", error);
            return {
              supported: false,
              error: error.message || String(error),
            };
          }
        },

        /**
         * Event fired when labels change on the server
         */
        onLabelsChanged: new ExtensionCommon.EventManager({
          context,
          name: "imapMetadata.onLabelsChanged",
          register: (fire) => {
            const listener = (accountId, labels) => {
              fire.async(accountId, labels);
            };

            imapMetadata._eventListeners.set(context.extension.id, listener);

            return () => {
              imapMetadata._eventListeners.delete(context.extension.id);
            };
          },
        }).api(),
      },
    };
  }

  /**
   * Get server and folder objects from account ID and folder path
   */
  getServerAndFolder(accountId, folderPath) {
    const accountManager = Cc[
      "@mozilla.org/messenger/account-manager;1"
    ].getService(Ci.nsIMsgAccountManager);

    const account = accountManager.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const server = account.incomingServer;
    if (!server || server.type !== "imap") {
      throw new Error(`Account ${accountId} is not an IMAP account`);
    }

    // Get the root folder and find the target folder
    const rootFolder = server.rootFolder;
    let folder;

    if (folderPath === "INBOX" || folderPath === "") {
      // Get INBOX directly
      folder = rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
      if (!folder) {
        // Fallback: try to get by name
        try {
          folder = rootFolder.getChildNamed("INBOX");
        } catch (e) {
          folder = rootFolder;
        }
      }
    } else {
      // Navigate to the specified folder path
      try {
        folder = rootFolder.getChildNamed(folderPath);
      } catch (e) {
        throw new Error(`Folder not found: ${folderPath}`);
      }
    }

    return { server, folder };
  }

  /**
   * Fetch labels via IMAP METADATA command
   *
   * Uses raw IMAP socket since Thunderbird doesn't natively expose METADATA
   */
  async fetchLabelsViaMetadata(server, folder) {
    try {
      console.log("TMail Labels: Fetching metadata via raw IMAP");
      const labels = await this.fetchMetadataViaRawImap(server, folder);
      return labels;
    } catch (err) {
      console.warn("TMail Labels: Raw IMAP failed, using cached data", err);
      // Return cached/stored labels if available
      return this.getCachedLabels(server.key);
    }
  }

  /**
   * Fetch metadata via raw IMAP socket connection
   * This sends the actual GETMETADATA command to the server
   */
  async fetchMetadataViaRawImap(server, folder) {
    const host = server.hostName;
    const port = server.port || 993;
    const useSSL = server.socketType === Ci.nsMsgSocketType.SSL;
    const username = server.username;

    // Resolve password before opening the socket.
    // server.password returns the in-memory cached password (set when Thunderbird
    // authenticated with the IMAP server). Falls back to nsILoginManager.
    const password = await this._getImapPassword(server);
    if (!password) {
      throw new Error("Could not find IMAP password for account");
    }

    return new Promise((resolve, reject) => {
      try {
        console.log(`TMail Labels: Connecting to ${host}:${port} (SSL: ${useSSL})`);

        const transportService = Cc[
          "@mozilla.org/network/socket-transport-service;1"
        ].getService(Ci.nsISocketTransportService);

        const socketTypes = useSSL ? ["ssl"] : [];
        const transport = transportService.createTransport(
          socketTypes,
          host,
          port,
          null,
          null
        );

        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, 30);
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 60);

        const outstream = transport.openOutputStream(0, 0, 0);
        const instream = transport.openInputStream(0, 0, 0);

        const scriptStream = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        scriptStream.init(instream);

        let commandTag = 0;
        let state = "greeting";
        let responseBuffer = "";
        const labels = [];

        const sendCommand = (cmd) => {
          commandTag++;
          const fullCmd = `A${commandTag} ${cmd}\r\n`;
          console.log("TMail Labels: Sending:", fullCmd.trim());
          outstream.write(fullCmd, fullCmd.length);
        };

        const processResponse = () => {
          try {
            const available = scriptStream.available();
            if (available > 0) {
              responseBuffer += scriptStream.read(available);

              const lines = responseBuffer.split("\r\n");
              responseBuffer = lines.pop() || "";

              for (const line of lines) {
                if (!line) continue;
                console.log("TMail Labels: Received:", line);

                if (state === "greeting") {
                  if (line.startsWith("* OK")) {
                    state = "login";
                    sendCommand(`LOGIN ${username} ${password}`);
                  }
                } else if (state === "login") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "getmetadata";
                    sendCommand(
                      `GETMETADATA "INBOX" (DEPTH infinity) /private/vendor/tmail/labels`
                    );
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Login failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "getmetadata") {
                  if (line.startsWith("* METADATA")) {
                    const parsed = this.parseMetadataResponse(line);
                    labels.push(...parsed);
                  } else if (line.match(/^A\d+ OK/)) {
                    state = "logout";
                    sendCommand("LOGOUT");
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    console.warn("TMail Labels: GETMETADATA failed:", line);
                    state = "logout";
                    sendCommand("LOGOUT");
                  }
                } else if (state === "logout") {
                  if (line.match(/^A\d+ OK/) || line.startsWith("* BYE")) {
                    this.setCachedLabels(server.key, labels);
                    resolve(labels);
                    cleanup();
                    return;
                  }
                }
              }
            }

            if (state !== "done") {
              Services.tm.currentThread.dispatch(
                { run: processResponse },
                Ci.nsIThread.DISPATCH_NORMAL
              );
            }
          } catch (e) {
            if (e.name !== "NS_BASE_STREAM_WOULD_BLOCK") {
              console.error("TMail Labels: Read error", e);
              reject(e);
              cleanup();
            } else {
              Services.tm.currentThread.dispatch(
                { run: processResponse },
                Ci.nsIThread.DISPATCH_NORMAL
              );
            }
          }
        };

        const cleanup = () => {
          state = "done";
          try {
            outstream.close();
            instream.close();
            transport.close(0);
          } catch (e) {
            // Ignore cleanup errors
          }
        };

        Services.tm.currentThread.dispatch(
          { run: processResponse },
          Ci.nsIThread.DISPATCH_NORMAL
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Retrieve the IMAP password for a given server.
   *
   * Primary: server.password — Thunderbird caches this after the first
   * successful IMAP login in the session (no UI prompt, no keyring access).
   *
   * Fallback: nsILoginManager.findLogins() — works whether the API is
   * synchronous (older TB) or returns a Promise (TB 128+).
   */
  async _getImapPassword(server) {
    // Primary: in-memory cache on the server object
    try {
      const cached = server.password;
      if (cached) return cached;
    } catch (e) {
      // not exposed in this context, fall through
    }

    // Fallback: login manager
    const host = server.hostName;
    const port = server.port || 993;
    const username = server.username;
    const loginManager = Cc[
      "@mozilla.org/login-manager;1"
    ].getService(Ci.nsILoginManager);

    const candidates = [
      [`imap://${host}`, `imap://${host}`],
      [`imap://${host}:${port}`, `imap://${host}:${port}`],
      [`imap://${host}:${port}`, ""],
      [`imap://${host}`, ""],
    ];

    for (const [origin, realm] of candidates) {
      try {
        const logins = await loginManager.findLogins(origin, null, realm);
        if (logins && logins.length) {
          for (const login of logins) {
            if (login.username === username) return login.password;
          }
        }
      } catch (e) {
        // try next candidate
      }
    }
    return null;
  }

  /**
   * Parse IMAP METADATA response line
   * Format: * METADATA "INBOX" (/private/vendor/tmail/labels/ID/keyword "value" ...)
   */
  parseMetadataResponse(line) {
    const labels = new Map(); // labelId -> {keyword, displayName, color}

    // Extract the metadata entries part
    const match = line.match(/\* METADATA "[^"]*" \((.+)\)/);
    if (!match) return [];

    const entriesStr = match[1];

    // Parse key-value pairs
    // Format: /path/to/key "value" /path/to/key2 "value2"
    const regex = /\/private\/vendor\/tmail\/labels\/([^/]+)\/(\w+)\s+"([^"]*)"/g;
    let m;

    while ((m = regex.exec(entriesStr)) !== null) {
      const labelId = m[1];
      const property = m[2];
      const value = m[3];

      if (!labels.has(labelId)) {
        labels.set(labelId, { id: labelId });
      }

      const label = labels.get(labelId);
      if (property === "keyword") {
        label.keyword = value;
      } else if (property === "displayname") {
        label.displayName = value;
      } else if (property === "color") {
        label.color = value;
      }
    }

    // Convert to array and filter out incomplete labels
    return Array.from(labels.values()).filter(
      (l) => l.keyword && l.displayName
    );
  }

  /**
   * Get cached labels for a server
   */
  getCachedLabels(serverKey) {
    if (!imapMetadata._labelCache) {
      imapMetadata._labelCache = new Map();
    }
    return imapMetadata._labelCache.get(serverKey) || [];
  }

  /**
   * Set cached labels for a server
   */
  setCachedLabels(serverKey, labels) {
    if (!imapMetadata._labelCache) {
      imapMetadata._labelCache = new Map();
    }
    imapMetadata._labelCache.set(serverKey, labels);
  }

};
