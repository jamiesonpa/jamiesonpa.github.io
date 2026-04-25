import { SIM, NIGHTMARE, FLEET_CONFIG, VIS } from "./constants.js";
import { Battle } from "./sim.js";
import { Renderer } from "./render.js";
import { ViolinPlot } from "./violin.js";

const canvas = document.getElementById("view");
const renderer = new Renderer(canvas);

let battle = new Battle();
renderer.syncShips(battle);

// --- Per-team roster panels ----------------------------------------------
// Build one row per ship into the left/right scrollable lists. Cache the
// fill-bar elements by ship id for cheap per-frame width updates.
const greenRosterList = document.querySelector("#green-roster .roster-list");
const redRosterList = document.querySelector("#red-roster .roster-list");
const rosterRows = new Map(); // shipId -> { row, sFill, aFill, hFill }

function rebuildRoster(b) {
  greenRosterList.innerHTML = "";
  redRosterList.innerHTML = "";
  rosterRows.clear();

  // Per-(team, subfleet) sequential numbering so labels look like
  //   G1·01 G1·02 ... G2·01 G2·02
  // when subfleets > 1, falling back to G·01 / G·02 for a single subfleet.
  // The leader of each subfleet is naturally "01" because we spawn it first.
  const counters = { green: new Map(), red: new Map() };
  const subfleetCounts = {
    green: b.subfleets.green.length,
    red: b.subfleets.red.length,
  };
  for (const s of b.ships) {
    const isGreen = s.team === "green";
    const teamCounters = counters[s.team];
    const next = (teamCounters.get(s.subfleetId) || 0) + 1;
    teamCounters.set(s.subfleetId, next);
    const teamPrefix = isGreen ? "G" : "R";
    const subPart =
      subfleetCounts[s.team] > 1 ? String(s.subfleetId + 1) : "";
    const label = teamPrefix + subPart + "\u00b7" + String(next).padStart(2, "0");

    const row = document.createElement("div");
    row.className = "ship-row";
    if (s.isLeader) row.classList.add("leader");

    const labelEl = document.createElement("div");
    labelEl.className = "ship-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    // Small "H" pip that lights up once this ship's shield hardeners
    // activate. Always present in the DOM so we don't have to insert /
    // remove nodes per frame; .hardened on the row drives its colour.
    const hardEl = document.createElement("span");
    hardEl.className = "hard-pip";
    hardEl.textContent = "H";
    hardEl.title = "Shield hardeners";
    row.appendChild(hardEl);

    const bars = document.createElement("div");
    bars.className = "bars";
    const mkBar = (cls) => {
      const bar = document.createElement("div");
      bar.className = "bar " + cls;
      const fill = document.createElement("div");
      fill.className = "fill";
      bar.appendChild(fill);
      bars.appendChild(bar);
      return fill;
    };
    const sFill = mkBar("shield");
    const aFill = mkBar("armor");
    const hFill = mkBar("struct");
    row.appendChild(bars);

    (isGreen ? greenRosterList : redRosterList).appendChild(row);
    rosterRows.set(s.id, { row, sFill, aFill, hFill });
  }
}

// Throttled to 10 Hz; bars CSS-transition fills the gap visually.
let lastRosterUpdate = 0;
function updateRoster(b, nowMs) {
  if (nowMs - lastRosterUpdate < 100) return;
  lastRosterUpdate = nowMs;

  // A ship is "primary" in the roster if any opposing subfleet currently
  // has it as its primary call. With subfleets > 1 multiple ships per
  // team can be primary at once; the highlight just flags "someone is
  // shooting me as primary".
  const primaryIds = new Set();
  for (const team of ["green", "red"]) {
    for (const sub of b.subfleets[team]) {
      if (sub.primary && sub.primary.alive) primaryIds.add(sub.primary.id);
    }
  }

  for (const s of b.ships) {
    const r = rosterRows.get(s.id);
    if (!r) continue;
    const sPct = (Math.max(0, s.shield) / NIGHTMARE.shieldHP) * 100;
    const aPct = (Math.max(0, s.armor) / NIGHTMARE.armorHP) * 100;
    const hPct = (Math.max(0, s.structure) / NIGHTMARE.structureHP) * 100;
    r.sFill.style.width = sPct + "%";
    r.aFill.style.width = aPct + "%";
    r.hFill.style.width = hPct + "%";
    if (!s.alive) {
      r.row.classList.add("dead");
      r.row.classList.remove("primary");
    } else {
      r.row.classList.toggle("primary", primaryIds.has(s.id));
    }
    r.row.classList.toggle("hardened", !!s.hardenersOn);
    r.row.classList.toggle("overheated", !!s.hardenersOverheated);
    // Promotion: a follower may have been promoted to leader mid-battle.
    if (s.isLeader) r.row.classList.add("leader");
  }
}

