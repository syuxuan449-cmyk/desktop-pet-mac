// 桌面小伙伴 v4 · macOS 版
// 运行方式：/usr/bin/osascript -l JavaScript pet.js <Resources 目录>
// 使用 macOS 自带的 JavaScript for Automation (JXA) + Cocoa 桥接，无需 Xcode / 编译器。
// 逻辑逐条移植自 Windows 版 DesktopPet.ps1。

ObjC.import('Cocoa');
try { ObjC.import('QuartzCore'); } catch (e) {}

var WIN_W = 205, WIN_H = 285;
var IMG_AREA = { x: 8, y: 42, w: WIN_W - 16, h: WIN_H - 42 - 37 }; // Grid Margin="8,42,8,37"
var CMD_MASK = 1 << 20;

var S = {
  resDir: '',
  assetDir: '',
  imageCache: {},
  affection: 0,
  isSleeping: false,
  isDancing: false,
  isAngry: false,
  quitRequested: false,
  spankCooldownUntil: 0,
  pointerDown: false,
  dragStarted: false,
  suppressClick: false,
  downScreen: null,
  downWinOrigin: null,
  toolbarVisible: true,
  bubbleVisible: false,
  timers: {},
  hearts: [],
  angerLayers: [],
  imgRect: null
};

var UI = {};

function log(msg) {
  var line = '[桌面小伙伴] ' + msg;
  try { console.log(line); } catch (e) {}
  try {
    var path = $.NSHomeDirectory().js + '/Library/Logs/桌面小伙伴.log';
    var data = $.NSString.alloc.initWithString(line + '\n').dataUsingEncoding(4);
    var fh = $.NSFileHandle.fileHandleForWritingAtPath(path);
    if (!fh || fh.isNil()) {
      $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(path, data, null);
    } else {
      fh.seekToEndOfFile;
      fh.writeData(data);
      fh.synchronizeFile;
      fh.closeFile;
    }
  } catch (e) {}
}

function logDiag(tag) {
  try {
    var host = UI.petHost.layer;
    var fr = UI.window.frame;
    var o = fr.origin, sz = fr.size;
    var r = S.imgRect;
    var scr = UI.window.screen;
    if (!scr || scr.isNil()) scr = $.NSScreen.mainScreen;
    var sf = scr.frame, vf = scr.visibleFrame;
    log('DIAG ' + tag
      + ' viewFlipped=' + (!!UI.view.isFlipped)
      + ' geomFlip=' + (!!host.isGeometryFlipped)
      + ' contentsFlip=' + (!!host.contentsAreFlipped)
      + ' win=' + o.x.toFixed(1) + ',' + o.y.toFixed(1) + ' ' + sz.width.toFixed(1) + 'x' + sz.height.toFixed(1)
      + ' screen=' + sf.origin.x.toFixed(1) + ',' + sf.origin.y.toFixed(1) + ' ' + sf.size.width.toFixed(1) + 'x' + sf.size.height.toFixed(1)
      + ' visible=' + vf.origin.x.toFixed(1) + ',' + vf.origin.y.toFixed(1) + ' ' + vf.size.width.toFixed(1) + 'x' + vf.size.height.toFixed(1)
      + ' img=' + (r ? (r.x.toFixed(1) + ',' + r.y.toFixed(1) + ' ' + r.w.toFixed(1) + 'x' + r.h.toFixed(1)) : 'null')
      + ' scale=' + UI.scale
      + ' fallback=' + (!!UI.fallback.isHidden ? 'hidden' : 'SHOWN'));
  } catch (e) { log('DIAG fail ' + tag + ' ' + e); }
}

function safe(name, fn) {
  return function (a) {
    try { return fn(a); } catch (e) { log(name + ' 出错: ' + e + (e && e.stack ? '\n' + e.stack : '')); }
  };
}

function rnd(min, max) { // 与 PowerShell Get-Random -Minimum -Maximum 一致：[min, max)
  return Math.floor(min + Math.random() * (max - min));
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function rgba(r, g, b, a) {
  return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, a === undefined ? 1 : a / 255);
}
function num(v) { return $.NSNumber.numberWithDouble(v); }
function rect(x, y, w, h) { return $.NSMakeRect(x, y, w, h); }

function font(size, weight) {
  try { return $.NSFont.systemFontOfSizeWeight(size, weight || 0); }
  catch (e) { return weight >= 0.3 ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.systemFontOfSize(size); }
}

function attr(text, fnt, color, centered) {
  // initWithString:attributes: is not exported by the JXA bridge on Sequoia
  // ("initWithStringAttributes is not a function"), so build the string with
  // addAttribute:value:range: instead.
  var s = $.NSMutableAttributedString.alloc.initWithString(String(text));
  var len = Number(s.length);
  var range = $.NSMakeRange(0, len);
  function add(key, val) {
    if (!val) return;
    s.addAttributeValueRange(key, val, range);
  }
  add($.NSFontAttributeName, fnt);
  add($.NSForegroundColorAttributeName, color);
  if (centered) {
    var p = $.NSMutableParagraphStyle.alloc.init;
    var align = 2; // macOS NSTextAlignmentCenter / NSCenterTextAlignment
    try {
      if ($.NSTextAlignmentCenter !== undefined && $.NSTextAlignmentCenter !== null) {
        align = Number($.NSTextAlignmentCenter);
      }
    } catch (e) {}
    p.setAlignment(align);
    add($.NSParagraphStyleAttributeName, p);
  }
  return s;
}

