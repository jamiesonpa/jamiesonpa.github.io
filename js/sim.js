import * as THREE from "three";
import { NIGHTMARE, SIM, FLEET_CONFIG } from "./constants.js";
import { Ship } from "./ship.js";
import { updateAI, buildFormationSlots } from "./ai.js";

const LOCK_TIME = 3.5; // seconds, per-ship lock-on

export class Battle {
  constructor() {
    this.ships = [];
    this.leaders = { green: null, red: null };
    // Each team's leader calls a primary target. All ships on that team
    // react -> lock -> fire on it. Re-picked when the current primary dies.
    this.primary = { green: null, red: null };
    this.simTime = 0;
    this.over = false;
    this.winner = null;
    // Hit events queued each tick for the renderer to consume:
    //   { fromId, toId, hit, t } where t is the simTime the event was emitted.
    this.hitEvents = [];

    this._spawn();
  }

  _spawn() {
    // Place green leader at -startSeparation/2 along x; red leader at +.
    // Initial velocity perpendicular (along z) but opposite signs to start
    // them passing each other, which is the optimal opening for transversal.
    const halfSep = SIM.startSeparation / 2;

    const greenLeaderPos = new THREE.Vector3(-halfSep, 0, 0);
    const redLeaderPos = new THREE.Vector3(+halfSep, 0, 0);

    const greenLeader = new Ship({
      team: "green",
      isLeader: true,
      position: greenLeaderPos,
    });
    greenLeader.velocity.set(0, 0, +NIGHTMARE.abSpeed);
    greenLeader.basis.forward.set(0, 0, 1);
    greenLeader.basis.right.set(1, 0, 0);
    greenLeader.basis.up.set(0, 1, 0);

    const redLeader = new Ship({
      team: "red",
      isLeader: true,
      position: redLeaderPos,
    });
    redLeader.velocity.set(0, 0, -NIGHTMARE.abSpeed);
    redLeader.basis.forward.set(0, 0, -1);
    redLeader.basis.right.set(-1, 0, 0);
    redLeader.basis.up.set(0, 1, 0);

    this.leaders.green = greenLeader;
    this.leaders.red = redLeader;
    this.ships.push(greenLeader, redLeader);

    // Per-fleet team size, clamped to >= 1 so we always have a leader.
    const greenSize = Math.max(1, Math.floor(FLEET_CONFIG.green.teamSize));
    const redSize = Math.max(1, Math.floor(FLEET_CONFIG.red.teamSize));

    const blob = {
      x: SIM.formationBlobX,
      y: SIM.formationBlobY,
      z: SIM.formationBlobZ,
    };

    // Build a separate formation per team so each side gets its own
    // properly-sized blob (and so changing one team's size doesn't waste
    // slot-packing effort for the other team).
    const greenSlots = buildFormationSlots(greenSize, SIM.formationMinSpacing, blob);
    const redSlots = buildFormationSlots(redSize, SIM.formationMinSpacing, blob);

    // Helper: given the leader's basis, compute the world position of a slot
    // and spawn a follower there with the leader's initial velocity.
    const spawnFollowers = (leader, slots, count) => {
      for (let i = 0; i < count; i++) {
        const slot = slots[i];
        const worldOff = new THREE.Vector3()
          .addScaledVector(leader.basis.right, slot.x)
          .addScaledVector(leader.basis.up, slot.y)
          .addScaledVector(leader.basis.forward, slot.z);
        const pos = leader.position.clone().add(worldOff);
        const f = new Ship({
          team: leader.team,
          isLeader: false,
          position: pos,
          slotOffset: slot,
        });
        f.velocity.copy(leader.velocity);
        this.ships.push(f);
      }
    };

    spawnFollowers(greenLeader, greenSlots, greenSize - 1);
    spawnFollowers(redLeader, redSlots, redSize - 1);
  }

