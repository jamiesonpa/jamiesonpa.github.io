// Logi optimization analysis runner + plots.
//
// Architecture (mirrors analysis.js but with a single experiment family):
//   1. Controls describe the red fleet (single fixed setting), the green
//      fleet's Nightmare counts to sweep (a list -> one plot card each),
//      the green Scimitar baseline + the symmetric deltas to apply
//      around it, plus trial budget. Read live from the DOM each time
//      experiments are resolved so the user can edit and see the grid
//      update without rerunning.
//   2. resolveExperiments(controls) materialises the controls into a
//      list of { id, nightmares, settings: [{ scimitars, greenOverride,
//      redOverride, ... }] } objects. Settings are deduped + clamped
//      to >= 0 scimitars.
//   3. runAll() iterates experiments x settings x trials, calling the
//      shared runBattle() from headless.js. We interleave trials so each
//      setting's CI tightens in lockstep on the live plot.
//   4. Plots are inline SVG, hand-drawn (no chart library). Three kinds:
//        a) per-experiment sweep card (mean +/- 95% CI + raw trial dots)
//        b) overlay plot stacking all nightmare-count series on one axis
//        c) compact text table per card with summary numbers
//
// All overrides target the GREEN team unless the experiment opts in to
// symmetric application. Red is held at the user-specified fixed values
// for every battle in the run.

import { FLEET_CONFIG } from "./constants.js";
import { runBattle, snapshotConfig } from "./headless.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  running: false,
  paused: false,
  cancelRequested: false,
  experiments: [], // resolved list
  results: new Map(), // experimentId -> [{ setting, trials: [...] }]
  startTimeMs: 0,
  totalBattles: 0,
  doneBattles: 0,
};

// Per-series colors for the overlay plot. Picked to be distinguishable on
// the dark background; cycled if the user asks for more nightmare counts
// than we have palette slots (rare in practice).
const SERIES_COLORS = [
  "#5dd17a", // green
  "#9bbcff", // blue
  "#ffd060", // amber
  "#f06464", // red
  "#c89aff", // purple
  "#6ff0c4", // teal
  "#ff8a3d", // orange
  "#aab4c8", // grey
];

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function clampInt(id, lo, hi, fallback) {
  const el = document.getElementById(id);
  let v = parseInt(el.value, 10);
  if (Number.isNaN(v)) v = fallback;
  v = Math.max(lo, Math.min(hi, v));
  el.value = v;
  return v;
}

// Parse a comma- (or whitespace-) separated list of non-negative integers
// from a text input. Returns the parsed list (with negatives dropped /
// non-numerics dropped); if the input is empty or fully invalid we
// reset the input to the supplied fallback and return a copy of it.
function parseIntList(id, fallback) {
  const el = document.getElementById(id);
  const text = (el.value || "").trim();
  if (!text) {
    el.value = fallback.join(", ");
    return [...fallback];
  }
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  const parsed = [];
  for (const t of tokens) {
    const v = parseInt(t, 10);
    if (Number.isFinite(v)) parsed.push(v);
  }
  if (parsed.length === 0) {
    el.value = fallback.join(", ");
    return [...fallback];
  }
  return parsed;
}

function readControls() {
  return {
    red: {
      nightmares: clampInt("ctrl-red-nightmares", 0, 500, 50),
      scimitars: clampInt("ctrl-red-scimitars", 0, 100, 5),
      subfleets: clampInt("ctrl-red-subfleets", 1, 6, 1),
    },
    green: {
      nightmaresList: parseIntList("ctrl-green-nightmares", [30, 50, 75, 100])
        .map((v) => Math.max(0, v)),
      baseScim: clampInt("ctrl-green-base-scim", 0, 100, 5),
      deltas: parseIntList(
        "ctrl-green-deltas",
        [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]
      ).filter((v) => v > 0),
      subfleets: clampInt("ctrl-green-subfleets", 1, 6, 1),
    },
    trials: clampInt("ctrl-trials", 1, 500, 30),
    simCap: clampInt("ctrl-simcap", 60, 7200, 600),
  };
}

