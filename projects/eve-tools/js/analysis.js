// Sensitivity analysis runner + plots.
//
// Architecture:
//   1. EXPERIMENTS describe what to sweep. They're declarative meta-specs
//      (NOT pre-resolved override objects), so the actual baseline is read
//      from the live FLEET_CONFIG at run-time -- this means the user can
//      edit baselines in the controls panel without rebuilding the spec.
//   2. resolveExperiments(controls) materialises EXPERIMENTS into concrete
//      { id, label, settings:[{x, label, greenOverride, redOverride}] }.
//   3. runAll() iterates experiments x settings x trials, calling
//      runBattle() and recording outcomes into RESULTS. Plots and progress
//      UI re-render after each trial; we yield to the event loop after
//      every battle so the page stays responsive.
//   4. Plots are inline SVG, hand-drawn (no chart library). Two kinds:
//        a) sweep plot per experiment (mean +/- 95% CI + raw trial dots)
//        b) global tornado summarising effect size per experiment
//
// All overrides target the GREEN team unless the experiment opts in to
// symmetric application (used for the optional symmetric reaction sweep).
// This keeps the metric "green's signed margin" interpretable as
// "how much does green's chosen value of param X move the outcome
// relative to red running baseline".

import { FLEET_CONFIG } from "./constants.js";
import { runBattle, snapshotConfig } from "./headless.js";

// ---------------------------------------------------------------------------
// Experiment specs
// ---------------------------------------------------------------------------

// Multipliers applied to BOTH min and max of a reaction range. Multiplier 0
// means "instant reaction". Multiplier 1 = baseline. We deliberately span
// 0..8x on a (roughly) log scale so the curve resolves both the "what if
// you were perfect" and "what if you were horribly slow" tails.
const REACTION_MULTIPLIERS = [0, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0];

const REACTION_PARAMS = [
  {
    id: "reaction",
    minKey: "reactionMin",
    maxKey: "reactionMax",
    label: "Primary call reaction",
    desc:
      "Time from primary being called until this ship begins its 3.5s lock cycle.",
  },
  {
    id: "hardener",
    minKey: "hardenerReactionMin",
    maxKey: "hardenerReactionMax",
    label: "Hardener reaction",
    desc:
      "Time from being first locked until this ship activates its shield hardeners.",
  },
  {
    id: "overheat",
    minKey: "overheatReactionMin",
    maxKey: "overheatReactionMax",
    label: "Overheat reaction",
    desc:
      "Time from hardeners activating until this ship overheats them for the resist boost.",
  },
  {
    id: "broadcast",
    minKey: "broadcastReactionMin",
    maxKey: "broadcastReactionMax",
    label: "Broadcast-for-reps reaction",
    desc:
      "Time from being first locked until this ship broadcasts for repairs (eligible for Scimitar reps).",
  },
  {
    id: "logi",
    minKey: "logiReactionMin",
    maxKey: "logiReactionMax",
    label: "Logi reaction",
    desc:
      "Scimitar reaction time after spotting a friendly broadcast before starting the 2s lock cycle.",
  },
  {
    id: "targetSwitch",
    minKey: "targetSwitchReactionMin",
    maxKey: "targetSwitchReactionMax",
    label: "Target-switch reaction",
    desc:
      "Time on the same primary before swapping to a different target if it is still alive (e.g. being kept alive by enemy reps).",
  },
  {
    id: "crystal",
    minKey: "crystalReactionMin",
    maxKey: "crystalReactionMax",
    label: "Crystal-swap reaction",
    desc:
      "Time from realising the loaded crystal is wrong for the current target distance until actually swapping.",
  },
];

