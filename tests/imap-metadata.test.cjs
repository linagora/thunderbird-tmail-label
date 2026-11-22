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
function fakeImap(greeting, answer, { trace = false } = {}) {
  let buffer = `${greeting}\r\n`;
  const transport = {
    setTimeout() {},
    openOutputStream: () => ({
      write(command) {
        const [tag, ...rest] = command.trim().split(" ");
        buffer += answer(tag, rest.join(" ")).map(line => `${line}\r\n`).join("");
      },
      close() {},
    }),
    openInputStream: () => ({ close() {} }),
    close() {},
  };
  scope.Cc = {
    "@mozilla.org/network/socket-transport-service;1": { getService: () => ({ createTransport: () => transport }) },
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
    nsISocketTransportService: {}, nsIScriptableInputStream: {}, nsMsgSocketType: { SSL: 3 },
    nsISocketTransport: { TIMEOUT_CONNECT: 0, TIMEOUT_READ_WRITE: 1 }, nsIThread: { DISPATCH_NORMAL: 0 },
  };
  scope.Services = {
    tm: { currentThread: { dispatch: runnable => setImmediate(() => runnable.run()) } },
    prefs: { getBoolPref: (name, fallback) => name === "extensions.twake-mail.imap-trace" ? trace : fallback },
  };
  const server = { key: "server1", hostname: "imap.example.com", port: 143, username: "alice", password: "s3cret-pw", socketType: 0 };
  return api.fetchLabelsViaMetadata(server, null);
}

const LABEL = '* METADATA "INBOX" (/private/vendor/tmail/labels/l1/keyword "kw1" /private/vendor/tmail/labels/l1/displayname "Work")';

test("reads labels from a Twake Mail server", async () => {
  const labels = await fakeImap("* OK [CAPABILITY IMAP4rev1 METADATA] ready", (tag, command) =>
    command.startsWith("GETMETADATA") ? [LABEL, `${tag} OK done`] : [`${tag} OK done`]);
  assert.equal(JSON.stringify(labels.map(label => [label.keyword, label.displayName])), JSON.stringify([["kw1", "Work"]]));
});

test("tells a server without METADATA apart from a failed read", async () => {
  const noMetadata = await fakeImap("* OK [CAPABILITY IMAP4rev1 IDLE] ready", tag => [`${tag} OK done`]).catch(error => error);
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