function makeBox(frame, fill, border, borderWidth, radius) {
  var b = $.NSBox.alloc.initWithFrame(frame);
  b.setBoxType(4);       // NSBoxCustom
  b.setTitlePosition(0); // NSNoTitle
  b.setBorderWidth(borderWidth || 0);
  b.setCornerRadius(radius || 0);
  b.setFillColor(fill);
  b.setBorderColor(border || $.NSColor.clearColor);
  b.setContentViewMargins($.NSMakeSize(0, 0));
  return b;
}

function makeLabel(text, fnt, color, wrap) {
  var l = wrap ? $.NSTextField.wrappingLabelWithString(text) : $.NSTextField.labelWithString(text);
  l.setEditable(false);
  l.setSelectable(false);
  l.setBezeled(false);
  l.setDrawsBackground(false);
  l.setFont(fnt);
  l.setTextColor(color);
  l.setAlignment(2);
  return l;
}

function addShadow(view, blur, depth, opacity) {
  view.setWantsLayer(true);
  var sh = $.NSShadow.alloc.init;
  sh.setShadowBlurRadius(blur);
  sh.setShadowOffset($.NSMakeSize(0, -depth));
  sh.setShadowColor($.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, opacity));
  view.setShadow(sh);
}

// 在父视图中按“左上角原点”放置子视图（自动适配父视图是否翻转）
function placeIn(parent, child, x, yTop, w, h) {
  var flipped = false;
  try { flipped = !!parent.isFlipped; } catch (e) {}
  var H = parent.bounds.size.height;
  child.setFrame(rect(x, flipped ? yTop : (H - yTop - h), w, h));
}

// ---------- 图层坐标（自动适配是否翻转） ----------
function layerFlipped(hostLayer) {
  // contentsAreFlipped describes bitmap orientation, not the y axis.
  // Only geometryFlipped swaps the layer's coordinate system.
  try { return !!hostLayer.isGeometryFlipped; } catch (e) { return false; }
}
// 以“左上角为原点、y 向下”的坐标给图层定位
function placeLayer(hostLayer, layer, x, y, w, h) {
  var H = hostLayer.bounds.size.height;
  var yy = layerFlipped(hostLayer) ? y : (H - y - h);
  layer.setFrame(rect(x, yy, w, h));
}
// y 方向位移（WPF 中负数 = 向上）
function dy(hostLayer, v) { return layerFlipped(hostLayer) ? v : -v; }

function noActions(fn) {
  $.CATransaction.begin;
  $.CATransaction.setDisableActions(true);
  try { fn(); } finally { $.CATransaction.commit; }
}

function basicAnim(keyPath, from, to, durMs, autoReverse, forever, timing) {
  var a = $.CABasicAnimation.animationWithKeyPath(keyPath);
  a.setFromValue(num(from));
  a.setToValue(num(to));
  a.setDuration(durMs / 1000);
  if (autoReverse) a.setAutoreverses(true);
  if (forever) a.setRepeatCount(1e9);
  if (timing) a.setTimingFunction($.CAMediaTimingFunction.functionWithName(timing));
  return a;
}

// ---------- 计时器（加入 CommonModes，菜单打开/拖动时也继续计时，和 WPF 一致） ----------
var TIMER_SEL = {
  bubble: 'bubbleTick:', state: 'stateTick:', dance: 'danceTick:',
  angry: 'angryTick:', chatter: 'chatterTick:', cleanup: 'cleanupTick:'
};
function startTimer(name, ms, repeats) {
  stopTimer(name);
  try {
    var t = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(ms / 1000, UI.controller, TIMER_SEL[name], null, !!repeats);
    var mode = $.NSRunLoopCommonModes;
    if (!mode) mode = 'NSRunLoopCommonModes';
    $.NSRunLoop.currentRunLoop.addTimerForMode(t, mode);
    S.timers[name] = t;
    log('TIMER start ' + name + ' ' + ms + 'ms repeats=' + (!!repeats));
  } catch (e) {
    log('TIMER FAIL ' + name + ' ' + e);
  }
}
function stopTimer(name) {
  var t = S.timers[name];
  if (t) { try { t.invalidate; } catch (e) {} }
  S.timers[name] = null;
}
function timerEnabled(name) { return !!S.timers[name]; }

// ---------- 图片 ----------
function getPetImage(stateName) {
  if (S.imageCache.hasOwnProperty(stateName)) return S.imageCache[stateName];
  var path = S.assetDir + '/' + stateName + '.png';
  var img = null;
  try {
    if ($.NSFileManager.defaultManager.fileExistsAtPath(path)) {
      var i = $.NSImage.alloc.initWithContentsOfFile(path);
      if (i && !i.isNil()) img = i;
    }
  } catch (e) { img = null; }
  if (img) S.imageCache[stateName] = img; // 与原版一样只缓存成功加载的图片
  else log('IMAGE missing ' + path);
  return img;
}

function layoutPetLayer() {
  // Stretch="Uniform"：按比例缩放并居中
  var img = getPetImage('idle') || getPetImage('happy');
  var iw = 512, ih = 768;
  if (img) { var sz = img.size; if (sz.width > 0 && sz.height > 0) { iw = sz.width; ih = sz.height; } }
  var scale = Math.min(IMG_AREA.w / iw, IMG_AREA.h / ih);
  var w = iw * scale, h = ih * scale;
  var x = IMG_AREA.x + (IMG_AREA.w - w) / 2, y = IMG_AREA.y + (IMG_AREA.h - h) / 2;
  S.imgRect = { x: x, y: y, w: w, h: h };
  var host = UI.petHost.layer;
  var flipped = layerFlipped(host);
  noActions(function () {
    // RenderTransformOrigin="0.5,0.76"（从上往下 76%）
    UI.petLayer.setAnchorPoint($.NSMakePoint(0.5, flipped ? 0.76 : 0.24));
    placeLayer(host, UI.petLayer, x, y, w, h);
  });
}