// Composition / non-reaction experiments. Each has a fixed list of values
// for the swept axis and a function that, given the baseline snapshot,
// returns the per-team override for that value.
const COMPOSITION_EXPERIMENTS = [
  {
    id: "subfleets-green",
    label: "Subfleet count (green only)",
    desc:
      "Splits green into N subfleets at spawn. Each subfleet has its own leader and primary call; firepower fans out across multiple targets.",
    xLabel: "Subfleet count",
    values: [1, 2, 3, 4, 5],
    formatX: (v) => String(v),
    greenOverride: (v) => ({ subfleetCount: v }),
    redOverride: () => ({}),
  },
  {
    id: "scimitars-green",
    label: "Scimitar count (green only)",
    desc:
      "Number of Scimitar logi cruisers in green's fleet (red holds baseline). Nightmare count unchanged.",
    xLabel: "Green scimitars",
    values: [0, 1, 2, 3, 5, 8, 12],
    formatX: (v) => String(v),
    greenOverride: (v) => ({ scimitarCount: v }),
    redOverride: () => ({}),
  },
  {
    id: "nightmares-green",
    label: "Nightmare count (green only)",
    desc:
      "Number of Nightmare battleships in green's fleet (red holds baseline). Scimitar count unchanged.",
    xLabel: "Green nightmares",
    values: [10, 15, 20, 25, 30, 40, 50],
    formatX: (v) => String(v),
    greenOverride: (v) => ({ nightmareCount: v }),
    redOverride: () => ({}),
  },
  {
    id: "unifiedMovement-green",
    label: "Unified movement (green, 3 subfleets)",
    desc:
      "With green forced to 3 subfleets, compare independent vs. unified-movement. Only meaningful when subfleetCount > 1.",
    xLabel: "Unified movement",
    values: [false, true],
    formatX: (v) => (v ? "On" : "Off"),
    greenOverride: (v) => ({ subfleetCount: 3, unifiedMovement: v }),
    redOverride: () => ({}),
  },
  {
    id: "damageMean-green",
    label: "Damage modifier mean (green only)",
    desc:
      "Per-ship damage modifier mean (heat sinks + skills + hull bonus). Strong sanity check: more damage should obviously help.",
    xLabel: "Mean damage modifier",
    values: [1.5, 2.0, 2.5, 3.0, 3.5],
    formatX: (v) => v.toFixed(1),
    greenOverride: (v) => ({ damageMean: v }),
    redOverride: () => ({}),
  },
];

// ---------------------------------------------------------------------------
// Resolve experiments (declarative -> concrete settings) at run time
// ---------------------------------------------------------------------------

// Resolve the effective baseline for a FLEET_CONFIG key. Per-card editors
// in the experiment grid push overrides into state.baselineOverrides; we
// fall back to the live FLEET_CONFIG.green value when no override exists.
// Used uniformly so all consumers of "the baseline" see the same number.
function effectiveBaseline(key) {
  if (key in state.baselineOverrides) return state.baselineOverrides[key];
  return FLEET_CONFIG.green[key];
}

// Resolve the effective swept-value list for a composition experiment.
// Per-card editors in the experiment grid can replace the hardcoded
// `c.values` array; we use the override when present, else the spec
// default. Used uniformly the same way effectiveBaseline is.
function effectiveSweptValues(compositionExp) {
  const o = state.sweptValueOverrides[compositionExp.id];
  if (Array.isArray(o) && o.length > 0) return o;
  return compositionExp.values;
}

