/* global ExtensionAPI, Services, ChromeUtils, Cc, Ci, IOUtils */
"use strict";

var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { CalAttachment } = ChromeUtils.importESModule("resource:///modules/CalAttachment.sys.mjs");
var { openLinkExternally } = ChromeUtils.importESModule("resource:///modules/LinkHelper.sys.mjs");
var btoa = value => Services.appShell.hiddenDOMWindow.btoa(value);
var atob = value => Services.appShell.hiddenDOMWindow.atob(value);

var CalendarAttachmentData = {
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  MAX_EVENT_BYTES: 10 * 1024 * 1024,

  isBinary(attachment) {
    return attachment.getParameter("VALUE")?.toUpperCase() === "BINARY" ||
      attachment.encoding?.toUpperCase() === "BASE64";
  },

  isWebLink(attachment) {
    return !this.isBinary(attachment) &&
      ["http", "https"].includes(attachment.uri?.scheme?.toLowerCase());
  },

  displayName(attachment) {
    if (this.isBinary(attachment)) {
      return this.fileName(attachment);
    }
    return attachment.getParameter("X-FILENAME")?.trim() ||
      attachment.getParameter("FILENAME")?.trim() || attachment.uri.spec;
  },

  fileName(attachment) {
    return this.safeName(attachment.getParameter("FILENAME") ||
      attachment.getParameter("X-FILENAME") || "attachment.bin");
  },

  safeName(name) {
    return String(name).replace(/[\x00-\x1f\x7f/\\:]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, "").slice(0, 180) || "attachment.bin";
  },

  encode(bytes) {
    if (!bytes.length || bytes.length > this.MAX_FILE_BYTES) {
      throw new Error("Choose a non-empty file no larger than 5 MiB.");
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  },

  base64(attachment) {
    if (attachment.encoding?.toUpperCase() !== "BASE64") {
      throw new Error("This inline attachment does not use BASE64 encoding.");
    }
    const raw = attachment.rawData || "";
    if (raw.length > Math.ceil(this.MAX_EVENT_BYTES / 3) * 4 + 1024) {
      throw new Error("This inline attachment is too large to save (limit: 5 MiB).");
    }
    const encoded = raw.replace(/\s/g, "");
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const payload = padding ? encoded.slice(0, -padding) : encoded;
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(payload)) {
      throw new Error("This attachment contains invalid BASE64 data.");
    }
    if (this.decodedSize(encoded) > this.MAX_FILE_BYTES) {
      throw new Error("This inline attachment is too large to save (limit: 5 MiB).");
    }
    return encoded;
  },

  decodedSize(encoded) {
    return encoded.length * 3 / 4 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  },

  decode(attachment) {
    return Uint8Array.from(atob(this.base64(attachment)), char => char.charCodeAt(0));
  },
};

