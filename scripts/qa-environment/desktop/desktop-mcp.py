#!/usr/bin/env python3
"""desktop-mcp: an MCP server (stdio) driving the desktop of its container, for the QA environment (scripts/qa-environment) and the desktop driver of twake-qa.

What the user sees: screenshots of the X display (xdotool, ImageMagick); what assistive technologies see: the
AT-SPI accessibility tree of the applications (names, roles, states, places), the equivalent of a browser
snapshot. A control without an accessible name shows as such: a finding of its own.

Run in the container (docker exec -i <container> /opt/desktop/desktop-mcp.py); screenshots are also written to
/captures when it is mounted (the output directory of the run, at the same path on the host: CAPTURES_DIR).
"""
import base64
import json
import os
import re
import subprocess
import sys
import time

with open("/tmp/desktop.env") as env:  # the display and session bus of the entrypoint
    for line in env:
        m = re.match(r"export (\w+)=(.*)", line.strip())
        if m:
            os.environ[m.group(1)] = subprocess.run(["bash", "-c", f"printf %s {m.group(2)}"],
                                                    capture_output=True, text=True).stdout

CAPTURES = os.environ.get("CAPTURES_DIR") or "/captures"
LOG = "/tmp/thunderbird.log"
INTERACTIVE = {"push button", "toggle button", "check box", "radio button", "menu item", "check menu item",
               "radio menu item", "menu", "combo box", "entry", "password text", "text", "link", "list item",
               "page tab", "tree item", "table cell", "slider", "spin button", "tool bar", "menu bar",
               "table row", "row header", "column header", "editbar", "document web", "dialog", "alert",
               "frame", "heading", "image", "label", "section", "paragraph", "list box", "tree table",
               "notification", "status bar", "split button"}
nodes = {}  # ref -> accessible, from the last tree


def sh(*args, input=None, timeout=30):
    return subprocess.run(list(args), capture_output=True, text=input is not None or None, input=input,
                          timeout=timeout)


def screenshot(name=None):
    png = sh("import", "-window", "root", "png:-").stdout
    content = [{"type": "image", "data": base64.b64encode(png).decode(), "mimeType": "image/png"}]
    try:
        os.makedirs(CAPTURES, exist_ok=True)
    except OSError:
        pass
    if os.access(CAPTURES, os.W_OK):
        path = os.path.join(CAPTURES, (re.sub(r"[^\w.-]", "_", name) if name else f"desktop-{int(time.time()*1000)}") + ".png")
        with open(path, "wb") as f:
            f.write(png)
        content.append({"type": "text", "text": f"saved: {path}"})
    return content


def xdo(*args):
    r = sh("xdotool", *[str(a) for a in args])
    if r.returncode:
        raise RuntimeError((r.stderr or b"").decode(errors="replace").strip() or "xdotool failed")


def click(x, y, button="left", double=False):
    xdo("mousemove", "--sync", int(x), int(y))
    xdo("click", *(["--repeat", 2] if double else []), {"left": 1, "middle": 2, "right": 3}[button])
    return text(f"clicked {button} at {x},{y}")


def text(s):
    return [{"type": "text", "text": s}]


def atspi():
    import pyatspi  # late: needs the session bus of the environment
    return pyatspi


def describe(acc, pa):
    role = acc.getRoleName()
    name = (acc.name or "").strip().replace("\n", " ")
    states = acc.getState()
    flags = [s for s, st in (("focused", pa.STATE_FOCUSED), ("selected", pa.STATE_SELECTED),
                             ("checked", pa.STATE_CHECKED), ("disabled", None), ("expanded", pa.STATE_EXPANDED))
             if st is not None and states.contains(st)]
    if not states.contains(pa.STATE_ENABLED) and role in INTERACTIVE:
        flags.append("disabled")
    try:
        x, y, w, h = acc.queryComponent().getExtents(pa.DESKTOP_COORDS)
        place = f" @({x + w // 2},{y + h // 2} {w}x{h})"
    except Exception:
        place = ""
    value = ""
    if role in ("entry", "password text", "text", "combo box", "spin button"):
        try:
            t = acc.queryText()
            value = t.getText(0, min(t.characterCount, 200)) if role != "password text" else "•••"
            value = f" value={json.dumps(value)}" if value else ""
        except Exception:
            pass
    shown = f'"{name}"' if name else ("(no accessible name)" if role in INTERACTIVE - {"section", "paragraph", "frame", "label", "image", "tool bar", "menu bar", "table row", "list box", "tree table", "status bar", "document web", "heading"} else "")
    return f"{role} {shown}{value}{(' [' + ', '.join(flags) + ']') if flags else ''}{place}"