function setPetVisual(stateName) {
  var img = getPetImage(stateName);
  noActions(function () {
    if (img) {
      UI.petLayer.setContents(img);
      UI.fallback.setHidden(true);
      log('VISUAL ' + stateName);
    } else {
      UI.petLayer.setContents(null);
      UI.fallbackText.setStringValue('缺少图片：assets/' + stateName + '.png');
      UI.fallback.setHidden(false);
    }
    UI.petLayer.setOpacity(stateName === 'sleeping' ? 0.88 : 1.0);
  });
}

// ---------- 对话气泡 ----------
function showSpeech(message, ms) {
  if (ms === undefined) ms = 1900;
  var bubbleW = 190, padX = 11, padY = 7;
  UI.speechText.setStringValue(message);
  var tw = bubbleW - padX * 2;
  var th = 18;
  try { th = Math.ceil(UI.speechText.cell.cellSizeForBounds(rect(0, 0, tw, 1000)).height); } catch (e) {}
  var bh = Math.max(42, Math.min(70, th + padY * 2));
  UI.bubble.setFrame(rect((WIN_W - bubbleW) / 2, 3, bubbleW, bh));
  var lh = Math.min(th, bh - padY * 2 + 4);
  placeIn(UI.bubble, UI.speechText, padX, (bh - lh) / 2, tw, lh);
  UI.bubble.setHidden(false);
  S.bubbleVisible = true;
  startTimer('bubble', ms, false);
}

// ---------- 好感度 ----------
function updateAffection(amount) {
  S.affection = Math.max(0, S.affection + amount);
  var text = '♥ ' + S.affection;
  UI.statusText.setStringValue(text);
  var tw = 30;
  try { tw = Math.ceil(UI.statusText.cell.cellSizeForBounds(rect(0, 0, 200, 40)).width); } catch (e) {}
  var cw = tw + 14, ch = 22;
  UI.chip.setFrame(rect(7, WIN_H - 40 - ch, cw, ch));
  placeIn(UI.chip, UI.statusText, 7, 3, tw, 16);
  var tip = '当前好感度：' + S.affection + '\n点头部/身体摸摸；点人物最下方约 28% 打屁屁（好感 -2）。';
  try { UI.petHost.setToolTip(tip); UI.chip.setToolTip(tip); } catch (e) {}
}

// ---------- 爱心 / 怒气特效 ----------
function textLayer(text, size, weight, color) {
  // Plain CATextLayer string: the JXA bridge on Sequoia does not export
  // NSAttributedString initializers, and hearts only need a colored glyph.
  var tl = $.CATextLayer.layer;
  tl.setString(String(text));
  tl.setFontSize(size);
  tl.setAlignmentMode('center');
  tl.setContentsScale(UI.scale || 2);
  try {
    var name = String(font(size, weight).fontName || '');
    tl.setFont(name && name.charAt(0) !== '.' ? name : 'PingFangSC-Regular');
  } catch (e) {}
  try { tl.setForegroundColor(color.CGColor); } catch (e) {}
  return tl;
}

function addFloatingHearts(count) {
  if (count === undefined) count = 3;
  var host = UI.fxHost.layer;
  var now = Date.now();
  for (var i = 0; i < count; i++) {
    var size = rnd(21, 34);
    var heart = textLayer('♥', size, 0, rgba(239, 91, 132));
    var w = size * 1.6, h = size * 1.45;
    var rise = -rnd(54, 94);
    var riseMs = rnd(900, 1350);
    var fadeMs = rnd(760, 1040);
    var total = Math.max(riseMs, 260 + fadeMs);

    var a1 = basicAnim('transform.translation.y', 0, dy(host, rise), riseMs, false, false, 'easeOut');
    a1.setFillMode('both');
    var a2 = basicAnim('opacity', 0.96, 0, fadeMs, false, false, null);
    a2.setBeginTime(0.26);
    a2.setFillMode('both');
    var g = $.CAAnimationGroup.animation;
    g.setAnimations($([a1, a2]));
    g.setDuration(total / 1000);

    (function (heart, x, y, w, h, g) {
      noActions(function () {
        placeLayer(host, heart, x, y, w, h);
        heart.setOpacity(0); // 动画结束后保持透明，随后统一清理（不会再触发报错闪退）
        host.addSublayer(heart);
        heart.addAnimationForKey(g, 'float');
      });
    })(heart, rnd(28, 156), rnd(150, 206), w, h, g);
    S.hearts.push({ layer: heart, until: now + total + 120 });
  }
  if (!timerEnabled('cleanup')) startTimer('cleanup', 400, true);
}

function cleanupHearts() {
  var now = Date.now();
  var keep = [];
  for (var i = 0; i < S.hearts.length; i++) {
    var h = S.hearts[i];
    if (now >= h.until) { try { h.layer.removeFromSuperlayer; } catch (e) {} }
    else keep.push(h);
  }
  S.hearts = keep;
  if (!S.hearts.length) stopTimer('cleanup');
}

