const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

// ChromeUtils' base64URL helpers, which use the URL-safe alphabet like Gecko's.
const ChromeUtils = {
  base64URLEncode(bytes, { pad }) {
    const encoded = Buffer.from(bytes).toString("base64url");
    return pad ? encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=") : encoded;
  },
  base64URLDecode(text, { padding }) {
    if (padding === "require" && text.length % 4 !== 0) {
      throw new Error("NS_ERROR_ILLEGAL_VALUE");
    }
    const bytes = Buffer.from(text, "base64url");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  },
};
const scope = vm.createContext({ ChromeUtils, Uint8Array });
const source = readFileSync(`${__dirname}/../experiment-apis/calendar-attachments/api.js`, "utf8");
vm.runInContext(source.slice(source.indexOf("var encodeBase64"), source.indexOf("var calendarAttachments")), scope);
const data = scope.CalendarAttachmentData;
scope.ExtensionAPI = class {};
vm.runInContext(source.slice(source.indexOf("var calendarAttachments")), scope);
const ui = new scope.calendarAttachments();
ui.data = data;
function attachment(rawData, parameters = {}) {
  return {
    rawData,
    encoding: parameters.ENCODING || "BASE64",
    getParameter: key => ({ VALUE: "BINARY", ...parameters })[key],
  };
}

function webAttachment(uri, parameters = {}) {
  return {
    uri: {
      spec: uri,
      scheme: uri.split(":", 1)[0],
      // Like nsIURI, which throws for URIs without a host.
      get host() {
        const { host } = new URL(uri);
        if (!host) throw new Error("NS_ERROR_FAILURE");
        return host;
      },
    },
    getParameter: key => parameters[key],
  };
}

test("recognizes Drive sharing links alongside inline attachments", () => {
  const inline = attachment("AA==");
  const drive = webAttachment("https://drive.example.com/sharing/report", {
    "X-FILENAME": "report.pdf", FMTTYPE: "application/pdf",
  });
  assert.equal(data.isBinary(inline), true);
  assert.equal(data.isWebLink(inline), false);
  assert.equal(data.isBinary(drive), false);
  assert.equal(data.isWebLink(drive), true);
  assert.equal(data.displayName(drive), "drive.example.com — report.pdf");
  assert.equal(data.isWebLink(webAttachment("http://localhost/agenda.txt")), true);
  assert.equal(data.isWebLink(webAttachment("HTTPS://drive.example.com/file")), true);
});

test("uses URI filename metadata with a URL fallback without changing attachment data", () => {
  const drive = webAttachment("https://drive.example.com/sharing/report?token=demo", {
    "X-FILENAME": " report.pdf ", FILENAME: "other.pdf",
  });
  const before = JSON.stringify(drive);
  assert.equal(data.displayName(drive), "drive.example.com — report.pdf");
  assert.equal(JSON.stringify(drive), before);
  assert.equal(data.displayName(webAttachment("https://example.com/file", {
    "X-FILENAME": "  ", FILENAME: "fallback.txt",
  })), "example.com — fallback.txt");
  assert.equal(data.displayName(webAttachment("https://example.com/file")), "https://example.com/file");
  assert.equal(data.displayName(attachment("AA==", { FILENAME: "local.bin" })), "local.bin");
});

test("does not treat unsupported schemes or binary content as web links", () => {
  for (const uri of ["javascript:alert(1)", "data:text/plain,hello", "file:///tmp/a.txt", "cid:file", "about:blank", "ftp://example.com/file"]) {
    assert.equal(data.isWebLink(webAttachment(uri)), false, uri);
  }
  const binaryWithUri = { ...attachment("AA=="), uri: { scheme: "https", spec: "https://example.com" } };
  assert.equal(data.isWebLink(binaryWithUri), false);
  assert.equal(data.isWebLink({ getParameter: () => null }), false);
});