rebuildRoster(battle);

// --- Per-fleet damage-modifier violin plots ------------------------------
// One persistent violin per fleet inside the corresponding roster panel.
// Each <circle> represents a single ship at its rolled damageModifier;
// dead ships are hidden via opacity so the live violin shape always
// reflects the surviving fleet. Both violins share a y-axis (computed
// once per battle) for direct visual comparison.
const greenViolin = new ViolinPlot(document.getElementById("green-violin"), {
  color: VIS.greenColor,
});
const redViolin = new ViolinPlot(document.getElementById("red-violin"), {
  color: VIS.redColor,
});

function rebuildViolins(b) {
  // Use whichever is larger of (config-derived 4-sigma upper) and the
  // observed max across all spawned ships, so the y-axis comfortably
  // contains the actual roll outcomes even on lucky tails. Stable across
  // the whole battle (no shrinking as ships die).
  const cfgMax = Math.max(
    FLEET_CONFIG.green.damageMean + 4 * FLEET_CONFIG.green.damageSigma,
    FLEET_CONFIG.red.damageMean + 4 * FLEET_CONFIG.red.damageSigma
  );
  let observedMax = 0;
  for (const s of b.ships) {
    if (s.damageModifier > observedMax) observedMax = s.damageModifier;
  }
  const yMax = Math.max(0.5, cfgMax, observedMax) * 1.05;
  greenViolin.setYMax(yMax);
  redViolin.setYMax(yMax);

  const greenShips = [];
  const redShips = [];
  for (const s of b.ships) {
    (s.team === "green" ? greenShips : redShips).push(s);
  }
  greenViolin.rebuild(greenShips);
  redViolin.rebuild(redShips);
}
rebuildViolins(battle);

// Throttled to 5 Hz; KDE on ~50 points * 80 grid samples is cheap, but
// SVG attribute writes still aren't free at 60 Hz on every tab.
let lastViolinUpdate = 0;
function updateViolins(b, nowMs) {
  if (nowMs - lastViolinUpdate < 200) return;
  lastViolinUpdate = nowMs;
  const greenAlive = [];
  const redAlive = [];
  for (const s of b.ships) {
    if (!s.alive) continue;
    (s.team === "green" ? greenAlive : redAlive).push(s);
  }
  greenViolin.update(greenAlive);
  redViolin.update(redAlive);
}

// --- Per-fleet config inputs ---------------------------------------------
// Two-way bind .cfg-input fields to FLEET_CONFIG. Edits take effect on the
// next reaction roll a ship makes (i.e., when a new primary is called),
// EXCEPT for spawn-time keys (teamSize, damageMean, damageSigma) which
// only take effect on Restart.
//
// Keys that must be parsed as integers and have a per-key minimum.
// teamSize must be >= 1 so we always have at least the leader.
// subfleetCount must be >= 1; sim.js further clamps it to <= teamSize.
const INTEGER_KEYS = {
  teamSize: { min: 1 },
  subfleetCount: { min: 1 },
};

