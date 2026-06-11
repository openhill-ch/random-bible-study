/* ============================================================
   script.js — state machine + orchestration
   ============================================================ */

(() => {
  "use strict";

  // ── Color palette — fun, saturated, no two adjacent can match ──
  const PALETTE = [
    "#FF0080", // hot magenta
    "#FFE600", // electric yellow
    "#FF3D00", // red-orange
    "#00FF94", // neon green
    "#7B00FF", // deep violet
    "#00CFFF", // laser blue
    "#FF6A00", // vivid orange
    "#FF00FF", // pure magenta
    "#00FF00", // acid green
    "#0040FF", // cobalt blue
    "#FF1744", // rave red
    "#CCFF00", // yellow-green
  ];

  // Assign a color to each slot so no two adjacent slots share a color.
  // Also wraps: last slice can't match first (circular).
  function assignColors(count) {
    const colors = [];
    for (let i = 0; i < count; i++) {
      const prev      = i > 0 ? colors[i - 1] : null;
      const wrapFirst = i === count - 1 ? colors[0] : null;
      const forbidden = new Set([prev, wrapFirst]);
      const available = PALETTE.filter(c => !forbidden.has(c));
      colors.push(available[Math.floor(Math.random() * available.length)]);
    }
    return colors;
  }

  // Fisher-Yates shuffle — returns new array
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── State ──
  const STATES = Object.freeze({
    LANDING: "LANDING", RAVING: "RAVING", DECEL: "DECEL",
    REVEAL: "REVEAL",   LOCK_IN: "LOCK_IN", COMPLETE: "COMPLETE",
  });

  const SPIN_SEQUENCE = [
    { kind: "book", slot: 1 }, { kind: "chapter", slot: 1 },
    { kind: "book", slot: 2 }, { kind: "chapter", slot: 2 },
    { kind: "book", slot: 3 }, { kind: "chapter", slot: 3 },
  ];

  const ROW_H = 26; // px — must match CSS .docket-track li height

  const state = {
    phase: STATES.LANDING,
    spinIndex: 0,
    assignments: [null, null, null],
    currentBookForSlot: null,
    // Current shuffled items on the wheel + their colors
    wheelItems: [],   // [{name, chapters?, originalIndex?}, ...]
    wheelColors: [],  // color per slot, same order as wheelItems
  };

  // Locked-in button letter colors (shuffled PALETTE subset, unique).
  // Picked once on the first spin and reused for every label until reset.
  let buttonLetterColors = null;

  // ── Wheel RAF ──
  let wheelAngle = 0;
  let wheelSpeed = 0;
  let animFrame  = null;

  const BASE_SPEED  = 14;   // deg/frame for 66 items
  const MAX_SPEED   = 60;   // cap so the wheel doesn't become an invisible blur
  const FRICTION    = 0.97;   // ~2.5-3.3s stop. Slow enough that the
                              // wagon-wheel backwards illusion has time
                              // to gradually fade as the strobes ramp
                              // down — feels like everything is slowing
                              // together, not snapping to a halt.
  const STOP_THRESH = 0.05;

  // Scale spin speed so the same number of items fly past the pointer per frame,
  // regardless of how few slices there are (3 chapters feels as exciting as 66 books).
  function fullSpeedForCount(count) {
    return Math.min(BASE_SPEED * (66 / count), MAX_SPEED);
  }

  // ── Docket (driven by wheel angle, no independent RAF) ──
  let docketTotal = 0;

  // ── DOM ──
  const el = {
    wheel:       document.getElementById("wheel"),
    spinButton:  document.getElementById("spin-button"),
    takeover:    document.getElementById("takeover"),
    docketTrack: document.getElementById("docket-track"),
    wheelTitle:  document.getElementById("wheel-title"),
    studyRow:    document.getElementById("study-row"),
    nowPlaying:  document.getElementById("now-playing-title"),
    upcoming1:   document.getElementById("upcoming-1"),
    upcoming2:   document.getElementById("upcoming-2"),
    upcoming3:   document.getElementById("upcoming-3"),
    studySlots:  () => document.querySelectorAll(".study-slot"),
  };

  // ============================================================
  // Init
  // ============================================================
  function init() {
    setupBookWheel();
    paintAllSlotsRave();   // pre-color the (invisible) study boxes
    paintButtonRave();     // pre-pick button border + letter colors
    raveifyTitle();        // pre-wrap title letters with rave colors
    setButtonText("Spin"); // pre-wrap button letters with rave colors
    buildThemePicker();
    el.spinButton.addEventListener("click", onSpinClicked);
    // Keep Now Playing / Next Up in sync with actual audio state (not the spin button)
    if (typeof Music !== "undefined" && Music.onChange) {
      let lastCurrent = null;
      Music.onChange(({ current, upcoming }) => {
        const newCurrent = current || "—";
        // When the track actually changes, fly the "on deck" text up into
        // the Now Playing slot as a little visual handoff.
        if (newCurrent !== lastCurrent && newCurrent !== "—" && lastCurrent !== null) {
          animateDeckPromotion(newCurrent);
        }
        lastCurrent = newCurrent;

        if (el.nowPlaying) el.nowPlaying.textContent = newCurrent;
        const slots = [el.upcoming1, el.upcoming2, el.upcoming3];
        slots.forEach((node, i) => {
          if (!node) return;
          const name = (upcoming && upcoming[i]) || "—";
          if (node.firstElementChild) node.firstElementChild.textContent = name;
          else node.textContent = name;
        });
      });
    }
    setPhase(STATES.LANDING);
  }

  // ============================================================
  // Book wheel — shuffled order, synced to docket
  // ============================================================
  function setupBookWheel() {
    // Shuffle books into random order
    const shuffled = shuffle(BIBLE_BOOKS.map((b, i) => ({ ...b, originalIndex: i })));
    const colors   = assignColors(shuffled.length);

    state.wheelItems  = shuffled;
    state.wheelColors = colors;
    state.wheelMode   = "books";
    state.chapterCount = 0;

    renderWheel(shuffled.map(b => b.name), colors, false);
    buildDocket(shuffled, colors);
    syncDocketToWheel();
  }

  // ============================================================
  // Chapter wheel — shuffled chapters, same sync logic
  // ============================================================
  function setupChapterWheel(chapterCount) {
    // Chapters 1..N in shuffled order
    const shuffled = shuffle(
      Array.from({ length: chapterCount }, (_, i) => ({ name: String(i + 1), num: i + 1 }))
    );
    const colors = assignColors(shuffled.length);

    state.wheelItems   = shuffled;
    state.wheelColors  = colors;
    state.wheelMode    = "chapters";
    state.chapterCount = chapterCount;

    renderWheel(shuffled.map(c => c.name), colors, true);
    buildDocket(shuffled, colors);
    syncDocketToWheel();
  }

  // ============================================================
  // Wheel rendering
  // ============================================================
  function renderWheel(labels, colors, isChapter) {
    wheelAngle = 0;
    wheelSpeed = 0;
    el.wheel.style.transform = "rotate(0deg)";
    el.wheel.innerHTML = "";

    const total  = labels.length;
    const segDeg = 360 / total;

    const stops = labels.map((_, i) => {
      const s = (i * segDeg).toFixed(4);
      const e = ((i + 1) * segDeg).toFixed(4);
      return `${colors[i]} ${s}deg ${e}deg`;
    }).join(", ");
    el.wheel.style.background = `conic-gradient(from -${segDeg / 2}deg, ${stops})`;

    // Slice dividers — skip if only 1 slice
    for (let i = 0; i < (total > 1 ? total : 0); i++) {
      const div = document.createElement("div");
      div.className = "wheel-divider";
      div.style.transform = `translateX(-50%) rotate(${i * segDeg - segDeg / 2}deg)`;
      el.wheel.appendChild(div);
    }

    const labelRadius = total <= 24 ? 36 : 42;
    labels.forEach((text, i) => {
      const angle = i * segDeg - 90;
      const rad   = angle * Math.PI / 180;
      const label = document.createElement("div");
      label.className   = "wheel-label" + (isChapter ? " chapter-label" : "");
      label.textContent = text;
      label.style.left  = `${50 + labelRadius * Math.cos(rad)}%`;
      label.style.top   = `${50 + labelRadius * Math.sin(rad)}%`;
      const flip = angle > 0 && angle < 180;
      label.style.transform = `translate(-50%, -50%) rotate(${flip ? angle + 180 : angle}deg)`;
      el.wheel.appendChild(label);
    });
  }

  // ============================================================
  // Docket — rebuilt to match whatever is on the wheel
  // ============================================================
  function buildDocket(items, colors) {
    el.docketTrack.innerHTML = "";

    const windowEl     = document.getElementById("docket-window");
    const windowH      = windowEl ? windowEl.clientHeight : window.innerHeight;
    const oneHeight    = items.length * ROW_H;
    const copiesNeeded = Math.ceil(windowH / oneHeight) + 2;

    for (let c = 0; c < copiesNeeded; c++) {
      items.forEach((item, i) => {
        const li = document.createElement("li");
        li.dataset.slotIndex = i;
        li.style.background  = colors[i];
        const chapInfo = item.chapters != null ? `${item.chapters} ch` : "";
        li.innerHTML = `<span>${item.name}</span>${chapInfo ? `<span class="docket-chapters">${chapInfo}</span>` : ""}`;
        el.docketTrack.appendChild(li);
      });
    }

    docketTotal = oneHeight;
    el.docketTrack.style.transform = "translateY(0px)";
  }

  function syncDocketToWheel() {
    const total    = state.wheelItems.length;
    const segDeg   = 360 / total;
    const norm     = ((-wheelAngle % 360) + 360) % 360;
    const fracIdx  = norm / segDeg; // continuous fractional slot index 0..total

    const windowEl = document.getElementById("docket-window");
    const windowH  = windowEl ? windowEl.clientHeight : 600;
    const rawOffset = fracIdx * ROW_H - windowH / 2 + ROW_H / 2;
    const offset    = ((rawOffset % docketTotal) + docketTotal) % docketTotal;
    el.docketTrack.style.transform = `translateY(-${offset}px)`;
  }

  function highlightDocket(slotIndex) {
    el.docketTrack.querySelectorAll("li").forEach(li => li.classList.remove("highlight"));
    if (slotIndex == null) return;
    el.docketTrack.querySelectorAll(`li[data-slot-index="${slotIndex}"]`)
      .forEach(li => li.classList.add("highlight"));

    // Snap docket so the landed item sits exactly at the center pointer
    const windowEl  = document.getElementById("docket-window");
    const windowH   = windowEl ? windowEl.clientHeight : 600;
    const rawOffset = slotIndex * ROW_H - windowH / 2 + ROW_H / 2;
    const offset    = ((rawOffset % docketTotal) + docketTotal) % docketTotal;
    el.docketTrack.style.transform = `translateY(-${offset}px)`;
  }

  // ============================================================
  // Wheel RAF loop
  // ============================================================
  function spinLoop() {
    wheelAngle += wheelSpeed;
    el.wheel.style.transform = `rotate(${wheelAngle}deg)`;
    syncDocketToWheel();

    if (state.phase === STATES.DECEL) {
      wheelSpeed *= FRICTION;
      if (wheelSpeed < STOP_THRESH) {
        cancelAnimationFrame(animFrame);
        animFrame = null;
        onWheelStopped();
        return;
      }
    }

    animFrame = requestAnimationFrame(spinLoop);
  }

  function onWheelStopped() {
    // Freeze + thicken the spotlights the moment the wheel lands.
    Disco.onWheelStopped();

    const spinDef   = SPIN_SEQUENCE[state.spinIndex];
    const slotIndex = angleToSlotIndex();
    const item      = state.wheelItems[slotIndex];

    let result;
    if (spinDef.kind === "book") {
      result = { book: item, slotIndex, display: item.name };
      highlightDocket(slotIndex);
    } else {
      result = { chapter: item.num, slotIndex, display: String(item.num), subtitle: state.currentBookForSlot.name };
      highlightDocket(slotIndex);
    }

    reveal(spinDef, result);
  }

  // Converts current wheelAngle to the slot index under the pointer
  function angleToSlotIndex() {
    const total  = state.wheelItems.length;
    const segDeg = 360 / total;
    const norm   = ((-wheelAngle % 360) + 360) % 360;
    return Math.floor((norm + segDeg / 2) / segDeg) % total;
  }

  // ============================================================
  // State machine
  // ============================================================
  function setPhase(next) {
    state.phase = next;
    document.body.dataset.phase = next;
  }

  function onSpinClicked() {
    switch (state.phase) {
      case STATES.LANDING:
      case STATES.LOCK_IN:  startRave();  break;
      case STATES.RAVING:   beginDecel(); break;
      case STATES.COMPLETE: resetAll();   break;
    }
  }

  function startRave() {
    setPhase(STATES.RAVING);
    // Reveal the study row on the first spin; leave the title in place above it.
    if (el.studyRow) el.studyRow.classList.remove("is-invisible");
    // Title + button letters + colors are pre-wrapped at init / reset,
    // so there's zero DOM work to do here — just flip the label.
    setButtonText("Stop");
    wheelSpeed = fullSpeedForCount(state.wheelItems.length);
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(spinLoop);
    Disco.startRave();
  }

  function beginDecel() {
    setPhase(STATES.DECEL);
    // Button stays "Stop" and clickable — extra clicks are a no-op via the
    // state machine (onSpinClicked has no DECEL/REVEAL cases), so fidget-
    // spinner mashers get the illusion of control.
    wheelAngle += Math.random() * 360;
    Disco.decelerate();
  }

  function reveal(spinDef, result) {
    setPhase(STATES.REVEAL);
    // Leave the button clickable — onSpinClicked ignores REVEAL-phase clicks.
    Particles.detonate();
    if (result.subtitle) {
      el.takeover.innerHTML = `<div class="takeover-subtitle">${result.subtitle}</div><div>${result.display}</div>`;
    } else {
      el.takeover.textContent = result.display;
    }
    el.takeover.classList.remove("hidden");

    setTimeout(() => {
      el.takeover.classList.add("hidden");
      lockIn(spinDef, result);
    }, 3000);
  }

  function lockIn(spinDef, result) {
    setPhase(STATES.LOCK_IN);

    if (spinDef.kind === "book") {
      state.currentBookForSlot = result.book;
      // Populate the box with the book name right away — chapter will fill in next.
      fillStudySlotBook(spinDef.slot, result.book.name);
      state.spinIndex += 1;
      setupChapterWheel(result.book.chapters);
      setButtonText("Spin");
    } else {
      state.assignments[spinDef.slot - 1] = {
        book: state.currentBookForSlot, chapter: result.chapter,
      };
      state.currentBookForSlot = null;
      updateStudySlot(spinDef.slot);

      state.spinIndex += 1;
      if (state.spinIndex >= SPIN_SEQUENCE.length) {
        finishAll();
        return;
      }
      // Next assignment — fresh shuffle
      setupBookWheel();
      setButtonText("Spin");
    }
  }

  function finishAll() {
    setPhase(STATES.COMPLETE);
    el.spinButton.disabled    = false;
    el.spinButton.textContent = "New Random Bible Study";
    // Rave keeps going — the disco stays in loiter, music switches to the
    // finale track. Only "New Random Bible Study" ends the party (resetAll).
    if (typeof Music !== "undefined" && Music.play) Music.play("Into The BibleVerse");
  }

  function resetAll() {
    Disco.stopAll();
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    wheelSpeed = 0; wheelAngle = 0;

    state.spinIndex          = 0;
    state.assignments        = [null, null, null];
    state.currentBookForSlot = null;

    el.studySlots().forEach(node => {
      node.classList.remove("filled");
      node.querySelector(".study-book").textContent    = "—";
      node.querySelector(".study-chapter").textContent = "";
    });

    // Hide the study row (but keep its layout) until the next first spin.
    if (el.studyRow) el.studyRow.classList.add("is-invisible");
    // Re-roll rave colors for the fresh session while the row is invisible.
    // Everything stays pre-wrapped so the next first-spin is instant.
    paintAllSlotsRave();
    paintButtonRave();
    raveifyTitle();
    setButtonText("Spin");

    el.spinButton.disabled = false;
    setupBookWheel();
    setPhase(STATES.LANDING);
  }

  // Convert a #RRGGBB hex color to an rgba() string at a given alpha.
  function hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ── Deck-promotion animation ─────────────────────────────────
  // When a song changes, clone the "on deck" text and fly it up to the
  // Now Playing slot, morphing size/weight/opacity en route. The real
  // Now Playing text is hidden under the ghost so the transition reads
  // as a single element promoting itself into focus.
  function animateDeckPromotion(newText) {
    if (!el.upcoming1 || !el.nowPlaying) return;

    const fromRect  = el.upcoming1.getBoundingClientRect();
    const toRect    = el.nowPlaying.getBoundingClientRect();
    const fromStyle = getComputedStyle(el.upcoming1);
    const toStyle   = getComputedStyle(el.nowPlaying);

    const ghost = document.createElement("div");
    ghost.textContent = newText;
    Object.assign(ghost.style, {
      position:    "fixed",
      left:        `${fromRect.left}px`,
      top:         `${fromRect.top}px`,
      margin:      "0",
      fontFamily:  fromStyle.fontFamily,
      fontSize:    fromStyle.fontSize,
      fontWeight:  fromStyle.fontWeight,
      color:       fromStyle.color,
      opacity:     fromStyle.opacity,
      whiteSpace:  "nowrap",
      pointerEvents: "none",
      zIndex:      "50",
      transform:   "translate(0, 0)",
      transition:  "transform 0.3s ease-out, font-size 0.3s ease-out, font-weight 0.3s ease-out, color 0.3s ease-out, opacity 0.3s ease-out",
    });
    document.body.appendChild(ghost);
    el.nowPlaying.style.visibility = "hidden";

    requestAnimationFrame(() => {
      const dx = toRect.left - fromRect.left;
      const dy = toRect.top  - fromRect.top;
      ghost.style.transform  = `translate(${dx}px, ${dy}px)`;
      ghost.style.fontSize   = toStyle.fontSize;
      ghost.style.fontWeight = toStyle.fontWeight;
      ghost.style.color      = toStyle.color;
      ghost.style.opacity    = "1";
    });

    setTimeout(() => {
      el.nowPlaying.style.visibility = "";
      ghost.remove();
    }, 320);
  }

  // ── Dev theme picker ─────────────────────────────────────────
  // Small panel in the bottom-right with one swatch-row per theme.
  // Clicking a row swaps the active spotlight theme. Dev-only; the
  // session still starts on a random theme — this just lets us try
  // them live.
  function buildThemePicker() {
    if (!window.Disco || !Disco.getThemes) return;
    const panel = document.createElement("div");
    panel.className = "theme-picker";
    panel.innerHTML = `<div class="theme-picker-label">Strobe Theme</div>`;
    Disco.getThemes().forEach(theme => {
      const row = document.createElement("button");
      row.type      = "button";
      row.className = "theme-row";
      row.title     = theme.name;
      const swatches = theme.colors
        .map(c => `<span class="theme-swatch" style="background:${c}"></span>`).join("");
      row.innerHTML = `${swatches}<span class="theme-name">${theme.name}</span>`;
      row.addEventListener("click", () => Disco.setTheme(theme.index));
      panel.appendChild(row);
    });
    document.body.appendChild(panel);
  }

  // Pick a random rave color for a slot and paint it on — semi-transparent
  // fill with an opaque border so the boxes feel a bit glassy.
  function paintSlotRave(node) {
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    node.style.background  = hexToRgba(color, 0.55);
    node.style.borderColor = color;
    node.style.borderWidth = "2px";
    node.style.borderStyle = "solid";
    node.dataset.raveColor = color;
  }

  // Wrap each character of the title in a <span.rave-letter> and paint a
  // random rave color + matching glow on each one. Called at startRave.
  // Spaces are preserved as plain text nodes so line breaks still flow.
  function raveifyTitle() {
    if (!el.wheelTitle) return;
    const text = el.wheelTitle.dataset.plainText
              || (el.wheelTitle.dataset.plainText = el.wheelTitle.textContent);
    el.wheelTitle.innerHTML = "";
    // Pick non-repeating colors for adjacent letters so the title has variety.
    let lastColor = null;
    for (const ch of text) {
      if (ch === " ") {
        el.wheelTitle.appendChild(document.createTextNode(" "));
        continue;
      }
      const span = document.createElement("span");
      span.className   = "rave-letter";
      span.textContent = ch;
      const choices = PALETTE.filter(c => c !== lastColor);
      const color   = choices[Math.floor(Math.random() * choices.length)];
      lastColor = color;
      // Stash colors in CSS vars; the visible styling only kicks in under
      // body.rave-active, so pre-wrapping at load is invisible until rave.
      span.style.setProperty("--letter-color", color);
      span.style.setProperty("--glow", color);
      el.wheelTitle.appendChild(span);
    }
  }

  // Restore the title to plain text (on reset, so the landing page looks normal).
  function deraveifyTitle() {
    if (!el.wheelTitle) return;
    if (el.wheelTitle.dataset.plainText) {
      el.wheelTitle.textContent = el.wheelTitle.dataset.plainText;
    }
  }

  // Paint all three slots with fresh random rave colors — guaranteed unique,
  // no two slots share a color. Called at startup (while invisible) and on reset.
  // Pick a random rave color for the Spin/Stop button (border + glow).
  // Text stays glowing white; only --rave-color changes.
  // Set the button's label. In rave mode, wrap each letter in a rave-letter
  // span with a random color (like raveifyTitle). Otherwise plain text.
  // Always builds rave-letter spans using the pre-picked buttonLetterColors.
  // Visible styling is gated by body.rave-active in CSS, so pre-wrapping
  // at load costs nothing visually and prevents a first-spin lag spike.
  function setButtonText(text) {
    if (!buttonLetterColors) { el.spinButton.textContent = text; return; }
    el.spinButton.innerHTML = "";
    let colorIdx = 0;
    for (const ch of text) {
      if (ch === " ") { el.spinButton.appendChild(document.createTextNode(" ")); continue; }
      const span = document.createElement("span");
      span.className   = "rave-letter";
      span.textContent = ch;
      const color = buttonLetterColors[colorIdx % buttonLetterColors.length];
      colorIdx += 1;
      span.style.setProperty("--letter-color", color);
      span.style.setProperty("--glow", color);
      el.spinButton.appendChild(span);
    }
  }

  // Called once, on the very first Spin of the session. Locks in:
  //   - border/fill rave color for the button
  //   - a distinct-per-letter color palette (no duplicates) reused for
  //     every "Spin"/"Stop" label change until the session resets
  function paintButtonRave() {
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    el.spinButton.style.setProperty("--rave-color", color);
    el.spinButton.style.setProperty("--rave-fill", hexToRgba(color, 0.55));
    // Reserve 6 unique letter colors — "Spin"/"Stop" are 4 letters, so
    // there's plenty of headroom and no repeats within the word.
    buttonLetterColors = shuffle(PALETTE).slice(0, 6);
  }

  function paintAllSlotsRave() {
    const shuffled = shuffle(PALETTE);
    el.studySlots().forEach((node, i) => {
      const color = shuffled[i % shuffled.length];
      node.style.background  = hexToRgba(color, 0.55);
      node.style.borderColor = color;
      node.style.borderWidth = "2px";
      node.style.borderStyle = "solid";
      node.dataset.raveColor = color;
    });
  }

  function fillStudySlotBook(slot, bookName) {
    const node = document.querySelector(`.study-slot[data-slot="${slot}"]`);
    if (!node) return;
    // Color was already painted at init/reset — just mark filled + set text.
    node.classList.add("filled");
    node.querySelector(".study-book").textContent    = bookName;
    node.querySelector(".study-chapter").textContent = "";
  }

  function updateStudySlot(slot) {
    const assign = state.assignments[slot - 1];
    if (!assign) return;
    const node = document.querySelector(`.study-slot[data-slot="${slot}"]`);
    node.classList.add("filled");
    node.querySelector(".study-book").textContent    = `${assign.book.name} ${assign.chapter}`;
    node.querySelector(".study-chapter").textContent = "";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