function clearAngerEffects() {
  for (var i = 0; i < S.angerLayers.length; i++) {
    try { S.angerLayers[i].removeAllAnimations; S.angerLayers[i].removeFromSuperlayer; } catch (e) {}
  }
  S.angerLayers = [];
}

function addAngerEffects() {
  var symbols = ['╬', '!!', '怒'];
  var host = UI.fxHost.layer;
  for (var i = 0; i < 5; i++) {
    var text = symbols[i % symbols.length];
    var size = rnd(20, 31);
    var sym = textLayer(text, size, 0.62, rgba(224, 39, 49));
    var w = size * (text.length > 1 ? 1.6 : 1.4), h = size * 1.4;
    var rise = basicAnim('transform.translation.y', dy(host, 10), dy(host, -rnd(18, 42)), rnd(600, 920), true, true, null);
    var pulse = basicAnim('opacity', 0.35, 1.0, rnd(180, 320), true, true, null);
    (function (sym, x, y, w, h, rise, pulse) {
      noActions(function () {
        placeLayer(host, sym, x, y, w, h);
        sym.setOpacity(0.98);
        host.addSublayer(sym);
        sym.addAnimationForKey(rise, 'rise');
        sym.addAnimationForKey(pulse, 'pulse');
      });
    })(sym, rnd(10, 166), rnd(55, 166), w, h, rise, pulse);
    S.angerLayers.push(sym);
  }
}

// ---------- 人物动画 ----------
var DEG = Math.PI / 180;
function petAnim(key, anim) { UI.petLayer.addAnimationForKey(anim, key); }
function petStop(key) { UI.petLayer.removeAnimationForKey(key); }

function startBreathingAnimation() {
  petAnim('breathX', basicAnim('transform.scale.x', 1.0, 1.018, 1450, true, true, 'easeInEaseOut'));
  petAnim('breathY', basicAnim('transform.scale.y', 0.995, 1.025, 1450, true, true, 'easeInEaseOut'));
}

function scheduleIdle(ms) {
  if (ms === undefined) ms = 1800;
  startTimer('state', ms, false);
}

function setSleepButton(title) {
  S.sleepTitle = title;
  UI.sleepButton.setTitle(title);
  if (UI.sleepLabel) UI.sleepLabel.setStringValue(title);
}

function stopDanceAnimation() {
  stopTimer('dance');
  petStop('jumpY');
  petStop('rot');
  S.isDancing = false;
}

function stopAngerAnimation() {
  stopTimer('angry');
  petStop('shakeX');
  petStop('rot');
  clearAngerEffects();
  S.isAngry = false;
}

function startPetting(area) {
  if (S.isDancing || S.isAngry) return;
  var wasSleeping = S.isSleeping;
  S.isSleeping = false;
  setSleepButton('睡觉');
  updateAffection(1);
  setPetVisual('happy');
  addFloatingHearts(3);
  if (wasSleeping) {
    log('ACTION wake-pet');
    showSpeech('被你叫醒啦…不过摸摸也很开心！', 2200);
  } else if (area === 'head') {
    log('ACTION head');
    showSpeech(pick(['头顶再摸一下～', '嘿嘿，好舒服！', '今天也要开心呀～']), 1800);
  } else {
    log('ACTION body');
    showSpeech(pick(['收到你的抱抱啦！', '我会乖乖陪着你～', '好感度上升中！']), 1800);
  }
  scheduleIdle(1700);
}

function feedPet() {
  if (S.isAngry) { log('ACTION feed-blocked'); showSpeech('哼，我还在生气呢！', 1300); return; }
  log('ACTION feed');
  if (S.isDancing) stopDanceAnimation();
  S.isSleeping = false;
  setSleepButton('睡觉');
  stopTimer('state');
  updateAffection(2);
  setPetVisual('eating');
  addFloatingHearts(2);
  showSpeech(pick(['好吃！谢谢你～', '吃饱就有力气陪你啦！', '这份小零食我很喜欢！']), 2300);
  scheduleIdle(2600);
}

function toggleSleep() {
  if (S.isAngry) { showSpeech('气鼓鼓的，暂时睡不着！', 1400); return; }
  if (S.isDancing) stopDanceAnimation();
  stopTimer('state');
  if (S.isSleeping) {
    log('ACTION wake');
    S.isSleeping = false;
    setSleepButton('睡觉');
    setPetVisual('happy');
    showSpeech('早上好！我醒啦～', 1900);
    scheduleIdle(1500);
  } else {
    log('ACTION sleep');
    S.isSleeping = true;
    setSleepButton('醒来');
    setPetVisual('sleeping');
    showSpeech('晚安… Zzz…', 2200);
  }
}

function startDance() {
  if (S.isDancing || S.isAngry) { log('ACTION dance-blocked'); return; }
  log('ACTION dance');
  S.isSleeping = false;
  setSleepButton('睡觉');
  stopTimer('state');
  S.isDancing = true;
  updateAffection(1);
  setPetVisual('happy');
  addFloatingHearts(5);
  showSpeech('看我跳个小舞！', 1800);
  var host = UI.petHost.layer;
  petAnim('jumpY', basicAnim('transform.translation.y', 0, dy(host, -30), 185, true, true, 'easeOut'));
  petAnim('rot', basicAnim('transform.rotation.z', -7 * DEG, 7 * DEG, 150, true, true, null));
  startTimer('dance', 1550, false);
}

