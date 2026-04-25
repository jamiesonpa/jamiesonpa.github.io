import * as THREE from "three";
import {
  NIGHTMARE,
  SHIP_STATS,
  TURRET_SIG_RESOLUTION,
  FLEET_CONFIG,
  CRYSTALS,
  DEFAULT_CRYSTAL_IDX,
} from "./constants.js";

let nextShipId = 0;

// Box-Muller normal sample. We only need one value per call so we throw
// away the second draw; cheaper than caching for the volumes we use here
// (one roll per ship at spawn). u1 floored to a tiny positive to avoid
// log(0) -> -Infinity on the unlucky 1-in-2^53 draw.
function sampleNormal(mean, sigma) {
  let u1 = Math.random();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sigma * z;
}

// Per-ship state. Pure data + small combat methods; AI lives in ai.js.
//
// shipType selects the stats profile from SHIP_STATS:
//   "nightmare" - DPS battleship, fires Tachyon Beam Lasers
//   "scimitar"  - logistics cruiser, no weapons; runs the rep state
//                 machine in sim.js (_updateLogiLocks) instead of the
//                 turret/lock state machine
//
// Both types share the same hardener-on / overheated state machine and
// the same broadcast-for-repairs trigger (firstLockedAt -> broadcastingAt).
export class Ship {
  constructor({
    team,
    shipType = "nightmare",
    isLeader = false,
    position,
    slotOffset = null,
    subfleetId = 0,
  }) {
    this.id = nextShipId++;
    this.team = team; // "green" | "red"
    this.shipType = shipType; // "nightmare" | "scimitar"
    this.isLeader = isLeader;
    // Index into Battle.subfleets[team]. All members of a subfleet -- leader
    // and followers -- share this id. Stable across promotion (a follower
    // promoted to leader keeps its subfleet).
    this.subfleetId = subfleetId;

    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    // The local frame the leader uses to place its formation (followers reuse
    // the leader's basis to compute their slot world position).
    this.basis = {
      forward: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
    };
    // Followers store the constant offset from the leader (in leader-local
    // frame) that defines their formation slot.
    this.slotOffset = slotOffset ? slotOffset.clone() : null;

    const stats = SHIP_STATS[shipType];
    this.shield = stats.shieldHP;
    this.armor = stats.armorHP;
    this.structure = stats.structureHP;
    this.alive = true;

    this.target = null;
    // Stagger initial cycles so all ships of a side don't volley in
    // perfect lockstep. Nightmares only -- scimitars don't use this.
    this.weaponCooldown =
      shipType === "nightmare" ? Math.random() * NIGHTMARE.rateOfFire : 0;

    // Lock state machine (turret target). Used by nightmares only; scimitars
    // stay in "idle" forever on this state machine and use repState instead.
    //   "idle"     -> no primary yet, or primary dead
    //   "reacting" -> waiting out random reaction delay
    //   "locking"  -> 3.5 s ship-lock timer ticking down
    //   "locked"   -> may fire on this.target
    this.lockState = "idle";
    this.lockTimer = 0;
    this.lockedPrimaryId = null;

    // Shield-hardener state. Hardeners start OFF (passive resist profile).
    // They activate once, after the per-ship hardener-reaction roll that
    // begins the moment this ship is first locked by any enemy. After they
    // come on, a separate overheat-reaction roll begins; once it elapses
    // the ship overheats its hardeners (boosted resists). Overheating is
    // capped at SIM.overheatBurnoutDuration seconds -- after that the
    // hardeners burn out, both hardenersOn and hardenersOverheated drop
    // back to false, and hardenersBurnedOut latches true so the rest of
    // the battle uses the BASE resist profile (no re-arming).
    //   firstLockedAt        - sim time of the first completed enemy lock
    //                          (null until that happens)
    //   hardenerActivateAt   - sim time at which hardenersOn flips to true
    //                          (null until firstLockedAt is set)
    //   hardenersOn          - true while hardeners are active; flips to
    //                          false on burnout
    //   overheatActivateAt   - sim time at which hardenersOverheated flips
    //                          (null until hardenersOn flips)
    //   hardenersOverheated  - true while overheating; flips to false on
    //                          burnout
    //   overheatBurnoutAt    - sim time at which the burnout fires
    //                          (null until hardenersOverheated flips true)
    //   hardenersBurnedOut   - true once burnout has fired; latched for
    //                          the rest of the battle. Gates _updateHardeners
    //                          out of re-activating the (well-elapsed)
    //                          hardenerActivateAt deadline.
    this.firstLockedAt = null;
    this.hardenerActivateAt = null;
    this.hardenersOn = false;
    this.overheatActivateAt = null;
    this.hardenersOverheated = false;
    this.overheatBurnoutAt = null;
    this.hardenersBurnedOut = false;

    // Broadcast-for-repairs state. Same trigger as hardenerActivateAt
    // (firstLockedAt) but an INDEPENDENT roll, so the pilot's reaction to
    // "harden up" and "broadcast for reps" don't share a timer. Once
    // broadcastingAt elapses, isBroadcasting flips to true and the ship is
    // a candidate rep target for friendly Scimitars. One-shot per ship.
    //   broadcastingAt    - sim time at which isBroadcasting flips to true
    //                       (null until firstLockedAt is set)
    //   isBroadcasting    - true once broadcastingAt is reached and the
    //                       ship is still alive; stays true until death
    this.broadcastingAt = null;
    this.isBroadcasting = false;

    // Scimitar-only rep state machine (drives _updateLogiLocks in sim.js).
    // For nightmares these stay in their initial values forever; cheap
    // enough that we don't bother gating on shipType.
    //   repState     - "idle" | "reacting" | "locking" | "repping"
    //   repTimer     - seconds remaining in current repState (reacting /
    //                  locking only; ignored in idle / repping)
    //   repTarget    - friendly Ship currently locked / being repped
    //                  (null in idle / reacting; set on lock complete)
    //   repTargetId  - id of repTarget for cheap dead-check + restore
    //   repCooldown  - seconds until next rep cycle fires (only meaningful
    //                  in repping state)
    this.repState = "idle";
    this.repTimer = 0;
    this.repTarget = null;
    this.repTargetId = null;
    this.repCooldown = 0;

    // Per-ship damage modifier (heat sinks + skills + hull bonus). Drawn
    // once at spawn from the team's normal distribution; clamped to >= 0
    // so the unlucky tail can't produce healing-laser ships. Scimitars
    // never fire turrets so we leave their modifier at 0 and skip the
    // roll -- it's only meaningful for nightmare DPS calculation and
    // would just pollute the violin plot if we rolled it for logi too.
    if (shipType === "nightmare") {
      const dcfg = FLEET_CONFIG[team];
      this.damageModifier = Math.max(
        0,
        sampleNormal(dcfg.damageMean, Math.max(0, dcfg.damageSigma))
      );
    } else {
      this.damageModifier = 0;
    }

    // Currently-loaded frequency crystal (index into CRYSTALS). All four
    // lasers on this ship share it. Scimitars also carry these fields for
    // uniformity (cheap), but their values are never read because they
    // never enter the firing branch.
    //   crystalIdx        - index of the live crystal (drives hit chance,
    //                       tracking, EM/thermal damage in fireVolley)
    //   pendingCrystalIdx - the "ideal" crystal the pilot has noticed they
    //                       want to swap to but hasn't yet (null when no
    //                       swap is queued); updated each tick by
    //                       Battle._updateCrystalSwaps as the situation
    //                       evolves -- the actual swap doesn't apply until
    //                       crystalSwapAt fires
    //   crystalSwapAt     - sim time at which the queued swap will be
    //                       applied (null when no swap is queued); rolled
    //                       from FLEET_CONFIG[team].crystalReactionMin/Max
    //                       the first tick a swap becomes warranted, NOT
    //                       re-rolled if the ideal target updates while we
    //                       wait, cleared if the situation resolves first
    this.crystalIdx = DEFAULT_CRYSTAL_IDX;
    this.pendingCrystalIdx = null;
    this.crystalSwapAt = null;
  }

