/* CQB SIGHT — shared detection, geometry, tracking and drawing core.
 * Used by index.html (live camera) and test/harness.html (static image test).
 * Requires globals: tf (TensorFlow.js) and cocoSsd (COCO-SSD) from jsDelivr. */
(function (global) {
  'use strict';

  var COLORS = { person: '#9ACD32', pet: '#00E5FF', target: '#C6FF3D', bg: 'rgba(0,0,0,0.72)' };
  // COCO animal classes (COCO-SSD label strings)
  var ANIMALS = { bird: 1, cat: 1, dog: 1, horse: 1, sheep: 1, cow: 1, elephant: 1, bear: 1, zebra: 1, giraffe: 1 };

  var model = null, modelBase = null, loading = null;
  var scratch = null, scratchCtx = null;

  function setStatus(cb, s) { try { cb && cb(s); } catch (e) {} }

  async function initBackend(onStatus) {
    if (tf.getBackend && tf.getBackend() && tf.getBackend() !== 'cpu') return tf.getBackend();
    try {
      setStatus(onStatus, 'INIT WEBGL');
      var ok = await tf.setBackend('webgl');
      if (!ok) throw new Error('webgl unavailable');
      await tf.ready();
    } catch (e) {
      console.warn('WebGL backend failed, trying WASM', e);
      setStatus(onStatus, 'WEBGL FAIL → WASM');
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/tf-backend-wasm.min.js');
        tf.wasm.setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');
        await tf.setBackend('wasm'); await tf.ready();
      } catch (e2) {
        console.warn('WASM failed, using CPU', e2);
        await tf.setBackend('cpu'); await tf.ready();
      }
    }
    return tf.getBackend();
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /** Load (or switch) the COCO-SSD model. base: 'lite_mobilenet_v2' | 'mobilenet_v2' */
  async function loadModel(base, onStatus) {
    base = base || 'lite_mobilenet_v2';
    if (model && modelBase === base) return model;
    if (loading) { try { await loading; } catch (e) {} if (model && modelBase === base) return model; }
    loading = (async function () {
      var backend = await initBackend(onStatus);
      setStatus(onStatus, 'LOADING ' + label(base));
      var m = await cocoSsd.load({ base: base });
      // Warm-up pass so the first real frame isn't slow (shader compile)
      setStatus(onStatus, 'WARMING UP');
      var c = document.createElement('canvas'); c.width = 320; c.height = 240;
      await m.detect(c, 5, 0.9);
      if (model) { try { model.dispose(); } catch (e) {} }
      model = m; modelBase = base;
      setStatus(onStatus, 'READY · ' + label(base) + ' · ' + backend.toUpperCase());
      return m;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function label(base) { return base === 'mobilenet_v2' ? 'ACCURATE' : 'FAST'; }

  /**
   * Run detection on a source (video/img/canvas) of intrinsic size srcW x srcH.
   * The frame is downscaled so its long side is <= longSide before inference.
   * Returns detections in SOURCE pixel coordinates.
   */
  async function detect(source, srcW, srcH, opts) {
    if (!model || !srcW || !srcH) return [];
    opts = opts || {};
    var longSide = opts.longSide || 300; // SSD graph resizes to 300x300 internally
    var k = Math.min(1, longSide / Math.max(srcW, srcH));
    var dw = Math.max(1, Math.round(srcW * k)), dh = Math.max(1, Math.round(srcH * k));
    if (!scratch) { scratch = document.createElement('canvas'); scratchCtx = scratch.getContext('2d', { willReadFrequently: false }); }
    if (scratch.width !== dw || scratch.height !== dh) { scratch.width = dw; scratch.height = dh; }
    // ~4x downscale from 720p: high-quality filtering avoids aliasing that hurts small/far targets
    scratchCtx.imageSmoothingEnabled = true; scratchCtx.imageSmoothingQuality = opts.smoothing || 'high';
    scratchCtx.drawImage(source, 0, 0, dw, dh);
    // model.detect handles tensor creation + disposal internally (tf.tidy + explicit dispose)
    var minP = opts.minScore != null ? opts.minScore : 0.5;
    var minA = opts.petMinScore != null ? opts.petMinScore : minP;
    var floor = opts.pets === false ? minP : Math.min(minP, minA);
    var raw = await model.detect(scratch, opts.maxBoxes || 20, floor);
    var inv = 1 / k, out = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i], cls = r['class'];
      var kind = cls === 'person' ? 'person' : (ANIMALS[cls] ? 'pet' : null);
      if (!kind) continue;
      if (kind === 'pet' && (opts.pets === false || r.score < minA)) continue;
      if (kind === 'person' && r.score < minP) continue;
      out.push({ kind: kind, cls: cls, score: r.score,
        x: r.bbox[0] * inv, y: r.bbox[1] * inv, w: r.bbox[2] * inv, h: r.bbox[3] * inv });
    }
    return out;
  }

  /** Mapping from source pixels to element CSS pixels for object-fit: cover */
  function coverTransform(srcW, srcH, viewW, viewH) {
    var s = Math.max(viewW / srcW, viewH / srcH);
    return { s: s, ox: (viewW - srcW * s) / 2, oy: (viewH - srcH * s) / 2 };
  }
  function containTransform(srcW, srcH, viewW, viewH) {
    var s = Math.min(viewW / srcW, viewH / srcH);
    return { s: s, ox: (viewW - srcW * s) / 2, oy: (viewH - srcH * s) / 2 };
  }
  function toView(b, t) { return { x: b.x * t.s + t.ox, y: b.y * t.s + t.oy, w: b.w * t.s, h: b.h * t.s }; }
  function visibleFrac(vb, W, H) {
    var x1 = Math.max(0, vb.x), y1 = Math.max(0, vb.y), x2 = Math.min(W, vb.x + vb.w), y2 = Math.min(H, vb.y + vb.h);
    var a = vb.w * vb.h; return a > 0 ? Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / a : 0;
  }
  function contains(b, px, py) { return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; }

  function iou(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    var x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    var u = a.w * a.h + b.w * b.h - inter;
    return u > 0 ? inter / u : 0;
  }

  /**
   * Simple IoU + centroid tracker. Boxes in source coords.
   * A track is "confirmed" after minHits detections (filters 1-frame flicker);
   * firstSeen is the timestamp of its first raw detection.
   */
  function Tracker(opts) {
    opts = opts || {};
    this.iouThresh = opts.iouThresh || 0.25;
    this.centroidFrac = opts.centroidFrac || 0.35; // of the track box diagonal
    this.maxAgeMs = opts.maxAgeMs || 1500;
    this.minHits = opts.minHits || 2;
    this.reset();
  }
  Tracker.prototype.reset = function () { this.tracks = []; this.nextId = { person: 1, pet: 1 }; this.allConfirmed = []; };
  Tracker.prototype.update = function (dets, now) {
    var self = this, newlyConfirmed = [];
    var live = this.tracks;
    // candidate pairs
    var pairs = [];
    for (var d = 0; d < dets.length; d++) {
      for (var t = 0; t < live.length; t++) {
        var tr = live[t], det = dets[d];
        if (tr.kind !== det.kind) continue;
        var ov = iou(tr.box, det);
        var cx1 = tr.box.x + tr.box.w / 2, cy1 = tr.box.y + tr.box.h / 2;
        var cx2 = det.x + det.w / 2, cy2 = det.y + det.h / 2;
        var dist = Math.hypot(cx1 - cx2, cy1 - cy2), diag = Math.hypot(tr.box.w, tr.box.h);
        var age = now - tr.lastSeen;
        var cOk = dist < diag * self.centroidFrac * (1 + Math.min(age, 1000) / 1000);
        if (ov >= self.iouThresh || cOk) pairs.push({ d: d, t: t, score: ov + (cOk ? 0.5 * (1 - dist / (diag + 1e-6)) : 0) });
      }
    }
    pairs.sort(function (a, b) { return b.score - a.score; });
    var usedD = {}, usedT = {};
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (usedD[p.d] || usedT[p.t]) continue;
      usedD[p.d] = usedT[p.t] = true;
      var tr2 = live[p.t], det2 = dets[p.d];
      // smooth box a little
      var a = 0.6;
      tr2.box = { x: tr2.box.x * (1 - a) + det2.x * a, y: tr2.box.y * (1 - a) + det2.y * a,
                  w: tr2.box.w * (1 - a) + det2.w * a, h: tr2.box.h * (1 - a) + det2.h * a };
      tr2.votes[det2.cls] = (tr2.votes[det2.cls] || 0) + det2.score;
      tr2.score = det2.score; tr2.cls = argmax(tr2.votes); tr2.lastSeen = now; tr2.hits++; tr2.visible = true;
      if (!tr2.confirmed && tr2.hits >= self.minHits) {
        tr2.confirmed = true; tr2.id = self.nextId[tr2.kind]++; newlyConfirmed.push(tr2); self.allConfirmed.push(tr2);
      }
    }
    for (var t3 = 0; t3 < live.length; t3++) if (!usedT[t3]) live[t3].visible = false;
    for (var d2 = 0; d2 < dets.length; d2++) {
      if (usedD[d2]) continue;
      var det3 = dets[d2];
      var nt = { id: null, kind: det3.kind, cls: det3.cls, score: det3.score, box: { x: det3.x, y: det3.y, w: det3.w, h: det3.h },
                 firstSeen: now, lastSeen: now, hits: 1, votes: {}, confirmed: false, visible: true, reticleAt: null };
      nt.votes[det3.cls] = det3.score;
      if (self.minHits <= 1) { nt.confirmed = true; nt.id = self.nextId[nt.kind]++; newlyConfirmed.push(nt); self.allConfirmed.push(nt); }
      live.push(nt);
    }
    this.tracks = live.filter(function (t) { return now - t.lastSeen <= (t.confirmed ? self.maxAgeMs : 400); });
    return newlyConfirmed;
  };
  Tracker.prototype.visible = function () { return this.tracks.filter(function (t) { return t.confirmed && t.visible; }); };

  function argmax(o) { var best = null, bv = -1; for (var k in o) if (o[k] > bv) { bv = o[k]; best = k; } return best; }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /** Draw one labeled box (view coords). */
  function drawBox(ctx, vb, item, onTarget, scale, opts) {
    scale = scale || 1;
    var col = item.kind === 'person' ? (onTarget ? COLORS.target : COLORS.person) : COLORS.pet;
    var lw = (onTarget ? 4 : 2) * scale;
    ctx.save();
    if (onTarget) { ctx.fillStyle = 'rgba(154,205,50,0.18)'; ctx.fillRect(vb.x, vb.y, vb.w, vb.h); }
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.strokeRect(vb.x, vb.y, vb.w, vb.h);
    // corner brackets for a sight-like look
    var c = Math.min(vb.w, vb.h) * 0.18; ctx.lineWidth = lw + 2 * scale; ctx.beginPath();
    ctx.moveTo(vb.x, vb.y + c); ctx.lineTo(vb.x, vb.y); ctx.lineTo(vb.x + c, vb.y);
    ctx.moveTo(vb.x + vb.w - c, vb.y); ctx.lineTo(vb.x + vb.w, vb.y); ctx.lineTo(vb.x + vb.w, vb.y + c);
    ctx.moveTo(vb.x + vb.w, vb.y + vb.h - c); ctx.lineTo(vb.x + vb.w, vb.y + vb.h); ctx.lineTo(vb.x + vb.w - c, vb.y + vb.h);
    ctx.moveTo(vb.x + c, vb.y + vb.h); ctx.lineTo(vb.x, vb.y + vb.h); ctx.lineTo(vb.x, vb.y + vb.h - c);
    ctx.stroke();
    var name = item.kind === 'person' ? 'PERSON' : 'PET · ' + item.cls.toUpperCase();
    var txt = name + (item.id ? ' #' + item.id : '') + '  ' + Math.round(item.score * 100) + '%' + (onTarget ? '  ◉ ON TARGET' : '');
    var fs = Math.round(13 * scale);
    ctx.font = '700 ' + fs + 'px ui-monospace, "SF Mono", Menlo, monospace';
    var tw = ctx.measureText(txt).width + 10 * scale, th = fs + 8 * scale;
    // keep the label on-screen even when the box extends past the view edges (close targets)
    var VW = ctx.canvas.clientWidth || ctx.canvas.width, VH = ctx.canvas.clientHeight || ctx.canvas.height;
    var minY = (opts && opts.minY) || 0, maxY = VH - ((opts && opts.maxYPad) || 0);
    var ty = vb.y - th - 2 * scale;
    if (ty < minY) ty = Math.max(minY, vb.y + 2 * scale);
    if (ty + th > maxY) ty = maxY - th;
    var tx = Math.min(Math.max(vb.x, 4), Math.max(4, VW - tw - 4));
    ctx.fillStyle = onTarget ? col : COLORS.bg; roundRect(ctx, tx, ty, tw, th, 3 * scale); ctx.fill();
    ctx.fillStyle = onTarget ? '#000' : col; ctx.textBaseline = 'middle';
    ctx.fillText(txt, tx + 5 * scale, ty + th / 2 + 0.5);
    ctx.restore();
  }

  function drawReticle(ctx, cx, cy, onTarget, scale) {
    scale = scale || 1;
    var col = onTarget ? '#FF3B30' : COLORS.person, r = 26 * scale, g = 7 * scale, L = 46 * scale;
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2 * scale;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3 * scale;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - L, cy); ctx.lineTo(cx - g, cy); ctx.moveTo(cx + g, cy); ctx.lineTo(cx + L, cy);
    ctx.moveTo(cx, cy - L); ctx.lineTo(cx, cy - g); ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + L);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 2.2 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  global.CQB = {
    COLORS: COLORS, ANIMALS: ANIMALS,
    loadModel: loadModel, detect: detect,
    getModelBase: function () { return modelBase; }, isReady: function () { return !!model && !loading; },
    coverTransform: coverTransform, containTransform: containTransform, toView: toView, contains: contains, visibleFrac: visibleFrac, iou: iou,
    petThreshold: function (t) { return Math.max(0.25, Math.round((t - 0.15) * 100) / 100); },
    Tracker: Tracker, drawBox: drawBox, drawReticle: drawReticle
  };
})(window);
