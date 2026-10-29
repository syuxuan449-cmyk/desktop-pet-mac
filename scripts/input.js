// CI input helper. Run with:
//   /usr/bin/osascript -l JavaScript scripts/input.js <command> [args...]
// Commands: windows | click x y | dclick x y | rclick x y | drag x1 y1 x2 y2 | key esc | key cmd-q
// `windows` prints one JSON object to stdout. osascript is pre-authorized for
// accessibility and AppleEvents on GitHub-hosted macOS runners.

ObjC.import('Cocoa');
ObjC.import('CoreGraphics');

function stdout(s) {
  var data = $.NSString.alloc.initWithString(String(s)).dataUsingEncoding(4);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function sleep(sec) { $.NSThread.sleepForTimeInterval(sec); }

function argList() {
  var args = $.NSProcessInfo.processInfo.arguments;
  var list = [];
  var n = Number(args.count);
  for (var i = 0; i < n; i++) {
    var o = args.objectAtIndex(i);
    list.push(String(o.js !== undefined ? o.js : o));
  }
  var idx = 0;
  for (var j = 0; j < list.length; j++) {
    if (list[j].indexOf('input.js') !== -1) idx = j;
  }
  return list.slice(idx + 1);
}

function numOf(dict, key) {
  if (!dict || dict.isNil()) return 0;
  var v = dict.objectForKey(key);
  if (!v || v.isNil()) return 0;
  return Number(v);
}

function strOf(dict, key) {
  if (!dict || dict.isNil()) return '';
  var v = dict.objectForKey(key);
  if (!v || v.isNil()) return '';
  return String(v.js !== undefined ? v.js : v);
}

function windows() {
  var arr = [];
  // CGWindowList from a second osascript often returns nothing without the
  // screen-recording TCC grant. System Events is allowed for /usr/bin/osascript
  // on GitHub-hosted runners and reports global top-left window frames.
  try {
    var se = Application('System Events');
    var procs = se.processes();
    for (var i = 0; i < procs.length; i++) {
      var proc = procs[i];
      var owner = '';
      try { owner = String(proc.name()); } catch (e) { continue; }
      if (owner !== 'osascript' && owner !== 'DesktopPet' && owner.indexOf('桌面') !== 0) continue;
      var wins = [];
      try { wins = proc.windows(); } catch (e2) { continue; }
      for (var j = 0; j < wins.length; j++) {
        var w = wins[j];
        var pos = [0, 0], sz = [0, 0], title = '';
        try { pos = w.position(); } catch (e3) {}
        try { sz = w.size(); } catch (e4) {}
        try { title = String(w.name() || ''); } catch (e5) {}
        arr.push({
          id: 0,
          owner: owner,
          name: title,
          x: Number(pos[0]) || 0,
          y: Number(pos[1]) || 0,
          w: Number(sz[0]) || 0,
          h: Number(sz[1]) || 0,
          layer: 0
        });
      }
    }
  } catch (e) {
    stderr('system events windows ' + e);
  }
  var opts = Number($.kCGWindowListOptionOnScreenOnly) | Number($.kCGWindowListExcludeDesktopElements);
  if (!opts) opts = 1 | 16;
  try {
    var info = $.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID);
    var n = Number(info.count);
    for (var k = 0; k < n; k++) {
      var d = info.objectAtIndex(k);
      var b = d.objectForKey('kCGWindowBounds');
      arr.push({
        id: numOf(d, 'kCGWindowNumber'),
        owner: strOf(d, 'kCGWindowOwnerName'),
        name: strOf(d, 'kCGWindowName'),
        x: numOf(b, 'X'),
        y: numOf(b, 'Y'),
        w: numOf(b, 'Width'),
        h: numOf(b, 'Height'),
        layer: numOf(d, 'kCGWindowLayer')
      });
    }
  } catch (e6) {}
  var screens = [];
  var ss = $.NSScreen.screens;
  var sn = Number(ss.count);
  for (var s = 0; s < sn; s++) {
    var scr = ss.objectAtIndex(s);
    var f = scr.frame;
    var v = scr.visibleFrame;
    screens.push({
      x: Number(f.origin.x), y: Number(f.origin.y),
      w: Number(f.size.width), h: Number(f.size.height),
      vx: Number(v.origin.x), vy: Number(v.origin.y),
      vw: Number(v.size.width), vh: Number(v.size.height),
      scale: Number(scr.backingScaleFactor)
    });
  }
  stdout(JSON.stringify({ windows: arr, screens: screens }) + '\n');
}