// Pure function: builds the resolved experiment list from `controls`
// (the values read off the UI panel) WITHOUT mutating FLEET_CONFIG.
// Reaction baselines and composition swept values are pulled from the
// per-card editors via state.baselineOverrides / state.sweptValueOverrides
// (with FLEET_CONFIG.green / spec defaults as fallback). Every emitted
// setting has a fully self-contained greenOverride / redOverride that
// includes the controls fleet sizes, so runBattle() doesn't need to know
// anything about the controls baseline -- it just applies the override
// and runs.
//
// Per user spec, the resolved overrides for asymmetric reaction sweeps
// also write the (effective) baseline into the red override, so at
// multiplier=1 both teams have identical reaction times and the mean
// margin curve naturally crosses zero at base. The damage-modifier
// composition sweep does the analogous thing for damageMean (red holds
// at the user-overridden mean) and damageSigma (both teams pick up the
// override since sigma isn't part of the swept axis).
function resolveExperiments(controls) {
  const baseline = snapshotConfig();

  // Common fleet-composition baseline that every setting includes by
  // default (so each battle starts from the user's chosen fleet sizes).
  // Per-setting overrides may further override any of these (e.g. the
  // "nightmare count" sweep overrides nightmareCount). Because spread
  // order is { ...baselineFleet, ...settingOverride }, the setting's
  // values always win.
  const baselineFleet = {
    nightmareCount: controls.nightmares,
    scimitarCount: controls.scimitars,
    subfleetCount: controls.subfleets,
  };

  const out = [];

  // Asymmetric reaction sweeps -- vary green only, hold red at the
  // (overridden) baseline. Multiplier scales BOTH min and max so the
  // [min, max] range shape is preserved (range width also scales with
  // multiplier). Red gets the same baseline written into its override so
  // editing the per-card baseline tuner moves both teams in lockstep at
  // multiplier=1 (curve crosses zero at base).
  for (const p of REACTION_PARAMS) {
    const baseMin = effectiveBaseline(p.minKey);
    const baseMax = effectiveBaseline(p.maxKey);
    const baseLabel = `${baseMin.toFixed(2)}-${baseMax.toFixed(2)}s`;
    const settings = REACTION_MULTIPLIERS.map((m) => ({
      x: m,
      label: m === 1 ? "1x (base)" : `${m}x`,
      tooltip:
        `${p.label}: ${(baseMin * m).toFixed(2)}-${(baseMax * m).toFixed(2)}s ` +
        `(baseline ${baseLabel})`,
      greenOverride: {
        ...baselineFleet,
        [p.minKey]: baseMin * m,
        [p.maxKey]: baseMax * m,
      },
      redOverride: {
        ...baselineFleet,
        [p.minKey]: baseMin,
        [p.maxKey]: baseMax,
      },
    }));
    out.push({
      id: `${p.id}-asym`,
      label: `${p.label} (green only)`,
      desc:
        p.desc +
        ` Baseline ${baseLabel}; multipliers scale both min and max.`,
      xLabel: "Multiplier of baseline range",
      formatX: (v) => `${v}x`,
      settings,
      kind: "reaction",
      paramId: p.id,
      paramLabel: p.label,
      minKey: p.minKey,
      maxKey: p.maxKey,
    });
  }

  // Optional symmetric reaction sweeps -- vary BOTH teams identically.
  // In expectation the mean margin is zero by symmetry, but the spread
  // / timeout-rate / mean-sim-time of the trials is informative on its
  // own (e.g. "do faster reactions on both sides shorten battles?").
  if (controls.symmetric) {
    for (const p of REACTION_PARAMS) {
      const baseMin = effectiveBaseline(p.minKey);
      const baseMax = effectiveBaseline(p.maxKey);
      const baseLabel = `${baseMin.toFixed(2)}-${baseMax.toFixed(2)}s`;
      const settings = REACTION_MULTIPLIERS.map((m) => ({
        x: m,
        label: m === 1 ? "1x (base)" : `${m}x`,
        tooltip:
          `${p.label}: ${(baseMin * m).toFixed(2)}-${(baseMax * m).toFixed(2)}s on both teams ` +
          `(baseline ${baseLabel})`,
        greenOverride: {
          ...baselineFleet,
          [p.minKey]: baseMin * m,
          [p.maxKey]: baseMax * m,
        },
        redOverride: {
          ...baselineFleet,
          [p.minKey]: baseMin * m,
          [p.maxKey]: baseMax * m,
        },
      }));
      out.push({
        id: `${p.id}-sym`,
        label: `${p.label} (BOTH teams)`,
        desc:
          p.desc +
          ` Symmetric: same multiplier applied to both teams. Mean margin should sit near zero; spread / timeout rate shows how much the parameter affects battle uncertainty / length.`,
        xLabel: "Multiplier of baseline range",
        formatX: (v) => `${v}x`,
        settings,
        kind: "reaction",
        paramId: p.id,
        paramLabel: p.label,
        minKey: p.minKey,
        maxKey: p.maxKey,
      });
    }
  }

  // Composition experiments. Each setting's greenOverride is merged ON TOP
  // of baselineFleet so e.g. the "nightmare count" sweep can override
  // nightmareCount while leaving scimitarCount and subfleetCount at the
  // controls baseline. The unifiedMovement experiment forces subfleetCount
  // to 3 (its override returns {subfleetCount: 3, unifiedMovement: v}),
  // again winning over the baseline value.
  for (const c of COMPOSITION_EXPERIMENTS) {
    const sweptValues = effectiveSweptValues(c);
    const isDamage = c.id === "damageMean-green";
    const settings = sweptValues.map((v, i) => {
      let greenOverride = { ...baselineFleet, ...c.greenOverride(v) };
      let redOverride = { ...baselineFleet, ...c.redOverride(v) };
      if (isDamage) {
        // Per-card baseline tuner can override damageMean (what red
        // holds at; also where the curve naturally crosses zero) and
        // damageSigma (both teams use the override because sigma is
        // not the swept axis).
        const meanBase = effectiveBaseline("damageMean");
        const sigmaBase = effectiveBaseline("damageSigma");
        redOverride = {
          ...redOverride,
          damageMean: meanBase,
          damageSigma: sigmaBase,
        };
        greenOverride = {
          ...greenOverride,
          damageSigma: sigmaBase,
        };
      }
      return {
        x: i,
        xRaw: v,
        label: c.formatX(v),
        tooltip: `${c.label}: ${c.formatX(v)}`,
        greenOverride,
        redOverride,
      };
    });
    out.push({
      id: c.id,
      label: c.label,
      desc: c.desc,
      xLabel: c.xLabel,
      formatX: c.formatX,
      settings,
      categorical: typeof sweptValues[0] !== "number",
      kind: "composition",
      compositionId: c.id,
      isDamage,
      // valuesEditable controls whether the per-card swept-values input
      // is rendered. Booleans (unifiedMovement) are excluded -- there's
      // no useful tuning of [false, true], and parsing those from a
      // text input would just be confusing.
      valuesEditable: typeof c.values[0] === "number",
      defaultValues: c.values,
    });
  }

  return { experiments: out, baseline };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  running: false,
  paused: false,
  cancelRequested: false,
  experiments: [], // resolved
  results: new Map(), // experimentId -> [{ trials: [...], setting }]
  startTimeMs: 0,
  totalBattles: 0,
  doneBattles: 0,
  // Per-card baseline overrides. Keyed by FLEET_CONFIG key (e.g.
  // "reactionMin", "hardenerReactionMax", "damageMean", "damageSigma").
  // Read by effectiveBaseline() with FLEET_CONFIG.green as the fallback.
  // Persists across runs and across grid rebuilds (intentionally never
  // wiped by control changes / Run starts) so tuning state survives.
  baselineOverrides: {},
  // Per-card swept-value overrides. Keyed by composition experiment id
  // (e.g. "nightmares-green"). Read by effectiveSweptValues() with the
  // spec's hardcoded c.values as fallback. Same persistence rules.
  sweptValueOverrides: {},
};