def tree(app="thunderbird", max_depth=40, contains=None, max_lines=900):
    pa = atspi()
    nodes.clear()
    lines = []
    desktop = pa.Registry.getDesktop(0)
    apps = [a for a in desktop if a is not None and (not app or app.lower() in (a.name or "").lower())]
    if not apps:
        return text("no application on the accessibility bus" + (f" named {app}" if app else "") +
                    f" (seen: {[a.name for a in desktop if a is not None]}); is it started? thunderbird_log says")

    def walk(acc, depth, ref):
        if acc is None or depth > max_depth or len(lines) >= max_lines:
            return
        try:
            states = acc.getState()
            if depth > 1 and not states.contains(pa.STATE_SHOWING):
                return
            role = acc.getRoleName()
            line = describe(acc, pa)
        except Exception:
            return
        keep = (acc.name or role in INTERACTIVE) and role not in ("filler", "panel", "unknown", "redundant object")
        if keep and (not contains or contains.lower() in line.lower()):
            nodes[ref] = acc
            lines.append(f"{'  ' * min(depth, 12)}[{ref}] {line}")
        for i in range(min(acc.childCount, 400)):
            try:
                walk(acc.getChildAtIndex(i), depth + 1, f"{ref}.{i}")
            except Exception:
                continue

    for n, a in enumerate(apps):
        walk(a, 0, f"a{n}")
    if len(lines) >= max_lines:
        lines.append(f"... cut at {max_lines} lines: narrow it with `contains`")
    return text("\n".join(lines) or "nothing shown")


