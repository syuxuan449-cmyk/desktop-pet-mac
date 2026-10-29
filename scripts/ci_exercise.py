#!/usr/bin/env python3
"""Launch 桌面小伙伴 on a real macOS session and exercise it.

Writes test-results/<runner>/ with screenshots, the pet log, and summary.json.
Exit 0 only when every required feature passes.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "桌面小伙伴.app"
LAUNCHER = APP / "Contents" / "MacOS" / "DesktopPet"
BACKUP = ROOT / "启动桌宠（备用）.command"
PLIST = APP / "Contents" / "Info.plist"
JS = APP / "Contents" / "Resources" / "DesktopPet.js"
ASSETS = APP / "Contents" / "Resources" / "assets"
INPUT = ROOT / "scripts" / "input.js"
LABEL = os.environ.get("PET_RUNNER_LABEL", "local")
OUT = ROOT / "test-results" / LABEL
LOG = Path.home() / "Library" / "Logs" / "桌面小伙伴.log"
WALL = Path("/tmp/pet-bg-green.png")
BACKDROP_JS = Path("/tmp/pet-backdrop.js")
BACKDROP_PID = None

BACKDROP_SRC = r'''
ObjC.import('Cocoa');
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy(1);
var scr = $.NSScreen.mainScreen.frame;
var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(scr, 0, 2, false);
win.setLevel(0);
win.setOpaque(true);
win.setBackgroundColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 1, 80 / 255, 1));
win.setHasShadow(false);
win.setIgnoresMouseEvents(true);
win.makeKeyAndOrderFront(null);
app.run();
'''

# Window-relative points, top-left. Matches DesktopPet.js layout (205×285, flipped view).
HEAD = (102, 96)
SPANK_ZONE = (102, 220)
FEED = (39, 266)
SLEEP = (84, 266)
MORE = (174, 266)


class Suite:
    def __init__(self):
        self.features = {}
        self.notes = []
        self.failures = []
        self.driver = None

    def mark(self, name, ok, detail=""):
        self.features[name] = "pass" if ok else "fail"
        line = f"{name}: {'pass' if ok else 'FAIL'} {detail}".rstrip()
        print(line, flush=True)
        if not ok:
            self.failures.append(line)
        if detail:
            self.notes.append(line)

    def note(self, text):
        print(text, flush=True)
        self.notes.append(text)


S = Suite()


def run(cmd, timeout=60, check=False, env=None):
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, check=check, env=env
    )


def write_rgb_png(path, w, h, rgb):
    row = bytes(rgb) * w
    raw = b"".join(b"\x00" + row for _ in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def read_png(path):
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a png")
    pos = 8
    idat = b""
    w = h = ct = None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h = struct.unpack(">II", chunk[:8])
            ct = chunk[9]
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    bpp = {2: 3, 6: 4}.get(ct)
    if not bpp:
        raise ValueError("unsupported color type %s" % ct)
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows = []
    i = 0
    prev = bytearray(stride)

    def paeth(a, b, c):
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        if pa <= pb and pa <= pc:
            return a
        if pb <= pc:
            return b
        return c

    for _y in range(h):
        f = raw[i]
        i += 1
        row = bytearray(raw[i:i + stride])
        i += stride
        if f == 1:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + left) & 255
        elif f == 2:
            for x in range(stride):
                row[x] = (row[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + ((left + prev[x]) // 2)) & 255
        elif f == 4:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                up = prev[x]
                ul = prev[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + paeth(left, up, ul)) & 255
        elif f != 0:
            raise ValueError("bad filter")
        rows.append(row)
        prev = row
    return w, h, bpp, rows


def sample(path, x, y):
    w, h, bpp, rows = read_png(path)
    x = max(0, min(w - 1, int(x)))
    y = max(0, min(h - 1, int(y)))
    i = x * bpp
    px = tuple(rows[y][i:i + bpp])
    return w, h, px


def pet_pids():
    r = run(["pgrep", "-f", "[D]esktopPet.js"])
    if r.returncode != 0:
        return []
    return [int(x) for x in r.stdout.split() if x.strip().isdigit()]


def kill_pet():
    run(["pkill", "-f", "[D]esktopPet.js"])
    for _ in range(20):
        if not pet_pids():
            return
        time.sleep(0.15)


def read_log():
    if not LOG.exists():
        return ""
    return LOG.read_text(encoding="utf-8", errors="replace")


def jxa(*args, timeout=30):
    r = run(["/usr/bin/osascript", "-l", "JavaScript", str(INPUT), *map(str, args)], timeout=timeout)
    if r.returncode != 0:
        S.note("jxa %s failed rc=%s err=%s" % (" ".join(map(str, args)), r.returncode, (r.stderr or "")[:500]))
    return r


LISTER = None


def ensure_lister():
    global LISTER
    if LISTER is not None:
        return LISTER
    dest = Path("/tmp/pet-listwindows")
    src = ROOT / "scripts" / "listwindows.swift"
    r = run(["xcrun", "swiftc", "-O", "-o", str(dest), str(src)], timeout=180)
    if r.returncode != 0 or not dest.exists():
        S.note("swiftc failed %s" % ((r.stderr or r.stdout or "")[:400]))
        LISTER = ""
    else:
        LISTER = str(dest)
        S.note("window lister %s" % LISTER)
    return LISTER


def query_windows():
    base = {"windows": [], "screens": []}
    r = jxa("windows", timeout=25)
    text = (r.stdout or "").strip()
    if text:
        try:
            base = json.loads(text)
        except json.JSONDecodeError as e:
            base = {"windows": [], "screens": [], "error": str(e), "raw": text[:400]}
    else:
        base["error"] = (r.stderr or "")[:400]
    lister = ensure_lister()
    if lister:
        rr = run([lister], timeout=15)
        if rr.returncode == 0 and (rr.stdout or "").strip():
            try:
                extra = json.loads(rr.stdout)
                if extra.get("windows"):
                    base["windows"] = list(base.get("windows") or []) + extra["windows"]
                    base["swift_windows"] = len(extra["windows"])
            except json.JSONDecodeError as e:
                S.note("lister json %s" % e)
        elif rr.returncode != 0:
            S.note("lister rc=%s %s" % (rr.returncode, (rr.stderr or "")[:200]))
    return base


def find_pet(data):
    wins = data.get("windows") or []
    cands = []
    for w in wins:
        if 160 <= w.get("w", 0) <= 280 and 230 <= w.get("h", 0) <= 360:
            cands.append(w)
    if not cands:
        return None
    cands.sort(key=lambda w: ((1 if w.get("id") else 0), w.get("x", 0) + w.get("y", 0)))
    return cands[-1]


def wait_window(timeout=15):
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = query_windows()
        win = find_pet(last)
        if win:
            return win, last
        time.sleep(0.4)
    return None, last


def screen_of(data):
    screens = data.get("screens") or []
    if not screens:
        return {"w": 1440, "h": 900, "scale": 2}
    return max(screens, key=lambda s: s.get("w", 0) * s.get("h", 0))


def capture(name, expand=40, full=False):
    OUT.mkdir(parents=True, exist_ok=True)
    data = query_windows()
    (OUT / ("windows-%s.json" % name)).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    win = find_pet(data)
    if full:
        dest = OUT / ("full-%s.png" % name)
        run(["/usr/sbin/screencapture", "-x", "-t", "png", str(dest)], timeout=30)
    if not win:
        S.note("capture %s: pet window not found" % name)
        return None, data
    x = int(round(win["x"])) - expand
    y = int(round(win["y"])) - expand
    w = int(round(win["w"])) + expand * 2
    h = int(round(win["h"])) + expand * 2
    scr = screen_of(data)
    if x < 0:
        w += x
        x = 0
    if y < 0:
        h += y
        y = 0
    w = max(1, min(w, int(scr["w"]) - x))
    h = max(1, min(h, int(scr["h"]) - y))
    dest = OUT / ("%s.png" % name)
    run(["/usr/sbin/screencapture", "-x", "-R", "%d,%d,%d,%d" % (x, y, w, h), "-t", "png", str(dest)], timeout=30)
    if int(win.get("id") or 0) > 0 and name in ("01-idle", "03-head", "05-angry", "07-feed", "09-sleep", "11-dance", "13-more-menu"):
        run(["/usr/sbin/screencapture", "-x", "-o", "-l", str(int(win["id"])), "-t", "png", str(OUT / ("win-%s.png" % name))], timeout=30)
    return win, data


def log_has(token, since=""):
    text = read_log()
    if since and text.startswith(since):
        text = text[len(since):]
    elif since:
        # log rewritten; search the whole file
        pass
    return token in text, text


def deliver(kind, coords, marker, settle=0.55):
    """Post an input event. Prefer cliclick, fall back to the JXA CGEvent helper."""
    drivers = []
    if shutil.which("cliclick"):
        drivers.append("cliclick")
    drivers.append("jxa")
    last_delta = ""
    for driver in drivers:
        before = read_log()
        try:
            if driver == "cliclick":
                cliclick(kind, coords)
            else:
                jxa_input(kind, coords)
        except Exception as e:
            S.note("%s %s error %s" % (driver, kind, e))
            continue
        time.sleep(settle)
        after = read_log()
        delta = after[len(before):] if after.startswith(before) else after
        last_delta = delta
        arrived = ("EVENT " in delta) or ("ACTION " in delta)
        wanted = (marker in delta) if marker else arrived
        S.note("input %s via %s arrived=%s wanted=%s" % (kind, driver, arrived, wanted))
        # Double-click must actually start the dance. A plain click is not enough,
        # so fall through to the JXA helper which sets clickCount 2.
        if kind == "dclick":
            if wanted or driver == drivers[-1]:
                S.driver = driver
                return wanted, delta, driver
            continue
        # A different action means the event landed; don't fire a second driver.
        if wanted or arrived or driver == drivers[-1]:
            S.driver = driver
            return wanted, delta, driver
    return False, last_delta, "none"


def cliclick(kind, coords):
    pts = [str(int(round(float(n)))) for n in coords]
    if kind == "click":
        cmd = ["cliclick", "-m", "verbose", "c:%s,%s" % (pts[0], pts[1])]
    elif kind == "rclick":
        cmd = ["cliclick", "-m", "verbose", "rc:%s,%s" % (pts[0], pts[1])]
    elif kind == "dclick":
        cmd = ["cliclick", "-m", "verbose", "dc:%s,%s" % (pts[0], pts[1])]
    elif kind == "drag":
        cmd = ["cliclick", "-m", "verbose", "-w", "20",
               "dd:%s,%s" % (pts[0], pts[1]),
               "dm:%s,%s" % (pts[2], pts[3]),
               "du:%s,%s" % (pts[2], pts[3])]
    elif kind == "esc":
        cmd = ["cliclick", "kp:esc"]
    elif kind == "cmd-q":
        cmd = ["cliclick", "kd:cmd", "kp:q", "ku:cmd"]
    else:
        raise ValueError(kind)
    r = run(cmd, timeout=20)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "cliclick failed")[:300])


def jxa_input(kind, coords):
    if kind == "click":
        jxa("click", coords[0], coords[1])
    elif kind == "rclick":
        jxa("rclick", coords[0], coords[1])
    elif kind == "dclick":
        jxa("dclick", coords[0], coords[1])
    elif kind == "drag":
        jxa("drag", coords[0], coords[1], coords[2], coords[3])
    elif kind == "esc":
        jxa("key", "esc")
    elif kind == "cmd-q":
        jxa("key", "cmd-q")
    else:
        raise ValueError(kind)


def screen_point(win, rel):
    if not win:
        raise RuntimeError("pet window is gone")
    return (win["x"] + rel[0], win["y"] + rel[1])


def fresh_window():
    win, data = wait_window(12)
    return win, data


def structure():
    r = run(["/usr/bin/plutil", "-lint", str(PLIST)])
    plist_ok = r.returncode == 0
    exec_ok = os.access(LAUNCHER, os.X_OK) and os.access(BACKUP, os.X_OK)
    assets_ok = all((ASSETS / (n + ".png")).is_file() for n in ("idle", "happy", "eating", "sleeping", "angry"))
    text = PLIST.read_text(encoding="utf-8")
    keys_ok = all(k in text for k in ("CFBundleExecutable", "LSUIElement", "桌面小伙伴"))
    S.mark("structure", plist_ok and exec_ok and assets_ok and keys_ok,
           "plutil=%s exec=%s assets=%s" % (r.returncode, exec_ok, assets_ok))


def start_backdrop():
    global BACKDROP_PID
    BACKDROP_JS.write_text(BACKDROP_SRC, encoding="utf-8")
    proc = subprocess.Popen(
        ["/usr/bin/osascript", "-l", "JavaScript", str(BACKDROP_JS)],
        start_new_session=True,
    )
    BACKDROP_PID = proc.pid
    time.sleep(1.0)
    S.note("backdrop pid=%s" % BACKDROP_PID)


def stop_backdrop():
    global BACKDROP_PID
    if not BACKDROP_PID:
        return
    try:
        os.kill(BACKDROP_PID, 15)
    except OSError:
        pass
    BACKDROP_PID = None


def prepare_desktop():
    try:
        write_rgb_png(WALL, 64, 64, (0, 255, 80))
        r = run(["/usr/bin/osascript", "-e",
                 'tell application "System Events" to set picture of every desktop to POSIX file "%s"' % WALL])
        S.note("wallpaper rc=%s %s" % (r.returncode, (r.stderr or "")[:200]))
    except Exception as e:
        S.note("wallpaper failed %s" % e)
    run(["defaults", "write", "com.apple.dock", "autohide", "-bool", "true"])
    run(["killall", "Dock"])
    run(["defaults", "write", "com.apple.finder", "CreateDesktop", "-bool", "false"])
    run(["killall", "Finder"])
    run(["launchctl", "setenv", "PET_CI", "1"])
    Path("/tmp/pet-ci").write_text("1", encoding="utf-8")
    start_backdrop()
    time.sleep(1.5)


def launch_open():
    kill_pet()
    if LOG.exists():
        LOG.write_text("")
    r = run(["/usr/bin/open", str(APP)])
    S.note("open rc=%s %s" % (r.returncode, (r.stderr or r.stdout or "")[:300]))
    pids = []
    for _ in range(25):
        pids = pet_pids()
        if pids:
            break
        time.sleep(0.4)
    if not pids:
        S.note("open did not start osascript; ad-hoc signing and retrying")
        run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(APP)])
        r2 = run(["/usr/bin/open", str(APP)])
        S.note("open retry rc=%s %s" % (r2.returncode, (r2.stderr or "")[:200]))
        for _ in range(25):
            pids = pet_pids()
            if pids:
                break
            time.sleep(0.4)
    S.mark("open_launch", bool(pids), "pids=%s" % pids)
    time.sleep(2.0)
    alive = bool(pet_pids())
    S.mark("open_stays_alive", alive, "pids=%s" % pet_pids())
    win, _data = fresh_window()
    if alive:
        capture("00-open-idle", full=True)
    return alive


def launch_direct():
    kill_pet()
    time.sleep(0.6)
    if LOG.exists():
        LOG.write_text("")
    env = os.environ.copy()
    env["PET_CI"] = "1"
    subprocess.Popen([str(LAUNCHER)], env=env, start_new_session=True, cwd=str(ROOT))
    pids = []
    for _ in range(25):
        pids = pet_pids()
        if pids:
            break
        time.sleep(0.4)
    ready = False
    for _ in range(40):
        if pet_pids() and "ACTION ready" in read_log():
            ready = True
            break
        time.sleep(0.25)
    S.mark("direct_launch", bool(pet_pids()) and ready, "pids=%s ready=%s" % (pet_pids(), ready))
    return ready


def is_green(px):
    if len(px) < 3:
        return False
    r, g, b = px[:3]
    return g > 170 and r < 90 and b < 140


def is_white(px):
    if len(px) < 3:
        return False
    r, g, b = px[:3]
    return r > 210 and g > 210 and b > 210


def is_dark(px):
    if len(px) < 3:
        return False
    r, g, b = px[:3]
    return r < 90 and g < 80 and b < 100 and (r + g + b) > 20


def count_where(path, pred, step=3):
    try:
        w, h, bpp, rows = read_png(path)
    except Exception as e:
        S.note("png %s %s" % (path, e))
        return 0, 0, None
    n = 0
    total = 0
    for y in range(0, h, step):
        row = rows[y]
        for x in range(0, w, step):
            total += 1
            if pred(tuple(row[x * bpp:(x + 1) * bpp])):
                n += 1
    return n, total, (w, h)


def check_placement_and_transparency():
    win, data = fresh_window()
    (OUT / "windows-placement.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    S.mark("window_found", win is not None, json.dumps(win, ensure_ascii=False) if win else "missing")
    if not win:
        return None
    scr = screen_of(data)
    right_gap = scr["w"] - (win["x"] + win["w"])
    bottom_gap = scr["h"] - (win["y"] + win["h"])
    bottom_right = right_gap < 90 and -5 <= bottom_gap < 180 and win["x"] > scr["w"] * 0.45
    S.mark("bottom_right", bottom_right,
           "gap_right=%.1f gap_bottom=%.1f screen=%sx%s win=%s,%s %sx%s" % (
               right_gap, bottom_gap, scr["w"], scr["h"], win["x"], win["y"], win["w"], win["h"]))
    capture("01-idle", expand=8, full=True)
    crop = OUT / "01-idle.png"
    # Empty padding at the window's top-left should show the green desktop.
    expand = 8
    try:
        pw, ph, _px = sample(crop, 2, 2)
        scale = max(1, round(pw / (win["w"] + expand * 2)))
        corner = sample(crop, (expand + 3) * scale, (expand + 4) * scale)[2]
        S.note("corner pixel %s scale=%s" % (corner, scale))
        transparent = is_green(corner)
        # Also accept a window-only capture whose corner is transparent.
        win_png = OUT / "win-01-idle.png"
        if win_png.exists():
            try:
                ww, wh, cpx = sample(win_png, 3, 3)
                S.note("window-capture corner %s size=%s" % (cpx, (ww, wh)))
                if len(cpx) == 4 and cpx[3] < 20:
                    transparent = True
            except Exception as e:
                S.note("win png %s" % e)
        S.mark("transparent", transparent, "corner=%s" % (corner,))
        n, total, _ = count_where(crop, lambda p: not is_green(p))
        S.mark("pet_visible", n > 80, "nongreen=%s/%s" % (n, total))
        # Speech bubble is a white rounded rect along the top.
        white_n, _, _ = count_where(crop, is_white)
        S.mark("bubble", white_n > 30, "white=%s" % white_n)
    except Exception as e:
        S.mark("transparent", False, str(e))
        S.mark("pet_visible", False, str(e))
        S.mark("bubble", False, str(e))
    return win


def wait_new(token, timeout, prior=None):
    """Wait until `token` appears more often than in `prior` (or the log right now)."""
    base = (prior if prior is not None else read_log()).count(token)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if read_log().count(token) > base:
            return True
        time.sleep(0.25)
    return read_log().count(token) > base


def exercise(win):
    if not win:
        for name in ("bubble_hides", "head_click", "head_returns_idle", "bottom_spank",
                     "spank_returns_idle", "feed", "feed_returns_idle", "sleep", "wake",
                     "dance", "dance_ends", "more_menu", "toolbar_hide", "right_menu", "drag", "quit"):
            S.mark(name, False, "no window")
        return

    hides = ("ACTION bubble-hide" in read_log()) or wait_new("ACTION bubble-hide", 6)
    capture("02-bubble-gone", expand=8)
    S.mark("bubble_hides", hides, "timer")

    prior = read_log()
    ok, _delta, _drv = deliver("click", screen_point(win, HEAD), "ACTION head", settle=0.35)
    capture("03-head", expand=16)
    # Hearts are drawn after the click; grab a second frame immediately.
    time.sleep(0.15)
    capture("03b-head-hearts", expand=16)
    S.mark("head_click", ok and "ACTION head" in read_log(), "log")

    idle = wait_new("ACTION idle", 4, prior)
    capture("04-after-head-idle", expand=8)
    S.mark("head_returns_idle", idle, "state timer")

    win, _ = fresh_window()
    prior = read_log()
    ok, _, _ = deliver("click", screen_point(win, SPANK_ZONE), "ACTION spank", settle=0.35)
    capture("05-angry", expand=20)
    S.mark("bottom_spank", "ACTION spank" in read_log(), "log")
    ended = wait_new("ACTION angry-end", 4, prior)
    capture("06-after-angry", expand=8)
    S.mark("spank_returns_idle", ended, "angry timer")

    time.sleep(0.6)  # spank cooldown is 2.55s from the click; angry-end is at 2.3s
    win, _ = fresh_window()
    prior = read_log()
    deliver("click", screen_point(win, FEED), "ACTION feed", settle=0.4)
    capture("07-feed", expand=12)
    S.mark("feed", "ACTION feed" in read_log(), "toolbar 喂食")
    feed_idle = wait_new("ACTION idle", 4.5, prior)
    S.mark("feed_returns_idle", feed_idle, "state timer after feed")
    capture("08-after-feed", expand=8)

    win, _ = fresh_window()
    deliver("click", screen_point(win, SLEEP), "ACTION sleep", settle=0.45)
    capture("09-sleep", expand=12)
    S.mark("sleep", "ACTION sleep" in read_log(), "toolbar 睡觉")

    win, _ = fresh_window()
    deliver("click", screen_point(win, SLEEP), "ACTION wake", settle=0.45)
    capture("10-wake", expand=12)
    S.mark("wake", "ACTION wake" in read_log(), "toolbar 醒来")

    win, _ = fresh_window()
    prior = read_log()
    deliver("dclick", screen_point(win, HEAD), "ACTION dance", settle=0.25)
    capture("11-dance", expand=24)
    time.sleep(0.22)
    capture("11b-dance-2", expand=24)
    S.mark("dance", "ACTION dance" in read_log(), "double-click")
    dance_end = wait_new("ACTION dance-end", 3, prior)
    capture("12-after-dance", expand=8)
    S.mark("dance_ends", dance_end, "dance timer")

    win, _ = fresh_window()
    before_ids = {w["id"] for w in (query_windows().get("windows") or [])}
    deliver("click", screen_point(win, MORE), "ACTION more-menu", settle=0.7)
    data = query_windows()
    (OUT / "windows-more-menu.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    new_wins = [w for w in (data.get("windows") or []) if w["id"] not in before_ids]
    capture("13-more-menu", expand=260, full=True)
    S.mark("more_menu", "ACTION more-menu" in read_log(), "new_windows=%s" % new_wins)

    # The open menu eats the first Esc. A second Esc reaches the window.
    deliver("esc", (), "ACTION toolbar-hide", settle=0.3)
    if "ACTION toolbar-hide" not in read_log():
        deliver("esc", (), "ACTION toolbar-hide", settle=0.4)
    capture("14-toolbar-hidden", expand=12)
    hidden = "ACTION toolbar-hide" in read_log()
    # Dark toolbar pixels should be gone from the bottom strip.
    try:
        crop = OUT / "14-toolbar-hidden.png"
        _w, h, bpp, rows = read_png(crop)
        dark = 0
        total = 0
        for y in range(int(h * 0.82), h, 2):
            row = rows[y]
            for x in range(0, _w, 3):
                total += 1
                if is_dark(tuple(row[x * bpp:(x + 1) * bpp])):
                    dark += 1
        S.note("toolbar-hidden dark=%s/%s" % (dark, total))
    except Exception as e:
        S.note("toolbar pixel check %s" % e)
    S.mark("toolbar_hide", hidden, "esc")

    win, _ = fresh_window()
    before_ids = {w["id"] for w in (query_windows().get("windows") or [])}
    deliver("rclick", screen_point(win, (102, 150)), "ACTION right-menu", settle=0.7)
    data = query_windows()
    (OUT / "windows-right-menu.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    new_wins = [w for w in (data.get("windows") or []) if w["id"] not in before_ids]
    capture("15-right-menu", expand=260, full=True)
    S.mark("right_menu", "ACTION right-menu" in read_log(), "new_windows=%s" % new_wins)
    # Dismiss the menu without using Esc (Esc also hides the toolbar).
    if win:
        deliver("click", (max(20, win["x"] - 80), max(20, win["y"] + 40)), "", settle=0.3)

    win, _ = fresh_window()
    if not win:
        S.mark("drag", False, "no window")
    else:
        x1, y1 = screen_point(win, (102, 150))
        x2, y2 = max(30, x1 - 380), max(30, y1 - 140)
        deliver("drag", (x1, y1, x2, y2), "ACTION drag", settle=0.5)
        win2, _ = fresh_window()
        capture("16-dragged", expand=20, full=True)
        moved = False
        if win2:
            moved = (win["x"] - win2["x"]) > 150
            S.note("drag from %s,%s to window %s,%s" % (win["x"], win["y"], win2["x"], win2["y"]))
        S.mark("drag", ("ACTION drag" in read_log()) and moved, "moved=%s" % moved)

    alive_before_quit = bool(pet_pids())
    S.mark("run_loop", alive_before_quit, "still alive before quit")
    deliver("cmd-q", (), "ACTION quit", settle=0.8)
    time.sleep(0.8)
    gone = not pet_pids()
    S.mark("quit", gone and "ACTION quit" in read_log(), "gone=%s" % gone)
    kill_pet()


def copy_diagnostics():
    OUT.mkdir(parents=True, exist_ok=True)
    if LOG.exists():
        shutil.copy(LOG, OUT / "pet.log")
    diag = Path.home() / "Library" / "Logs" / "DiagnosticReports"
    if diag.is_dir():
        copied = 0
        for p in sorted(diag.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True)[:8]:
            if time.time() - p.stat().st_mtime > 1800:
                continue
            if p.suffix.lower() not in (".ips", ".crash", ".spin"):
                continue
            shutil.copy(p, OUT / ("crash-%s" % p.name))
            copied += 1
        S.note("copied crash reports %s" % copied)
    r = run(["sw_vers"])
    (OUT / "sw_vers.txt").write_text((r.stdout or "") + "\n" + (r.stderr or ""), encoding="utf-8")
    uname = run(["uname", "-a"])
    (OUT / "uname.txt").write_text(uname.stdout or "", encoding="utf-8")


def write_summary():
    OUT.mkdir(parents=True, exist_ok=True)
    payload = {
        "runner": LABEL,
        "features": S.features,
        "failures": S.failures,
        "notes": S.notes,
        "input_driver": S.driver,
    }
    (OUT / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# %s" % LABEL, ""]
    for k, v in S.features.items():
        lines.append("- %s: %s" % (k, v))
    if S.failures:
        lines += ["", "## failures"] + ["- " + f for f in S.failures]
    (OUT / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    os.environ["PET_CI"] = "1"
    try:
        ensure_lister()
        structure()
        prepare_desktop()
        opened = launch_open()
        if opened:
            kill_pet()
            time.sleep(0.8)
        alive = launch_direct()
        win = check_placement_and_transparency() if alive else None
        if alive:
            time.sleep(2.0)
            still = bool(pet_pids())
            S.mark("direct_stays_alive", still, "pids=%s" % pet_pids())
            if not still:
                win = None
        else:
            S.mark("direct_stays_alive", False, "never ready")
            win = None
        exercise(win)
    except Exception as e:
        S.note("suite exception: %s" % e)
        S.failures.append("exception %s" % e)
    finally:
        copy_diagnostics()
        write_summary()
        kill_pet()
        stop_backdrop()
    print("RESULT %s" % ("ok" if not S.failures else "failed"), flush=True)
    return 0 if not S.failures else 1


if __name__ == "__main__":
    sys.exit(main())