test("keeps a Drive sharing query and fragment intact when presenting its filename", () => {
  const uri = "https://drive.example.com/public?sharecode=DEMO#/";
  const drive = webAttachment(uri, {
    "X-FILENAME": "Twake-Sync-Setup-Guide-EN.docx",
    FMTTYPE: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.equal(data.isWebLink(drive), true);
  assert.equal(data.displayName(drive), "drive.example.com — Twake-Sync-Setup-Guide-EN.docx");
  assert.equal(drive.uri.spec, uri);
  assert.equal(drive.getParameter("FMTTYPE"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("hides only managed editor attachments and restores native visibility", () => {
  const managed = { attachment: { hashId: "web" }, hidden: false };
  const unsupported = { attachment: { hashId: "file" }, hidden: false };
  const list = { children: [managed, unsupported], hidden: false };
  const state = { editor: true, doc: { getElementById: () => list }, hiddenNative: new Map() };
  ui.syncNative(state, [{ hashId: "web" }]);
  assert.equal(managed.hidden, true);
  assert.equal(unsupported.hidden, false);
  assert.equal(list.hidden, false);
  ui.restoreNative(state);
  assert.equal(managed.hidden, false);
  list.children = [managed];
  ui.syncNative(state, [{ hashId: "web" }]);
  assert.equal(list.hidden, true);
  ui.syncNative(state, []);
  assert.equal(managed.hidden, false);
  assert.equal(list.hidden, false);
});

test("restores summary URI rows without revealing its hidden template", () => {
  const uri = "https://drive.example.com/public?sharecode=DEMO#/";
  const item = { hidden: false, querySelector: () => ({ getAttribute: () => uri }) };
  const template = { hidden: true };
  const row = { hidden: false };
  const summary = { querySelectorAll: () => [template, item], querySelector: () => row };
  const state = { editor: false, doc: { getElementById: () => summary }, hiddenNative: new Map() };
  ui.syncNative(state, [webAttachment(uri)]);
  assert.equal(item.hidden, true);
  assert.equal(row.hidden, true);
  ui.restoreNative(state);
  assert.equal(item.hidden, false);
  assert.equal(row.hidden, false);
  assert.equal(template.hidden, true);
});

test("round-trips all byte values including NUL and non-text bytes", () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  assert.deepEqual(data.decode(attachment(data.encode(bytes))), bytes);
});

test("decodes folded iCalendar BASE64 without modifying the attachment", () => {
  const original = attachment("AAEC\r\n /v8=", { FILENAME: "picture.png" });
  const before = JSON.stringify(original);
  assert.deepEqual(Array.from(data.decode(original)), [0, 1, 2, 254, 255]);
  assert.equal(JSON.stringify(original), before);
});

test("validates BASE64 rather than silently truncating malformed data", () => {
  for (const input of ["ab", "abc", "A===", "AA==junk", "AA$=", "===="]) {
    assert.throws(() => data.decode(attachment(input)), /invalid BASE64/);
  }
  assert.throws(() => data.decode(attachment("AA==", { ENCODING: "QUOTED-PRINTABLE" })), /does not use BASE64/);
});

test("uses a safe filename for untrusted event attachment parameters", () => {
  assert.equal(data.fileName(attachment("AA==", { FILENAME: "../../secret\u0000.txt" })), "_.._secret_.txt");
  assert.equal(data.fileName(attachment("AA==", { "X-FILENAME": "agenda.pdf" })), "agenda.pdf");
  assert.equal(data.safeName("..."), "attachment.bin");
});

test("enforces the file size boundary for both adding and downloading", () => {
  const bytes = new Uint8Array(data.MAX_FILE_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    webcrypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  assert.deepEqual(data.decode(attachment(data.encode(bytes))), bytes);
  assert.throws(() => data.encode(new Uint8Array(data.MAX_FILE_BYTES + 1)), /no larger than/);
  assert.throws(() => data.decode(attachment("A".repeat(Math.ceil((data.MAX_FILE_BYTES + 3) / 3) * 4))), /too large/);
  assert.throws(() => data.encode(new Uint8Array()), /non-empty/);
});

test("encodes and decodes with the standard BASE64 alphabet and padding", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xfe]);
  assert.equal(data.encode(bytes), "+/+//g==");
  assert.deepEqual(Array.from(data.decode(attachment("+/+//g=="))), Array.from(bytes));
});

test("Return on the Attach button opens its menu and does not reach the dialog", () => {
  const button = { disabled: false };
  const opened = [];
  const popup = { state: "closed", openPopup: (anchor, position) => opened.push([anchor, position]) };
  const key = (type, key, target = button) => {
    const event = { type, key, target, prevented: false, stopped: false };
    event.preventDefault = () => { event.prevented = true; };
    event.stopPropagation = () => { event.stopped = true; };
    ui.openMenuOnReturn(event, button, popup);
    return event;
  };
  const down = key("keydown", "Enter");
  const press = key("keypress", "Enter");
  assert.equal(down.prevented && down.stopped && press.prevented && press.stopped, true);
  assert.deepEqual(opened, [[button, "after_start"]]);
  assert.equal(key("keydown", "Tab").prevented, false);
  assert.equal(key("keydown", "Enter", {}).prevented, false);
  button.disabled = true;
  key("keydown", "Enter");
  assert.equal(opened.length, 1);
});

test("names each Remove button after its attachment", () => {
  const node = () => ({
    attributes: {}, children: [], style: {}, hidden: false,
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children = []; },
    addEventListener() {},
  });
  const elements = { "attachment-link": node(), "event-grid-tab-attachments": node() };
  const win = {
    gAttachMap: {
      a: webAttachment("https://example.com/doc.pdf"),
      b: webAttachment("https://example.org/two"),
    },
    attachmentTabLabel: "Attachments:",
    calendarItem: { calendar: { readOnly: false } },
  };
  const doc = {
    defaultView: win,
    createXULElement: node,
    createElementNS: node,
    getElementById: id => elements[id],
  };
  const state = { doc, editor: true, hiddenNative: new Map(), rows: node(), heading: node(), root: node(), add: node(), menus: [] };
  ui.render(state);
  const buttons = state.rows.children.map(row => row.children.find(child => child.attributes.label === "Remove"));
  assert.deepEqual(buttons.map(button => button.attributes["aria-label"]),
    ["Remove https://example.com/doc.pdf", "Remove https://example.org/two"]);
  assert.equal(buttons[0].attributes.tooltiptext, "Remove https://example.com/doc.pdf");
});

test("shows where a link really goes when the invitation gives it another name", () => {
  const phishing = webAttachment("https://evil.example/login", {
    "X-FILENAME": "https://drive.twake.app/s/Budget-2027.xlsx",
  });
  assert.equal(data.displayName(phishing), "evil.example — https://drive.twake.app/s/Budget-2027.xlsx");
  const sameAsUrl = webAttachment("https://drive.twake.app/s/a", { "X-FILENAME": "https://drive.twake.app/s/a" });
  assert.equal(data.displayName(sameAsUrl), "https://drive.twake.app/s/a");
});

test("a link name cannot hide or reorder the host shown before it", () => {
  const spoof = webAttachment("https://evil.example/x", {
    "X-FILENAME": "Budget.xlsx (drive.twake.app)\u202E\u2066\u200B\r\nend",
  });
  assert.equal(data.displayName(spoof), "evil.example — Budget.xlsx (drive.twake.app) end");
  const long = data.displayName(webAttachment("https://evil.example/x", { "X-FILENAME": "a".repeat(500) }));
  assert.ok(long.startsWith("evil.example — "));
  assert.equal(long.length, "evil.example — ".length + 100);
  assert.equal(data.displayName(webAttachment("https://example.com/f", { "X-FILENAME": "\u202E\u200B" })), "https://example.com/f");
});