// ---------------------------------------------------------------------------
// Experiment construction
// ---------------------------------------------------------------------------

// Convert a baseline scimitar count + symmetric deltas into a sorted,
// deduplicated, clamped-to->=0 list of scimitar counts to sweep. The base
// itself is always included (delta=0 implicitly).
function buildScimCounts(base, deltas) {
  const set = new Set();
  set.add(Math.max(0, Math.round(base)));
  for (const d of deltas) {
    if (!Number.isFinite(d) || d <= 0) continue;
    set.add(Math.max(0, Math.round(base - d)));
    set.add(Math.max(0, Math.round(base + d)));
  }
  return [...set].sort((a, b) => a - b);
}

function resolveExperiments(controls) {
  const out = [];
  const scims = buildScimCounts(controls.green.baseScim, controls.green.deltas);
  for (const nmRaw of controls.green.nightmaresList) {
    const nm = Math.max(0, Math.round(nmRaw));
    const settings = scims.map((s) => ({
      x: s,
      xRaw: s,
      label: String(s),
      scimitars: s,
      greenOverride: {
        nightmareCount: nm,
        scimitarCount: s,
        subfleetCount: controls.green.subfleets,
      },
      redOverride: {
        nightmareCount: controls.red.nightmares,
        scimitarCount: controls.red.scimitars,
        subfleetCount: controls.red.subfleets,
      },
      tooltip:
        `Green ${nm}N + ${s}S vs Red ${controls.red.nightmares}N + ${controls.red.scimitars}S`,
    }));
    out.push({
      id: `nm-${nm}`,
      nightmares: nm,
      label: `${nm} green Nightmares`,
      desc:
        `Sweep green Scimitar count with ${nm} green Nightmares vs red ` +
        `${controls.red.nightmares}N + ${controls.red.scimitars}S ` +
        `(red held fixed across all settings).`,
      xLabel: "Green Scimitar count",
      settings,
    });
  }
  return out;
}