function startSpank() {
  var now = Date.now();
  if (S.isAngry || now < S.spankCooldownUntil) { log('ACTION spank-blocked'); showSpeech('不许连着欺负我！', 1300); return; }
  log('ACTION spank');
  if (S.isDancing) stopDanceAnimation();
  stopTimer('state');
  S.isSleeping = false;
  setSleepButton('睡觉');
  S.isAngry = true;
  S.spankCooldownUntil = now + 2550;
  updateAffection(-2);
  setPetVisual('angry');
  clearAngerEffects();
  addAngerEffects();
  showSpeech(pick(['呀！不许打屁屁！', '哼！我真的生气啦！', '坏蛋！要哄我才行！']), 2250);
  petAnim('shakeX', basicAnim('transform.translation.x', -8, 8, 72, true, true, null));
  petAnim('rot', basicAnim('transform.rotation.z', -5 * DEG, 5 * DEG, 95, true, true, null));
  startTimer('angry', 2300, false);
}

function resetPetPosition(silent) {
  var scr = UI.window.screen;
  if (!scr || scr.isNil()) scr = $.NSScreen.mainScreen;
  var wa = scr.visibleFrame; // 不含菜单栏和程序坞
  var x = Math.max(wa.origin.x, wa.origin.x + wa.size.width - WIN_W - 24);
  var y = wa.origin.y + 18; // Cocoa 原点在左下角
  UI.window.setFrameOrigin($.NSMakePoint(x, y));
  log('ACTION reset x=' + x.toFixed(1) + ' y=' + y.toFixed(1));
  if (!silent) showSpeech('我回到屏幕右下角啦～', 1800);
}

function setToolbarVisible(v) {
  S.toolbarVisible = v;
  UI.toolbar.setHidden(!v);
  for (var i = 0; i < UI.buttons.length; i++) UI.buttons[i].setHidden(!v);
}

function quitPet() {
  S.quitRequested = true;
  log('ACTION quit');
  ['bubble', 'state', 'dance', 'angry', 'chatter', 'cleanup'].forEach(stopTimer);
  try { stopDanceAnimation(); stopAngerAnimation(); } catch (e) {}
  UI.app.terminate(null);
}

function activatePet() {
  try { UI.app.activateIgnoringOtherApps(true); } catch (e) {}
  UI.window.makeKeyAndOrderFront(null);
  UI.window.makeFirstResponder(UI.view);
}