def element(ref, action="click", value=None):
    pa = atspi()
    acc = nodes.get(ref)
    if acc is None:
        return text(f"unknown ref {ref}: take accessibility_tree again")
    if action == "set_text":
        try:
            acc.queryEditableText().setTextContents(value or "")
            return text(f"text of [{ref}] set")
        except NotImplementedError:
            return text(f"[{ref}] is not an editable text: click it and use type")
    if action == "focus":
        acc.queryComponent().grabFocus()
        return text(f"[{ref}] focused")
    try:
        act = acc.queryAction()
        names = [act.getName(i) for i in range(act.nActions)]
        for wanted in ("click", "press", "activate", "jump", "select", "switch", "check", "uncheck", "open", "expand", "collapse"):
            if wanted in names:
                act.doAction(names.index(wanted))
                return text(f"[{ref}] {wanted} (actions: {names})")
    except NotImplementedError:
        pass
    x, y, w, h = acc.queryComponent().getExtents(pa.DESKTOP_COORDS)
    return click(x + w // 2, y + h // 2)


def log(lines=80, contains=None):
    try:
        with open(LOG, errors="replace") as f:
            out = f.read().splitlines()
    except FileNotFoundError:
        out = []
    if contains:
        out = [l for l in out if contains.lower() in l.lower()]
    return text("\n".join(out[-int(lines):]) or "(empty)")


def restart():
    sh("pkill", "-f", "thunderbird")
    time.sleep(4)
    return text("Thunderbird restarted (the entrypoint starts it again); wait a few seconds")


TOOLS = {
    "screenshot": (screenshot, "A screenshot of the whole display (1440x900). Coordinates of the other tools are those of this image.",
                   {"name": {"type": "string", "description": "file name of the saved PNG, without extension"}}, []),
    "accessibility_tree": (tree, "The AT-SPI accessibility tree of Thunderbird as assistive technologies get it: role, accessible name, value, states, center and size of each element shown. Refs ([a0.1.2]) are for element_action, valid until the next tree. A control with '(no accessible name)' is an accessibility defect.",
                           {"contains": {"type": "string", "description": "only the lines containing this text"},
                            "max_depth": {"type": "integer"}, "app": {"type": "string", "description": "application name (default thunderbird)"}}, []),
    "element_action": (element, "Acts on an element of the last accessibility_tree: click (its default action, else a click at its center), focus, set_text (an editable text field).",
                       {"ref": {"type": "string"}, "action": {"type": "string", "enum": ["click", "focus", "set_text"]},
                        "value": {"type": "string"}}, ["ref"]),
    "click": (click, "Mouse click at x,y of the screenshot.",
              {"x": {"type": "integer"}, "y": {"type": "integer"}, "button": {"type": "string", "enum": ["left", "middle", "right"]},
               "double": {"type": "boolean"}}, ["x", "y"]),
    "type_text": (lambda value: (xdo("type", "--delay", "15", value), text(f"typed {len(value)} characters"))[1],
                  "Types text with the keyboard into the focused element.", {"value": {"type": "string"}}, ["value"]),
    "press_keys": (lambda keys: (xdo("key", "--delay", "60", *keys.split()), text(f"pressed {keys}"))[1],
                   "Presses keys, xdotool names, space separated: 'Return', 'ctrl+n', 'Tab Tab', 'alt+F4', 'Escape'.",
                   {"keys": {"type": "string"}}, ["keys"]),
    "scroll": (lambda x, y, direction="down", amount=3: (xdo("mousemove", "--sync", x, y),
                                                         xdo("click", "--repeat", amount, {"up": 4, "down": 5, "left": 6, "right": 7}[direction]),
                                                         text(f"scrolled {direction} {amount} at {x},{y}"))[2],
               "Mouse wheel at x,y.", {"x": {"type": "integer"}, "y": {"type": "integer"},
                                       "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                                       "amount": {"type": "integer"}}, ["x", "y"]),
    "drag": (lambda x1, y1, x2, y2: (xdo("mousemove", "--sync", x1, y1), xdo("mousedown", 1), xdo("mousemove", "--sync", x2, y2),
                                     xdo("mouseup", 1), text(f"dragged {x1},{y1} -> {x2},{y2}"))[4],
             "Drags with the left button from x1,y1 to x2,y2.",
             {"x1": {"type": "integer"}, "y1": {"type": "integer"}, "x2": {"type": "integer"}, "y2": {"type": "integer"}},
             ["x1", "y1", "x2", "y2"]),
    "thunderbird_log": (log, "The end of Thunderbird's output: its console (the extension logs with the prefix 'Twake Mail'), errors, restarts.",
                        {"lines": {"type": "integer"}, "contains": {"type": "string"}}, []),
    "restart_thunderbird": (restart, "Quits Thunderbird and starts it again on the same profile.", {}, []),
}


def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    msg["error" if error else "result"] = error or result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        method, id_ = req.get("method"), req.get("id")
        if id_ is None:
            continue  # notifications
        if method == "initialize":
            reply(id_, {"protocolVersion": req.get("params", {}).get("protocolVersion", "2025-06-18"),
                        "capabilities": {"tools": {}}, "serverInfo": {"name": "desktop", "version": "1"}})
        elif method == "tools/list":
            reply(id_, {"tools": [{"name": n, "description": d, "inputSchema": {"type": "object", "properties": p, "required": r}}
                                  for n, (_, d, p, r) in TOOLS.items()]})
        elif method == "tools/call":
            name = req["params"]["name"]
            args = req["params"].get("arguments") or {}
            try:
                content = TOOLS[name][0](**args)
                reply(id_, {"content": content})
            except Exception as e:
                reply(id_, {"content": text(f"{type(e).__name__}: {e}"), "isError": True})
        elif method == "ping":
            reply(id_, {})
        else:
            reply(id_, error={"code": -32601, "message": f"unknown method {method}"})


if __name__ == "__main__":
    main()