function totalBattlesFor(experiments, trials) {
  let n = 0;
  for (const e of experiments) n += e.settings.length * trials;
  return n;
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

async function runAll() {
  if (state.running) return;
  state.running = true;
  state.paused = false;
  state.cancelRequested = false;

  const controls = readControls();
  // Snapshot the live FLEET_CONFIG so we can restore it on exit. Each
  // runBattle() call also restores per-call, but we keep this belt-and-
  // braces guard in case any future code path leaks.
  const baseline = snapshotConfig();
  // Rebuild from current controls so the grid + result slots are fresh
  // (also resets state.results, wiping any stale trials).
  rebuildGridFromControls();
  const experiments = state.experiments;

  state.startTimeMs = performance.now();
  state.totalBattles = totalBattlesFor(experiments, controls.trials);
  state.doneBattles = 0;

  updateProgress();

  setButtons(true);
  setStatus("Running...");

  try {
    for (const exp of experiments) {
      if (state.cancelRequested) break;
      const slots = state.results.get(exp.id);
      // Interleave: trial 1 across every setting in the experiment, then
      // trial 2 across every setting, etc. This keeps each setting's CI
      // tightening together so the live plot reads as "filling in"
      // rather than "fully resolved left-to-right".
      for (let t = 0; t < controls.trials; t++) {
        for (let i = 0; i < exp.settings.length; i++) {
          if (state.cancelRequested) break;
          while (state.paused && !state.cancelRequested) {
            await sleep(150);
          }
          if (state.cancelRequested) break;
          const setting = exp.settings[i];
          const result = runBattle({
            greenCfg: setting.greenOverride,
            redCfg: setting.redOverride,
            maxSimTime: controls.simCap,
          });
          slots[i].trials.push(result);
          state.doneBattles++;

          // Cooperative yield + DOM update. Every 4 battles or whenever
          // a setting completes a fresh trial round so the page stays
          // responsive without paying for a full re-render every battle.
          if (state.doneBattles % 4 === 0 || i === exp.settings.length - 1) {
            renderExperimentPlot(exp);
            renderOverlay();
            updateProgress();
            await sleep(0);
          }
        }
      }
      renderExperimentPlot(exp);
      renderOverlay();
    }
  } finally {
    // Restore baseline (snapshotConfig captured the pre-run values).
    for (const team of ["green", "red"]) {
      for (const k of Object.keys(baseline[team])) {
        FLEET_CONFIG[team][k] = baseline[team][k];
      }
    }
    state.running = false;
    state.paused = false;
    setButtons(false);
    if (state.cancelRequested) setStatus("Cancelled.");
    else setStatus("Done.");
    updateProgress();
    document.getElementById("btn-download").disabled = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function trialShipMargin(t) {
  return t.green.alive - t.red.alive;
}
function trialHpMargin(t) {
  return t.green.hpFraction - t.red.hpFraction;
}

function summariseTrials(trials) {
  const n = trials.length;
  if (n === 0) {
    return {
      n: 0,
      meanShip: 0,
      seShip: 0,
      ciShip: 0,
      meanHp: 0,
      seHp: 0,
      ciHp: 0,
      greenWins: 0,
      redWins: 0,
      draws: 0,
      timeouts: 0,
      meanSimTime: 0,
    };
  }
  let sumShip = 0,
    sumShipSq = 0;
  let sumHp = 0,
    sumHpSq = 0;
  let g = 0,
    r = 0,
    d = 0,
    to = 0;
  let sumT = 0;
  for (const t of trials) {
    const s = trialShipMargin(t);
    const h = trialHpMargin(t);
    sumShip += s;
    sumShipSq += s * s;
    sumHp += h;
    sumHpSq += h * h;
    if (t.winner === "green") g++;
    else if (t.winner === "red") r++;
    else d++;
    if (t.timedOut) to++;
    sumT += t.simTime;
  }
  const meanShip = sumShip / n;
  const meanHp = sumHp / n;
  const varShip = n > 1 ? (sumShipSq - n * meanShip * meanShip) / (n - 1) : 0;
  const varHp = n > 1 ? (sumHpSq - n * meanHp * meanHp) / (n - 1) : 0;
  const seShip = Math.sqrt(Math.max(0, varShip) / n);
  const seHp = Math.sqrt(Math.max(0, varHp) / n);
  // 95% CI half-width using normal approximation. With trials default of
  // 30 the t-correction would be a few percent at most; not worth it.
  const ciShip = 1.96 * seShip;
  const ciHp = 1.96 * seHp;
  return {
    n,
    meanShip,
    seShip,
    ciShip,
    meanHp,
    seHp,
    ciHp,
    greenWins: g,
    redWins: r,
    draws: d,
    timeouts: to,
    meanSimTime: sumT / n,
  };
}

// ---------------------------------------------------------------------------
// Plotting helpers
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    if (attrs[k] === undefined || attrs[k] === null) continue;
    e.setAttribute(k, attrs[k]);
  }
  for (const c of kids) {
    if (c == null) continue;
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

// "Nice" tick spacing for the y-axis: choose a step from {1,2,5}*10^k that
// produces ~targetCount ticks across [lo, hi]. Always includes 0 if it
// lies inside the range.
function niceTicks(lo, hi, targetCount) {
  if (lo === hi) return [lo];
  const range = hi - lo;
  const rawStep = range / Math.max(1, targetCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  if (lo <= 0 && hi >= 0 && !ticks.includes(0)) ticks.push(0);
  ticks.sort((a, b) => a - b);
  return ticks;
}

function formatY(v) {
  if (v === 0) return "0";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Per-experiment grid
// ---------------------------------------------------------------------------

function buildExperimentGrid(experiments) {
  const grid = document.getElementById("experiment-grid");
  grid.innerHTML = "";
  for (const exp of experiments) {
    const card = document.createElement("div");
    card.className = "exp-card";
    card.dataset.expId = exp.id;
    const h = document.createElement("h3");
    h.textContent = exp.label;
    card.appendChild(h);
    if (exp.desc) {
      const p = document.createElement("p");
      p.className = "exp-desc";
      p.textContent = exp.desc;
      card.appendChild(p);
    }
    const plot = document.createElement("div");
    plot.className = "exp-plot";
    card.appendChild(plot);
    const tab = document.createElement("div");
    tab.className = "exp-table";
    card.appendChild(tab);
    grid.appendChild(card);
  }
}

function renderExperimentPlot(exp) {
  const card = document.querySelector(`.exp-card[data-exp-id="${exp.id}"]`);
  if (!card) return;
  const plotDiv = card.querySelector(".exp-plot");
  const tabDiv = card.querySelector(".exp-table");

  const slots = state.results.get(exp.id);
  const summaries = slots.map((s) => summariseTrials(s.trials));

  // Pick y range from observed margins +/- their CIs, with sensible
  // padding and a guarantee that 0 is on the axis.
  let yMin = 0,
    yMax = 0;
  let anyTrials = false;
  for (let i = 0; i < slots.length; i++) {
    const sum = summaries[i];
    for (const t of slots[i].trials) {
      anyTrials = true;
      const v = trialShipMargin(t);
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    if (sum.n > 0) {
      const lo = sum.meanShip - sum.ciShip;
      const hi = sum.meanShip + sum.ciShip;
      if (lo < yMin) yMin = lo;
      if (hi > yMax) yMax = hi;
    }
  }
  if (!anyTrials) {
    yMin = -5;
    yMax = 5;
  } else {
    const pad = Math.max(1, (yMax - yMin) * 0.08);
    yMin -= pad;
    yMax += pad;
  }
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }

  const W = 460,
    H = 240;
  const M = { l: 44, r: 14, t: 10, b: 42 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  // x maps the categorical setting index to a pixel position (evenly
  // spaced). xRaw (the actual scimitar count) is shown as the tick label
  // so the user reads the actual swept value.
  const xToPx = (i) => {
    if (exp.settings.length === 1) return M.l + innerW / 2;
    return M.l + (i / (exp.settings.length - 1)) * innerW;
  };
  const yToPx = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    class: "exp-svg",
  });

  svg.appendChild(
    el("rect", {
      x: M.l,
      y: M.t,
      width: innerW,
      height: innerH,
      fill: "rgba(20,28,42,0.6)",
      stroke: "rgba(120,150,200,0.18)",
    })
  );

  const yTicks = niceTicks(yMin, yMax, 5);
  for (const tv of yTicks) {
    const py = yToPx(tv);
    svg.appendChild(
      el("line", {
        x1: M.l,
        y1: py,
        x2: M.l + innerW,
        y2: py,
        stroke: tv === 0 ? "rgba(200,210,230,0.5)" : "rgba(120,150,200,0.12)",
        "stroke-dasharray": tv === 0 ? "4,4" : null,
      })
    );
    svg.appendChild(
      el(
        "text",
        {
          x: M.l - 6,
          y: py + 3,
          "text-anchor": "end",
          "font-size": 10,
          fill: "#9aa6bc",
        },
        formatY(tv)
      )
    );
  }

  // X-axis labels (scimitar count). Skip every other tick if there are
  // many settings to keep labels readable.
  const labelStride =
    exp.settings.length > 14 ? 2 : exp.settings.length > 8 ? 1 : 1;
  for (let i = 0; i < exp.settings.length; i++) {
    const px = xToPx(i);
    svg.appendChild(
      el("line", {
        x1: px,
        y1: M.t + innerH,
        x2: px,
        y2: M.t + innerH + 4,
        stroke: "rgba(120,150,200,0.4)",
      })
    );
    if (i % labelStride === 0) {
      svg.appendChild(
        el(
          "text",
          {
            x: px,
            y: M.t + innerH + 16,
            "text-anchor": "middle",
            "font-size": 10,
            fill: "#cfd6e4",
          },
          exp.settings[i].label
        )
      );
    }
  }
  svg.appendChild(
    el(
      "text",
      {
        x: M.l + innerW / 2,
        y: H - 4,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "#9aa6bc",
      },
      exp.xLabel || "Green Scimitar count"
    )
  );

  svg.appendChild(
    el(
      "text",
      {
        x: 12,
        y: M.t + innerH / 2,
        "text-anchor": "middle",
        "font-size": 11,
        fill: "#9aa6bc",
        transform: `rotate(-90 12 ${M.t + innerH / 2})`,
      },
      "Ships ahead at battle end (green - red)"
    )
  );

  // Connecting line through the means.
  const meanPoints = [];
  for (let i = 0; i < exp.settings.length; i++) {
    const sum = summaries[i];
    if (sum.n > 0) meanPoints.push([xToPx(i), yToPx(sum.meanShip)]);
  }
  if (meanPoints.length >= 2) {
    const path =
      "M" +
      meanPoints
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" L");
    svg.appendChild(
      el("path", {
        d: path,
        stroke: "#5dd17a",
        "stroke-width": 1.5,
        fill: "none",
        "stroke-opacity": 0.55,
      })
    );
  }

  // Per-setting: jittered raw trial dots, then CI bars + mean dot.
  for (let i = 0; i < exp.settings.length; i++) {
    const sum = summaries[i];
    const px = xToPx(i);
    const trials = slots[i].trials;
    for (let j = 0; j < trials.length; j++) {
      const v = trialShipMargin(trials[j]);
      const jitter = ((j * 0.6180339) % 1) * 6 - 3;
      svg.appendChild(
        el("circle", {
          cx: px + jitter,
          cy: yToPx(v),
          r: 1.8,
          fill: "rgba(108,255,138,0.28)",
        })
      );
    }
    if (sum.n > 0) {
      const lo = sum.meanShip - sum.ciShip;
      const hi = sum.meanShip + sum.ciShip;
      svg.appendChild(
        el("line", {
          x1: px,
          y1: yToPx(lo),
          x2: px,
          y2: yToPx(hi),
          stroke: "#9bff9b",
          "stroke-width": 1.5,
        })
      );
      svg.appendChild(
        el("line", {
          x1: px - 4,
          y1: yToPx(hi),
          x2: px + 4,
          y2: yToPx(hi),
          stroke: "#9bff9b",
          "stroke-width": 1.5,
        })
      );
      svg.appendChild(
        el("line", {
          x1: px - 4,
          y1: yToPx(lo),
          x2: px + 4,
          y2: yToPx(lo),
          stroke: "#9bff9b",
          "stroke-width": 1.5,
        })
      );
      const dot = el("circle", {
        cx: px,
        cy: yToPx(sum.meanShip),
        r: 4,
        fill: "#5dd17a",
        stroke: "#0d141f",
        "stroke-width": 1,
      });
      dot.appendChild(
        el(
          "title",
          {},
          `${exp.settings[i].tooltip || exp.settings[i].label}\n` +
            `Mean ships ahead at battle end: ${sum.meanShip.toFixed(2)} ` +
            `(95% CI +/- ${sum.ciShip.toFixed(2)}, n=${sum.n})\n` +
            `Mean HP-fraction margin: ${sum.meanHp.toFixed(3)}\n` +
            `Wins green/red/draw: ${sum.greenWins}/${sum.redWins}/${sum.draws}\n` +
            `Timeouts: ${sum.timeouts}, mean sim time: ${sum.meanSimTime.toFixed(1)}s`
        )
      );
      svg.appendChild(dot);
    }
  }

  plotDiv.innerHTML = "";
  plotDiv.appendChild(svg);

  // Compact text table.
  tabDiv.innerHTML = "";
  const tbl = document.createElement("table");
  const head = document.createElement("tr");
  for (const h of [
    exp.xLabel || "Green Scimitars",
    "n",
    "Mean ships ahead",
    "95% CI",
    "G/R/D",
    "Timeouts",
    "Mean sim t (s)",
  ]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  tbl.appendChild(head);
  for (let i = 0; i < exp.settings.length; i++) {
    const sum = summaries[i];
    const tr = document.createElement("tr");
    const cells = [
      exp.settings[i].label,
      sum.n,
      sum.n > 0 ? sum.meanShip.toFixed(2) : "-",
      sum.n > 0 ? `+/- ${sum.ciShip.toFixed(2)}` : "-",
      sum.n > 0 ? `${sum.greenWins}/${sum.redWins}/${sum.draws}` : "-",
      sum.n > 0 ? sum.timeouts : "-",
      sum.n > 0 ? sum.meanSimTime.toFixed(1) : "-",
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  tabDiv.appendChild(tbl);
}

// ---------------------------------------------------------------------------
// Overlay plot: all nightmare-count series on one axis
// ---------------------------------------------------------------------------

function renderOverlay() {
  const container = document.getElementById("overlay-plot");
  const legend = document.getElementById("overlay-legend");

  // Build a unified x-axis (union of all settings' scimitar counts; in
  // practice every experiment has the same list so this is just that
  // list, but we union to be safe against future per-experiment edits).
  const xSet = new Set();
  for (const exp of state.experiments) {
    for (const s of exp.settings) xSet.add(s.scimitars);
  }
  const xs = [...xSet].sort((a, b) => a - b);
  if (xs.length === 0 || state.experiments.length === 0) {
    container.innerHTML = '<div class="muted">No experiments configured.</div>';
    legend.innerHTML = "";
    return;
  }

  // Collect per-series points.
  const series = [];
  let yMin = 0,
    yMax = 0;
  let anyTrials = false;
  for (let si = 0; si < state.experiments.length; si++) {
    const exp = state.experiments[si];
    const slots = state.results.get(exp.id);
    const points = [];
    for (let i = 0; i < exp.settings.length; i++) {
      const sum = summariseTrials(slots[i].trials);
      if (sum.n === 0) continue;
      anyTrials = true;
      const lo = sum.meanShip - sum.ciShip;
      const hi = sum.meanShip + sum.ciShip;
      if (lo < yMin) yMin = lo;
      if (hi > yMax) yMax = hi;
      points.push({
        x: exp.settings[i].scimitars,
        mean: sum.meanShip,
        ciLo: lo,
        ciHi: hi,
        n: sum.n,
        ci: sum.ciShip,
        wins: `${sum.greenWins}/${sum.redWins}/${sum.draws}`,
      });
    }
    series.push({
      exp,
      color: SERIES_COLORS[si % SERIES_COLORS.length],
      points,
    });
  }
  if (!anyTrials) {
    yMin = -5;
    yMax = 5;
  } else {
    const pad = Math.max(1, (yMax - yMin) * 0.08);
    yMin -= pad;
    yMax += pad;
  }
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }

  const W = Math.max(640, container.clientWidth || 800);
  const H = 360;
  const M = { l: 56, r: 18, t: 14, b: 50 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const xToPx = (xv) => {
    if (xs.length === 1) return M.l + innerW / 2;
    const i = xs.indexOf(xv);
    if (i < 0) return M.l;
    return M.l + (i / (xs.length - 1)) * innerW;
  };
  const yToPx = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    class: "overlay-svg",
  });

  svg.appendChild(
    el("rect", {
      x: M.l,
      y: M.t,
      width: innerW,
      height: innerH,
      fill: "rgba(20,28,42,0.6)",
      stroke: "rgba(120,150,200,0.18)",
    })
  );

  const yTicks = niceTicks(yMin, yMax, 6);
  for (const tv of yTicks) {
    const py = yToPx(tv);
    svg.appendChild(
      el("line", {
        x1: M.l,
        y1: py,
        x2: M.l + innerW,
        y2: py,
        stroke: tv === 0 ? "rgba(200,210,230,0.5)" : "rgba(120,150,200,0.12)",
        "stroke-dasharray": tv === 0 ? "4,4" : null,
      })
    );
    svg.appendChild(
      el(
        "text",
        {
          x: M.l - 8,
          y: py + 3,
          "text-anchor": "end",
          "font-size": 11,
          fill: "#9aa6bc",
        },
        formatY(tv)
      )
    );
  }

  const labelStride = xs.length > 14 ? 2 : 1;
  for (let i = 0; i < xs.length; i++) {
    const px = xToPx(xs[i]);
    svg.appendChild(
      el("line", {
        x1: px,
        y1: M.t + innerH,
        x2: px,
        y2: M.t + innerH + 4,
        stroke: "rgba(120,150,200,0.4)",
      })
    );
    if (i % labelStride === 0) {
      svg.appendChild(
        el(
          "text",
          {
            x: px,
            y: M.t + innerH + 18,
            "text-anchor": "middle",
            "font-size": 11,
            fill: "#cfd6e4",
          },
          String(xs[i])
        )
      );
    }
  }
  svg.appendChild(
    el(
      "text",
      {
        x: M.l + innerW / 2,
        y: H - 6,
        "text-anchor": "middle",
        "font-size": 12,
        fill: "#9aa6bc",
      },
      "Green Scimitar count"
    )
  );
  svg.appendChild(
    el(
      "text",
      {
        x: 16,
        y: M.t + innerH / 2,
        "text-anchor": "middle",
        "font-size": 12,
        fill: "#9aa6bc",
        transform: `rotate(-90 16 ${M.t + innerH / 2})`,
      },
      "Mean ships ahead at battle end (green - red)"
    )
  );

  // Per-series: CI vertical bars (drawn first so dots/lines sit on top),
  // mean polyline, mean dots.
  for (const s of series) {
    if (s.points.length === 0) continue;
    // CI bars (light)
    for (const p of s.points) {
      const px = xToPx(p.x);
      svg.appendChild(
        el("line", {
          x1: px,
          y1: yToPx(p.ciLo),
          x2: px,
          y2: yToPx(p.ciHi),
          stroke: s.color,
          "stroke-width": 1.2,
          "stroke-opacity": 0.45,
        })
      );
    }
    // Mean polyline
    if (s.points.length >= 2) {
      const path =
        "M" +
        s.points
          .map((p) => `${xToPx(p.x).toFixed(1)},${yToPx(p.mean).toFixed(1)}`)
          .join(" L");
      svg.appendChild(
        el("path", {
          d: path,
          stroke: s.color,
          "stroke-width": 1.8,
          fill: "none",
          "stroke-opacity": 0.95,
        })
      );
    }
    // Mean dots with tooltips
    for (const p of s.points) {
      const dot = el("circle", {
        cx: xToPx(p.x),
        cy: yToPx(p.mean),
        r: 3.5,
        fill: s.color,
        stroke: "#0d141f",
        "stroke-width": 1,
      });
      dot.appendChild(
        el(
          "title",
          {},
          `${s.exp.label} @ ${p.x} green Scimitars\n` +
            `Mean ships ahead: ${p.mean.toFixed(2)} ` +
            `(95% CI +/- ${p.ci.toFixed(2)}, n=${p.n})\n` +
            `Wins green/red/draw: ${p.wins}`
        )
      );
      svg.appendChild(dot);
    }
  }

  container.innerHTML = "";
  container.appendChild(svg);

  // Legend
  legend.innerHTML = "";
  for (const s of series) {
    const item = document.createElement("span");
    item.className = "overlay-legend-item";
    const swatch = document.createElement("span");
    swatch.className = "overlay-legend-swatch";
    swatch.style.background = s.color;
    item.appendChild(swatch);
    const label = document.createElement("span");
    label.textContent = s.exp.label;
    item.appendChild(label);
    legend.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Grid lifecycle
// ---------------------------------------------------------------------------

function rebuildGridFromControls() {
  const controls = readControls();
  const experiments = resolveExperiments(controls);
  state.experiments = experiments;
  state.results.clear();
  for (const exp of experiments) {
    const slot = exp.settings.map((s) => ({ setting: s, trials: [] }));
    state.results.set(exp.id, slot);
  }
  buildExperimentGrid(experiments);
  for (const exp of experiments) renderExperimentPlot(exp);
  renderOverlay();
  estimateTotal();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function setStatus(s) {
  document.getElementById("status-text").textContent = s;
}

function setButtons(running) {
  document.getElementById("btn-run").disabled = running;
  document.getElementById("btn-pause").disabled = !running;
  document.getElementById("btn-cancel").disabled = !running;
}

function updateProgress() {
  const bar = document.getElementById("progress-bar");
  const total = state.totalBattles || 1;
  const done = state.doneBattles;
  const pct = (done / total) * 100;
  bar.style.width = pct.toFixed(1) + "%";
  document.getElementById("completed-count").textContent =
    `${done} / ${total}`;
  const elapsedSec = (performance.now() - state.startTimeMs) / 1000;
  document.getElementById("elapsed-time").textContent =
    formatDuration(elapsedSec);
  if (done > 0 && state.running) {
    const perBattle = elapsedSec / done;
    const eta = perBattle * (total - done);
    document.getElementById("eta-time").textContent = formatDuration(eta);
  } else if (!state.running) {
    document.getElementById("eta-time").textContent = "-";
  }
}

function formatDuration(s) {
  if (!isFinite(s) || s < 0) return "-";
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const ss = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${ss}s`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return `${h}h ${mm}m`;
}

function estimateTotal() {
  const c = readControls();
  const experiments = resolveExperiments(c);
  const n = totalBattlesFor(experiments, c.trials);
  document.getElementById("estimate-battles").textContent = String(n);
}

function downloadResults() {
  const out = {
    controls: readControls(),
    timestamp: new Date().toISOString(),
    experiments: state.experiments.map((exp) => {
      const slots = state.results.get(exp.id) || [];
      return {
        id: exp.id,
        label: exp.label,
        nightmares: exp.nightmares,
        xLabel: exp.xLabel,
        settings: slots.map((slot, i) => {
          const sum = summariseTrials(slot.trials);
          return {
            label: exp.settings[i].label,
            scimitars: exp.settings[i].scimitars,
            greenOverride: exp.settings[i].greenOverride,
            redOverride: exp.settings[i].redOverride,
            summary: sum,
            trials: slot.trials.map((t) => ({
              winner: t.winner,
              simTime: t.simTime,
              timedOut: t.timedOut,
              greenAlive: t.green.alive,
              redAlive: t.red.alive,
              greenHpFraction: t.green.hpFraction,
              redHpFraction: t.red.hpFraction,
            })),
          };
        }),
      };
    }),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `logi-optimization-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.getElementById("btn-run").addEventListener("click", runAll);
document.getElementById("btn-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  document.getElementById("btn-pause").textContent = state.paused
    ? "Resume"
    : "Pause";
  setStatus(state.paused ? "Paused." : "Running...");
});
document.getElementById("btn-cancel").addEventListener("click", () => {
  state.cancelRequested = true;
});
document
  .getElementById("btn-download")
  .addEventListener("click", downloadResults);

// Any control change rebuilds the grid (so the user sees the new card
// shape / x-axis / etc. without running anything). Mid-run we just
// re-estimate the total instead of clobbering live results.
const CONTROL_IDS = [
  "ctrl-red-nightmares",
  "ctrl-red-scimitars",
  "ctrl-red-subfleets",
  "ctrl-green-nightmares",
  "ctrl-green-base-scim",
  "ctrl-green-deltas",
  "ctrl-green-subfleets",
  "ctrl-trials",
  "ctrl-simcap",
];
for (const id of CONTROL_IDS) {
  const elt = document.getElementById(id);
  if (!elt) continue;
  elt.addEventListener("change", () => {
    if (state.running) {
      estimateTotal();
    } else {
      rebuildGridFromControls();
    }
  });
}

// Initial render: build the grid on page load so empty plots are
// visible BEFORE the user clicks Run.
rebuildGridFromControls();