function readControls() {
  return {
    nightmares: clampInt("ctrl-nightmares", 1, 200, 20),
    scimitars: clampInt("ctrl-scimitars", 0, 50, 3),
    subfleets: clampInt("ctrl-subfleets", 1, 6, 1),
    trials: clampInt("ctrl-trials", 1, 200, 10),
    simCap: clampInt("ctrl-simcap", 60, 3600, 600),
    symmetric: document.getElementById("ctrl-symmetric").checked,
  };
}

function clampInt(id, lo, hi, fallback) {
  const el = document.getElementById(id);
  let v = parseInt(el.value, 10);
  if (Number.isNaN(v)) v = fallback;
  v = Math.max(lo, Math.min(hi, v));
  el.value = v;
  return v;
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
  // Snapshot baseline for restore on finally; resolveExperiments() does
  // its own snapshot internally for the resolved settings.
  const baseline = snapshotConfig();
  // Use the shared grid-rebuild path so the cards (including their
  // editor blocks with the latest baseline / swept-value state) are
  // freshly initialised. This also clears state.results to wipe any
  // stale trial data from a previous run, sets state.experiments, and
  // estimates the total. Note: rebuildGridFromControls calls
  // estimateTotal, but we then overwrite progress fields below and call
  // updateProgress for the running display.
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
      // Run interleaved: trial 1 of every setting, then trial 2 of every
      // setting, etc. This keeps each setting's CI tightening in lockstep
      // so the live plot reads as "filling in" rather than "fully resolved
      // left-to-right". Slightly less cache-coherent for FLEET_CONFIG, but
      // applyConfig is O(20) per battle so it's irrelevant.
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

          // Cooperative yield. Don't update DOM every battle (too slow at
          // small fleet sizes); update every M battles or whenever a
          // setting completes a fresh trial round.
          if (state.doneBattles % 4 === 0 || i === exp.settings.length - 1) {
            renderExperimentPlot(exp);
            renderTornado();
            updateProgress();
            await sleep(0);
          }
        }
      }
      renderExperimentPlot(exp);
      renderTornado();
    }
  } finally {
    // Restore baseline (snapshotConfig captured the pre-controls values).
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

// Mean signed ship margin: greenAlive - redAlive.
function trialShipMargin(t) {
  return t.green.alive - t.red.alive;
}
// Mean signed HP-fraction margin: greenHpFraction - redHpFraction. Falls back
// to 0 when both fleets are empty (degenerate; shouldn't happen).
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
  // Sample variance (n-1 denominator for unbiased estimate). For n=1 we
  // fall back to 0 -- single sample carries no variance info.
  const varShip = n > 1 ? (sumShipSq - n * meanShip * meanShip) / (n - 1) : 0;
  const varHp = n > 1 ? (sumHpSq - n * meanHp * meanHp) / (n - 1) : 0;
  const seShip = Math.sqrt(Math.max(0, varShip) / n);
  const seHp = Math.sqrt(Math.max(0, varHp) / n);
  // 95% CI half-width using normal approximation. For small n a t-distribution
  // would be more correct but we typically run >=10 trials so this is fine.
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
// Plotting -- inline SVG, no chart library
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
    // Per-card editor block, inserted ABOVE the plot so the user can
    // tune the parameters that drive this graph without leaving its
    // visual context. Each editor mutates state.baselineOverrides /
    // state.sweptValueOverrides; on change we re-render this card so
    // the tooltip ranges reflect the new values immediately. Pulling
    // the trigger on a re-run still requires clicking "Run".
    attachExperimentEditor(card, exp);
    const plot = document.createElement("div");
    plot.className = "exp-plot";
    card.appendChild(plot);
    const tab = document.createElement("div");
    tab.className = "exp-table";
    card.appendChild(tab);
    grid.appendChild(card);
  }
}