  // The crystal currently loaded in all four lasers. Returns the CRYSTALS[]
  // entry, not the index, so callers can directly read optimalRange /
  // falloff / trackingSpeed / emDamage / thermalDamage. Scimitars also
  // resolve to a valid entry (their crystalIdx defaults to multifrequency)
  // even though they never call this -- harmless and avoids null checks.
  currentCrystal() {
    return CRYSTALS[this.crystalIdx];
  }

  // Combined HP fraction across all three layers, normalised by THIS ship
  // type's total HP (different for nightmares vs scimitars). Used by the
  // renderer to dim the emissive as a ship dies.
  hpFraction() {
    const stats = SHIP_STATS[this.shipType];
    const total = stats.shieldHP + stats.armorHP + stats.structureHP;
    return (this.shield + this.armor + this.structure) / total;
  }

  shieldFraction() {
    const stats = SHIP_STATS[this.shipType];
    return Math.max(0, this.shield) / stats.shieldHP;
  }

  // Hit chance from formulae.txt:
  //   tracking_term = (omega * sigRes) / (tracking * targetSig)
  //   range_term    = max(0, dist - optimal) / falloff
  //   hit_chance    = 0.5 ^ (tracking_term^2 + range_term^2)
  //
  // omega is the target's angular velocity relative to the shooter, computed
  // from the perpendicular component of relative velocity divided by range.
  // The shooter is always a nightmare (only callsite is fireVolley); the
  // target's signature radius depends on the target's ship type, so we pull
  // it from SHIP_STATS rather than hard-coding NIGHTMARE.signatureRadius
  // (Scimitars are much smaller, ~65 m vs 462 m).
  //
  // optimalRange / falloff / trackingSpeed all come from the currently-
  // loaded crystal so the same nightmare computes very different hit chances
  // depending on ammo (e.g. aurora has 142 km optimal but only 0.709 mrad/s
  // tracking, while gleam has 19.7 km optimal at 3.55 mrad/s).
  computeHitChance(target) {
    const toTarget = target.position.clone().sub(this.position);
    const distance = toTarget.length();
    if (distance < 1) return 0; // degenerate

    const losDir = toTarget.divideScalar(distance);
    const relVel = target.velocity.clone().sub(this.velocity);
    // Perpendicular component magnitude: |v - (v . d) d|
    const radialSpeed = relVel.dot(losDir);
    const perpVec = relVel.sub(losDir.multiplyScalar(radialSpeed));
    const perpSpeed = perpVec.length();

    const targetSig = SHIP_STATS[target.shipType].signatureRadius;
    const crystal = this.currentCrystal();
    const omega = perpSpeed / distance; // rad/s
    // Effective tracking applies pilot/fitting bonuses (Tracking Enhancer
    // modules + Trajectory Analysis skill, etc.) on top of the gun+ammo
    // tracking. See NIGHTMARE.trackingModifier in constants.js.
    const effectiveTracking = crystal.trackingSpeed * NIGHTMARE.trackingModifier;
    const trackingTerm =
      (omega * TURRET_SIG_RESOLUTION) / (effectiveTracking * targetSig);
    const rangeTerm =
      distance <= crystal.optimalRange
        ? 0
        : (distance - crystal.optimalRange) / crystal.falloff;

    const exponent = trackingTerm * trackingTerm + rangeTerm * rangeTerm;
    return Math.pow(0.5, exponent);
  }