// ---------- 鼠标 ----------
function localPoint(ev) { return UI.view.convertPointFromView(ev.locationInWindow, null); }
function inRect(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
function viewRect(v) { var f = v.frame; return { x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }; }

function onMouseDown(ev) {
  try {
    var lp = localPoint(ev);
    log('EVENT down clicks=' + ev.clickCount + ' x=' + lp.x.toFixed(1) + ' y=' + lp.y.toFixed(1));
  } catch (e) { log('EVENT down ' + e); }
  if (S.isAngry) {
    S.pointerDown = false;
    showSpeech('先让我消消气！', 1200);
    return;
  }
  if (ev.clickCount >= 2) {
    S.suppressClick = true;
    S.pointerDown = false;
    if (S.imgRect && inRect(localPoint(ev), S.imgRect)) startDance();
    return;
  }
  S.pointerDown = true;
  S.dragStarted = false;
  S.suppressClick = false;
  var m = $.NSEvent.mouseLocation;
  S.downScreen = { x: m.x, y: m.y };
  var o = UI.window.frame.origin;
  S.downWinOrigin = { x: o.x, y: o.y };
  activatePet();
}

function onMouseDragged(ev) {
  if (!S.pointerDown && !S.dragStarted) return;
  var m = $.NSEvent.mouseLocation;
  var ddx = m.x - S.downScreen.x, ddy = m.y - S.downScreen.y;
  if (!S.dragStarted && (Math.abs(ddx) > 4 || Math.abs(ddy) > 4)) {
    S.dragStarted = true;
    S.pointerDown = false;
    log('ACTION drag');
  }
  if (S.dragStarted) {
    UI.window.setFrameOrigin($.NSMakePoint(S.downWinOrigin.x + ddx, S.downWinOrigin.y + ddy));
  }
}

function onMouseUp(ev) {
  if (S.pointerDown && !S.dragStarted && !S.suppressClick) {
    var p = localPoint(ev);
    var onUi = (S.toolbarVisible && inRect(p, viewRect(UI.toolbar))) || inRect(p, viewRect(UI.chip));
    var inImg = !!(S.imgRect && inRect(p, S.imgRect));
    log('EVENT up x=' + p.x.toFixed(1) + ' y=' + p.y.toFixed(1) + ' onUi=' + onUi + ' inImg=' + inImg);
    if (!onUi && inImg) {
      var y = p.y - S.imgRect.y, h = S.imgRect.h;
      log('EVENT hit y=' + y.toFixed(1) + ' h=' + h.toFixed(1) + ' frac=' + (h > 0 ? (y / h).toFixed(3) : 'na'));
      if (h > 0 && y >= h * 0.72) startSpank();
      else if (h > 0 && y < h * 0.46) startPetting('head');
      else startPetting('body');
    }
  }
  S.pointerDown = false;
  S.dragStarted = false;
  S.suppressClick = false;
}

function onRightMouseDown(ev) {
  log('ACTION right-menu');
  setToolbarVisible(true);
  activatePet();
  $.NSMenu.popUpContextMenuWithEventForView(UI.menu, ev, UI.view);
}

function onKeyDown(ev) {
  var code = ev.keyCode;
  var flags = ev.modifierFlags;
  var chars = '';
  try { chars = ev.charactersIgnoringModifiers.js || ''; } catch (e) {}
  if (code === 53) { // Esc：只隐藏工具栏/菜单，不退出
    try { UI.menu.cancelTracking; } catch (e) {}
    setToolbarVisible(false);
    log('ACTION toolbar-hide');
    showSpeech('工具栏已隐藏，右键可再次打开菜单。', 2200);
    return;
  }
  if ((flags & CMD_MASK) && (chars === 'q' || chars === 'w')) { // ⌘Q / ⌘W 相当于 Windows 的 Alt+F4
    quitPet();
  }
}

function showMoreMenu() {
  log('ACTION more-menu');
  setToolbarVisible(true);
  activatePet();
  // Placement=Top：菜单出现在“⋯”按钮上方（系统会自动避开屏幕边缘）
  var f = UI.moreButton.frame;
  var mh = 160;
  try { mh = UI.menu.size.height || mh; } catch (e) {}
  // UI.view 是翻转坐标（y 向下），location 为菜单左上角
  UI.app.activateIgnoringOtherApps(true);
  UI.menu.popUpMenuPositioningItemAtLocationInView(null, $.NSMakePoint(f.origin.x, f.origin.y - mh - 4), UI.view);
}

// ---------- Objective-C 子类 ----------
// macOS x86_64 encodes BOOL as signed char ('c'); arm64 encodes it as C bool ('B').
// JXA's 'bool' alias is 'B', so Intel rejects the subclass ("method types do not match").
function hostArch() {
  try {
    var args = $.NSProcessInfo.processInfo.arguments;
    var n = Number(args.count);
    for (var i = 0; i < n; i++) {
      var o = args.objectAtIndex(i);
      var s = String(o.js !== undefined ? o.js : o);
      if (s === 'x86_64' || s === 'arm64' || s === 'i386') return s;
    }
  } catch (e) {}
  try {
    var task = $.NSTask.alloc.init;
    task.setLaunchPath('/usr/bin/uname');
    task.setArguments($(['-m']));
    var pipe = $.NSPipe.pipe;
    task.setStandardOutput(pipe);
    task.launch;
    task.waitUntilExit;
    var data = pipe.fileHandleForReading.readDataToEndOfFile;
    var str = $.NSString.alloc.initWithDataEncoding(data, 4);
    return String(str.js !== undefined ? str.js : str).replace(/\s+/g, '');
  } catch (e2) {
    return 'unknown';
  }
}
var HOST_ARCH = hostArch();
var BOOL_ENC = HOST_ARCH.indexOf('arm') === 0 ? 'B' : 'c';
function objcYes() { return 1; }
try { log('ARCH ' + HOST_ARCH + ' BOOL ' + BOOL_ENC); } catch (e) {}

ObjC.registerSubclass({
  name: 'DPPetWindow',
  superclass: 'NSWindow',
  methods: {
    'canBecomeKeyWindow': { types: [BOOL_ENC, []], implementation: function () { return objcYes(); } },
    'canBecomeMainWindow': { types: [BOOL_ENC, []], implementation: function () { return objcYes(); } }
  }
});

ObjC.registerSubclass({
  name: 'DPButton',
  superclass: 'NSButton',
  methods: {
    'acceptsFirstMouse:': { types: [BOOL_ENC, ['id']], implementation: function (e) { return objcYes(); } }
  }
});

ObjC.registerSubclass({
  name: 'DPPetView',
  superclass: 'NSView',
  methods: {
    'isFlipped': { types: [BOOL_ENC, []], implementation: function () { return objcYes(); } },
    'acceptsFirstResponder': { types: [BOOL_ENC, []], implementation: function () { return objcYes(); } },
    'acceptsFirstMouse:': { types: [BOOL_ENC, ['id']], implementation: function (e) { return objcYes(); } },
    'mouseDown:': { types: ['void', ['id']], implementation: safe('mouseDown', onMouseDown) },
    'mouseDragged:': { types: ['void', ['id']], implementation: safe('mouseDragged', onMouseDragged) },
    'mouseUp:': { types: ['void', ['id']], implementation: safe('mouseUp', onMouseUp) },
    'rightMouseDown:': { types: ['void', ['id']], implementation: safe('rightMouseDown', onRightMouseDown) },
    'keyDown:': { types: ['void', ['id']], implementation: safe('keyDown', onKeyDown) }
  }
});

ObjC.registerSubclass({
  name: 'DPPetController',
  superclass: 'NSObject',
  methods: {
    'feed:': { types: ['void', ['id']], implementation: safe('feed', function () { feedPet(); }) },
    'sleep:': { types: ['void', ['id']], implementation: safe('sleep', function () { toggleSleep(); }) },
    'spank:': { types: ['void', ['id']], implementation: safe('spank', function () { startSpank(); }) },
    'dance:': { types: ['void', ['id']], implementation: safe('dance', function () { startDance(); }) },
    'more:': { types: ['void', ['id']], implementation: safe('more', function () { showMoreMenu(); }) },
    'resetPos:': { types: ['void', ['id']], implementation: safe('reset', function () { resetPetPosition(false); }) },
    'quitPet:': { types: ['void', ['id']], implementation: safe('quit', function () { quitPet(); }) },
    'bubbleTick:': { types: ['void', ['id']], implementation: safe('bubbleTick', function () {
      stopTimer('bubble');
      UI.bubble.setHidden(true);
      S.bubbleVisible = false;
      log('ACTION bubble-hide');
    }) },
    // v4 修复：计时器触发时先检查当前状态，绝不覆盖“睡觉/跳舞/生气”
    'stateTick:': { types: ['void', ['id']], implementation: safe('stateTick', function () {
      stopTimer('state');
      if (!S.isSleeping && !S.isDancing && !S.isAngry) { setPetVisual('idle'); log('ACTION idle'); }
      else log('ACTION idle-skipped');
    }) },
    'danceTick:': { types: ['void', ['id']], implementation: safe('danceTick', function () {
      stopTimer('dance');
      stopDanceAnimation();
      log('ACTION dance-end');
      if (!S.isSleeping && !S.isAngry) setPetVisual('idle');
    }) },
    'angryTick:': { types: ['void', ['id']], implementation: safe('angryTick', function () {
      stopAngerAnimation();
      log('ACTION angry-end');
      if (!S.isSleeping && !S.isDancing) setPetVisual('idle');
    }) },
    'chatterTick:': { types: ['void', ['id']], implementation: safe('chatterTick', function () {
      if (!S.isSleeping && !S.isDancing && !S.isAngry && !timerEnabled('state') && rnd(0, 3) === 0) {
        showSpeech(pick(['我在这里陪你～', '记得喝口水哦。', '休息一下眼睛吧！']), 2600);
      }
    }) },
    'cleanupTick:': { types: ['void', ['id']], implementation: safe('cleanupTick', function () { cleanupHearts(); }) },
    'relayout:': { types: ['void', ['id']], implementation: safe('relayout', function () { layoutPetLayer(); }) }
  }
});

// ---------- 搭建界面 ----------
function makeLayerHost(frame) {
  var v = $.NSView.alloc.initWithFrame(frame);
  var l = $.CALayer.layer;
  l.setGeometryFlipped(false);
  v.setLayer(l);
  v.setWantsLayer(true); // layer-hosting：图层完全由我们控制
  return v;
}

function makeButton(title, sel, x, w, color, fill) {
  var h = 25, y = WIN_H - 4 - 3 - h;
  var bg = makeBox(rect(x, y, w, h), fill, rgba(255, 255, 255, 0x45), 1, 7);
  UI.view.addSubview(bg);
  // Title is an NSTextField. Sequoia's JXA bridge does not export
  // initWithString: / initWithString:attributes:, so attributed button titles crash.
  var lab = makeLabel(title, font(12, 0), color, false);
  lab.setFrame(rect(x, y, w, h));
  UI.view.addSubview(lab);
  var b = $.DPButton.buttonWithTitleTargetAction('', UI.controller, sel);
  b.setBordered(false);
  try { b.setTransparent(true); } catch (e) { log('button transparent ' + e); }
  b.setFrame(rect(x, y, w, h));
  UI.view.addSubview(b);
  UI.buttons.push(bg, lab, b);
  if (title === '睡觉') UI.sleepLabel = lab;
  return b;
}

function buildUI() {
  var app = $.NSApplication.sharedApplication;
  UI.app = app;
  app.setActivationPolicy(1); // Accessory：不在程序坞显示（相当于 ShowInTaskbar=False）

  var win = $.DPPetWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect(0, 0, WIN_W, WIN_H), 0, 2, false);
  win.setOpaque(false);
  win.setBackgroundColor($.NSColor.clearColor);
  win.setHasShadow(false);
  win.setLevel(3); // NSFloatingWindowLevel：总在最前
  win.setCollectionBehavior(1 | 256); // 所有桌面空间可见 + 全屏辅助
  win.setTitle('桌面小伙伴');
  win.setReleasedWhenClosed(false);
  UI.window = win;
  UI.scale = win.backingScaleFactor || 2;
  UI.controller = $.DPPetController.alloc.init;
  UI.buttons = [];

  var view = $.DPPetView.alloc.initWithFrame(rect(0, 0, WIN_W, WIN_H));
  view.setWantsLayer(true);
  win.setContentView(view);
  UI.view = view;

  // 1) 对话气泡（WPF 中位于最底层）
  var bubble = makeBox(rect(7.5, 3, 190, 42), rgba(255, 255, 255, 0xF8), rgba(0xE4, 0x5D, 0x86, 0x28), 1.5, 16);
  addShadow(bubble, 12, 2, 0.24);
  var speech = makeLabel('我在这里～', font(13, 0.3), rgba(0x51, 0x28, 0x3A), true);
  bubble.addSubview(speech);
  bubble.setHidden(true);
  view.addSubview(bubble);
  UI.bubble = bubble; UI.speechText = speech;

  // 2) 人物图片
  var petHost = makeLayerHost(rect(0, 0, WIN_W, WIN_H));
  view.addSubview(petHost);
  UI.petHost = petHost;
  var petLayer = $.CALayer.layer;
  petLayer.setGeometryFlipped(false);
  petLayer.setContentsGravity('resizeAspect');
  petLayer.setContentsScale(UI.scale);
  petHost.layer.addSublayer(petLayer);
  UI.petLayer = petLayer;

  // 缺图提示
  var fb = makeBox(rect((WIN_W - 185) / 2, IMG_AREA.y + (IMG_AREA.h - 205) / 2, 185, 205), rgba(0xFC, 0xEE, 0xF3, 0xDD), rgba(0xE4, 0x5D, 0x86, 0x65), 2, 92);
  var fbHeart = makeLabel('♥', font(58, 0), rgba(0xE4, 0x5D, 0x86), false);
  fb.addSubview(fbHeart); placeIn(fb, fbHeart, 0, 50, 185, 70);
  var fbText = makeLabel('正在准备形象…', font(13, 0), rgba(0x6C, 0x40, 0x50), true);
  fb.addSubview(fbText); placeIn(fb, fbText, 10, 122, 165, 40);
  fb.setHidden(true);
  view.addSubview(fb);
  UI.fallback = fb; UI.fallbackText = fbText;

  // 3) 爱心 / 怒气层
  var fxHost = makeLayerHost(rect(0, 0, WIN_W, WIN_H));
  view.addSubview(fxHost);
  UI.fxHost = fxHost;

  // 4) 好感度标签
  var chip = makeBox(rect(7, WIN_H - 62, 40, 22), rgba(0x32, 0x26, 0x38, 0xD9), null, 0, 11);
  var st = makeLabel('♥ 0', font(12, 0.4), $.NSColor.whiteColor, false);
  chip.addSubview(st);
  view.addSubview(chip);
  UI.chip = chip; UI.statusText = st;

  // 5) 底部工具栏
  var tbW = 4 + 45 + 45 + 53 + 30 + 4, tbH = 3 + 25 + 3;
  var tbX = Math.round((WIN_W - tbW) / 2), tbY = WIN_H - 4 - tbH;
  var toolbar = makeBox(rect(tbX, tbY, tbW, tbH), rgba(0x40, 0x33, 0x49, 0xE6), null, 0, 16);
  addShadow(toolbar, 9, 1, 0.28);
  view.addSubview(toolbar);
  UI.toolbar = toolbar;
  var bx = tbX + 4 + 1;
  var pink = rgba(0xFF, 0xF4, 0xF7), dark = rgba(0x5C, 0x30, 0x42);
  UI.feedButton = makeButton('喂食', 'feed:', bx, 43, dark, pink); bx += 45;
  UI.sleepButton = makeButton('睡觉', 'sleep:', bx, 43, dark, pink); bx += 45;
  UI.spankButton = makeButton('打屁屁', 'spank:', bx, 51, rgba(0x7B, 0x27, 0x30), rgba(0xFF, 0xF0, 0xF1)); bx += 53;
  UI.moreButton = makeButton('⋯', 'more:', bx, 28, dark, pink);
  UI.feedButton.setToolTip('喂一份小零食');
  UI.sleepButton.setToolTip('让小伙伴休息 / 醒来');
  UI.spankButton.setToolTip('调皮地打一下，会生气并扣 2 点好感');
  UI.moreButton.setToolTip('更多功能');

  // 右键菜单
  var menu = $.NSMenu.alloc.initWithTitle('桌面小伙伴');
  menu.setAutoenablesItems(false);
  function item(title, sel) {
    var it = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, sel, '');
    it.setTarget(UI.controller);
    it.setEnabled(true);
    menu.addItem(it);
    return it;
  }
  item('喂食（好感 +2）', 'feed:');
  item('睡觉 / 醒来', 'sleep:');
  item('打屁屁（好感 -2）', 'spank:');
  item('跳个舞', 'dance:');
  menu.addItem($.NSMenuItem.separatorItem);
  item('回到屏幕右下角', 'resetPos:');
  menu.addItem($.NSMenuItem.separatorItem);
  item('退出桌宠', 'quitPet:');
  UI.menu = menu;
  log('UI built');
}