// Insert the appropriate editor controls into `card` for `exp`. Reaction
// sweep cards get a baseline min/max number-input pair; numeric
// composition sweep cards get a comma-separated swept-values text input;
// the damage modifier card gets BOTH a swept-values input and a baseline
// mean/sigma pair. Boolean composition sweeps (unifiedMovement) get no
// editor -- there's nothing meaningful to tune in [false, true].
function attachExperimentEditor(card, exp) {
  if (exp.kind === "reaction") {
    attachReactionBaselineEditor(card, exp);
  } else if (exp.kind === "composition") {
    if (exp.isDamage) {
      attachDamageEditor(card, exp);
    } else if (exp.valuesEditable) {
      attachSweptValuesEditor(card, exp);
    }
  }
}

// Reaction baseline editor: two number inputs (min, max) tied to
// state.baselineOverrides via FLEET_CONFIG keys. Editing min on the
// asym card also updates the sym card's min input (and vice versa) via
// syncBaselineInputs(), since both cards share the same paramId state.
function attachReactionBaselineEditor(card, exp) {
  const div = document.createElement("div");
  div.className = "exp-editor";
  div.innerHTML = `
    <span class="exp-editor-label">Baseline range</span>
    <label>min <input type="number" min="0" max="120" step="0.1" data-baseline-key="${exp.minKey}" /></label>
    <label>max <input type="number" min="0" max="120" step="0.1" data-baseline-key="${exp.maxKey}" /></label>
    <span class="exp-editor-unit">s</span>
    <button type="button" class="exp-editor-reset" title="Restore the FLEET_CONFIG default for this parameter">reset</button>
  `;
  card.appendChild(div);

  const minInput = div.querySelector(`input[data-baseline-key="${exp.minKey}"]`);
  const maxInput = div.querySelector(`input[data-baseline-key="${exp.maxKey}"]`);
  minInput.value = effectiveBaseline(exp.minKey);
  maxInput.value = effectiveBaseline(exp.maxKey);

  const onChange = (input) => () => {
    const v = parseFloat(input.value);
    const key = input.dataset.baselineKey;
    if (!Number.isFinite(v) || v < 0) {
      // Reject negatives / NaN; revert to current effective value.
      input.value = effectiveBaseline(key);
      return;
    }
    state.baselineOverrides[key] = v;
    syncBaselineInputs(key);
    onParamsEdited();
  };
  minInput.addEventListener("change", onChange(minInput));
  maxInput.addEventListener("change", onChange(maxInput));

  div.querySelector(".exp-editor-reset").addEventListener("click", () => {
    delete state.baselineOverrides[exp.minKey];
    delete state.baselineOverrides[exp.maxKey];
    syncBaselineInputs(exp.minKey);
    syncBaselineInputs(exp.maxKey);
    onParamsEdited();
  });
}

// Composition swept-values editor: a single comma-separated number list.
// Empty input or any non-numeric token reverts to the previous effective
// list and shows a small inline error; we never write a partial / mixed
// list to state. Reset restores the spec default.
function attachSweptValuesEditor(card, exp) {
  const div = document.createElement("div");
  div.className = "exp-editor";
  div.innerHTML = `
    <span class="exp-editor-label">Sweep values</span>
    <input type="text" class="exp-editor-list" data-sweep-id="${exp.compositionId}" />
    <button type="button" class="exp-editor-reset" title="Restore the spec default sweep values">reset</button>
    <span class="exp-editor-error"></span>
  `;
  card.appendChild(div);

  const input = div.querySelector("input");
  const errorSpan = div.querySelector(".exp-editor-error");
  const currentValues =
    state.sweptValueOverrides[exp.compositionId] || exp.defaultValues;
  input.value = currentValues.join(", ");

  input.addEventListener("change", () => {
    const text = input.value.trim();
    if (!text) {
      delete state.sweptValueOverrides[exp.compositionId];
      input.value = exp.defaultValues.join(", ");
      errorSpan.textContent = "";
      onParamsEdited();
      return;
    }
    const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
    const parsed = tokens.map((t) => parseFloat(t));
    if (parsed.length === 0 || parsed.some((v) => !Number.isFinite(v))) {
      errorSpan.textContent = "must be comma-separated numbers";
      const fallback =
        state.sweptValueOverrides[exp.compositionId] || exp.defaultValues;
      input.value = fallback.join(", ");
      return;
    }
    state.sweptValueOverrides[exp.compositionId] = parsed;
    errorSpan.textContent = "";
    onParamsEdited();
  });

  div.querySelector(".exp-editor-reset").addEventListener("click", () => {
    delete state.sweptValueOverrides[exp.compositionId];
    input.value = exp.defaultValues.join(", ");
    errorSpan.textContent = "";
    onParamsEdited();
  });
}

