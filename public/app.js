/*
 * Vidbx capture — app.js (Fable pass 2, 1 Sep 2026 night)
 *
 * Round-2 fixes only. Journey untouched. Search "VIDBX2:" for every change.
 * Vidbx patches from today (centered first screen, time_line/rerecord_line
 * slots) are preserved.
 *
 * ============================ THE THREE CULPRITS ============================
 *
 * A. QUIET REVIEW — the file was not the whole story.
 *    Measured file: peak −6..−16, mean −27..−34. Quiet, but not "half-volume-
 *    inaudible" quiet. The missing piece: during review THE MIC WAS STILL
 *    OPEN (we kept the camera stream alive for instant re-record). While any
 *    getUserMedia mic track is live, iOS switches the audio session to
 *    play-and-record and plays <video> at a much lower level / different
 *    route. So the customer heard a quiet file played through a quiet route.
 *    Fix: stop ALL capture tracks the moment a take enters review, and
 *    reacquire the camera on "צילום מחדש" / next pulse (permission is already
 *    granted — reopen is fast). Review now plays through the normal media
 *    route at full volume. NEVER hold a live mic while playing review.
 *
 * B. FILE STILL QUIET AT GAIN 3.0 — fixed gain was the wrong tool.
 *    Raw speech here means −34..−41 dB with peaks −14..−24: an ~18 dB spread.
 *    A fixed gain big enough to fix the mean would clip the peaks; a fixed
 *    gain safe for the peaks (what we had) leaves the mean at −30. That is
 *    not a bug in the old chain, it is the ceiling of the approach.
 *    New chain (still zero AGC/NS/echo — צ/ס untouched):
 *
 *      mic → HPF 70 Hz → pre-gain +10 dB → LEVELER → makeup +8 dB → limiter
 *
 *    The LEVELER is a gentle wideband compressor (soft knee, 2.2:1, 20 ms
 *    attack, 350 ms release). It narrows the peak-to-body spread by a few dB
 *    so the makeup gain can lift the BODY of the voice without the peaks
 *    clipping. It is wideband and slow-attack: no spectral shaping, sibilant
 *    transients pass through before it reacts. This is not AGC (no adaptive
 *    target, no noise gating) and not the limiter doing the lifting.
 *    Expected result on the measured takes: mean ≈ −17..−22, peak ≈ −3..−6.
 *    That is normal 2026 phone-video loudness. The brickwall limiter stays
 *    as pure safety at −2 dB and still never touches normal speech.
 *
 * C. VGA VIDEO — two separate causes, both fixed.
 *    1) With no width/height constraints, iOS getUserMedia DEFAULTS TO
 *       640×480. That is where VGA came from — nobody asked for more.
 *    2) Our own mime list preferred "avc1.42E01E" = H.264 CONSTRAINED
 *       BASELINE LEVEL 3.0, whose level caps around VGA/30. The measured
 *       files were exactly Constrained Baseline. Even with big frames the
 *       codec string would have fought us. Now we request plain "video/mp4"
 *       and let Safari pick its native profile at source resolution.
 *    The zoom Tubi saw came from Vidbx's 1080×1920 request: those are
 *    PORTRAIT numbers, and the sensor is LANDSCAPE. Safari satisfied the
 *    portrait aspect by center-cropping a landscape mode → telephoto look.
 *    Correct request: landscape ideals, width 1920 × height 1080, never
 *    "exact", never portrait-shaped. The phone held in portrait then encodes
 *    1920×1080 with −90° rotation metadata → plays upright as 9:16, full
 *    sensor field, same framing as the camera app. Do not swap these numbers.
 *
 * Debug mode for Tubi: open the link with ?debug=1 — logs the actual track
 * resolution on acquire, and after every take DECODES THE RECORDED FILE and
 * logs its true mean/peak dB (not the live meter). Console only, customers
 * never see it.
 */
