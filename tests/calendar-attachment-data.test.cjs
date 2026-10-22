const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const scope = vm.createContext({ btoa, atob, Uint8Array });
const source = readFileSync(`${__dirname}/../experiment-apis/calendar-attachments/api.js`, "utf8");
vm.runInContext(source.slice(source.indexOf("var CalendarAttachmentData"), source.indexOf("var calendarAttachments")), scope);
const data = scope.CalendarAttachmentData;
function attachment(rawData, parameters = {}) {
  return {
    rawData,
    encoding: parameters.ENCODING || "BASE64",
    getParameter: key => ({ VALUE: "BINARY", ...parameters })[key],
  };
}

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