// Damage modifier card editor: stacks the swept-values editor (green
// damageMean axis) above a damageMean / damageSigma baseline editor.
// The baseline mean drives where the curve crosses zero (red holds at
// it); the baseline sigma applies to BOTH teams (sigma isn't swept).
function attachDamageEditor(card, exp) {
  const div = document.createElement("div");
  div.className = "exp-editor exp-editor-stacked";
  div.innerHTML = `
    <div class="exp-editor-row">
      <span class="exp-editor-label">Sweep values (green damageMean)</span>
      <input type="text" class="exp-editor-list" data-sweep-id="${exp.compositionId}" />
      <button type="button" class="exp-editor-reset" data-reset="sweep" title="Restore the spec default sweep values">reset</button>
      <span class="exp-editor-error"></span>
    </div>
    <div class="exp-editor-row">
      <span class="exp-editor-label">Baseline</span>
      <label>mean <input type="number" min="0" max="20" step="0.1" data-baseline-key="damageMean" /></label>
      <label>sigma <input type="number" min="0" max="20" step="0.05" data-baseline-key="damageSigma" /></label>
      <button type="button" class="exp-editor-reset" data-reset="baseline" title="Restore the FLEET_CONFIG defaults for damageMean / damageSigma">reset</button>
    </div>
  `;
  card.appendChild(div);

  // Sweep values
  const sweepInput = div.querySelector(
    `input[data-sweep-id="${exp.compositionId}"]`
  );
  const sweepError = div.querySelector(".exp-editor-error");
  const currentValues =
    state.sweptValueOverrides[exp.compositionId] || exp.defaultValues;
  sweepInput.value = currentValues.join(", ");

  sweepInput.addEventListener("change", () => {
    const text = sweepInput.value.trim();
    if (!text) {
      delete state.sweptValueOverrides[exp.compositionId];
      sweepInput.value = exp.defaultValues.join(", ");
      sweepError.textContent = "";
      onParamsEdited();
      return;
    }
    const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
    const parsed = tokens.map((t) => parseFloat(t));
    if (parsed.length === 0 || parsed.some((v) => !Number.isFinite(v))) {
      sweepError.textContent = "must be comma-separated numbers";
      const fallback =
        state.sweptValueOverrides[exp.compositionId] || exp.defaultValues;
      sweepInput.value = fallback.join(", ");
      return;
    }
    state.sweptValueOverrides[exp.compositionId] = parsed;
    sweepError.textContent = "";
    onParamsEdited();
  });

  // Baseline mean / sigma
  const meanInput = div.querySelector(`input[data-baseline-key="damageMean"]`);
  const sigmaInput = div.querySelector(`input[data-baseline-key="damageSigma"]`);
  meanInput.value = effectiveBaseline("damageMean");
  sigmaInput.value = effectiveBaseline("damageSigma");

  const onBaselineChange = (input) => () => {
    const v = parseFloat(input.value);
    const key = input.dataset.baselineKey;
    if (!Number.isFinite(v) || v < 0) {
      input.value = effectiveBaseline(key);
      return;
    }
    state.baselineOverrides[key] = v;
    syncBaselineInputs(key);
    onParamsEdited();
  };
  meanInput.addEventListener("change", onBaselineChange(meanInput));
  sigmaInput.addEventListener("change", onBaselineChange(sigmaInput));

  // Reset buttons (independent: sweep reset and baseline reset).
  div
    .querySelector('button[data-reset="sweep"]')
    .addEventListener("click", () => {
      delete state.sweptValueOverrides[exp.compositionId];
      sweepInput.value = exp.defaultValues.join(", ");
      sweepError.textContent = "";
      onParamsEdited();
    });
  div
    .querySelector('button[data-reset="baseline"]')
    .addEventListener("click", () => {
      delete state.baselineOverrides.damageMean;
      delete state.baselineOverrides.damageSigma;
      syncBaselineInputs("damageMean");
      syncBaselineInputs("damageSigma");
      onParamsEdited();
    });
}

// Push the current effective baseline value to every input bound to
// `key` across the grid. Used so editing the asym card's baseline also
// updates the sym card's baseline input (they share state) without
// requiring a full grid rebuild.
function syncBaselineInputs(key) {
  const v = effectiveBaseline(key);
  const inputs = document.querySelectorAll(
    `input[data-baseline-key="${key}"]`
  );
  for (const input of inputs) {
    if (parseFloat(input.value) !== v) input.value = v;
  }
}

// Re-resolve and re-render the experiment grid after a per-card editor
// change. We re-render plots so tooltip ranges and table-row labels
// pick up the new sweep / baseline values immediately. Trial data is
// preserved (state.results is keyed by experiment id, which is stable
// across edits), but it's now technically stale relative to the new
// labels -- the user should click Run again for clean numbers. We
// don't auto-rerun.
//
// estimateTotal() is called too because edited swept-value lists can
// change the total-battle count (e.g. extending nightmares to
// [10..50, 75, 100]).
function onParamsEdited() {
  if (state.running) {
    estimateTotal();
    return;
  }
  rebuildGridFromControls();
}