  // If a leader dies, promote the surviving teammate closest to the old
  // leader's position (or just the first alive one) so followers have a
  // reference. We zero its slotOffset and recompute followers' offsets
  // relative to the new leader's CURRENT position so they don't all suddenly
  // teleport-target the same point.
  _maybePromoteLeader(team) {
    const leader = this.leaders[team];
    if (leader && leader.alive) return;

    let candidate = null;
    let bestDistSq = Infinity;
    const ref = leader ? leader.position : null;
    for (const s of this.ships) {
      if (!s.alive || s.team !== team || s.isLeader) continue;
      const d = ref ? s.position.distanceToSquared(ref) : 0;
      if (d < bestDistSq) {
        bestDistSq = d;
        candidate = s;
      }
    }
    if (!candidate) {
      this.leaders[team] = null;
      return;
    }
    candidate.isLeader = true;
    candidate.slotOffset = null;
    // Initialise basis from current velocity.
    if (candidate.velocity.lengthSq() < 1) {
      candidate.basis.forward.set(0, 0, team === "green" ? 1 : -1);
    } else {
      candidate.basis.forward.copy(candidate.velocity).normalize();
    }
    candidate.basis.right
      .copy(candidate.basis.forward)
      .cross(new THREE.Vector3(0, 1, 0))
      .normalize();
    if (candidate.basis.right.lengthSq() < 1e-6) candidate.basis.right.set(1, 0, 0);
    candidate.basis.up
      .copy(candidate.basis.right)
      .cross(candidate.basis.forward)
      .normalize();

    // Re-anchor surviving followers' slot offsets to be their current
    // position relative to the new leader's basis. This avoids a sudden
    // "everyone scrambles to a new spot" jolt when the leader changes.
    for (const s of this.ships) {
      if (!s.alive || s.team !== team || s === candidate) continue;
      const rel = s.position.clone().sub(candidate.position);
      s.slotOffset = new THREE.Vector3(
        rel.dot(candidate.basis.right),
        rel.dot(candidate.basis.up),
        rel.dot(candidate.basis.forward)
      );
    }
    this.leaders[team] = candidate;
  }

