/* ============================================================
   disco.js — nightclub atmosphere engine (rewritten)
   ------------------------------------------------------------
   Public API:
     Disco.startRave()         — dark room, accelerate spotlights
     Disco.decelerate()        — begin winding down (matches wheel decel)
     Disco.onWheelStopped()    — run stop sequence: thicken → hold → unfreeze → loiter
     Disco.fadeOut()           — fade the whole thing out
     Disco.stopAll()           — immediate cleanup
     Disco.setTheme(idx)       — switch color theme (dev picker uses this)
     Disco.getThemes()         — [{ index, name, colors }]
   ============================================================ */

const Disco = (() => {
  "use strict";

  // ============================================================
  // Themes — 4 colors each, one per spotlight group
  // ============================================================
  const THEMES = [
    { name: "Neon Rainbow",   colors: ["#FF0080", "#00CFFF", "#CCFF00", "#FF6A00"] },
    { name: "Synthwave",      colors: ["#FF00FF", "#00CFFF", "#7B00FF", "#FF0080"] },
    { name: "Hot Fire",       colors: ["#FF0000", "#FF6A00", "#FFE600", "#FFFFFF"] },
    { name: "Ocean Depths",   colors: ["#00CFFF", "#00FF94", "#0040FF", "#7B00FF"] },
    { name: "Jungle",         colors: ["#00FF94", "#CCFF00", "#00FF00", "#FFE600"] },
    { name: "Royal",          colors: ["#7B00FF", "#FFE600", "#FF0080", "#0040FF"] },
    { name: "Candy",          colors: ["#FF0080", "#00CFFF", "#00FF94", "#FF00FF"] },
    { name: "Autumn",         colors: ["#FF6A00", "#FF1744", "#FFE600", "#FF00FF"] },
    { name: "Holy Light",     colors: ["#FFE600", "#FFFFFF", "#FF6A00", "#CCFF00"] },
    { name: "UV Black Light", colors: ["#7B00FF", "#00FF94", "#FF00FF", "#00CFFF"] },
  ];

  // Groups: count, rotation speed at full velocity, theme color index.
  // fullSpeed=null → "chaos" group that bounces direction randomly.
  const GROUPS = [
    { count: 30, fullSpeed:  11.8, colorIdx: 0 },
    { count: 20, fullSpeed: -17.9, colorIdx: 1 },
    { count: 15, fullSpeed:  23.7, colorIdx: 2 },
    { count: 20, fullSpeed: null,  colorIdx: 3 },
  ];

  const ACCEL_MS       = 500;    // spin-up duration (snappy hit-the-gas feel)
  const DECEL_DECAY    = 0.985;  // per-frame velocity multiplier on decel
  const FREEZE_THICKEN = 15;     // beam width multiplier when frozen
  const IDLE_VELOCITY  = 0.012;  // gentle drift between cycles (loading-screen vibe)
  const THICKEN_MS     = 100;    // 1x → 10x beam width on wheel stop
  const HOLD_MS        = 100;    // beat at full thickness before unfreeze
  const UNFREEZE_MS    = 1500;   // 10x → 1x beam width + velocity ramp into loiter

  // ── State ──
  let phase        = "idle"; // idle | accel | sustain | decel | thicken | hold | unfreeze | loiter | fadeout
  let phaseStart   = 0;
  let rafId        = null;
  let accelStartTs = 0;
  let velocity     = 0;
  let fadeAlpha    = 1;
  let activeTheme  = 0;

  // Cached DOM refs (set on DOMContentLoaded)
  let bgEl = null;
  let spotsEl = null;

  // Spots
  const spots = [];

  function getWheelCenter() {
    const wheel = document.getElementById("wheel");
    if (!wheel) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = wheel.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // ============================================================
  // Build all spotlights once at page load
  // ============================================================
  function initSpotlights(container) {
    container.innerHTML = "";
    spots.length = 0;

    const c  = getWheelCenter();
    const cx = (c.x / window.innerWidth)  * 100;
    const cy = (c.y / window.innerHeight) * 100;

    GROUPS.forEach((group, gIdx) => {
      const isChaos = group.fullSpeed === null;
      for (let i = 0; i < group.count; i++) {
        const beam  = document.createElement("div");
        const angle = (i / group.count) * 360;
        const width = 1.5 + Math.random() * 2.5;

        Object.assign(beam.style, {
          position:        "absolute",
          top:             `${cy}%`,
          left:            `${cx}%`,
          width:           `${width}px`,
          height:          "140vmax",
          transformOrigin: "top center",
          transform:       `rotate(${angle}deg)`,
          pointerEvents:   "none",
          borderRadius:    "0 0 50% 50%",
          // NOTE: no mixBlendMode here — applied at container level for perf
        });

        container.appendChild(beam);

        // Chaos group: magnitude only + randomly flipping direction.
        // Locked groups: signed fullSpeed split into magnitude + direction.
        const magnitude = isChaos
          ? (Math.random() < 0.5 ? 0.6 + Math.random() * 0.8 : 1.8 + Math.random() * 1.4)
          : Math.abs(group.fullSpeed);
        const direction = isChaos
          ? (Math.random() < 0.5 ? 1 : -1)
          : Math.sign(group.fullSpeed);

        spots.push({
          el:         beam,
          angle,
          groupIdx:   gIdx,
          magnitude,
          direction,
          isChaos,
          nextFlipAt: performance.now() + 400 + Math.random() * 2400,
          baseWidth:  width,
        });
      }
    });

    applyTheme(activeTheme);
  }

  // ============================================================
  // Theme application — re-paint beam backgrounds without rebuilding
  // ============================================================
  function applyTheme(idx) {
    if (idx < 0 || idx >= THEMES.length) return;
    activeTheme = idx;
    const theme = THEMES[idx];
    for (const s of spots) {
      const color = theme.colors[GROUPS[s.groupIdx].colorIdx];
      s.el.style.background =
        `linear-gradient(to bottom, ${color}cc 0%, ${color}55 25%, ${color}11 60%, transparent 100%)`;
    }
  }

  // ============================================================
  // Public API
  // ============================================================
  function startRave() {
    if (!bgEl || !spotsEl) return;
    bgEl.classList.remove("rave-off");
    spotsEl.classList.remove("rave-off");
    bgEl.style.opacity    = "1";
    spotsEl.style.opacity = "1";
    fadeAlpha = 1;

    // Restore beam widths from any previous frozen state
    for (const s of spots) s.el.style.width = `${s.baseWidth}px`;

    phase        = "accel";
    accelStartTs = performance.now();
    velocity     = 0;

    // These are reentrant-safe
    Music.start();
    document.body.classList.add("rave-active");

    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function decelerate() {
    if (phase === "idle" || phase === "fadeout") return;
    phase = "decel";
  }

  // When the wheel lands, run the full stop sequence automatically:
  //   thicken (100ms) → hold (250ms) → unfreeze (1500ms) → loiter
  function onWheelStopped() {
    phase      = "thicken";
    phaseStart = performance.now();
    velocity   = 0;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function fadeOut() {
    phase     = "fadeout";
    fadeAlpha = 1;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function stopAll() {
    phase = "idle";
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    cleanup();
  }

  function setTheme(idx) { applyTheme(idx); }
  function getThemes()   { return THEMES.map((t, i) => ({ index: i, name: t.name, colors: t.colors })); }

  // ============================================================
  // RAF loop
  // ============================================================
  function loop(ts) {
    if (phase === "idle") { rafId = null; return; }

    if (phase === "accel") {
      velocity = Math.min(1, (ts - accelStartTs) / ACCEL_MS);
      if (velocity >= 1) { velocity = 1; phase = "sustain"; }
    } else if (phase === "sustain") {
      velocity = 1;
    } else if (phase === "decel") {
      velocity *= DECEL_DECAY;
    } else if (phase === "thicken") {
      const t = Math.min(1, (ts - phaseStart) / THICKEN_MS);
      velocity = 0;
      const widthMul = 1 + (FREEZE_THICKEN - 1) * t; // 1 → 10
      for (const s of spots) s.el.style.width = `${s.baseWidth * widthMul}px`;
      if (t >= 1) { phase = "hold"; phaseStart = ts; }
    } else if (phase === "hold") {
      velocity = 0;
      if (ts - phaseStart >= HOLD_MS) { phase = "unfreeze"; phaseStart = ts; }
    } else if (phase === "unfreeze") {
      const t = Math.min(1, (ts - phaseStart) / UNFREEZE_MS);
      velocity = IDLE_VELOCITY * t;
      const widthMul = FREEZE_THICKEN + (1 - FREEZE_THICKEN) * t; // 10 → 1
      for (const s of spots) s.el.style.width = `${s.baseWidth * widthMul}px`;
      if (t >= 1) phase = "loiter";
    } else if (phase === "loiter") {
      velocity = IDLE_VELOCITY;
    } else if (phase === "fadeout") {
      fadeAlpha = Math.max(0, fadeAlpha - 0.005);
      if (bgEl)    bgEl.style.opacity    = fadeAlpha;
      if (spotsEl) spotsEl.style.opacity = fadeAlpha;
      if (fadeAlpha === 0) { stopAll(); return; }
    }

    tickSpotlights(ts);
    rafId = requestAnimationFrame(loop);
  }

  function tickSpotlights(ts) {
    if (velocity <= 0) return; // frozen / idle → skip DOM writes
    for (const s of spots) {
      if (s.isChaos && ts >= s.nextFlipAt) {
        s.direction  *= -1;
        s.nextFlipAt  = ts + 400 + Math.random() * 2400;
      }
      s.angle += s.magnitude * s.direction * velocity;
      s.el.style.transform = `rotate(${s.angle}deg)`;
    }
  }

  function cleanup() {
    if (bgEl)    { bgEl.classList.add("rave-off");    bgEl.style.opacity    = "1"; }
    if (spotsEl) { spotsEl.classList.add("rave-off"); spotsEl.style.opacity = "1"; }
    // Restore beam widths so next session starts clean
    for (const s of spots) s.el.style.width = `${s.baseWidth}px`;
    fadeAlpha = 1;
    Music.stop();
    document.body.classList.remove("rave-active");
  }

  // ============================================================
  // Init — build spotlights and pick a random theme for this session
  // ============================================================
  document.addEventListener("DOMContentLoaded", () => {
    bgEl    = document.getElementById("rave-bg");
    spotsEl = document.getElementById("spotlights");
    activeTheme = Math.floor(Math.random() * THEMES.length);
    initSpotlights(spotsEl);
  });

  return { startRave, decelerate, onWheelStopped, fadeOut, stopAll, setTheme, getThemes };
})();