// Build (or rebuild) the experiment grid from the current controls +
// per-card override state. Initialises empty trial slots in
// state.results so renderExperimentPlot can draw an empty axis. Called
// on page load, on main-controls change, and at the start of each Run.
function rebuildGridFromControls() {
  const controls = readControls();
  const { experiments } = resolveExperiments(controls);
  state.experiments = experiments;
  state.results.clear();
  for (const exp of experiments) {
    const slot = exp.settings.map((s) => ({ setting: s, trials: [] }));
    state.results.set(exp.id, slot);
  }
  buildExperimentGrid(experiments);
  buildTornado();
  for (const exp of experiments) renderExperimentPlot(exp);
  estimateTotal();
}

function buildTornado() {
  const container = document.getElementById("tornado-plot");
  container.innerHTML = "";
}

function renderExperimentPlot(exp) {
  const card = document.querySelector(`.exp-card[data-exp-id="${exp.id}"]`);
  if (!card) return;
  const plotDiv = card.querySelector(".exp-plot");
  const tabDiv = card.querySelector(".exp-table");

  const slots = state.results.get(exp.id);
  const summaries = slots.map((s) => summariseTrials(s.trials));

  // Pick y range from observed margins +/- their CIs, with sensible padding
  // and a guarantee that 0 is on the axis.
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
    H = 220;
  const M = { l: 44, r: 14, t: 8, b: 38 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const xs = exp.settings.map((_, i) => i);
  const xToPx = (i) => {
    if (xs.length === 1) return M.l + innerW / 2;
    return M.l + (i / (xs.length - 1)) * innerW;
  };
  const yToPx = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    class: "exp-svg",
  });

  // Background
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

  // Y-axis grid lines + labels (5 ticks).
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

  // X-axis labels.
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
  // X-axis title.
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
      exp.xLabel || ""
    )
  );

  // Y-axis title (rotated).
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

  // Compute mean points first so we can draw the connecting line BEFORE
  // the dots / CI bars (so the dots end up on top of the line in z-order).
  const meanPoints = [];
  for (let i = 0; i < exp.settings.length; i++) {
    const sum = summaries[i];
    if (sum.n > 0) {
      meanPoints.push([xToPx(i), yToPx(sum.meanShip)]);
    }
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

  // Per-setting: jittered raw trial dots, then CI bars + mean dot on top.
  for (let i = 0; i < exp.settings.length; i++) {
    const sum = summaries[i];
    const px = xToPx(i);
    const trials = slots[i].trials;
    for (let j = 0; j < trials.length; j++) {
      const v = trialShipMargin(trials[j]);
      // Deterministic-ish jitter from trial index so dots don't dance
      // between renders.
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
      // CI vertical bar
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
      // CI cap top
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
      // CI cap bottom
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
      // Mean dot with hover tooltip.
      const cy = yToPx(sum.meanShip);
      const dot = el("circle", {
        cx: px,
        cy: cy,
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
    exp.xLabel || "Setting",
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

function renderTornado() {
  const container = document.getElementById("tornado-plot");
  // Effect size = max(meanMargin) - min(meanMargin) across the experiment's
  // settings, considering only settings with at least one trial.
  const items = [];
  for (const exp of state.experiments) {
    const slots = state.results.get(exp.id);
    let lo = +Infinity,
      hi = -Infinity;
    let hasAny = false;
    for (const slot of slots) {
      if (slot.trials.length === 0) continue;
      hasAny = true;
      const sum = summariseTrials(slot.trials);
      if (sum.meanShip < lo) lo = sum.meanShip;
      if (sum.meanShip > hi) hi = sum.meanShip;
    }
    if (!hasAny) continue;
    items.push({ exp, lo, hi, span: hi - lo });
  }
  items.sort((a, b) => b.span - a.span);

  if (items.length === 0) {
    container.innerHTML =
      '<div class="muted">No completed experiments yet.</div>';
    return;
  }

  const W = Math.max(560, container.clientWidth || 700);
  const rowH = 22;
  const labelW = 220;
  const padR = 60;
  const innerW = W - labelW - padR;
  const H = items.length * rowH + 26;
  // Symmetric x range so center=0 is fixed; use max(|lo|, |hi|) across all.
  let absMax = 0;
  for (const it of items) {
    absMax = Math.max(absMax, Math.abs(it.lo), Math.abs(it.hi));
  }
  if (absMax === 0) absMax = 1;
  const cx = labelW + innerW / 2;
  const xToPx = (v) => cx + (v / absMax) * (innerW / 2);

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    class: "tornado-svg",
  });

  // Center axis.
  svg.appendChild(
    el("line", {
      x1: cx,
      y1: 0,
      x2: cx,
      y2: H - 22,
      stroke: "rgba(200,210,230,0.55)",
      "stroke-dasharray": "4,4",
    })
  );

  // Tick marks at -absMax, 0, +absMax (and a couple in between).
  const ticks = [-absMax, -absMax / 2, 0, absMax / 2, absMax];
  for (const tv of ticks) {
    const px = xToPx(tv);
    svg.appendChild(
      el("line", {
        x1: px,
        y1: H - 22,
        x2: px,
        y2: H - 18,
        stroke: "rgba(200,210,230,0.4)",
      })
    );
    svg.appendChild(
      el(
        "text",
        {
          x: px,
          y: H - 6,
          "text-anchor": "middle",
          "font-size": 10,
          fill: "#9aa6bc",
        },
        formatY(tv)
      )
    );
  }
  svg.appendChild(
    el(
      "text",
      {
        x: cx,
        y: H - 6,
        dy: 12,
        "text-anchor": "middle",
        "font-size": 10,
        fill: "#9aa6bc",
      },
      ""
    )
  );

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const y = i * rowH + 8;
    const cy = y + rowH / 2 - 2;
    // Label
    svg.appendChild(
      el(
        "text",
        {
          x: labelW - 8,
          y: cy + 4,
          "text-anchor": "end",
          "font-size": 11,
          fill: "#cfd6e4",
        },
        it.exp.label
      )
    );
    // Bar from lo to hi
    const x0 = Math.min(xToPx(it.lo), xToPx(it.hi));
    const x1 = Math.max(xToPx(it.lo), xToPx(it.hi));
    const fillCol =
      it.span > 0
        ? it.hi >= 0 && it.lo >= 0
          ? "rgba(108,255,138,0.55)"
          : it.hi <= 0 && it.lo <= 0
          ? "rgba(255,90,90,0.55)"
          : "rgba(180,200,255,0.55)"
        : "rgba(120,140,170,0.45)";
    const rect = el("rect", {
      x: x0,
      y: y + 4,
      width: Math.max(2, x1 - x0),
      height: rowH - 10,
      fill: fillCol,
      stroke: "rgba(20,28,42,0.85)",
    });
    rect.appendChild(
      el(
        "title",
        {},
        `${it.exp.label}\n` +
          `Mean ships-ahead range: ${it.lo.toFixed(2)} to ${it.hi.toFixed(2)}\n` +
          `Span (effect size): ${it.span.toFixed(2)}`
      )
    );
    svg.appendChild(rect);
    // End-cap labels with the lo/hi values.
    svg.appendChild(
      el(
        "text",
        {
          x: x0 - 4,
          y: cy + 4,
          "text-anchor": "end",
          "font-size": 9,
          fill: "#9aa6bc",
        },
        formatY(it.lo)
      )
    );
    svg.appendChild(
      el(
        "text",
        {
          x: x1 + 4,
          y: cy + 4,
          "text-anchor": "start",
          "font-size": 9,
          fill: "#9aa6bc",
        },
        formatY(it.hi)
      )
    );
  }

  container.innerHTML = "";
  container.appendChild(svg);
}

// "Nice" tick spacing for the y-axis: choose a step from {1,2,5}*10^k that
// produces ~targetCount ticks across [lo, hi]. Always includes 0 if it lies
// inside the range.
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
    // Round to step's precision to suppress FP noise like 0.30000000000000004.
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
  const { experiments } = resolveExperiments(c);
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
        xLabel: exp.xLabel,
        settings: slots.map((slot, i) => {
          const sum = summariseTrials(slot.trials);
          return {
            label: exp.settings[i].label,
            x: exp.settings[i].x,
            xRaw: exp.settings[i].xRaw,
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
  a.download = `sensitivity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

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
document.getElementById("btn-download").addEventListener("click", downloadResults);
for (const id of [
  "ctrl-nightmares",
  "ctrl-scimitars",
  "ctrl-subfleets",
  "ctrl-trials",
  "ctrl-symmetric",
]) {
  document.getElementById(id).addEventListener("change", () => {
    // Only ctrl-trials and ctrl-simcap don't change the experiment grid
    // shape; everything else affects baselineFleet sizes (so the
    // settings' tooltip strings change) or symmetric (so the sym cards
    // appear/disappear). Cheapest correct thing: rebuild the grid on
    // every controls change, but only when not running. estimateTotal
    // is called inside rebuildGridFromControls.
    if (state.running) {
      estimateTotal();
    } else {
      rebuildGridFromControls();
    }
  });
}
// Initial render: build the grid on page load so per-card editors are
// visible BEFORE the user runs anything. Plots show empty axes until
// the first Run completes a trial.
rebuildGridFromControls();
