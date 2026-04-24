import * as THREE from "three";
import {
  NIGHTMARE,
  TURRET_SIG_RESOLUTION,
  FLEET_CONFIG,
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
export class Ship {
  constructor({ team, isLeader = false, position, slotOffset = null }) {
    this.id = nextShipId++;
    this.team = team; // "green" | "red"
    this.isLeader = isLeader;

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

    this.shield = NIGHTMARE.shieldHP;
    this.armor = NIGHTMARE.armorHP;
    this.structure = NIGHTMARE.structureHP;
    this.alive = true;

    this.target = null;
    // Stagger initial cycles so all 50 ships of a side don't volley in
    // perfect lockstep.
    this.weaponCooldown = Math.random() * NIGHTMARE.rateOfFire;

    // Lock state machine. The team primary is broadcast by Battle; on each
    // change every ship rolls a fresh reaction delay (0-1 s), then takes
    // 3.5 s to lock before it can fire.
    //   "idle"     -> no primary yet, or primary dead
    //   "reacting" -> waiting out random reaction delay
    //   "locking"  -> 3.5 s ship-lock timer ticking down
    //   "locked"   -> may fire on this.target
    this.lockState = "idle";
    this.lockTimer = 0;
    this.lockedPrimaryId = null;

    // Shield-hardener state. Hardeners start OFF (passive resist profile).
    // They activate once, after the per-ship hardener-reaction roll that
    // begins the moment this ship is first locked by any enemy.
    //   firstLockedAt        - sim time of the first completed enemy lock
    //                          (null until that happens)
    //   hardenerActivateAt   - sim time at which hardenersOn flips to true
    //                          (null until firstLockedAt is set)
    //   hardenersOn          - true once activated; never turns back off
    this.firstLockedAt = null;
    this.hardenerActivateAt = null;
    this.hardenersOn = false;

    // Per-ship damage modifier (heat sinks + skills + hull bonus). Drawn
    // once at spawn from the team's normal distribution; clamped to >= 0
    // so the unlucky tail can't produce healing-laser ships.
    const dcfg = FLEET_CONFIG[team];
    this.damageModifier = Math.max(
      0,
      sampleNormal(dcfg.damageMean, Math.max(0, dcfg.damageSigma))
    );
  }

  hpFraction() {
    const total = NIGHTMARE.shieldHP + NIGHTMARE.armorHP + NIGHTMARE.structureHP;
    return (this.shield + this.armor + this.structure) / total;
  }

  shieldFraction() {
    return Math.max(0, this.shield) / NIGHTMARE.shieldHP;
  }

  // Hit chance from formulae.txt:
  //   tracking_term = (omega * sigRes) / (tracking * targetSig)
  //   range_term    = max(0, dist - optimal) / falloff
  //   hit_chance    = 0.5 ^ (tracking_term^2 + range_term^2)
  //
  // omega is the target's angular velocity relative to the shooter, computed
  // from the perpendicular component of relative velocity divided by range.
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

    const omega = perpSpeed / distance; // rad/s
    const trackingTerm =
      (omega * TURRET_SIG_RESOLUTION) /
      (NIGHTMARE.trackingSpeed * NIGHTMARE.signatureRadius);
    const rangeTerm =
      distance <= NIGHTMARE.optimalRange
        ? 0
        : (distance - NIGHTMARE.optimalRange) / NIGHTMARE.falloff;

    const exponent = trackingTerm * trackingTerm + rangeTerm * rangeTerm;
    return Math.pow(0.5, exponent);
  }

  // Apply per-laser damage for one cycle's volley. Returns the array of laser
  // results (each {hit, distance, hitChance}) so the renderer can draw beams.
  // Raw EM / thermal damage is computed once from the SHOOTER's per-ship
  // damage modifier (rolled at spawn) and applied to each hitting laser.
  fireVolley() {
    if (!this.target || !this.target.alive) return [];
    const target = this.target;
    const hc = this.computeHitChance(target);
    const distance = this.position.distanceTo(target.position);
    const emRaw =
      NIGHTMARE.emDamage * NIGHTMARE.damageMultiplier * this.damageModifier;
    const thRaw =
      NIGHTMARE.thermalDamage * NIGHTMARE.damageMultiplier * this.damageModifier;
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
  // multiplier are already baked into emRaw / thRaw by fireVolley().
  takeHit(emRaw, thRaw) {
    if (!this.alive) return;
    let emRemaining = emRaw;
    let thRemaining = thRaw;

    const shieldResists = this.hardenersOn
      ? NIGHTMARE.shieldResistsHardenersOn
      : NIGHTMARE.shieldResistsBase;

    // Bleed each damage type through the layers in order.
    const layers = [
      { name: "shield", hpKey: "shield", resists: shieldResists },
      { name: "armor", hpKey: "armor", resists: NIGHTMARE.armorResists },
      { name: "structure", hpKey: "structure", resists: NIGHTMARE.structureResists },
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