  // Apply per-laser damage for one cycle's volley. Returns the array of laser
  // results (each {hit, distance, hitChance}) so the renderer can draw beams.
  // Raw EM / thermal damage is computed once from the SHOOTER's per-ship
  // damage modifier (rolled at spawn) AND the currently-loaded crystal's
  // EM/thermal stats, then applied to each hitting laser. The turret damage
  // multiplier (NIGHTMARE.damageMultiplier) is a property of the gun itself
  // and is shared across all crystals.
  fireVolley() {
    if (!this.target || !this.target.alive) return [];
    const target = this.target;
    const hc = this.computeHitChance(target);
    const distance = this.position.distanceTo(target.position);
    const crystal = this.currentCrystal();
    const emRaw =
      crystal.emDamage * NIGHTMARE.damageMultiplier * this.damageModifier;
    const thRaw =
      crystal.thermalDamage * NIGHTMARE.damageMultiplier * this.damageModifier;
    const results = [];
    for (let i = 0; i < NIGHTMARE.numLasers; i++) {
      const hit = Math.random() < hc;
      if (hit) target.takeHit(emRaw, thRaw);
      results.push({ hit, distance, hitChance: hc });
    }
    return results;
  }

  // Apply one laser's damage to layered HP, respecting per-layer EM/thermal
  // resists. The shooter's per-ship damage modifier and the turret damage
  // multiplier are already baked into emRaw / thRaw by fireVolley(). Layer
  // HPs and resists come from this ship's type-specific stats profile.
  takeHit(emRaw, thRaw) {
    if (!this.alive) return;
    const stats = SHIP_STATS[this.shipType];
    let emRemaining = emRaw;
    let thRemaining = thRaw;

    const shieldResists = this.hardenersOverheated
      ? stats.shieldResistsHardenersOverheated
      : this.hardenersOn
      ? stats.shieldResistsHardenersOn
      : stats.shieldResistsBase;

    // Bleed each damage type through the layers in order.
    const layers = [
      { name: "shield", hpKey: "shield", resists: shieldResists },
      { name: "armor", hpKey: "armor", resists: stats.armorResists },
      { name: "structure", hpKey: "structure", resists: stats.structureResists },
    ];

    for (const layer of layers) {
      if (this[layer.hpKey] <= 0) continue;
      const emEff = emRemaining * (1 - layer.resists.em);
      const thEff = thRemaining * (1 - layer.resists.thermal);
      const totalEff = emEff + thEff;
      if (totalEff <= 0) break;

      if (this[layer.hpKey] >= totalEff) {
        this[layer.hpKey] -= totalEff;
        emRemaining = 0;
        thRemaining = 0;
        break;
      }
      // Layer breaks; figure out what fraction of the volley's effective
      // damage was absorbed and bleed the rest into the next layer in
      // proportion to the original raw mix.
      const absorbed = this[layer.hpKey];
      this[layer.hpKey] = 0;
      const consumedFraction = absorbed / totalEff;
      emRemaining *= 1 - consumedFraction;
      thRemaining *= 1 - consumedFraction;
    }

    if (this.structure <= 0) {
      this.structure = 0;
      this.alive = false;
    }
  }
}