  // The "leader's call": nearest enemy ship to our team's leader. If our
  // leader is dead (mid-promotion), fall back to the first surviving teammate
  // as the reference point. Returns null if no enemies remain.
  _pickPrimary(team) {
    const enemyTeam = team === "green" ? "red" : "green";
    const leader = this.leaders[team];
    let ref = null;
    if (leader && leader.alive) {
      ref = leader.position;
    } else {
      for (const s of this.ships) {
        if (s.alive && s.team === team) {
          ref = s.position;
          break;
        }
      }
    }
    if (!ref) return null;

    let best = null;
    let bestD = Infinity;
    for (const o of this.ships) {
      if (!o.alive || o.team !== enemyTeam) continue;
      const d = ref.distanceToSquared(o.position);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  _updatePrimaries() {
    for (const team of ["green", "red"]) {
      const cur = this.primary[team];
      if (!cur || !cur.alive) {
        this.primary[team] = this._pickPrimary(team);
      }
    }
  }

  // Per-ship lock-on progression. When the team primary changes (or is set
  // for the first time), every ship rolls a fresh reaction delay (uniform
  // 0-1 s), then enters a 3.5 s lock cycle. Only ships in the "locked" state
  // are allowed to fire (enforced in the combat loop).
  _updateLocks(dt) {
    for (const s of this.ships) {
      if (!s.alive) continue;
      const primary = this.primary[s.team];

      if (!primary || !primary.alive) {
        s.lockState = "idle";
        s.lockedPrimaryId = null;
        s.target = null;
        continue;
      }

      // New primary called -> restart reaction + lock for this ship.
      if (s.lockedPrimaryId !== primary.id) {
        s.lockedPrimaryId = primary.id;
        s.lockState = "reacting";
        // Per-team reaction range, configured at runtime via FLEET_CONFIG
        // (UI bound in main.js). Uniform roll in [min, max], clamped to >= 0.
        const cfg = FLEET_CONFIG[s.team];
        const lo = Math.max(0, cfg.reactionMin);
        const hi = Math.max(lo, cfg.reactionMax);
        s.lockTimer = lo + Math.random() * (hi - lo);
        s.target = null;
      }

      if (s.lockState === "reacting") {
        s.lockTimer -= dt;
        if (s.lockTimer <= 0) {
          s.lockState = "locking";
          s.lockTimer = LOCK_TIME;
        }
      } else if (s.lockState === "locking") {
        s.lockTimer -= dt;
        if (s.lockTimer <= 0) {
          s.lockState = "locked";
          s.target = primary;
          // First completed enemy lock against `primary` triggers its
          // hardener-reaction countdown. Roll uses the *primary's* team
          // config (it's the targeted ship that's reacting). One-shot:
          // subsequent lockers don't reset or re-roll.
          if (primary.firstLockedAt === null) {
            primary.firstLockedAt = this.simTime;
            const hcfg = FLEET_CONFIG[primary.team];
            const hlo = Math.max(0, hcfg.hardenerReactionMin);
            const hhi = Math.max(hlo, hcfg.hardenerReactionMax);
            primary.hardenerActivateAt =
              this.simTime + hlo + Math.random() * (hhi - hlo);
          }
        }
      } else if (s.lockState === "locked") {
        // Stay locked on the current primary as long as it lives.
        s.target = primary;
      }
    }
  }

  // Flip hardenersOn for any ship whose activation time has arrived, and
  // flip hardenersOverheated for any ship whose overheat time has arrived.
  // Trigger / activation time for hardeners is seeded inside _updateLocks
  // on the first enemy lock; the overheat trigger is seeded HERE on the
  // tick that hardeners actually come online (so the overheat reaction is
  // counted from "hardeners on", not from "first locked"). Once flipped,
  // both flags stay on for the rest of the battle (no cycle / cap / burnout
  // model in v1).
  _updateHardeners() {
    for (const s of this.ships) {
      if (!s.alive) continue;

      if (!s.hardenersOn) {
        if (s.hardenerActivateAt === null) continue;
        if (this.simTime >= s.hardenerActivateAt) {
          s.hardenersOn = true;
          // Seed the overheat reaction now that hardeners are live.
          // Per-team config; uniform roll in [min, max], clamped to >= 0.
          const ocfg = FLEET_CONFIG[s.team];
          const olo = Math.max(0, ocfg.overheatReactionMin);
          const ohi = Math.max(olo, ocfg.overheatReactionMax);
          s.overheatActivateAt =
            this.simTime + olo + Math.random() * (ohi - olo);
        }
      } else if (!s.hardenersOverheated) {
        if (s.overheatActivateAt === null) continue;
        if (this.simTime >= s.overheatActivateAt) {
          s.hardenersOverheated = true;
        }
      }
    }
  }

  // One fixed-step tick: dt seconds of sim time.
  tick(dt) {
    if (this.over) return;
    this.simTime += dt;

    // Drain stale beam-flash events older than the flash duration so the
    // renderer doesn't have to filter them every frame.
    const cutoff = this.simTime - SIM.beamFlashDuration;
    while (this.hitEvents.length && this.hitEvents[0].t < cutoff) {
      this.hitEvents.shift();
    }

    // Promotion + primary call + per-ship lock progression + AI steering.
    this._maybePromoteLeader("green");
    this._maybePromoteLeader("red");
    this._updatePrimaries();
    this._updateLocks(dt);
    this._updateHardeners();
    updateAI(this, dt);

    // Integrate motion.
    const tmp = new THREE.Vector3();
    for (const s of this.ships) {
      if (!s.alive) continue;
      tmp.copy(s.velocity).multiplyScalar(dt);
      s.position.add(tmp);
    }

    // Combat: tick weapon cooldowns; fire only when locked. If unlocked, the
    // cooldown clamps at 0 so the first volley after lock isn't delayed by a
    // wasted cycle.
    for (const s of this.ships) {
      if (!s.alive) continue;
      s.weaponCooldown -= dt;
      if (s.weaponCooldown > 0) continue;

      const canFire =
        s.lockState === "locked" && s.target && s.target.alive;
      if (!canFire) {
        s.weaponCooldown = 0; // hold ready; will fire as soon as locked
        continue;
      }
      s.weaponCooldown = NIGHTMARE.rateOfFire;
      const targetId = s.target.id;
      const results = s.fireVolley();
      // Emit one beam-flash event per individual laser shot so multiple
      // bright flashes can stack visually for hits.
      for (const r of results) {
        this.hitEvents.push({
          fromId: s.id,
          toId: targetId,
          hit: r.hit,
          t: this.simTime,
        });
      }
    }

    // End condition.
    let greenAlive = 0;
    let redAlive = 0;
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team === "green") greenAlive++;
      else redAlive++;
    }
    if (greenAlive === 0 || redAlive === 0) {
      this.over = true;
      this.winner =
        greenAlive === 0 && redAlive === 0
          ? "draw"
          : greenAlive > 0
          ? "green"
          : "red";
    }
  }

  countAlive(team) {
    let n = 0;
    for (const s of this.ships) if (s.alive && s.team === team) n++;
    return n;
  }
}