function eventSource() {
  return $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
}

function postMouse(type, x, y, button, clicks) {
  var ev = $.CGEventCreateMouseEvent(eventSource(), type, $.CGPointMake(Number(x), Number(y)), button);
  if (clicks) $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clicks);
  $.CGEventPost($.kCGHIDEventTap, ev);
}

var LEFT = 0;
var RIGHT = 1;

function click(x, y, right) {
  var button = right ? RIGHT : LEFT;
  var down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  var up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  postMouse($.kCGEventMouseMoved, x, y, 0, 0);
  sleep(0.06);
  postMouse(down, x, y, button, 1);
  sleep(0.05);
  postMouse(up, x, y, button, 1);
}

function dclick(x, y) {
  postMouse($.kCGEventMouseMoved, x, y, 0, 0);
  sleep(0.04);
  postMouse($.kCGEventLeftMouseDown, x, y, LEFT, 1);
  sleep(0.03);
  postMouse($.kCGEventLeftMouseUp, x, y, LEFT, 1);
  sleep(0.06);
  postMouse($.kCGEventLeftMouseDown, x, y, LEFT, 2);
  sleep(0.03);
  postMouse($.kCGEventLeftMouseUp, x, y, LEFT, 2);
}

function drag(x1, y1, x2, y2) {
  postMouse($.kCGEventMouseMoved, x1, y1, 0, 0);
  sleep(0.06);
  postMouse($.kCGEventLeftMouseDown, x1, y1, LEFT, 1);
  sleep(0.08);
  var steps = 14;
  for (var i = 1; i <= steps; i++) {
    var x = Number(x1) + (Number(x2) - Number(x1)) * i / steps;
    var y = Number(y1) + (Number(y2) - Number(y1)) * i / steps;
    postMouse($.kCGEventLeftMouseDragged, x, y, LEFT, 0);
    sleep(0.02);
  }
  sleep(0.05);
  postMouse($.kCGEventLeftMouseUp, x2, y2, LEFT, 1);
}

function keyTap(code, flags) {
  var source = eventSource();
  var down = $.CGEventCreateKeyboardEvent(source, code, true);
  var up = $.CGEventCreateKeyboardEvent(source, code, false);
  if (flags) {
    $.CGEventSetFlags(down, flags);
    $.CGEventSetFlags(up, flags);
  }
  $.CGEventPost($.kCGHIDEventTap, down);
  sleep(0.05);
  $.CGEventPost($.kCGHIDEventTap, up);
}

function main() {
  var a = argList();
  var cmd = a[0] || 'windows';
  if (cmd === 'windows') windows();
  else if (cmd === 'click') click(a[1], a[2], false);
  else if (cmd === 'rclick') click(a[1], a[2], true);
  else if (cmd === 'dclick') dclick(a[1], a[2]);
  else if (cmd === 'drag') drag(a[1], a[2], a[3], a[4]);
  else if (cmd === 'key' && a[1] === 'esc') keyTap(53, 0);
  else if (cmd === 'key' && a[1] === 'cmd-q') keyTap(12, 1 << 20);
  else {
    stderr('unknown command ' + cmd);
    $.NSApplication.sharedApplication; // keep import used
    throw new Error('unknown command ' + cmd);
  }
}

function stderr(s) {
  var data = $.NSString.alloc.initWithString(String(s) + '\n').dataUsingEncoding(4);
  $.NSFileHandle.fileHandleWithStandardError.writeData(data);
}

try { main(); } catch (e) { stderr(String(e)); throw e; }