(() => {
  const slots = window.SLOTS || {};
  const questions = Array.isArray(slots.questions)
    ? slots.questions.map((q) => String(q || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  const pulseCount = 1 + questions.length;
  const MIN_RESULT_MS = 5000;
  const MAX_RESULT_MS = 15000;
  const MIN_TALK_MS = 2000;
  const MAX_TALK_MS = 30000;
  const STOP_GRACE_MS = 1500;
  const MIN_BLOB_BYTES = 1024;
  const TOAST_MS = 2800;

  // VIDBX2: audio chain constants. AUDIO_GAIN (single knob) is gone — the
  // lift is split so peaks and body are handled separately.
  // PRE_GAIN raises everything into the leveler's working range.
  // MAKEUP_GAIN lifts the leveled voice to delivery loudness.
  // If a venue still records shy, raise MAKEUP_GAIN to 3.16 (+10 dB) — that
  // is now the safe knob; the leveler+limiter absorb it without clipping.
  // Do NOT raise PRE_GAIN past 4.0 and do NOT touch the leveler's attack
  // (20 ms is what keeps sibilant transients intact).
  const PRE_GAIN = 3.16;    // +10 dB
  const MAKEUP_GAIN = 2.51; // +8 dB
  const LEVELER = { threshold: -28, knee: 20, ratio: 2.2, attack: 0.02, release: 0.35 };
  const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.2 };

  // VIDBX2: debug metering, console-only. ?debug=1
  const DEBUG = /[?&]debug=1/.test(location.search);

  const $ = (name) => document.querySelector(`[data-el="${name}"]`);

  const state = {
    screen: "first",
    sessionId: null,
    stream: null,
    recorder: null,
    chunks: [],
    pulseIndex: 0,
    phase: "live",
    startedAt: 0,
    elapsedMs: 0,
    tick: null,
    blob: null,
    blobUrl: null,
    mime: { mimeType: "", blobType: "video/mp4" },
    uploads: {},
    pulseBlobs: {},
    wakeLock: null,
    opening: false,
    sessionPromise: null,
    stopWatchdog: null,
    finishing: false,
    audioCtx: null,
    audioTeardown: null,
    toastTimer: null,
  };

  function isInAppBrowser() {
    const ua = navigator.userAgent || "";
    if (/Instagram|FBAN|FBAV|FB_IAB|FB4A|FBIOS|WhatsApp/i.test(ua)) return true;
    const hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasRec = typeof MediaRecorder !== "undefined";
    if ((!hasCam || !hasRec) && /iPhone|iPad|iPod/i.test(ua)) return true;
    return false;
  }

  function showScreen(name) {
    state.screen = name;
    document.querySelectorAll(".screen").forEach((el) => {
      el.hidden = el.getAttribute("data-screen") !== name;
    });
    const paper =
      getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() ||
      "#F3EEE6";
    const theme = name === "pulse" ? "#0b0b0b" : paper;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme);
  }

  /* ---------------------------------------------------------------- brand */

  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function luminance({ r, g, b }) {
    const f = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrast(l1, l2) {
    const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (a + 0.05) / (b + 0.05);
  }

  function applyBrand() {
    const raw = String(slots.brand_color || "").trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return;
    const root = document.documentElement;
    const lum = luminance(hexToRgb(raw));
    const whiteC = contrast(1.0, lum);
    const inkC = contrast(luminance(hexToRgb("#171411")), lum);
    root.style.setProperty("--brand", raw);
    if (whiteC >= 4.5 || inkC >= 4.5) {
      root.style.setProperty("--cta", raw);
      root.style.setProperty(
        "--cta-text",
        whiteC >= inkC ? "#ffffff" : "#171411"
      );
    }
    root.classList.add("branded");
  }

  /* ---------------------------------------------------------------- first */

  function fillFirst() {
    document.title = slots.business_name || "Vidbx";
    const mark = $("wordmark");
    mark.replaceChildren();
    if (slots.logo_url) {
      const img = document.createElement("img");
      img.src = slots.logo_url;
      img.alt = slots.business_name || "";
      mark.appendChild(img);
    } else {
      mark.textContent = slots.business_name || "";
    }
    $("ask").textContent = slots.ask || "";
    $("time-line").textContent = (slots.time_line || "").trim() ||
      `${questions.length} שאלות + צילום התוצאה. בערך דקה.`;
    const rerecord = $("rerecord-line");
    if (rerecord) {
      const line = (slots.rerecord_line || "").trim();
      if (line) {
        rerecord.hidden = false;
        rerecord.textContent = line;
      } else {
        rerecord.hidden = true;
        rerecord.textContent = "";
      }
    }
    const incentive = (slots.incentive_line || "").trim();
    const incentiveEl = $("incentive");
    if (incentive) {
      incentiveEl.hidden = false;
      incentiveEl.textContent = incentive;
    } else {
      incentiveEl.hidden = true;
      incentiveEl.textContent = "";
    }
  }

  /* ---------------------------------------------------------------- pulse */

  function overlayText(index) {
    if (index === 0) return `צלמו ${slots.result_prompt || ""}`.trim();
    return questions[index - 1] || "";
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function limitsFor(index) {
    return index === 0
      ? { min: MIN_RESULT_MS, max: MAX_RESULT_MS }
      : { min: MIN_TALK_MS, max: MAX_TALK_MS };
  }

  function facingFor(index) {
    return index === 0 ? "environment" : "user";
  }

  function renderDots() {
    const wrap = $("dots");
    if (!wrap) return;
    wrap.replaceChildren();
    for (let i = 0; i < pulseCount; i++) {
      const dot = document.createElement("span");
      dot.className = "dot" + (i === state.pulseIndex ? " on" : "") +
        (i < state.pulseIndex ? " done" : "");
      wrap.appendChild(dot);
    }
  }

  // VIDBX2 (culprit C-2): "avc1.42E01E" is H.264 Constrained Baseline
  // LEVEL 3.0 — its level caps encode around 640×480/30. The measured VGA
  // files were exactly this profile. Never pin a codec string here again;
  // plain "video/mp4" lets Safari encode its native profile (High) at the
  // track's real resolution.
  function pickMime() {
    const types = [
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined") {
      return { mimeType: "", blobType: "video/mp4" };
    }
    for (const mimeType of types) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return { mimeType, blobType: mimeType.split(";")[0] };
      }
    }
    return { mimeType: "", blobType: "video/mp4" };
  }

  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
  }

  // VIDBX2 (culprit A): release the capture session entirely. Called when a
  // take enters review, so iOS drops the play-and-record audio session and
  // review plays loud through the normal media route.
  function releaseCapture() {
    stopTracks(state.stream);
    state.stream = null;
    const live = $("live");
    try { live.srcObject = null; } catch (_) {}
  }

  async function releaseWake() {
    try {
      await state.wakeLock?.release?.();
    } catch (_) {}
    state.wakeLock = null;
  }

  async function requestWake() {
    try {
      if ("wakeLock" in navigator) {
        state.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- audio */

  function rawAudioConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      googEchoCancellation: false,
      googNoiseSuppression: false,
      googAutoGainControl: false,
      voiceIsolation: false,
    };
  }

  function audioProcessingOn(settings) {
    if (!settings) return false;
    return (
      settings.echoCancellation === true ||
      settings.noiseSuppression === true ||
      settings.autoGainControl === true ||
      settings.googEchoCancellation === true ||
      settings.googNoiseSuppression === true ||
      settings.googAutoGainControl === true ||
      settings.voiceIsolation === true
    );
  }

  async function forceRawAudioTrack(track) {
    const audio = rawAudioConstraints();
    try {
      await track.applyConstraints(audio);
    } catch (_) {}
    let settings = {};
    try {
      settings = track.getSettings();
    } catch (_) {}
    if (audioProcessingOn(settings)) {
      try {
        await track.applyConstraints(audio);
      } catch (_) {}
      try {
        settings = track.getSettings();
      } catch (_) {}
    }
    if (audioProcessingOn(settings)) {
      throw new Error("processed-audio");
    }
  }

  async function forceRawAudio(stream) {
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error("audio");
    for (const track of tracks) {
      await forceRawAudioTrack(track);
    }
  }

  // VIDBX2 (culprit B): the leveling chain. Still zero AGC/NS/echo.
  // mic → HPF 70 Hz → pre +10 dB → leveler (soft, slow) → makeup +8 dB →
  // brickwall limiter → recorder. Video track passes through untouched.
  // Returns null on any failure so the caller records the raw stream.
  function buildBoostedStream(rawStream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const videoTrack = rawStream.getVideoTracks()[0];
      const audioTrack = rawStream.getAudioTracks()[0];
      if (!videoTrack || !audioTrack) return null;

      // Created inside the record tap, while the mic session is live, so
      // the context comes up at the hardware rate (48 kHz) — no resample
      // weirdness between mic and chain.
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(
        new MediaStream([audioTrack])
      );

      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 70;
      highpass.Q.value = 0.707;

      const pre = ctx.createGain();
      pre.gain.value = PRE_GAIN;

      // The leveler: gentle wideband compression. Soft knee 20 dB, 2.2:1,
      // 20 ms attack (sibilant transients pass BEFORE it reacts — this is
      // the anti-chew guarantee; do not shorten it), 350 ms release (no
      // pumping). It narrows the peak-to-body spread so makeup gain can
      // lift the voice body to normal loudness without clipping peaks.
      // This is NOT AGC: fixed curve, no adaptation, no gating, wideband.
      const leveler = ctx.createDynamicsCompressor();
      leveler.threshold.value = LEVELER.threshold;
      leveler.knee.value = LEVELER.knee;
      leveler.ratio.value = LEVELER.ratio;
      leveler.attack.value = LEVELER.attack;
      leveler.release.value = LEVELER.release;

      const makeup = ctx.createGain();
      makeup.gain.value = MAKEUP_GAIN;

      // Pure safety. Normal leveled speech peaks −6..−4 and never hits −2.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = LIMITER.threshold;
      limiter.knee.value = LIMITER.knee;
      limiter.ratio.value = LIMITER.ratio;
      limiter.attack.value = LIMITER.attack;
      limiter.release.value = LIMITER.release;

      const dest = ctx.createMediaStreamDestination();
      source.connect(highpass);
      highpass.connect(pre);
      pre.connect(leveler);
      leveler.connect(makeup);
      makeup.connect(limiter);
      limiter.connect(dest);

      const boostedAudio = dest.stream.getAudioTracks()[0];
      if (!boostedAudio) {
        try { ctx.close(); } catch (_) {}
        return null;
      }
      const mixed = new MediaStream([videoTrack, boostedAudio]);
      const teardown = () => {
        try { source.disconnect(); } catch (_) {}
        try { ctx.close(); } catch (_) {}
      };
      return { stream: mixed, ctx, teardown };
    } catch (_) {
      return null;
    }
  }

  function teardownAudioChain() {
    if (state.audioTeardown) {
      try { state.audioTeardown(); } catch (_) {}
    }
    state.audioTeardown = null;
    state.audioCtx = null;
  }

  // VIDBX2: debug-only. Decodes the RECORDED FILE (not the live meter) and
  // logs its real mean/peak dB. This is the number that answers "is the
  // file the loud one". Console only; requires ?debug=1.
  function debugMeasureBlob(blob, label) {
    if (!DEBUG || !blob) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      blob.arrayBuffer().then((buf) => {
        const ctx = new Ctx();
        const done = (msg) => {
          try { ctx.close(); } catch (_) {}
          console.log(msg);
        };
        ctx.decodeAudioData(
          buf,
          (audio) => {
            let peak = 0;
            let sumSq = 0;
            let n = 0;
            for (let c = 0; c < audio.numberOfChannels; c++) {
              const d = audio.getChannelData(c);
              for (let i = 0; i < d.length; i++) {
                const v = Math.abs(d[i]);
                if (v > peak) peak = v;
                sumSq += d[i] * d[i];
              }
              n += d.length;
            }
            const rms = Math.sqrt(sumSq / Math.max(1, n));
            const dB = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");
            done(
              `[vidbx debug] ${label}: file mean ${dB(rms)} dB RMS, peak ${dB(peak)} dB, ` +
              `${audio.sampleRate} Hz, ${audio.duration.toFixed(1)}s`
            );
          },
          () => done(`[vidbx debug] ${label}: could not decode audio for metering`)
        );
      });
    } catch (_) {}
  }

  /* --------------------------------------------------------------- camera */

  // VIDBX2 (culprit C-1): real resolution, no zoom.
  // RULES — carved here because this exact spot caused both bugs:
  // - Numbers are LANDSCAPE (sensor-native): width 1920 × height 1080.
  //   Portrait comes from the phone's rotation metadata, not from us.
  //   Requesting 1080×1920 (portrait-shaped) makes Safari center-crop a
  //   landscape mode → the telephoto zoom Tubi aborted on. Never swap.
  // - "ideal", never "exact", for size and frame rate. "ideal" lets Safari
  //   pick the nearest NATIVE mode (full sensor field). "exact" forces a
  //   crop when no native mode matches.
  // - No size at all defaults iOS to 640×480 — that is where VGA came from.
  function videoConstraintsFor(facing, tier) {
    const base =
      tier === 0
        ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        : tier === 1
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          : {};
    return Object.assign({ facingMode: { ideal: facing } }, base);
  }

  async function getCamera(facing) {
    const audio = rawAudioConstraints();
    const tries = [
      // exact facing + full-HD ideals: guarantees the right camera, lets
      // Safari pick the closest native full-sensor mode.
      { video: Object.assign(videoConstraintsFor(facing, 0), { facingMode: { exact: facing } }), audio },
      { video: videoConstraintsFor(facing, 0), audio },
      { video: videoConstraintsFor(facing, 1), audio },
      { video: videoConstraintsFor(facing, 2), audio },
      { video: true, audio },
    ];
    let last;
    for (const constraints of tries) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        try {
          await forceRawAudio(stream);
          if (DEBUG) {
            try {
              const s = stream.getVideoTracks()[0].getSettings();
              console.log(
                `[vidbx debug] camera: ${s.width}×${s.height}@${s.frameRate || "?"} facing=${s.facingMode || facing}`
              );
            } catch (_) {}
          }
          return stream;
        } catch (err) {
          stopTracks(stream);
          throw err;
        }
      } catch (err) {
        last = err;
      }
    }
    throw last || new Error("camera");
  }

  function attachLive(stream) {
    const video = $("live");
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.classList.toggle("mirror", facingFor(state.pulseIndex) === "user");
    const play = video.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  }

  function clearBlob() {
    if (state.blobUrl) {
      try {
        URL.revokeObjectURL(state.blobUrl);
      } catch (_) {}
    }
    state.blob = null;
    state.blobUrl = null;
  }

  function streamReady() {
    return !!(
      state.stream &&
      state.stream.getVideoTracks()[0] &&
      state.stream.getVideoTracks()[0].readyState === "live"
    );
  }

  function setPulseChrome() {
    $("overlay").textContent = overlayText(state.pulseIndex);
    $("timer").textContent = formatTime(state.elapsedMs);
    const recording = state.phase === "recording" || state.phase === "stopping";
    const review = state.phase === "review";
    $("record").classList.toggle("recording", recording);
    $("timer").classList.toggle("recording", recording);
    $("record-wrap").hidden = review;
    $("review-actions").hidden = !review;
    $("live").hidden = review;
    $("review").hidden = !review;
    $("overlay").hidden = review;
    $("timer").hidden = review;
    // VIDBX2: shutter disabled while the camera is (re)opening — no dead
    // taps on a black frame after re-record.
    $("record").disabled = state.phase === "live" && !streamReady();
    const dots = $("dots");
    if (dots) dots.hidden = review;
    if (!review) $("review-play").hidden = true;
    renderDots();
  }

  function tooShortCopy(index) {
    return index === 0
      ? "קצר מדי — צריך לפחות חמש שניות. עוד פעם?"
      : "קצר מדי — צריך לפחות שתי שניות. עוד פעם?";
  }

  function showToast(text, sticky) {
    const el = $("pulse-error");
    el.hidden = false;
    el.textContent = text;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(state.toastTimer);
    if (!sticky) {
      state.toastTimer = setTimeout(() => {
        el.classList.remove("show");
        el.hidden = true;
      }, TOAST_MS);
    }
  }

  function hidePulseError() {
    clearTimeout(state.toastTimer);
    const el = $("pulse-error");
    el.classList.remove("show");
    el.hidden = true;
  }

  function clearStopWatchdog() {
    if (state.stopWatchdog) {
      clearTimeout(state.stopWatchdog);
      state.stopWatchdog = null;
    }
  }

  function cameraErrorCopy(err) {
    const name = err && err.name ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "המצלמה חסומה. אפשר הרשאה בספארי או בכרום.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "לא נמצאה מצלמה.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "המצלמה תפוסה. סגרו אפליקציה אחרת ונסו שוב.";
    }
    return "המצלמה לא נפתחה. נסו שוב.";
  }

  /* -------------------------------------------------------------- session */

  async function openSession() {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slots.slug || "" }),
    });
    if (!res.ok) throw new Error("session");
    const data = await res.json();
    state.sessionId = data.id;
  }

  async function ensureSession() {
    if (state.sessionId) return;
    if (!state.sessionPromise) {
      state.sessionPromise = openSession().catch((err) => {
        state.sessionPromise = null;
        throw err;
      });
    }
    await state.sessionPromise;
  }

  /* ------------------------------------------------------------ recording */

  async function startPulse(index) {
    state.pulseIndex = index;
    state.phase = "live";
    state.elapsedMs = 0;
    state.chunks = [];
    state.finishing = false;
    clearStopWatchdog();
    clearBlob();
    hidePulseError();
    stopRecorder(false);
    teardownAudioChain();
    releaseCapture();
    setPulseChrome(); // shutter disabled while reopening
    const stream = await getCamera(facingFor(index));
    state.stream = stream;
    attachLive(stream);
    setPulseChrome();
  }

  function stopRecorder(keepChunks) {
    const rec = state.recorder;
    state.recorder = null;
    if (!rec) return;
    try {
      rec.ondataavailable = null;
      rec.onerror = null;
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
    } catch (_) {}
    if (!keepChunks) state.chunks = [];
  }

  function startTick() {
    clearInterval(state.tick);
    state.tick = setInterval(() => {
      state.elapsedMs = performance.now() - state.startedAt;
      $("timer").textContent = formatTime(state.elapsedMs);
      const { max } = limitsFor(state.pulseIndex);
      if (state.phase === "recording" && state.elapsedMs >= max) {
        stopRecording();
      }
    }, 200);
  }

  // VIDBX2: bitrate follows the REAL delivered frame size — 2.5 Mbps was
  // right for VGA and wrong for 1080p; a flat 8 Mbps wastes upload on VGA
  // fallbacks. Never encode above what the track actually is.
  function videoBitrateFor(stream) {
    try {
      const s = stream.getVideoTracks()[0].getSettings();
      const shortSide = Math.min(s.width || 0, s.height || 0);
      if (shortSide >= 1080) return 8000000;
      if (shortSide >= 720) return 5000000;
      return 3000000;
    } catch (_) {
      return 5000000;
    }
  }

  function startRecording() {
    if (state.phase !== "live" || !state.stream) return;
    const track = state.stream.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      showToast("המצלמה אינה זמינה. נסו שוב.", true);
      return;
    }
    stopRecorder(false);
    teardownAudioChain();
    state.chunks = [];
    state.finishing = false;
    state.mime = pickMime();

    const boosted = buildBoostedStream(state.stream);
    let recStream = state.stream;
    if (boosted) {
      recStream = boosted.stream;
      state.audioCtx = boosted.ctx;
      state.audioTeardown = boosted.teardown;
      if (boosted.ctx.state !== "running") {
        boosted.ctx.resume().catch(() => {});
      }
    }

    const opts = {
      videoBitsPerSecond: videoBitrateFor(state.stream),
      audioBitsPerSecond: 256000,
    };
    if (state.mime.mimeType) opts.mimeType = state.mime.mimeType;
    let rec;
    try {
      rec = new MediaRecorder(recStream, opts);
    } catch (_) {
      try {
        rec = new MediaRecorder(recStream);
      } catch (_) {
        teardownAudioChain();
        recStream = state.stream;
        try {
          rec = new MediaRecorder(recStream, opts);
        } catch (_) {
          try {
            rec = new MediaRecorder(recStream);
          } catch (err) {
            showToast("ההקלטה לא נפתחה. נסו שוב.", true);
            return;
          }
        }
      }
    }
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) state.chunks.push(ev.data);
    };
    rec.onerror = () => {
      showToast("ההקלטה לא נשמרה. צלמו שוב.", true);
    };
    rec.onstop = () => {
      settleStop();
    };
    track.addEventListener(
      "ended",
      () => {
        if (state.phase === "recording") stopRecording();
      },
      { once: true }
    );
    try {
      rec.start(250);
    } catch (_) {
      try {
        rec.start();
      } catch (err) {
        teardownAudioChain();
        showToast("ההקלטה לא נפתחה. נסו שוב.", true);
        return;
      }
    }
    state.recorder = rec;
    state.phase = "recording";
    state.startedAt = performance.now();
    state.elapsedMs = 0;
    hidePulseError();
    requestWake();
    startTick();
    setPulseChrome();
  }

  function finishRecording() {
    if (state.finishing) return;
    if (state.phase !== "recording" && state.phase !== "stopping") return;
    state.finishing = true;
    clearStopWatchdog();
    clearInterval(state.tick);
    state.tick = null;
    releaseWake();
    const rec = state.recorder;
    if (rec) {
      try {
        rec.ondataavailable = null;
        rec.onerror = null;
        rec.onstop = null;
      } catch (_) {}
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch (_) {}
      state.recorder = null;
    }
    teardownAudioChain();
    const { min } = limitsFor(state.pulseIndex);
    const elapsed = state.elapsedMs;
    const parts = state.chunks.slice();
    state.chunks = [];
    const blob = new Blob(parts, { type: state.mime.blobType || "video/mp4" });
    const tooShort = elapsed < min;
    const tooSmall = !blob || blob.size < MIN_BLOB_BYTES;
    if (tooShort || tooSmall) {
      state.phase = "live";
      clearBlob();
      state.elapsedMs = 0;
      $("timer").textContent = formatTime(0);
      setPulseChrome();
      showToast(
        tooShort ? tooShortCopy(state.pulseIndex) : "ההקלטה לא נשמרה. צלמו שוב."
      );
      return;
    }
    hidePulseError();

    // VIDBX2 (culprit A): kill the capture session BEFORE playing review.
    // With the mic still open, iOS keeps a play-and-record audio session and
    // plays the review video at a much lower level. Releasing the tracks
    // flips the session back to normal media playback at full volume.
    // Re-record / next pulse reacquire the camera (permission is cached).
    releaseCapture();

    state.blob = blob;
    state.blobUrl = URL.createObjectURL(blob);
    debugMeasureBlob(blob, `pulse ${state.pulseIndex}`);
    const review = $("review");
    review.src = state.blobUrl;
    review.muted = false;
    review.volume = 1;
    review.loop = true;
    review.controls = false;
    state.phase = "review";
    setPulseChrome();
    const play = review.play();
    if (play && typeof play.catch === "function") {
      play.catch(() => {
        $("review-play").hidden = false;
      });
    }
  }

  function settleStop() {
    if (state.phase !== "stopping" && state.phase !== "recording") return;
    finishRecording();
  }

  function stopRecording() {
    if (state.phase !== "recording") return;
    state.phase = "stopping";
    const rec = state.recorder;
    clearInterval(state.tick);
    state.tick = null;
    state.elapsedMs = performance.now() - state.startedAt;
    setPulseChrome();

    const armWatchdog = () => {
      clearStopWatchdog();
      state.stopWatchdog = setTimeout(() => {
        state.stopWatchdog = null;
        try {
          if (rec && rec.state === "recording" && typeof rec.requestData === "function") {
            rec.requestData();
          }
        } catch (_) {}
        settleStop();
      }, STOP_GRACE_MS);
    };

    if (!rec || rec.state === "inactive") {
      settleStop();
      return;
    }
    rec.onstop = () => {
      settleStop();
    };
    armWatchdog();
    try {
      if (typeof rec.requestData === "function") rec.requestData();
    } catch (_) {}
    try {
      rec.stop();
    } catch (_) {
      settleStop();
    }
  }

  function toggleReview() {
    if (state.phase !== "review") return;
    const review = $("review");
    if (review.paused) {
      $("review-play").hidden = true;
      const p = review.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      review.pause();
      $("review-play").hidden = false;
    }
  }

  /* --------------------------------------------------------------- upload */

  function extFor(blob) {
    const type = (blob && blob.type) || "";
    if (type.includes("mp4")) return "mp4";
    if (type.includes("webm")) return "webm";
    return "mp4";
  }

  async function uploadPulse(index, blob) {
    await ensureSession();
    const ext = extFor(blob);
    const attempt = async () => {
      const res = await fetch(
        `/api/session/${encodeURIComponent(state.sessionId)}/pulse/${index}?ext=${ext}`,
        {
          method: "POST",
          headers: { "Content-Type": blob.type || "application/octet-stream" },
          body: blob,
        }
      );
      if (!res.ok) throw new Error("upload");
      return res.json();
    };
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const data = await attempt();
        state.uploads[index] = data;
        return;
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw last;
  }

  async function acceptPulse() {
    if (state.phase !== "review" || !state.blob) return;
    const index = state.pulseIndex;
    const blob = state.blob;
    $("accept").disabled = true;
    state.pulseBlobs[index] = blob;
    uploadPulse(index, blob).catch(() => {});
    $("review").pause();
    clearBlob();
    if (index + 1 >= pulseCount) {
      // Capture already released on entering review; nothing to stop.
      releaseCapture();
      $("accept").disabled = false;
      showScreen("details");
      return;
    }
    try {
      await startPulse(index + 1);
    } catch (err) {
      showToast(cameraErrorCopy(err), true);
    }
    $("accept").disabled = false;
  }

  async function rerecord() {
    $("review").pause();
    clearBlob();
    state.phase = "live";
    state.elapsedMs = 0;
    state.finishing = false;
    hidePulseError();
    $("timer").textContent = formatTime(0);
    // VIDBX2: capture was released when review started, so this always
    // reacquires. Permission is cached — the camera is back in well under a
    // second, and the shutter stays disabled until it is.
    if (!streamReady()) {
      try {
        await startPulse(state.pulseIndex);
      } catch (err) {
        showToast(cameraErrorCopy(err), true);
      }
      return;
    }
    attachLive(state.stream);
    setPulseChrome();
  }

  async function onOpenCamera() {
    if (state.opening) return;
    if (isInAppBrowser()) {
      showScreen("gate");
      return;
    }
    const errEl = $("first-error");
    errEl.hidden = true;
    state.opening = true;
    $("open-camera").disabled = true;
    const streamPromise = getCamera("environment");
    ensureSession().catch(() => {});
    try {
      showScreen("pulse");
      state.pulseIndex = 0;
      $("overlay").textContent = overlayText(0);
      $("overlay").hidden = false;
      $("record").disabled = true;
      renderDots();
      const stream = await streamPromise;
      state.phase = "live";
      state.elapsedMs = 0;
      state.chunks = [];
      state.finishing = false;
      clearStopWatchdog();
      clearBlob();
      hidePulseError();
      teardownAudioChain();
      stopTracks(state.stream);
      state.stream = stream;
      attachLive(stream);
      setPulseChrome();
    } catch (err) {
      showScreen("first");
      errEl.hidden = false;
      errEl.textContent = cameraErrorCopy(err);
    } finally {
      state.opening = false;
      $("open-camera").disabled = false;
    }
  }

  /* -------------------------------------------------------------- details */

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const form = $("details-form");
    const name = String(form.name.value || "").trim();
    const email = String(form.email.value || "").trim();
    const consent = !!form.consent.checked;
    const errEl = $("details-error");
    errEl.hidden = true;
    if (!name) {
      errEl.hidden = false;
      errEl.textContent = "כתבו את השם.";
      return;
    }
    if (!email || !validEmail(email)) {
      errEl.hidden = false;
      errEl.textContent = "כתבו אימייל תקין.";
      return;
    }
    if (!consent) {
      errEl.hidden = false;
      errEl.textContent = "יש לאשר שימוש בסרטון.";
      return;
    }
    $("submit").disabled = true;
    $("submit").textContent = "שולח…";
    try {
      await ensureSession();
      for (let i = 0; i < pulseCount; i++) {
        if (!state.uploads[i] && state.pulseBlobs[i]) {
          await uploadPulse(i, state.pulseBlobs[i]);
        }
      }
      const res = await fetch(
        `/api/session/${encodeURIComponent(state.sessionId)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email,
            consent: true,
            slug: slots.slug || "",
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "submit");
      }
      showThanks();
    } catch (_) {
      errEl.hidden = false;
      errEl.textContent = "השליחה לא עברה. נסו שוב.";
      $("submit").disabled = false;
      $("submit").textContent = "שליחה";
    }
  }

  function showThanks() {
    const url = (slots.thank_you_url || "").trim();
    const label = (slots.thank_you_label || "").trim();
    const link = $("thanks-link");
    const mark = $("vidbx-mark");
    if (url) {
      link.hidden = false;
      link.href = url;
      link.textContent = label || url;
      mark.hidden = true;
    } else {
      link.hidden = true;
      link.removeAttribute("href");
      link.textContent = "";
      mark.hidden = false;
    }
    showScreen("thanks");
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    applyBrand();
    fillFirst();
    if (isInAppBrowser()) {
      showScreen("gate");
      return;
    }
    showScreen("first");
  }

  $("open-camera").addEventListener("click", onOpenCamera);
  $("record").addEventListener("click", () => {
    if (state.phase === "recording") stopRecording();
    else startRecording();
  });
  $("accept").addEventListener("click", acceptPulse);
  $("rerecord").addEventListener("click", rerecord);
  $("review").addEventListener("click", toggleReview);
  $("review-play").addEventListener("click", toggleReview);
  $("details-form").addEventListener("submit", onSubmit);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.phase === "recording") {
      requestWake();
      if (state.audioCtx && state.audioCtx.state !== "running") {
        state.audioCtx.resume().catch(() => {});
      }
    }
  });

  boot();
})();
