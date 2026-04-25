// Headless sim driver for sensitivity analysis. Wraps the existing Battle
// class so analysis.js can run thousands of battles without touching the
// renderer. The sim itself (sim.js / ship.js / ai.js) has zero DOM /
// renderer dependencies, so all we need to do here is:
//
//   1. Temporarily mutate FLEET_CONFIG to apply per-team overrides for
//      this battle. (Battle reads FLEET_CONFIG live during _spawn and
//      every reaction-rolling call.)
//   2. Construct a Battle, tick it to completion or to a sim-time cap.
//   3. Compute per-team outcome stats from the final ship list.
//   4. Restore FLEET_CONFIG to whatever it was before the call, so we
//      don't poison subsequent battles or the main app's UI bindings if
//      the analysis page is ever opened in the same window as the live
//      simulator.
//
// The hitEvents queue inside Battle is bounded by Battle.tick's own ~7s
// retention window, so we don't need to drain it explicitly here -- it
// stays small enough not to matter for analysis throughput.

import { FLEET_CONFIG } from "./constants.js";
import { Battle } from "./sim.js";

// All keys in FLEET_CONFIG[team] we may override. Listing them explicitly
// (rather than Object.keys()) keeps applyConfig safe against the user
// accidentally passing a typo'd key from analysis.js -- only known keys
// are written through.
const KEYS = [
  "nightmareCount",
  "scimitarCount",
  "subfleetCount",
  "unifiedMovement",
  "reactionMin",
  "reactionMax",
  "hardenerReactionMin",
  "hardenerReactionMax",
  "overheatReactionMin",
  "overheatReactionMax",
  "broadcastReactionMin",
  "broadcastReactionMax",
  "logiReactionMin",
  "logiReactionMax",
  "targetSwitchReactionMin",
  "targetSwitchReactionMax",
  "crystalReactionMin",
  "crystalReactionMax",
  "damageMean",
  "damageSigma",
];

// Snapshot the live FLEET_CONFIG so we can restore it after a battle.
// Returns a deep copy of just the keys we know about.
export function snapshotConfig() {
  const snap = { green: {}, red: {} };
  for (const team of ["green", "red"]) {
    for (const k of KEYS) snap[team][k] = FLEET_CONFIG[team][k];
  }
  return snap;
}

// Apply a partial config of the form { green: {key:val,...}, red: {...} }
// onto the live FLEET_CONFIG. Missing keys / teams are left untouched.
export function applyConfig(cfg) {
  if (!cfg) return;
  for (const team of ["green", "red"]) {
    if (!cfg[team]) continue;
    for (const k of KEYS) {
      if (k in cfg[team]) FLEET_CONFIG[team][k] = cfg[team][k];
    }
  }
}

// Run one battle to completion (or sim-time cap) with the given per-team
// overrides on top of the current FLEET_CONFIG. Restores FLEET_CONFIG on
// exit, including on exceptions. Returns:
//   {
//     winner: "green" | "red" | "draw" | "timeout",
//     simTime,
//     timedOut,
//     green: { startN, startS, startCount, startHp,
//              nightmares, scimitars, alive, hp,
//              hpFraction },
//     red:   { ... same ... },
//   }
//
// hpFraction is endHp / startHp -- a continuous version of "how much of
// the fleet survived" that's well-defined even on timeouts where neither
// side is wiped.
export function runBattle({
  greenCfg = {},
  redCfg = {},
  maxSimTime = 600,
  simDt = 0.1,
} = {}) {
  const prev = snapshotConfig();
  applyConfig({ green: greenCfg, red: redCfg });
  try {
    const b = new Battle();

    let startG = 0,
      startR = 0;
    let startGN = 0,
      startGS = 0,
      startRN = 0,
      startRS = 0;
    for (const s of b.ships) {
      const hp = s.shield + s.armor + s.structure;
      if (s.team === "green") {
        startG += hp;
        if (s.shipType === "nightmare") startGN++;
        else startGS++;
      } else {
        startR += hp;
        if (s.shipType === "nightmare") startRN++;
        else startRS++;
      }
    }

    while (!b.over && b.simTime < maxSimTime) {
      b.tick(simDt);
    }

    let endG = 0,
      endR = 0;
    let endGN = 0,
      endGS = 0,
      endRN = 0,
      endRS = 0;
    for (const s of b.ships) {
      if (!s.alive) continue;
      const hp =
        Math.max(0, s.shield) + Math.max(0, s.armor) + Math.max(0, s.structure);
      if (s.team === "green") {
        endG += hp;
        if (s.shipType === "nightmare") endGN++;
        else endGS++;
      } else {
        endR += hp;
        if (s.shipType === "nightmare") endRN++;
        else endRS++;
      }
    }

    const timedOut = !b.over;
    let winner;
    if (timedOut) {
      // On timeout, call the battle by HP remaining instead of ship count
      // so a slow-grinding stalemate still gets a directional outcome.
      // Within 1% HP -> draw.
      const totalStart = Math.max(1, startG + startR);
      const diff = (endG - endR) / totalStart;
      if (Math.abs(diff) < 0.01) winner = "draw";
      else winner = diff > 0 ? "green" : "red";
    } else {
      winner = b.winner;
    }

    return {
      winner,
      simTime: b.simTime,
      timedOut,
      green: {
        startN: startGN,
        startS: startGS,
        startCount: startGN + startGS,
        startHp: startG,
        nightmares: endGN,
        scimitars: endGS,
        alive: endGN + endGS,
        hp: endG,
        hpFraction: startG > 0 ? endG / startG : 0,
      },
      red: {
        startN: startRN,
        startS: startRS,
        startCount: startRN + startRS,
        startHp: startR,
        nightmares: endRN,
        scimitars: endRS,
        alive: endRN + endRS,
        hp: endR,
        hpFraction: startR > 0 ? endR / startR : 0,
      },
    };
  } finally {
    applyConfig(prev);
  }
}
