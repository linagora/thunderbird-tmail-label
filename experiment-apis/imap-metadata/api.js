/* global ExtensionAPI, ExtensionCommon, Services, Cc, Ci, ChromeUtils */

"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

/**
 * Twake Mail for Thunderbird - IMAP Metadata Experiment API
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
                name: server.prettyName || self.hostOf(server),
                serverHost: self.hostOf(server),
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
            const labels = await self.fetchLabelsViaMetadata(server, folder);
            return { success: true, labels };
          } catch (error) {
            console.error("Twake Mail: getLabels error", error);
            return { success: false, error: error.message || String(error), unsupported: !!error.unsupported };
          }
        },

        /**
         * Fetch Twake Mail identities from IMAP METADATA
         */
        async getIdentities(accountId) {
          try {
            const { server, folder } = self.getServerAndFolder(
              accountId,
              "INBOX"
            );
            const identities = await self.fetchIdentitiesViaMetadata(server, folder);
            return { success: true, identities };
          } catch (error) {
            console.error("Twake Mail: getIdentities error", error);
            return { success: false, error: error.message || String(error), unsupported: !!error.unsupported };
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
            console.error("Twake Mail: testConnection error", error);
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
   * Host name of an incoming server. Thunderbird 153 renamed
   * nsIMsgIncomingServer.hostName to hostname; older versions only have hostName.
   */
  hostOf(server) {
    return server.hostname || server.hostName;
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

  // A failed read must reach the caller: an empty result would make the sync
  // delete every tag and identity it created for the account.
  async fetchLabelsViaMetadata(server, folder) {
    console.log("Twake Mail: Fetching labels via raw IMAP");
    return this.fetchMetadataViaRawImap(
      server, folder,
      "/private/vendor/tmail/labels",
      (line) => this.parseLabelsResponse(line)
    );
  }

  async fetchIdentitiesViaMetadata(server, folder) {
    console.log("Twake Mail: Fetching identities via raw IMAP");
    return this.fetchMetadataViaRawImap(
      server, folder,
      "/private/vendor/tmail/identities",
      (line) => this.parseIdentitiesResponse(line)
    );
  }

  /**
   * Fetch metadata via raw IMAP socket — sends GETMETADATA and parses lines
   * with the provided parseFn.
   */
  async fetchMetadataViaRawImap(server, folder, metadataPath, parseFn) {
    const host = this.hostOf(server);
    if (!host) {
      throw new Error(`No IMAP host name for account ${server.key}`);
    }
    const port = server.port || 993;
    const { useSSL, startTLS } = this.connectionSecurity(server);
    const username = server.username;
    this.checkAuthMethod(server, useSSL || startTLS);

    // Resolve password before opening the socket.
    // server.password returns the in-memory cached password (set when Thunderbird
    // authenticated with the IMAP server). Falls back to nsILoginManager.
    const password = await this._getImapPassword(server);
    if (!password) {
      // OAuth accounts have no password: they cannot be read this way.
      throw this.unsupported("No saved IMAP password for this account");
    }
    const loginParts = this.loginParts(username, password);

    return new Promise((resolve, reject) => {
      try {
        console.log(`Twake Mail: Connecting to ${host}:${port} (SSL: ${useSSL}, STARTTLS: ${startTLS})`);

        const transportService = Cc[
          "@mozilla.org/network/socket-transport-service;1"
        ].getService(Ci.nsISocketTransportService);

        // "starttls" sets up a TLS layer that stays off until asyncStartTLS().
        const socketTypes = useSSL ? ["ssl"] : startTLS ? ["starttls"] : [];
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

        const trace = this.traceEnabled();
        let commandTag = 0;
        let loginContinuations = [];
        let capabilities = null;
        let state = "greeting";
        let responseBuffer = "";
        const items = [];

        // Bytes not written yet: the stream is non-blocking, so write() can
        // take part of them, or none while the TLS handshake runs.
        let pending = "";
        const flush = () => {
          while (pending) {
            let written;
            try {
              written = outstream.write(pending, pending.length);
            } catch (e) {
              if (e.name === "NS_BASE_STREAM_WOULD_BLOCK") {
                return;
              }
              throw e;
            }
            pending = pending.slice(written);
          }
        };

        // `shown` replaces the text in the trace: credentials are never logged.
        const send = (text, shown) => {
          if (trace) {
            console.log("Twake Mail: Sending:", shown);
          }
          // write() takes bytes: send the text as UTF-8.
          pending += unescape(encodeURIComponent(`${text}\r\n`));
          flush();
        };

        const sendCommand = (cmd, shown = cmd) => {
          commandTag++;
          send(`A${commandTag} ${cmd}`, `A${commandTag} ${shown}`);
        };

        const fail = (error) => {
          reject(error);
          cleanup();
        };

        const login = () => {
          if (capabilities && capabilities.includes("LOGINDISABLED")) {
            fail(this.unsupported("The server does not accept LOGIN on this connection (LOGINDISABLED)"));
            return;
          }
          // Parts after the first are literals, sent on the server's "+".
          loginContinuations = loginParts.slice(1);
          state = "login";
          sendCommand(loginParts[0], "LOGIN <redacted>");
        };

        // Only capabilities announced once authenticated tell whether the
        // server has METADATA: they often change after login.
        const afterLogin = (line) => {
          const announced = this.parseCapabilities(line);
          if (announced && !announced.includes("METADATA") && !announced.includes("METADATA-SERVER")) {
            fail(this.unsupported("The server does not support IMAP METADATA"));
            return;
          }
          state = "getmetadata";
          sendCommand(`GETMETADATA "INBOX" (DEPTH infinity) ${metadataPath}`);
        };

        // Upgrades the connection after the server's OK to STARTTLS. Reading
        // stops meanwhile; anything the server sent before the handshake is
        // dropped (it was not protected), and so are the capabilities.
        const upgrade = () => {
          state = "upgrading";
          responseBuffer = "";
          capabilities = null;
          Promise.resolve()
            .then(() => transport.tlsSocketControl.QueryInterface(Ci.nsITLSSocketControl).asyncStartTLS())
            .then(() => {
              state = "capability";
              sendCommand("CAPABILITY");
              schedule();
            })
            .catch((error) => fail(new Error("STARTTLS failed: " + (error.message || error))));
        };

        const schedule = () => {
          Services.tm.currentThread.dispatch(
            { run: processResponse },
            Ci.nsIThread.DISPATCH_NORMAL
          );
        };

        const processResponse = () => {
          try {
            flush();
            const available = scriptStream.available();
            if (available > 0) {
              responseBuffer += scriptStream.read(available);

              const lines = responseBuffer.split("\r\n");
              responseBuffer = lines.pop() || "";

              for (const line of lines) {
                if (!line) continue;
                if (trace) {
                  console.log("Twake Mail: Received:", line);
                }
                capabilities = this.parseCapabilities(line) || capabilities;

                if (state === "greeting" && line.startsWith("* PREAUTH")) {
                  if (startTLS) {
                    // STARTTLS is not allowed once authenticated: this would stay in clear.
                    fail(new Error("The server pre-authenticated a connection that must use STARTTLS"));
                    return;
                  }
                  afterLogin(line);
                } else if (state === "greeting") {
                  if (!line.startsWith("* OK")) {
                    fail(new Error("Unexpected IMAP greeting: " + line));
                    return;
                  }
                  if (!startTLS) {
                    login();
                  } else if (capabilities && !capabilities.includes("STARTTLS")) {
                    // Never fall back to a cleartext LOGIN: the account asks for TLS.
                    fail(new Error("The server does not offer STARTTLS"));
                    return;
                  } else {
                    state = "starttls";
                    sendCommand("STARTTLS");
                  }
                } else if (state === "starttls") {
                  if (line.match(/^A\d+ OK/)) {
                    upgrade();
                    break;
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    fail(new Error("STARTTLS refused: " + line));
                    return;
                  }
                } else if (state === "capability") {
                  if (line.match(/^A\d+ OK/)) {
                    login();
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    fail(new Error("CAPABILITY failed: " + line));
                    return;
                  }
                } else if (state === "login") {
                  if (line.startsWith("+") && loginContinuations.length) {
                    send(loginContinuations.shift(), "<redacted>");
                  } else if (line.match(/^A\d+ OK/)) {
                    afterLogin(line);
                  } else if (line.match(/^A\d+ (NO|BAD)/)) {
                    reject(new Error("Login failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "getmetadata") {
                  if (line.startsWith("* METADATA")) {
                    const parsed = parseFn(line);
                    items.push(...parsed);
                  } else if (line.match(/^A\d+ OK/)) {
                    state = "logout";
                    sendCommand("LOGOUT");
                  } else if (line.match(/^A\d+ BAD/)) {
                    // BAD: the command is unknown, the server is not Twake Mail.
                    reject(this.unsupported("GETMETADATA not supported: " + line));
                    cleanup();
                    return;
                  } else if (line.match(/^A\d+ NO/)) {
                    reject(new Error("GETMETADATA failed: " + line));
                    cleanup();
                    return;
                  }
                } else if (state === "logout") {
                  if (line.match(/^A\d+ OK/) || line.startsWith("* BYE")) {
                    resolve(items);
                    cleanup();
                    return;
                  }
                }
              }
            }

            if (state !== "done" && state !== "upgrading") {
              schedule();
            }
          } catch (e) {
            if (e.name !== "NS_BASE_STREAM_WOULD_BLOCK") {
              console.error("Twake Mail: Read error", e);
              reject(e);
              cleanup();
            } else if (state !== "done" && state !== "upgrading") {
              schedule();
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
   * TLS mode of the account: implicit TLS, or STARTTLS before authenticating.
   * trySTARTTLS, deprecated, is handled as alwaysSTARTTLS: no cleartext fallback.
   */
  connectionSecurity(server) {
    const types = Ci.nsMsgSocketType;
    return {
      useSSL: server.socketType === types.SSL,
      startTLS: server.socketType === types.alwaysSTARTTLS ||
        server.socketType === (types.trySTARTTLS ?? 1),
    };
  }

  /**
   * The raw connection authenticates with LOGIN, i.e. a password sent as is:
   * only allowed when the account uses a normal password ("anything" only
   * over TLS). Other methods (encrypted password, Kerberos, NTLM, OAuth...)
   * exist so that the password never travels in clear.
   */
  checkAuthMethod(server, encrypted) {
    const methods = Ci.nsMsgAuthMethod;
    const method = server.authMethod;
    if (method === undefined || method === methods.passwordCleartext || method === methods.old ||
        (encrypted && method === methods.anything)) {
      return;
    }
    throw this.unsupported(`Authentication method ${method} is not supported; it needs a normal password`);
  }

  /**
   * LOGIN command split where the server must answer "+" before a literal.
   * ASCII values are quoted strings (RFC 3501); others, which quoted strings
   * cannot hold, are {n} literals of their UTF-8 bytes. Line breaks and NUL
   * are refused.
   */
  loginParts(username, password) {
    const parts = [];
    let current = "LOGIN";
    for (const value of [String(username), String(password)]) {
      if (/[\r\n\0]/.test(value)) {
        throw new Error("Credentials cannot contain line breaks");
      }
      if (/^[\x01-\x7f]*$/.test(value)) {
        current += ` "${value.replace(/[\\"]/g, "\\$&")}"`;
      } else {
        parts.push(`${current} {${unescape(encodeURIComponent(value)).length}}`);
        current = value;
      }
    }
    parts.push(current);
    return parts;
  }

  /**
   * Whether the raw IMAP exchange is logged. It holds signatures and Bcc
   * addresses, so it is off unless the extensions.twake-mail.imap-trace
   * preference is set.
   */
  traceEnabled() {
    try {
      return Services.prefs.getBoolPref("extensions.twake-mail.imap-trace", false);
    } catch (e) {
      return false;
    }
  }

  /**
   * Capability list announced by a "[CAPABILITY ...]" response code or a
   * "* CAPABILITY" response, upper-cased; null when the line has none.
   */
  parseCapabilities(line) {
    const match = line.match(/\[CAPABILITY ([^\]]*)\]/i) || line.match(/^\* CAPABILITY (.*)$/i);
    return match ? match[1].trim().toUpperCase().split(/\s+/) : null;
  }

  /**
   * Error for an account that cannot hold Twake Mail metadata: the sync skips
   * it instead of reporting a failure.
   */
  unsupported(message) {
    const error = new Error(message);
    error.unsupported = true;
    return error;
  }

  /**
   * Retrieve the IMAP password for a given server.
   *
   * Primary: server.password — Thunderbird caches this after the first
   * successful IMAP login in the session (no UI prompt, no keyring access).
   *
   * Fallback: nsILoginManager.searchLoginsAsync(), or findLogins() on
   * versions without it.
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
    const host = this.hostOf(server);
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
        // Thunderbird 153 removed findLogins(); searchLoginsAsync() exists since 128.
        const logins = typeof loginManager.searchLoginsAsync === "function"
          ? await loginManager.searchLoginsAsync(realm ? { origin, httpRealm: realm } : { origin })
          : await loginManager.findLogins(origin, null, realm);
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

  parseLabelsResponse(line) {
    const labels = new Map();
    const match = line.match(/\* METADATA "[^"]*" \((.+)\)/);
    if (!match) return [];
    const entriesStr = match[1];
    const regex = /\/private\/vendor\/tmail\/labels\/([^/]+)\/(\w+)\s+"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = regex.exec(entriesStr)) !== null) {
      const labelId = m[1];
      const property = m[2];
      const value = m[3].replace(/\\(.)/g, "$1");
      if (!labels.has(labelId)) labels.set(labelId, { id: labelId });
      const label = labels.get(labelId);
      if (property === "keyword") label.keyword = value;
      else if (property === "displayname") label.displayName = value;
      else if (property === "color") label.color = value;
    }
    return Array.from(labels.values()).filter((l) => l.keyword && l.displayName);
  }

  parseIdentitiesResponse(line) {
    const identities = new Map();
    const match = line.match(/\* METADATA "[^"]*" \((.+)\)/);
    if (!match) return [];
    const entriesStr = match[1];
    const regex = /\/private\/vendor\/tmail\/identities\/([^/]+)\/(\w+)\s+"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = regex.exec(entriesStr)) !== null) {
      const hash = m[1];
      const property = m[2];
      const value = m[3].replace(/\\(.)/g, "$1");
      if (!identities.has(hash)) identities.set(hash, { hash });
      const identity = identities.get(hash);
      if (property === "id") identity.id = value;
      else if (property === "displayname") identity.displayName = value;
      else if (property === "sortorder") identity.sortOrder = parseInt(value, 10) || 0;
      else if (property === "email") identity.email = value;
      else if (property === "html") identity.htmlSignature = value;
      else if (property === "text") identity.textSignature = value;
      else if (property === "maydelete") identity.mayDelete = value === "true";
      else if (property === "replyto") identity.replyTo = value;
      else if (property === "bcc") identity.bcc = value;
    }
    return Array.from(identities.values()).filter((i) => i.id && i.email);
  }

};
