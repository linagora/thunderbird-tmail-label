const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../experiment-apis/imap-metadata/api.js`, "utf8");
const scope = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
scope.ExtensionAPI = class {};
vm.runInContext(source.slice(source.indexOf("var imapMetadata")), scope);
const api = new scope.imapMetadata();

test("reads the host from hostname (Thunderbird 153+) and from hostName (older versions)", () => {
  assert.equal(api.hostOf({ hostname: "imap.example.com" }), "imap.example.com");
  assert.equal(api.hostOf({ hostName: "imap.example.org" }), "imap.example.org");
  assert.equal(api.hostOf({}), undefined);
});

test("refuses to connect when the account has no host name", async () => {
  await assert.rejects(
    api.fetchMetadataViaRawImap({ key: "server1" }, null, "/private/vendor/tmail/labels", () => []),
    /No IMAP host name for account server1/
  );
});

test("finds the password with searchLoginsAsync, or findLogins on older versions", async () => {
  const server = { hostname: "imap.example.com", port: 143, username: "alice" };
  const login = { username: "alice", password: "secret" };
  for (const loginManager of [
    { searchLoginsAsync: async ({ origin, httpRealm }) => origin === "imap://imap.example.com" && httpRealm === origin ? [login] : [] },
    { findLogins: async (origin, action, realm) => origin === "imap://imap.example.com" && realm === origin ? [login] : [] },
  ]) {
    scope.Cc = { "@mozilla.org/login-manager;1": { getService: () => loginManager } };
    scope.Ci = { nsILoginManager: {} };
    assert.equal(await api._getImapPassword(server), "secret");
  }
});

test("reports a failed metadata read instead of an empty list", async () => {
  const failing = new scope.imapMetadata();
  failing.fetchMetadataViaRawImap = async () => {
    throw new Error("GETMETADATA failed: A2 NO busy");
  };
  await assert.rejects(failing.fetchLabelsViaMetadata({ key: "server1" }, null), /GETMETADATA failed/);
  await assert.rejects(failing.fetchIdentitiesViaMetadata({ key: "server1" }, null), /GETMETADATA failed/);
});

// Runs fetchMetadataViaRawImap against a fake IMAP server: `greeting` is its
// first line, `answer(command)` the lines it sends back to each command.
// `options.writes` collects the commands the client sent (literals joined),
// with whether TLS was on. Like a real non-blocking socket, write() takes at
// most 5 bytes, and throws "would block" right after the TLS switch.
function fakeImap(greeting, answer, { trace = false, writes = [], ...account } = {}) {
  let buffer = `${greeting}\r\n`;
  let tls = false;
  let blockOnce = false;
  let received = "";
  let command = "";
  let literal = 0;
  const handle = () => {
    for (;;) {
      if (literal) {
        if (received.length < literal) return;
        command += received.slice(0, literal);
        received = received.slice(literal);
        literal = 0;
      }
      const end = received.indexOf("\r\n");
      if (end < 0) return;
      command += received.slice(0, end);
      received = received.slice(end + 2);
      const size = command.match(/\{(\d+)\}$/);
      if (size) {
        literal = Number(size[1]);
        buffer += "+ ready\r\n";
        continue;
      }
      writes.push({ command, tls });
      const [tag, ...rest] = command.split(" ");
      command = "";
      buffer += answer(tag, rest.join(" "), tls).map(line => `${line}\r\n`).join("");
    }
  };
  const transport = {
    setTimeout() {},
    tlsSocketControl: {
      QueryInterface() { return this; },
      asyncStartTLS: async () => { tls = true; blockOnce = true; },
    },
    openOutputStream: () => ({
      write(bytes, length) {
        assert.equal(length, bytes.length);
        if (blockOnce) {
          blockOnce = false;
          throw Object.assign(new Error("would block"), { name: "NS_BASE_STREAM_WOULD_BLOCK" });
        }
        const written = Math.min(5, length);
        received += bytes.slice(0, written);
        handle();
        return written;
      },
      close() {},
    }),
    openInputStream: () => ({ close() {} }),
    close() {},
  };
  scope.Cc = {
    "@mozilla.org/network/socket-transport-service;1": {
      getService: () => ({ createTransport: types => { writes.socketTypes = types; return transport; } }),
    },
    "@mozilla.org/scriptableinputstream;1": {
      createInstance: () => ({
        init() {},
        available: () => buffer.length,
        read(count) {
          const chunk = buffer.slice(0, count);
          buffer = buffer.slice(count);
          return chunk;
        },
      }),
    },
  };
  scope.Ci = {
    nsISocketTransportService: {}, nsIScriptableInputStream: {}, nsITLSSocketControl: {},
    nsMsgSocketType: { plain: 0, trySTARTTLS: 1, alwaysSTARTTLS: 2, SSL: 3 },
    nsMsgAuthMethod: { none: 1, old: 2, passwordCleartext: 3, passwordEncrypted: 4, GSSAPI: 5, NTLM: 6, External: 7, secure: 8, anything: 9, OAuth: 10 },
    nsISocketTransport: { TIMEOUT_CONNECT: 0, TIMEOUT_READ_WRITE: 1 }, nsIThread: { DISPATCH_NORMAL: 0 },
  };
  scope.Services = {
    tm: { currentThread: { dispatch: runnable => setImmediate(() => runnable.run()) } },
    prefs: { getBoolPref: (name, fallback) => name === "extensions.twake-mail.imap-trace" ? trace : fallback },
  };
  const server = { key: "server1", hostname: "imap.example.com", port: 143, username: "alice", password: "s3cret-pw", socketType: 0, ...account };
  return api.fetchLabelsViaMetadata(server, null);
}

const LABEL = '* METADATA "INBOX" (/private/vendor/tmail/labels/l1/keyword "kw1" /private/vendor/tmail/labels/l1/displayname "Work")';

test("reads labels from a Twake Mail server", async () => {
  const labels = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", (tag, command) =>
    command.startsWith("GETMETADATA") ? [LABEL, `${tag} OK done`] : [`${tag} OK done`]);
  assert.equal(JSON.stringify(labels.map(label => [label.keyword, label.displayName])), JSON.stringify([["kw1", "Work"]]));
});

test("tells a server without METADATA apart from a failed read", async () => {
  const noMetadata = await fakeImap("* OK ready", tag => [`${tag} OK [CAPABILITY IMAP4rev1 IDLE] done`]).catch(error => error);
  assert.equal(noMetadata.unsupported, true);
  const bad = await fakeImap("* OK ready", (tag, command) =>
    [command.startsWith("GETMETADATA") ? `${tag} BAD unknown command` : `${tag} OK done`]).catch(error => error);
  assert.equal(bad.unsupported, true);
  const no = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", (tag, command) =>
    [command.startsWith("GETMETADATA") ? `${tag} NO try later` : `${tag} OK done`]).catch(error => error);
  assert.match(no.message, /GETMETADATA failed: A2 NO try later/);
  assert.equal(no.unsupported, undefined);
  const login = await fakeImap("* OK ready", tag => [`${tag} NO bad password`]).catch(error => error);
  assert.match(login.message, /Login failed/);
  assert.equal(login.unsupported, undefined);
});

test("reads capabilities from response codes and CAPABILITY responses", () => {
  assert.deepEqual(Array.from(api.parseCapabilities("* OK [CAPABILITY IMAP4rev1 metadata] ready")), ["IMAP4REV1", "METADATA"]);
  assert.deepEqual(Array.from(api.parseCapabilities("* CAPABILITY IMAP4rev1 METADATA-SERVER")), ["IMAP4REV1", "METADATA-SERVER"]);
  assert.equal(api.parseCapabilities("A1 OK LOGIN completed"), null);
});

// Calls `run` with console.log captured; returns the logged lines.
async function captureLogs(run) {
  const lines = [];
  const quiet = scope.console;
  scope.console = { ...quiet, log: (...args) => lines.push(args.join(" ")) };
  try {
    await run();
  } finally {
    scope.console = quiet;
  }
  return lines;
}

const twakeMail = (tag, command) =>
  command.startsWith("GETMETADATA") ? [LABEL, `${tag} OK done`] : [`${tag} OK done`];

test("never logs the password, even with the IMAP trace on", async () => {
  const lines = await captureLogs(() => fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { trace: true }));
  assert.ok(lines.some(line => line.includes("A1 LOGIN <redacted>")), lines.join("\n"));
  assert.ok(lines.some(line => line.includes("Received: * METADATA")));
  assert.equal(lines.filter(line => line.includes("s3cret-pw")).length, 0);
});

test("does not log the IMAP exchange unless the trace is on", async () => {
  const lines = await captureLogs(() => fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail));
  assert.equal(lines.filter(line => /Sending:|Received:/.test(line)).length, 0, lines.join("\n"));
});

// A Twake Mail server offering STARTTLS; it only accepts LOGIN once TLS is on.
const startTlsServer = (tag, command, tls) => {
  if (command === "STARTTLS") return [`${tag} OK begin TLS`, "* INJECTED before the handshake"];
  if (command === "CAPABILITY") return ["* CAPABILITY IMAP4rev1 METADATA AUTH=PLAIN", `${tag} OK done`];
  if (command.startsWith("LOGIN") && !tls) return [`${tag} NO cleartext`];
  return twakeMail(tag, command);
};

test("a STARTTLS account upgrades the connection before sending LOGIN", async () => {
  for (const socketType of [1, 2]) {
    const writes = [];
    const labels = await fakeImap("* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready", startTlsServer, { writes, socketType });
    assert.equal(labels.length, 1);
    assert.deepEqual(Array.from(writes.socketTypes), ["starttls"]);
    assert.deepEqual(writes.map(write => [write.command.split(" ")[1], write.tls]),
      [["STARTTLS", false], ["CAPABILITY", true], ["LOGIN", true], ["GETMETADATA", true], ["LOGOUT", true]]);
  }
});

test("a STARTTLS account never logs in when the server does not offer STARTTLS", async () => {
  const writes = [];
  const error = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { writes, socketType: 2 }).catch(e => e);
  assert.match(error.message, /does not offer STARTTLS/);
  assert.equal(writes.length, 0);
  const refused = [];
  const error2 = await fakeImap("* OK ready", tag => [`${tag} BAD no TLS here`], { writes: refused, socketType: 2 }).catch(e => e);
  assert.match(error2.message, /STARTTLS refused/);
  assert.equal(refused.some(write => write.command.includes("LOGIN")), false);
});

test("does not send LOGIN when the server announces LOGINDISABLED", async () => {
  const writes = [];
  const error = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA LOGINDISABLED] ready", twakeMail, { writes }).catch(e => e);
  assert.equal(error.unsupported, true);
  assert.equal(writes.length, 0);
});

test("only sends a cleartext LOGIN for accounts using a normal password", async () => {
  for (const authMethod of [4, 5, 6, 7, 10]) {
    const writes = [];
    const error = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { writes, authMethod }).catch(e => e);
    assert.equal(error.unsupported, true, String(authMethod));
    assert.equal(writes.socketTypes, undefined, "no connection is opened");
  }
  assert.equal((await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { authMethod: 3 })).length, 1);
  assert.equal((await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { authMethod: 9, socketType: 3 })).length, 1);
  const anythingInClear = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { authMethod: 9 }).catch(e => e);
  assert.equal(anythingInClear.unsupported, true);
});

test("sends ASCII credentials as quoted strings and others as UTF-8 literals", async () => {
  const writes = [];
  await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { writes, username: "alice", password: 'my "pass\\word"' });
  assert.equal(writes.find(write => write.command.includes("LOGIN")).command, 'A1 LOGIN "alice" "my \\"pass\\\\word\\""');
  const unicode = [];
  const labels = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", twakeMail, { writes: unicode, username: "josé", password: "pässwörd" });
  assert.equal(labels.length, 1);
  const login = unicode.find(write => write.command.includes("LOGIN")).command;
  assert.equal(Buffer.from(login, "latin1").toString("utf8"), "A1 LOGIN {5}josé {10}pässwörd");
  await assert.rejects(fakeImap("* OK ready", twakeMail, { password: "a\r\nA9 DELETE INBOX" }), /line breaks/);
});

test("checks METADATA only against the capabilities announced after login", async () => {
  const metadataAfterLogin = await fakeImap("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready", twakeMail);
  assert.equal(metadataAfterLogin.length, 1);
  const error = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", (tag, command) =>
    command.startsWith("LOGIN") ? [`${tag} OK [CAPABILITY IMAP4rev1 IDLE] logged in`] : twakeMail(tag, command)).catch(e => e);
  assert.equal(error.unsupported, true);
});

test("reads a pre-authenticated connection, except when it must use STARTTLS", async () => {
  const writes = [];
  const labels = await fakeImap("* PREAUTH IMAP4rev1 ready", twakeMail, { writes });
  assert.equal(labels.length, 1);
  assert.equal(writes.some(write => write.command.includes("LOGIN")), false);
  const error = await fakeImap("* PREAUTH IMAP4rev1 ready", twakeMail, { socketType: 2 }).catch(e => e);
  assert.match(error.message, /pre-authenticated/);
});