function bindFleetConfigInputs() {
  const inputs = document.querySelectorAll(".cfg-input");
  for (const input of inputs) {
    const team = input.dataset.team;
    const key = input.dataset.key;
    if (!FLEET_CONFIG[team] || !(key in FLEET_CONFIG[team])) continue;

    input.value = FLEET_CONFIG[team][key];

    input.addEventListener("change", () => {
      const intSpec = INTEGER_KEYS[key];
      let v;
      if (intSpec) {
        v = parseInt(input.value, 10);
        if (Number.isNaN(v)) v = FLEET_CONFIG[team][key];
        v = Math.max(intSpec.min, Math.floor(v));
      } else {
        v = parseFloat(input.value);
        if (Number.isNaN(v)) v = FLEET_CONFIG[team][key];
        v = Math.max(0, v);
      }
      FLEET_CONFIG[team][key] = v;

      // Maintain min <= max for any "<prefix>Min" / "<prefix>Max" pair on
      // the same team. If the user dragged one side past the other, push
      // the other side along and write it back to its input so the UI
      // stays consistent.
      const cfg = FLEET_CONFIG[team];
      let peerKey = null;
      if (key.endsWith("Min")) {
        peerKey = key.slice(0, -3) + "Max";
      } else if (key.endsWith("Max")) {
        peerKey = key.slice(0, -3) + "Min";
      }
      if (peerKey && peerKey in cfg) {
        const minKey = key.endsWith("Min") ? key : peerKey;
        const maxKey = key.endsWith("Max") ? key : peerKey;
        if (cfg[minKey] > cfg[maxKey]) {
          // Whichever the user just edited wins; drag the peer to match.
          cfg[peerKey] = cfg[key];
          const peerInput = document.querySelector(
            `.cfg-input[data-team="${team}"][data-key="${peerKey}"]`
          );
          if (peerInput) peerInput.value = cfg[peerKey];
        }
      }

      input.value = FLEET_CONFIG[team][key];
    });
  }
}
bindFleetConfigInputs();

// HUD elements -------------------------------------------------------------
const greenCountEl = document.getElementById("green-count");
const redCountEl = document.getElementById("red-count");
const simTimeEl = document.getElementById("sim-time");
const speedSel = document.getElementById("speed");
const pauseBtn = document.getElementById("pause");
const restartBtn = document.getElementById("restart");
const resultBanner = document.getElementById("result-banner");

let paused = false;
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
});
restartBtn.addEventListener("click", () => {
  renderer.resetBattleVisuals();
  battle = new Battle();
  renderer.syncShips(battle);
  rebuildRoster(battle);
  rebuildViolins(battle);
  lastRosterUpdate = 0;
  lastViolinUpdate = 0;
  resultBanner.classList.add("hidden");
  resultBanner.classList.remove("green", "red");
  paused = false;
  pauseBtn.textContent = "Pause";
});

// Main loop ----------------------------------------------------------------
// Fixed-timestep sim sub-steps (SIM.simDt) advanced based on real elapsed
// time * the user-selected speed multiplier. Capped accumulator so that
// tab-switching doesn't make us spiral.
let lastFrameTime = performance.now();
let acc = 0;

function frame(nowMs) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (nowMs - lastFrameTime) / 1000);
  lastFrameTime = nowMs;

  if (!paused && !battle.over) {
    const mult = parseFloat(speedSel.value) || 1;
    acc += realDt * mult;
    // Hard cap so we don't lock up after a long pause.
    if (acc > 2.0) acc = 2.0;
    while (acc >= SIM.simDt) {
      battle.tick(SIM.simDt);
      acc -= SIM.simDt;
      if (battle.over) break;
    }
  }

  renderer.syncShips(battle);
  renderer.consumeHitEvents(battle);
  renderer.updatePrimaryIndicators(battle);
  renderer.render(realDt);

  updateRoster(battle, nowMs);
  updateViolins(battle, nowMs);

  greenCountEl.textContent = battle.countAlive("green");
  redCountEl.textContent = battle.countAlive("red");
  simTimeEl.textContent = battle.simTime.toFixed(1);

  if (battle.over && resultBanner.classList.contains("hidden")) {
    let text;
    if (battle.winner === "draw") text = "MUTUAL DESTRUCTION";
    else if (battle.winner === "green") text = "GREEN VICTORY";
    else text = "RED VICTORY";
    resultBanner.textContent = text;
    resultBanner.classList.remove("hidden");
    if (battle.winner === "green") resultBanner.classList.add("green");
    if (battle.winner === "red") resultBanner.classList.add("red");
  }
}

requestAnimationFrame((t) => {
  lastFrameTime = t;
  frame(t);
});