var calendarAttachments = class extends ExtensionAPI {
  getAPI(context) {
    this.windows = new Map();
    this.documents = new Map();
    this.data = CalendarAttachmentData;
    context.callOnClose(this);
    return { calendarAttachments: { start: async () => this.start(context.extension.id) } };
  }

  start(id) {
    if (this.listenerId) {
      return;
    }
    this.listenerId = `${id}-calendar-attachments`;
    ExtensionSupport.registerWindowListener(this.listenerId, {
      chromeURLs: [
        "chrome://messenger/content/messenger.xhtml",
        "chrome://calendar/content/calendar-event-dialog.xhtml",
        "chrome://calendar/content/calendar-summary-dialog.xhtml",
      ],
      onLoadWindow: win => this.watchWindow(win),
      onUnloadWindow: win => this.forgetWindow(win),
    });
  }

  watchWindow(win) {
    const scan = () => {
      this.discover(win.document);
      for (const frame of win.document.querySelectorAll("iframe, browser")) {
        if (frame.contentDocument) {
          this.discover(frame.contentDocument);
        }
      }
    };
    const onLoad = () => scan();
    win.addEventListener("load", onLoad, true);
    // The event editor can be an asynchronously inserted browser in a tab.
    const timer = win.setInterval(scan, 500);
    this.windows.set(win, { onLoad, timer });
    scan();
  }

  discover(doc) {
    const editor = doc?.documentURI === "chrome://calendar/content/calendar-item-iframe.xhtml";
    const summary = doc?.documentURI === "chrome://calendar/content/calendar-summary-dialog.xhtml";
    if ((!editor && !summary) || this.documents.has(doc)) {
      return;
    }
    const state = { doc, editor, root: null, timer: null, observer: null, hiddenNative: new Map() };
    this.documents.set(doc, state);
    state.unload = () => this.forgetDocument(doc);
    doc.defaultView.addEventListener("unload", state.unload, { once: true });
    // Calendar loads the item asynchronously after its document has loaded.
    const ready = attempts => {
      if (!this.documents.has(doc)) {
        return;
      }
      const win = doc.defaultView;
      if ((editor && win.onLoad?.hasLoaded) || (summary && win.calendarItem)) {
        try {
          this.mount(state);
        } catch (error) {
          console.error("Twake Mail: Cannot initialize calendar attachments", doc.documentURI, error);
        }
      } else if (attempts > 0) {
        state.timer = win.setTimeout(() => ready(attempts - 1), 100);
      } else {
        console.warn("Twake Mail: Calendar item did not initialize", doc.documentURI);
      }
    };
    ready(100);
  }

  element(doc, name, attributes = {}) {
    const node = doc.createXULElement(name);
    for (const [key, value] of Object.entries(attributes)) {
      // Native calendar documents can reject style attributes through their CSP.
      if (key === "style") {
        node.style.cssText = value;
      } else {
        node.setAttribute(key, value);
      }
    }
    return node;
  }

  button(doc, label, action) {
    const button = this.element(doc, "button", { label });
    button.addEventListener("command", () => {
      Promise.resolve().then(action).catch(error => this.showError(doc, error));
    });
    return button;
  }

  mount(state) {
    const { doc, editor } = state;
    const win = doc.defaultView;
    const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    root.id = "twake-inline-attachments";
    root.style.cssText = "display: flex; flex-direction: column; box-sizing: border-box; padding: 8px 4px; margin: 4px 0; min-width: 320px;";
    state.root = root;
    const header = this.element(doc, "hbox", { align: "center", style: "margin-bottom: 4px;" });
    state.heading = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    state.heading.style.cssText = "font-weight: 600; flex: 1; margin: 0; padding: 0;";
    header.append(state.heading);
    root.append(header);
    state.rows = this.element(doc, "vbox", { style: "display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0;" });
    root.append(state.rows);
    if (editor) {
      const add = this.button(doc, "Attach file...", () => this.attachFiles(state));
      header.append(add);
      state.add = add;
      const list = doc.getElementById("attachment-link");
      list.before(root);
      state.observer = new win.MutationObserver(() => this.render(state));
      state.observer.observe(list, { childList: true });
      state.observer.observe(doc.getElementById("item-calendar"), { attributes: true });
      state.menus = [];
      if (win.parent.document.documentURI === "chrome://calendar/content/calendar-event-dialog.xhtml") {
        for (const id of ["button-attach-menupopup", "options-attachments-menupopup"]) {
          const menu = win.parent.document.getElementById(id);
          if (menu) {
            const item = this.element(menu.ownerDocument, "menuitem", { label: "File from computer..." });
            item.addEventListener("command", () => {
              doc.getElementById("event-grid-tabs").selectedItem = doc.getElementById("event-grid-tab-attachments");
              this.attachFiles(state).catch(error => this.showError(doc, error));
            });
            menu.append(item);
            state.menus.push(item);
          }
        }
      }
    } else {
      const summary = doc.getElementById("calendar-item-summary");
      const details = summary.querySelector(".calendar-summary-table");
      if (details) {
        details.after(root);
      } else {
        summary.after(root);
        root.style.paddingInline = "24px";
      }
    }
    this.render(state);
    if (!editor) {
      win.sizeToContent();
    }
  }

  attachments(state) {
    const win = state.doc.defaultView;
    return state.editor ? Object.values(win.gAttachMap) : win.calendarItem.getAttachments();
  }

  restoreNative(state) {
    for (const [node, hidden] of state.hiddenNative) {
      node.hidden = hidden;
    }
    state.hiddenNative.clear();
  }

  syncNative(state, attachments) {
    this.restoreNative(state);
    const hide = node => {
      state.hiddenNative.set(node, node.hidden);
      node.hidden = true;
    };
    if (state.editor) {
      const list = state.doc.getElementById("attachment-link");
      const managed = new Set(attachments.map(attachment => attachment.hashId));
      for (const item of list.children) {
        if (item.attachment && managed.has(item.attachment.hashId)) {
          hide(item);
        }
      }
      if (![...list.children].some(item => !item.hidden)) {
        hide(list);
      }
    } else {
      const summary = state.doc.getElementById("calendar-item-summary");
      const urls = new Set(attachments.filter(attachment => this.data.isWebLink(attachment))
        .map(attachment => attachment.uri.spec));
      const items = [...summary.querySelectorAll(".attachment-template")].filter(item => !item.hidden);
      for (const item of items) {
        if (urls.has(item.querySelector("label")?.getAttribute("value"))) {
          hide(item);
        }
      }
      const row = summary.querySelector(".attachments-row");
      if (row && items.length && items.every(item => item.hidden)) {
        hide(row);
      }
    }
  }

  render(state) {
    const { doc, editor } = state;
    const win = doc.defaultView;
    const attachments = this.attachments(state)
      .filter(att => this.data.isBinary(att) || this.data.isWebLink(att));
    this.syncNative(state, attachments);
    state.rows.replaceChildren();
    state.heading.textContent = attachments.length ? `Attachments (${attachments.length})` : "Attachments";
    state.root.hidden = !editor && attachments.length === 0;
    state.root.style.display = state.root.hidden ? "none" : "flex";
    const readOnly = editor && (win.gIsReadOnly || win.calendarItem.calendar.readOnly);
    if (editor) {
      state.add.disabled = readOnly;
      const count = this.attachments(state).length;
      doc.getElementById("event-grid-tab-attachments").label = count
        ? `${win.attachmentTabLabel} (${count})` : win.attachmentTabLabel;
      for (const item of state.menus) {
        item.disabled = readOnly;
      }
    }
    if (editor && !attachments.length) {
      state.rows.append(this.element(doc, "description", { value: "Choose a file to include its content in the calendar event." }));
    }
    for (const attachment of attachments) {
      const row = this.element(doc, "hbox", { align: "center", style: "display: flex; align-items: center; margin: 0; padding: 0; min-height: 0;" });
      const binary = this.data.isBinary(attachment);
      const name = this.data.displayName(attachment);
      const download = doc.createElementNS("http://www.w3.org/1999/xhtml", "a");
      download.textContent = name;
      download.setAttribute("href", binary ? "#" : attachment.uri.spec);
      download.style.cssText = "display: block; color: var(--link-color, #58a6ff); text-decoration: underline; cursor: pointer; overflow-wrap: anywhere; min-width: 0; flex: 1; margin: 0; padding: 2px 0;";
      download.addEventListener("click", event => {
        event.preventDefault();
        Promise.resolve().then(() => {
          if (binary) {
            return this.saveFile(state, attachment);
          }
          if (this.data.isWebLink(attachment)) {
            openLinkExternally(attachment.uri, { addToHistory: false });
          }
          return undefined;
        }).catch(error => this.showError(doc, error));
      });
      download.setAttribute("title", binary ? "Download attachment" : attachment.uri.spec);
      row.append(download);
      if (editor && !readOnly) {
        row.append(this.button(doc, "Remove", () => {
          const list = doc.getElementById("attachment-link");
          const nativeItem = [...list.children].find(item => item.attachment?.hashId === attachment.hashId);
          if (nativeItem) {
            // Use native deletion to keep its list, save map and cloud-file cleanup in sync.
            list.selectedItem = nativeItem;
            win.deleteAttachment();
          } else {
            delete win.gAttachMap[attachment.hashId];
            win.updateAttachment();
          }
          win.updateAccept();
          this.render(state);
        }));
      }
      state.rows.append(row);
    }
  }

  async attachFiles(state) {
    const win = state.doc.defaultView;
    if (win.gIsReadOnly || win.calendarItem.calendar.readOnly) {
      return;
    }
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Attach files to this event", Ci.nsIFilePicker.modeOpenMultiple);
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK || !this.documents.has(state.doc)) {
      return;
    }
    let total = this.attachments(state).filter(att => this.data.isBinary(att))
      .reduce((sum, att) => sum + this.data.decodedSize(this.data.base64(att)), 0);
    const pending = [];
    const hashes = new Set(Object.keys(win.gAttachMap));
    for (const file of picker.files) {
      if (file.fileSize > this.data.MAX_FILE_BYTES) {
        throw new Error(`${file.leafName}: choose a file no larger than 5 MiB.`);
      }
      const bytes = await IOUtils.read(file.path, { maxBytes: this.data.MAX_FILE_BYTES + 1 });
      const attachment = new CalAttachment();
      attachment.rawData = this.data.encode(bytes);
      attachment.encoding = "BASE64";
      attachment.setParameter("FILENAME", this.data.safeName(file.leafName));
      try {
        attachment.formatType = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService).getTypeFromFile(file);
      } catch {
        attachment.formatType = "application/octet-stream";
      }
      if (!hashes.has(attachment.hashId)) {
        total += bytes.length;
        hashes.add(attachment.hashId);
        pending.push(attachment);
      }
      if (total > this.data.MAX_EVENT_BYTES) {
        throw new Error("The total size of embedded files must not exceed 10 MiB.");
      }
    }
    if (!this.documents.has(state.doc) || win.gIsReadOnly || win.calendarItem.calendar.readOnly) {
      return;
    }
    // Keep the original binary objects in Thunderbird's save map. A local URI
    // here would replace the bytes when the user saves the event.
    for (const attachment of pending) {
      win.addAttachment(attachment);
    }
    win.updateAccept();
    this.render(state);
  }

  async saveFile(state, attachment) {
    const win = state.doc.defaultView;
    const bytes = this.data.decode(attachment);
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Save embedded attachment", Ci.nsIFilePicker.modeSave);
    picker.defaultString = this.data.fileName(attachment);
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result === Ci.nsIFilePicker.returnOK || result === Ci.nsIFilePicker.returnReplace) {
      await IOUtils.write(picker.file.path, bytes, { mode: result === Ci.nsIFilePicker.returnReplace ? "overwrite" : "create" });
    }
  }

  showError(doc, error) {
    console.error("Twake Mail: Calendar attachment operation failed", doc.defaultView?.calendarItem?.id, error);
    if (!doc.defaultView?.closed) {
      Services.prompt.alert(doc.defaultView, "Calendar attachment", error.message || String(error));
    }
  }

  forgetDocument(doc) {
    const state = this.documents.get(doc);
    if (!state) {
      return;
    }
    doc.defaultView.clearTimeout(state.timer);
    doc.defaultView.removeEventListener("unload", state.unload);
    state.observer?.disconnect();
    this.restoreNative(state);
    state.root?.remove();
    if (state.editor && state.root && !doc.defaultView.closed) {
      doc.defaultView.updateAttachment();
    }
    for (const item of state.menus || []) {
      item.remove();
    }
    this.documents.delete(doc);
  }

  forgetWindow(win) {
    const watcher = this.windows.get(win);
    win.removeEventListener("load", watcher?.onLoad, true);
    win.clearInterval(watcher?.timer);
    this.windows.delete(win);
    for (const doc of this.documents.keys()) {
      if (doc.defaultView.top === win) {
        this.forgetDocument(doc);
      }
    }
  }

  close() {
    if (this.listenerId) {
      ExtensionSupport.unregisterWindowListener(this.listenerId);
    }
    for (const win of this.windows.keys()) {
      this.forgetWindow(win);
    }
  }
};