function run(argv) {
  try {
    log('ACTION startup');
    S.resDir = (argv && argv.length && argv[0]) ? argv[0] : '.';
    S.assetDir = S.resDir + '/assets';
    buildUI();

    layoutPetLayer();
    setPetVisual('idle');
    updateAffection(0);
    resetPetPosition(true);

    UI.window.makeKeyAndOrderFront(null);
    activatePet();
    // 窗口真正显示后再按实际图层坐标系校准一次
    layoutPetLayer();
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.15, UI.controller, 'relayout:', null, false);

    startBreathingAnimation();
    startTimer('chatter', 18000, true);
    showSpeech('我来陪你啦！摸摸我，或点下方试试～', 3000);
    log('已启动，素材目录：' + S.assetDir);
    logDiag('ready');
    log('ACTION ready');

    UI.app.run;
    log('ACTION run-returned');
    // osascript sometimes returns from NSApplication.run immediately.
    // Keep draining events so timers and clicks still run.
    if (!S.quitRequested) {
      log('ACTION manual-runloop');
      var mask = -1;
      try { if ($.NSEventMaskAny) mask = $.NSEventMaskAny; } catch (e) {}
      var loopMode = $.NSDefaultRunLoopMode || 'NSDefaultRunLoopMode';
      while (!S.quitRequested) {
        var ev = UI.app.nextEventMatchingMaskUntilDateInModeDequeue(
          mask, $.NSDate.dateWithTimeIntervalSinceNow(0.25), loopMode, true);
        if (ev && !ev.isNil()) UI.app.sendEvent(ev);
        UI.app.updateWindows;
      }
    }
  } catch (e) {
    log('启动失败: ' + e + (e && e.stack ? '\n' + e.stack : ''));
    try {
      var env = $.NSProcessInfo.processInfo.environment;
      var ci = env ? env.objectForKey('PET_CI') : null;
      if (ci && !ci.isNil()) return;
      var app = Application.currentApplication();
      app.includeStandardAdditions = true;
      app.displayAlert('桌面小伙伴启动失败', { message: String(e) });
    } catch (e2) {}
  }
}
