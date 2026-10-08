/* NEWTON · CQB SIGHT — live camera app */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var video = $('cam'), canvas = $('overlay'), ctx = canvas.getContext('2d');
  var LS_SETTINGS = 'cqbSight.settings.v2', LS_RUNS = 'cqbSight.runs.v1';

  // ---------- settings ----------
  var DEFAULTS = { threshold: 0.5, pets: true, sound: true, model: 'lite_mobilenet_v2', res: 300, debug: false };
  var settings = Object.assign({}, DEFAULTS);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch (e) {}
  function saveSettings() { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) {} }

  // ---------- state ----------
  var stream = null, started = false, busy = false, lastDets = [];
  var tracker = new CQB.Tracker({ minHits: 2, maxAgeMs: 1500 });
  var detFps = 0, lastDetT = 0, viewW = 0, viewH = 0, dpr = 1;
  var run = null; // {start, events, ...}
  var audioCtx = null, wakeLock = null, debugEl = null;
  var onTargetId = null;

  // ---------- status ----------
  function setStatus(s, isErr) {
    $('status').textContent = 'MODEL: ' + s; $('status').classList.toggle('err', !!isErr);
    $('splash-status').textContent = s;
  }

  // ---------- model ----------
  function loadModel() {
    $('btn-run').disabled = true;
    return CQB.loadModel(settings.model, setStatus).then(function () {
      $('btn-run').disabled = !started;
      $('btn-start').disabled = false;
    }).catch(function (e) {
      console.error(e); setStatus('LOAD FAILED · ' + (e && e.message || e), true);
      $('btn-start').disabled = false;
    });
  }

  // ---------- camera ----------
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(location.protocol !== 'https:' ? 'Camera needs HTTPS' : 'getUserMedia not supported');
    }
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', ''); video.muted = true;
    await new Promise(function (res) { if (video.readyState >= 1) res(); else video.onloadedmetadata = function () { res(); }; });
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', function () { if (!document.hidden) restartCamera(); });
  }
  var restarting = false;
  function restartCamera() {
    if (restarting || !started) return; restarting = true;
    startCamera().catch(function (e) { setStatus('CAMERA LOST · TAP START', true); showSplash(true); })
      .finally(function () { restarting = false; });
  }

  // ---------- wake lock ----------
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (e) { console.warn('wakeLock failed', e); }
    // Fallback / belt-and-braces (older iOS & home-screen apps before iOS 18.4): looping muted inline video
    try { await $('nosleep').play(); } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && started) {
      if (!wakeLock) keepAwake();
      var t = stream && stream.getVideoTracks()[0];
      if (!t || t.readyState === 'ended' || video.paused) {
        if (t && t.readyState !== 'ended') video.play().catch(restartCamera); else restartCamera();
      }
    }
  });

  // ---------- audio cue ----------
  function initAudio() {
    try {
      // Safari 17+: let the beep play even with the ring/silent switch on
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) {}
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audioCtx) audioCtx = new AC();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      // unlock with a silent buffer inside the user gesture
      if (audioCtx) { var b = audioCtx.createBuffer(1, 1, 22050), s = audioCtx.createBufferSource(); s.buffer = b; s.connect(audioCtx.destination); s.start(0); }
    } catch (e) { console.warn(e); }
  }
  function beep(freq, dur, when) {
    if (!audioCtx) return;
    var t0 = audioCtx.currentTime + (when || 0);
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function cuePerson() {
    if (!settings.sound) return;
    beep(1760, 0.07, 0); beep(2350, 0.07, 0.09);
    if (navigator.vibrate) try { navigator.vibrate(40); } catch (e) {}
  }

  // ---------- layout ----------
  function resize() {
    var r = $('stage').getBoundingClientRect();
    viewW = r.width; viewH = r.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewW * dpr); canvas.height = Math.round(viewH * dpr);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 250); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

  // ---------- run / drill ----------
  function fmt(ms) {
    if (ms == null || isNaN(ms)) return '--';
    var s = ms / 1000, m = Math.floor(s / 60); s = s - m * 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  function fmtS(ms) { return ms == null ? '—' : (ms / 1000).toFixed(2) + 's'; }
  function logEvent(text, cls) {
    var li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls;
    var ol = $('eventlog'); ol.insertBefore(li, ol.firstChild);
    while (ol.children.length > 5) ol.removeChild(ol.lastChild);
  }
  function startRun() {
    tracker.reset(); onTargetId = null;
    run = { start: performance.now(), startedAt: new Date().toISOString() };
    $('eventlog').innerHTML = '';
    $('btn-run').textContent = 'STOP'; $('btn-run').classList.add('live'); $('timer').classList.add('live');
    logEvent('T+0.00 RUN START');
    beep(880, 0.12, 0);
  }
  function stopRun() {
    var now = performance.now(), dur = now - run.start;
    var people = [], pets = [];
    tracker.allConfirmed.forEach(function (t) {
      var rec = { id: t.id, cls: t.cls, firstDetectMs: Math.round(t.firstSeen - run.start),
        timeToReticleMs: t.reticleAt != null ? Math.round(t.reticleAt - t.firstSeen) : null };
      (t.kind === 'person' ? people : pets).push(rec);
    });
    var ttr = people.filter(function (p) { return p.timeToReticleMs != null; }).map(function (p) { return p.timeToReticleMs; });
    var rec = {
      id: 'run-' + Date.now(), startedAt: run.startedAt, durationMs: Math.round(dur),
      model: CQB.getModelBase(), threshold: settings.threshold, detectionRes: settings.res,
      uniquePeople: people.length, uniquePets: pets.length,
      avgTimeToReticleMs: ttr.length ? Math.round(ttr.reduce(function (a, b) { return a + b; }, 0) / ttr.length) : null,
      people: people, pets: pets
    };
    var runs = loadRuns(); runs.unshift(rec); saveRuns(runs);
    run = null;
    $('btn-run').textContent = 'START CLEAR'; $('btn-run').classList.remove('live'); $('timer').classList.remove('live');
    $('timer').textContent = fmt(dur);
    beep(660, 0.12, 0); beep(440, 0.18, 0.14);
    showSummary(rec);
  }
  function showSummary(rec) {
    $('sum-total').textContent = fmt(rec.durationMs);
    $('sum-people').textContent = rec.uniquePeople; $('sum-pets').textContent = rec.uniquePets;
    $('sum-avg').textContent = fmtS(rec.avgTimeToReticleMs);
    var rows = '';
    rec.people.forEach(function (p) { rows += '<tr><td>PERSON #' + p.id + '</td><td>T+' + fmtS(p.firstDetectMs) + '</td><td>' + (p.timeToReticleMs == null ? 'MISSED' : fmtS(p.timeToReticleMs)) + '</td></tr>'; });
    rec.pets.forEach(function (p) { rows += '<tr><td class="pet">PET · ' + p.cls.toUpperCase() + ' #' + p.id + '</td><td>T+' + fmtS(p.firstDetectMs) + '</td><td>—</td></tr>'; });
    if (!rows) rows = '<tr><td colspan="3" style="color:#8a9a78">No targets detected</td></tr>';
    $('sum-rows').innerHTML = rows;
    openSheet('sheet-summary');
  }

  // ---------- history / export ----------
  function loadRuns() { try { return JSON.parse(localStorage.getItem(LS_RUNS) || '[]'); } catch (e) { return []; } }
  function saveRuns(r) { try { localStorage.setItem(LS_RUNS, JSON.stringify(r.slice(0, 500))); } catch (e) {} }
  function renderHistory() {
    var runs = loadRuns(), el = $('hist-list');
    if (!runs.length) { el.innerHTML = '<div class="empty">No runs yet. Hit START CLEAR to begin a drill.</div>'; return; }
    el.innerHTML = runs.map(function (r) {
      var d = new Date(r.startedAt);
      return '<div class="item"><span class="t">' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString() + '</span><span class="t">' + fmt(r.durationMs) + '</span>' +
        '<span>PPL ' + r.uniquePeople + ' · PET ' + r.uniquePets + '</span><span>AVG→RET ' + fmtS(r.avgTimeToReticleMs) + '</span></div>';
    }).join('');
  }
  function toCSV(runs) {
    var head = ['run_id', 'started_at', 'duration_s', 'model', 'threshold', 'unique_people', 'unique_pets', 'avg_time_to_reticle_s',
      'target_type', 'target_id', 'class', 'first_detect_s', 'time_to_reticle_s'];
    var lines = [head.join(',')];
    function s(v) { return v == null ? '' : (typeof v === 'number' ? String(v) : '"' + String(v).replace(/"/g, '""') + '"'); }
    function sec(ms) { return ms == null ? '' : (ms / 1000).toFixed(3); }
    runs.forEach(function (r) {
      var base = [s(r.id), s(r.startedAt), sec(r.durationMs), s(r.model), s(r.threshold), s(r.uniquePeople), s(r.uniquePets), sec(r.avgTimeToReticleMs)];
      var targets = r.people.map(function (p) { return ['person', p]; }).concat(r.pets.map(function (p) { return ['pet', p]; }));
      if (!targets.length) lines.push(base.concat(['', '', '', '', '']).join(','));
      targets.forEach(function (tp) {
        var p = tp[1];
        lines.push(base.concat([tp[0], s(p.id), s(p.cls), sec(p.firstDetectMs), sec(p.timeToReticleMs)]).join(','));
      });
    });
    return lines.join('\n');
  }
  async function exportFile(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    try {
      var file = new File([blob], name, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

  // ---------- sheets ----------
  function openSheet(id) { if (id === 'sheet-history') renderHistory(); $(id).classList.remove('hidden'); }
  function closeSheets() { document.querySelectorAll('.sheet').forEach(function (s) { s.classList.add('hidden'); }); }
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeSheets); });
  document.querySelectorAll('.sheet').forEach(function (s) { s.addEventListener('click', function (e) { if (e.target === s) closeSheets(); }); });

  // ---------- settings UI ----------
  function thrText(t) { return Number(t).toFixed(2) + ' (pets ' + CQB.petThreshold(t).toFixed(2) + ')'; }
  function bindSettings() {
    $('set-thr').value = settings.threshold; $('thr-val').textContent = thrText(settings.threshold);
    $('set-pets').checked = settings.pets; $('set-sound').checked = settings.sound;
    $('set-model').value = settings.model; $('set-res').value = String(settings.res); $('set-debug').checked = settings.debug;
    $('set-thr').addEventListener('input', function () { settings.threshold = parseFloat(this.value); $('thr-val').textContent = thrText(settings.threshold); saveSettings(); });
    $('set-pets').addEventListener('change', function () { settings.pets = this.checked; saveSettings(); });
    $('set-sound').addEventListener('change', function () { settings.sound = this.checked; saveSettings(); if (settings.sound) initAudio(); });
    $('set-res').addEventListener('change', function () { settings.res = parseInt(this.value, 10); saveSettings(); });
    $('set-debug').addEventListener('change', function () { settings.debug = this.checked; saveSettings(); });
    $('set-model').addEventListener('change', function () { settings.model = this.value; saveSettings(); lastDets = []; loadModel(); });
    $('btn-test-beep').addEventListener('click', function () { initAudio(); var s = settings.sound; settings.sound = true; cuePerson(); settings.sound = s; });
  }

  // ---------- main loop ----------
  function runDetection(now) {
    busy = true;
    var vw = video.videoWidth, vh = video.videoHeight;
    CQB.detect(video, vw, vh, { longSide: settings.res, minScore: settings.threshold, petMinScore: CQB.petThreshold(settings.threshold), pets: settings.pets })
      .then(function (dets) {
        var t = performance.now();
        if (lastDetT) { var inst = 1000 / (t - lastDetT); detFps = detFps ? detFps * 0.85 + inst * 0.15 : inst; }
        lastDetT = t;
        // object-fit:cover crops the camera frame; ignore targets that are (mostly) outside what the shooter sees
        if (viewW && viewH) {
          var T = CQB.coverTransform(vw, vh, viewW, viewH);
          dets = dets.filter(function (d) { return CQB.visibleFrac(CQB.toView(d, T), viewW, viewH) >= 0.3; });
        }
        lastDets = dets;
        var fresh = tracker.update(dets, t);
        fresh.forEach(function (tr) {
          if (tr.kind === 'person') cuePerson();
          if (run) {
            var rel = tr.firstSeen - run.start;
            if (tr.kind === 'person') logEvent('T+' + (rel / 1000).toFixed(2) + ' PERSON #' + tr.id + ' ACQUIRED');
            else logEvent('T+' + (rel / 1000).toFixed(2) + ' PET · ' + tr.cls.toUpperCase() + ' #' + tr.id, 'pet');
          }
        });
      })
      .catch(function (e) { console.error('detect', e); })
      .finally(function () { busy = false; });
  }

  var _lb = null, _lbT = 0;
  function labelBounds() {  // keep box labels clear of the top/bottom HUD bars
    var t = performance.now(); if (_lb && t - _lbT < 1000) return _lb;
    var top = Math.max($('hud-top').getBoundingClientRect().bottom, $('status').getBoundingClientRect().bottom), bot = $('hud-bottom').getBoundingClientRect().height;
    _lb = { minY: top + 2, maxYPad: bot + 2 }; _lbT = t; return _lb;
  }
  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    var vw = video.videoWidth, vh = video.videoHeight;
    var cx = viewW / 2, cy = viewH / 2, nPerson = 0, nPet = 0, hit = null;
    if (vw && vh) {
      var T = CQB.coverTransform(vw, vh, viewW, viewH);
      var vis = tracker.visible();
      // determine on-target (smallest person box containing reticle)
      var bestArea = Infinity;
      vis.forEach(function (tr) {
        if (tr.kind !== 'person') return;
        var vb = CQB.toView(tr.box, T);
        if (CQB.contains(vb, cx, cy) && vb.w * vb.h < bestArea) { bestArea = vb.w * vb.h; hit = tr; }
      });
      vis.forEach(function (tr) {
        if (tr.kind === 'person') nPerson++; else nPet++;
        CQB.drawBox(ctx, CQB.toView(tr.box, T), tr, tr === hit, 1, labelBounds());
      });
      // unconfirmed raw detections drawn faintly so nothing is hidden during the 2-frame confirm window
      ctx.save(); ctx.globalAlpha = 0.35;
      tracker.tracks.forEach(function (tr) { if (!tr.confirmed && tr.visible) CQB.drawBox(ctx, CQB.toView(tr.box, T), tr, false, 0.8, labelBounds()); });
      ctx.restore();
      if (hit && run && hit.reticleAt == null) {
        hit.reticleAt = performance.now();
        logEvent('T+' + ((hit.reticleAt - run.start) / 1000).toFixed(2) + ' #' + hit.id + ' ON RETICLE (' + fmtS(hit.reticleAt - hit.firstSeen) + ')', 'ret');
      }
    }
    CQB.drawReticle(ctx, cx, cy, !!hit, 1);
    $('ontarget').classList.toggle('hidden', !hit);
    if (hit) $('ontarget').textContent = '◉ ON TARGET · #' + hit.id;
    $('cnt-person').textContent = nPerson; $('cnt-pet').textContent = nPet;
    $('fps').textContent = detFps ? detFps.toFixed(1) : '--';
    if (run) $('timer').textContent = fmt(now - run.start);
    if (settings.debug) {
      if (!debugEl) { debugEl = document.createElement('div'); debugEl.className = 'debug'; document.body.appendChild(debugEl); }
      var m = tf.memory();
      debugEl.textContent = 'backend ' + tf.getBackend() + '\ntensors ' + m.numTensors + '\nvideo ' + vw + 'x' + vh + '\nview ' + Math.round(viewW) + 'x' + Math.round(viewH) + '\nres ' + settings.res;
      debugEl.style.display = '';
    } else if (debugEl) debugEl.style.display = 'none';
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!started || document.hidden) return;
    if (!busy && CQB.isReady() && video.readyState >= 2 && video.videoWidth) runDetection(now);
    draw(now);
  }

  // ---------- start ----------
  function showSplash(v) { $('splash').classList.toggle('hidden', !v); }
  $('btn-start').addEventListener('click', async function () {
    initAudio();             // must happen inside the tap
    $('btn-start').disabled = true; setStatus('REQUESTING CAMERA…');
    try {
      await startCamera();
    } catch (e) {
      console.error(e);
      var msg = e && e.name === 'NotAllowedError' ? 'CAMERA DENIED · Settings › Safari › Camera › Allow' : ('CAMERA ERROR · ' + (e && e.message || e));
      setStatus(msg, true); $('btn-start').disabled = false; return;
    }
    keepAwake();
    try { var de = document.documentElement; if (de.requestFullscreen && !document.fullscreenElement) de.requestFullscreen({ navigationUI: 'hide' }).catch(function () {}); } catch (e) {}
    started = true; resize(); showSplash(false);
    if (!CQB.isReady()) { setStatus('LOADING…'); await loadModel(); }
    else setStatus('READY · ' + (CQB.getModelBase() === 'mobilenet_v2' ? 'ACCURATE' : 'FAST') + ' · ' + tf.getBackend().toUpperCase());
    $('btn-run').disabled = false;
  });
  $('btn-run').addEventListener('click', function () { if (run) stopRun(); else startRun(); });
  $('btn-settings').addEventListener('click', function () { openSheet('sheet-settings'); });
  $('btn-history').addEventListener('click', function () { openSheet('sheet-history'); });
  $('btn-sum-history').addEventListener('click', function () { closeSheets(); openSheet('sheet-history'); });
  $('btn-export-csv').addEventListener('click', function () { exportFile('cqb-sight-runs-' + stamp() + '.csv', toCSV(loadRuns()), 'text/csv'); });
  $('btn-export-json').addEventListener('click', function () { exportFile('cqb-sight-runs-' + stamp() + '.json', JSON.stringify(loadRuns(), null, 2), 'application/json'); });
  $('btn-clear-hist').addEventListener('click', function () { if (confirm('Delete all saved runs?')) { saveRuns([]); renderHistory(); } });

  // expose for automated tests
  window.__cqb = { tracker: tracker, settings: settings, toCSV: toCSV, loadRuns: loadRuns, get detFps() { return detFps; }, get lastDets() { return lastDets; },
    startRun: startRun, stopRun: stopRun, isRunning: function () { return !!run; } };

  bindSettings(); resize();
  $('btn-start').disabled = false;
  if (!window.isSecureContext) setStatus('WARNING: not HTTPS — camera will be blocked', true);
  loadModel();  // preload while user reads the splash
  requestAnimationFrame(loop);
})();
