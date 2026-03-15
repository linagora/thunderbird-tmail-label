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
 * IMPORTANT: Labels are READ-ONLY via IMAP METADATA.
 * CRUD operations use TMail WebAdmin API (HTTP).
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

    // Store WebAdmin URLs per account
    if (!imapMetadata._webAdminUrls) {
      imapMetadata._webAdminUrls = new Map();
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
         * Create a new TMail label on the server via WebAdmin API
         */
        async createLabel(accountId, displayName, color = null) {
          try {
            const { server } = self.getServerAndFolder(accountId, "INBOX");
            const webAdminUrl = self.getWebAdminUrlForAccount(accountId, server);

            if (!webAdminUrl) {
              throw new Error(
                "WebAdmin URL not configured. Please set the TMail WebAdmin URL in settings."
              );
            }

            const username = server.username;
            const url = `${webAdminUrl}/users/${encodeURIComponent(username)}/labels`;

            const body = { displayName };
            if (color) body.color = color;

            const response = await self.httpRequest("POST", url, body);

            if (response.error) {
              throw new Error(response.error);
            }

            return {
              success: true,
              label: {
                id: response.id,
                keyword: response.keyword,
                displayName: response.displayName,
                color: response.color,
              },
            };
          } catch (error) {
            console.error("TMail Labels: createLabel error", error);
            return {
              success: false,
              error: error.message || String(error),
            };
          }
        },

        /**
         * Update an existing TMail label via WebAdmin API
         */
        async updateLabel(accountId, labelId, displayName = null, color = null) {
          try {
            const { server } = self.getServerAndFolder(accountId, "INBOX");
            const webAdminUrl = self.getWebAdminUrlForAccount(accountId, server);

            if (!webAdminUrl) {
              throw new Error("WebAdmin URL not configured");
            }

            const username = server.username;
            const url = `${webAdminUrl}/users/${encodeURIComponent(username)}/labels/${encodeURIComponent(labelId)}`;

            const body = {};
            if (displayName) body.displayName = displayName;
            if (color) body.color = color;

            const response = await self.httpRequest("PUT", url, body);

            if (response.error) {
              throw new Error(response.error);
            }

            return { success: true };
          } catch (error) {
            console.error("TMail Labels: updateLabel error", error);
            return {
              success: false,
              error: error.message || String(error),
            };
          }
        },

        /**
         * Delete a TMail label from the server via WebAdmin API
         */
        async deleteLabel(accountId, labelId) {
          try {
            const { server } = self.getServerAndFolder(accountId, "INBOX");
            const webAdminUrl = self.getWebAdminUrlForAccount(accountId, server);

            if (!webAdminUrl) {
              throw new Error("WebAdmin URL not configured");
            }

            const username = server.username;
            const url = `${webAdminUrl}/users/${encodeURIComponent(username)}/labels/${encodeURIComponent(labelId)}`;

            const response = await self.httpRequest("DELETE", url);

            if (response.error) {
              throw new Error(response.error);
            }

            return { success: true };
          } catch (error) {
            console.error("TMail Labels: deleteLabel error", error);
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
         * Set WebAdmin URL for an account
         */
        async setWebAdminUrl(accountId, webAdminUrl) {
          imapMetadata._webAdminUrls.set(accountId, webAdminUrl);
          return { success: true };
        },

        /**
         * Get WebAdmin URL for an account
         */
        async getWebAdminUrl(accountId) {
          return {
            webAdminUrl: imapMetadata._webAdminUrls.get(accountId) || null,
          };
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
    return new Promise((resolve, reject) => {
      try {
        // Get server connection parameters
        const host = server.hostName;
        const port = server.port || 993;
        const useSSL = server.socketType === Ci.nsMsgSocketType.SSL;
        const username = server.username;

        console.log(`TMail Labels: Connecting to ${host}:${port} (SSL: ${useSSL})`);

        // Create socket transport
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

        // Set timeout
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, 30);
        transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, 60);

        // Open streams
        const outstream = transport.openOutputStream(0, 0, 0);
        const instream = transport.openInputStream(0, 0, 0);

        // Create script input stream for reading
        const scriptStream = Cc[
          "@mozilla.org/scriptableinputstream;1"
        ].createInstance(Ci.nsIScriptableInputStream);
        scriptStream.init(instream);

        // IMAP command sequence
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

        // Password lookup using login manager
        const getPassword = () => {
          const loginManager = Cc[
            "@mozilla.org/login-manager;1"
          ].getService(Ci.nsILoginManager);

          const logins = loginManager.findLogins(
            `imap://${host}`,
            null,
            `imap://${host}`
          );

          for (const login of logins) {
            if (login.username === username) {
              return login.password;
            }
          }

          // Try alternate URI formats
          const altLogins = loginManager.findLogins(
            `imap://${host}:${port}`,
            null,
            ""
          );

          for (const login of altLogins) {
            if (login.username === username) {
              return login.password;
            }
          }

          return null;
        };

        // Process IMAP responses
        const processResponse = () => {
          try {
            const available = scriptStream.available();
            if (available > 0) {
              responseBuffer += scriptStream.read(available);

              // Check for complete responses (ending with \r\n)
              const lines = responseBuffer.split("\r\n");
              responseBuffer = lines.pop() || ""; // Keep incomplete line

              for (const line of lines) {
                if (!line) continue;
                console.log("TMail Labels: Received:", line);

                // Parse response based on state
                if (state === "greeting") {
                  if (line.startsWith("* OK")) {
                    state = "login";
                    const password = getPassword();
                    if (password) {
                      sendCommand(`LOGIN ${username} ${password}`);
                    } else {
                      reject(new Error("Could not find password for account"));
                      cleanup();
                      return;
                    }
                  }
                } else if (state === "login") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "getmetadata";
                    const folderName = folder.name || "INBOX";
                    sendCommand(
                      `GETMETADATA "${folderName}" (DEPTH infinity) /private/vendor/tmail/labels`
                    );
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Login failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "getmetadata") {
                  // Parse METADATA response
                  // Format: * METADATA "INBOX" (/private/vendor/tmail/labels/ID/key "value" ...)
                  if (line.startsWith("* METADATA")) {
                    const parsed = this.parseMetadataResponse(line);
                    labels.push(...parsed);
                  } else if (line.match(/^A\d+ OK/)) {
                    state = "logout";
                    sendCommand("LOGOUT");
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    // METADATA not supported or error
                    console.warn("TMail Labels: GETMETADATA failed:", line);
                    state = "logout";
                    sendCommand("LOGOUT");
                  }
                } else if (state === "logout") {
                  if (line.match(/^A\d+ OK/) || line.startsWith("* BYE")) {
                    // Cache the labels
                    this.setCachedLabels(server.key, labels);
                    resolve(labels);
                    cleanup();
                    return;
                  }
                }
              }
            }

            // Continue reading if not done
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
              // No data available yet, try again
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

        // Start processing
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
   * Get WebAdmin URL for an account, with auto-detection fallback
   */
  getWebAdminUrlForAccount(accountId, server) {
    // Check if explicitly configured
    const configured = imapMetadata._webAdminUrls.get(accountId);
    if (configured) return configured;

    // Auto-detect: assume WebAdmin is on same host, port 8000
    // This is a common TMail deployment pattern
    const host = server.hostName;
    return `http://${host}:8000`;
  }

  /**
   * Make HTTP request to TMail WebAdmin API using XPCOM
   */
  async httpRequest(method, url, body = null) {
    return new Promise((resolve) => {
      try {
        const uri = Services.io.newURI(url);
        const channel = Services.io.newChannelFromURI(
          uri,
          null,
          Services.scriptSecurityManager.getSystemPrincipal(),
          null,
          Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          Ci.nsIContentPolicy.TYPE_OTHER
        );

        if (channel instanceof Ci.nsIHttpChannel) {
          channel.requestMethod = method;
          channel.setRequestHeader("Content-Type", "application/json", false);

          if (body && (method === "POST" || method === "PUT")) {
            const inputStream = Cc[
              "@mozilla.org/io/string-input-stream;1"
            ].createInstance(Ci.nsIStringInputStream);
            const bodyStr = JSON.stringify(body);
            inputStream.setUTF8Data(bodyStr);

            const uploadChannel = channel.QueryInterface(Ci.nsIUploadChannel);
            uploadChannel.setUploadStream(
              inputStream,
              "application/json",
              -1
            );
            // setUploadStream resets the method, so set it again
            channel.requestMethod = method;
          }
        }

        const listener = {
          _data: [],
          onStartRequest() {},
          onStopRequest(request, status) {
            const httpChannel = request.QueryInterface(Ci.nsIHttpChannel);
            let responseStatus;
            try {
              responseStatus = httpChannel.responseStatus;
            } catch (e) {
              resolve({ error: "Network error: " + e.message });
              return;
            }

            const responseText = this._data.join("");

            if (responseStatus >= 200 && responseStatus < 300) {
              try {
                resolve(responseText ? JSON.parse(responseText) : {});
              } catch (e) {
                resolve({});
              }
            } else {
              resolve({ error: `HTTP ${responseStatus}` });
            }
          },
          onDataAvailable(request, inputStream, offset, count) {
            const sis = Cc[
              "@mozilla.org/scriptableinputstream;1"
            ].createInstance(Ci.nsIScriptableInputStream);
            sis.init(inputStream);
            this._data.push(sis.read(count));
          },
        };

        channel.asyncOpen(listener);
      } catch (error) {
        console.error("TMail Labels: HTTP request failed", error);
        resolve({ error: error.message || "Request failed" });
      }
    });
  }

  /**
   * DEPRECATED: Set label metadata on the server via SETMETADATA
   * TMail labels are read-only via IMAP METADATA.
   * Use WebAdmin API instead.
   */
  async setLabelMetadata(server, folder, labelId, data) {
    return new Promise((resolve, reject) => {
      try {
        const host = server.hostName;
        const port = server.port || 993;
        const useSSL = server.socketType === Ci.nsMsgSocketType.SSL;
        const username = server.username;

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

        const sendCommand = (cmd) => {
          commandTag++;
          const fullCmd = `A${commandTag} ${cmd}\r\n`;
          console.log("TMail Labels: Sending:", fullCmd.trim());
          outstream.write(fullCmd, fullCmd.length);
        };

        const getPassword = () => {
          const loginManager = Cc[
            "@mozilla.org/login-manager;1"
          ].getService(Ci.nsILoginManager);

          const logins = loginManager.findLogins(
            `imap://${host}`,
            null,
            `imap://${host}`
          );

          for (const login of logins) {
            if (login.username === username) {
              return login.password;
            }
          }
          return null;
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
                    const password = getPassword();
                    if (password) {
                      sendCommand(`LOGIN ${username} ${password}`);
                    } else {
                      reject(new Error("Could not find password for account"));
                      cleanup();
                      return;
                    }
                  }
                } else if (state === "login") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "setmetadata";
                    const folderName = folder.name || "INBOX";
                    const basePath = `/private/vendor/tmail/labels/${labelId}`;

                    // Build SETMETADATA command with all properties
                    let metadataCmd = `SETMETADATA "${folderName}" (`;
                    metadataCmd += `${basePath}/keyword "${data.keyword}" `;
                    metadataCmd += `${basePath}/displayname "${data.displayName}"`;
                    if (data.color) {
                      metadataCmd += ` ${basePath}/color "${data.color}"`;
                    }
                    metadataCmd += `)`;

                    sendCommand(metadataCmd);
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Login failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "setmetadata") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "logout";
                    sendCommand("LOGOUT");
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("SETMETADATA failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "logout") {
                  if (line.match(/^A\d+ OK/) || line.startsWith("* BYE")) {
                    resolve();
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
          } catch (e) {}
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
   * Delete label metadata from the server
   */
  async deleteLabelMetadata(server, folder, labelId) {
    return new Promise((resolve, reject) => {
      try {
        const host = server.hostName;
        const port = server.port || 993;
        const useSSL = server.socketType === Ci.nsMsgSocketType.SSL;
        const username = server.username;

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

        const sendCommand = (cmd) => {
          commandTag++;
          const fullCmd = `A${commandTag} ${cmd}\r\n`;
          console.log("TMail Labels: Sending:", fullCmd.trim());
          outstream.write(fullCmd, fullCmd.length);
        };

        const getPassword = () => {
          const loginManager = Cc[
            "@mozilla.org/login-manager;1"
          ].getService(Ci.nsILoginManager);

          const logins = loginManager.findLogins(
            `imap://${host}`,
            null,
            `imap://${host}`
          );

          for (const login of logins) {
            if (login.username === username) {
              return login.password;
            }
          }
          return null;
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
                    const password = getPassword();
                    if (password) {
                      sendCommand(`LOGIN ${username} ${password}`);
                    } else {
                      reject(new Error("Could not find password for account"));
                      cleanup();
                      return;
                    }
                  }
                } else if (state === "login") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "setmetadata";
                    const folderName = folder.name || "INBOX";
                    const basePath = `/private/vendor/tmail/labels/${labelId}`;

                    // Delete by setting to NIL
                    const metadataCmd =
                      `SETMETADATA "${folderName}" (` +
                      `${basePath}/keyword NIL ` +
                      `${basePath}/displayname NIL ` +
                      `${basePath}/color NIL)`;

                    sendCommand(metadataCmd);
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Login failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "setmetadata") {
                  if (line.match(/^A\d+ OK/)) {
                    state = "logout";
                    sendCommand("LOGOUT");
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Delete label failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "logout") {
                  if (line.match(/^A\d+ OK/) || line.startsWith("* BYE")) {
                    resolve();
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
          } catch (e) {}
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

  /**
   * Generate a short ID for new labels
   */
  generateShortId() {
    const chars = "0123456789abcdef";
    let result = "";
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Generate a UUID for keywords
   */
  generateUUID() {
    // Use crypto if available, otherwise fallback
    try {
      const uuid = Cc["@mozilla.org/uuid-generator;1"]
        .getService(Ci.nsIUUIDGenerator)
        .generateUUID()
        .toString();
      // Remove braces: {uuid} -> uuid
      return uuid.slice(1, -1);
    } catch (e) {
      // Fallback UUID generation
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
  }
};
