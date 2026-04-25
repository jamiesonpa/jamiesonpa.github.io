import * as THREE from "three";
import { NIGHTMARE, SIM, FLEET_CONFIG } from "./constants.js";
import { Ship } from "./ship.js";
import { updateAI, buildFormationSlots } from "./ai.js";

const LOCK_TIME = 3.5; // seconds, per-ship lock-on

export class Battle {
  constructor() {
    this.ships = [];
    // Per-team list of subfleets. Each entry is { id, leader, primary }:
    //   id      : index in the array; matches Ship.subfleetId for members
    //   leader  : Ship currently leading this subfleet (null if extinct)
    //   primary : Ship the subfleet's leader is calling as primary target
    //             (null if no live enemies / leader gone)
    // Entries are never removed mid-battle so subfleetId stays a stable
    // index. A wiped-out subfleet keeps its slot with leader/primary = null.
    this.subfleets = { green: [], red: [] };
    this.simTime = 0;
    this.over = false;
    this.winner = null;
    // Hit events queued each tick for the renderer to consume:
    //   { fromId, toId, hit, t } where t is the simTime the event was emitted.
    this.hitEvents = [];

    this._spawn();
  }

  // Distribute totalSize across n bins as evenly as possible. The first
  // (totalSize % n) bins get one extra ship. Returns an array of bin sizes
  // summing to totalSize (each >= 1 since we clamp n <= totalSize upstream).
  _splitTeamSize(totalSize, n) {
    const base = Math.floor(totalSize / n);
    const extra = totalSize - base * n;
    const sizes = new Array(n);
    for (let i = 0; i < n; i++) sizes[i] = base + (i < extra ? 1 : 0);
    return sizes;
  }

  _spawn() {
    // Place green team at -startSeparation/2 along x; red team at +.
    // Each team is split into N subfleets stacked along the Y axis so the
    // formation blobs (formationBlobY half-height) don't overlap and the
    // user can see them as visually distinct groups from frame 1. Each
    // subfleet gets its own initial velocity along Z (opposite signs per
    // team), its own formation slots, and its own leader.
    const halfSep = SIM.startSeparation / 2;

    for (const team of ["green", "red"]) {
      const cfg = FLEET_CONFIG[team];
      const teamSize = Math.max(1, Math.floor(cfg.teamSize));
      // Clamp subfleet count to teamSize (can't have more subfleets than
      // ships -- empty subfleets aren't useful and break the leader invariant).
      const requested = Math.max(1, Math.floor(cfg.subfleetCount));
      const n = Math.min(requested, teamSize);

      const sizes = this._splitTeamSize(teamSize, n);
      const baseX = team === "green" ? -halfSep : +halfSep;
      const vz = team === "green" ? +NIGHTMARE.abSpeed : -NIGHTMARE.abSpeed;
      const basisFwdZ = team === "green" ? 1 : -1;
      const basisRightX = team === "green" ? 1 : -1;

      const blob = {
        x: SIM.formationBlobX,
        y: SIM.formationBlobY,
        z: SIM.formationBlobZ,
      };

      for (let i = 0; i < n; i++) {
        const subfleetSize = sizes[i];
        // Center subfleets symmetrically around y=0.
        const yOffset = (i - (n - 1) / 2) * SIM.subfleetVerticalSpacing;

        const leaderPos = new THREE.Vector3(baseX, yOffset, 0);
        const leader = new Ship({
          team,
          isLeader: true,
          position: leaderPos,
          subfleetId: i,
        });
        leader.velocity.set(0, 0, vz);
        leader.basis.forward.set(0, 0, basisFwdZ);
        leader.basis.right.set(basisRightX, 0, 0);
        leader.basis.up.set(0, 1, 0);

        this.ships.push(leader);
        this.subfleets[team].push({ id: i, leader, primary: null });

        // Spawn followers around this subfleet's leader.
        const slots = buildFormationSlots(
          subfleetSize,
          SIM.formationMinSpacing,
          blob
        );
        for (let f = 0; f < subfleetSize - 1; f++) {
          const slot = slots[f];
          const worldOff = new THREE.Vector3()
            .addScaledVector(leader.basis.right, slot.x)
            .addScaledVector(leader.basis.up, slot.y)
            .addScaledVector(leader.basis.forward, slot.z);
          const pos = leader.position.clone().add(worldOff);
          const follower = new Ship({
            team,
            isLeader: false,
            position: pos,
            slotOffset: slot,
            subfleetId: i,
          });
          follower.velocity.copy(leader.velocity);
          this.ships.push(follower);
        }
      }
    }
  }

  // If a subfleet's leader dies, promote the surviving subfleet member
  // closest to the old leader's position (or just the first alive one) so
  // followers have a reference. We zero its slotOffset and recompute
  // followers' offsets relative to the new leader's CURRENT position so
  // they don't all suddenly teleport-target the same point. If the entire
  // subfleet is wiped out, leader becomes null and the subfleet is inert
  // until the battle ends. Promotion is scoped to (team, subfleetId) so
  // a candidate from a different subfleet can never absorb this one.
  _maybePromoteLeader(team, subfleetId) {
    const sub = this.subfleets[team][subfleetId];
    const leader = sub.leader;
    if (leader && leader.alive) return;

    let candidate = null;
    let bestDistSq = Infinity;
    const ref = leader ? leader.position : null;
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team !== team || s.subfleetId !== subfleetId) continue;
      if (s.isLeader) continue;
      const d = ref ? s.position.distanceToSquared(ref) : 0;
      if (d < bestDistSq) {
        bestDistSq = d;
        candidate = s;
      }
    }
    if (!candidate) {
      sub.leader = null;
      sub.primary = null;
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

    // Re-anchor surviving subfleet members' slot offsets to be their
    // current position relative to the new leader's basis. This avoids
    // a sudden "everyone scrambles to a new spot" jolt when the leader
    // changes.
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team !== team || s.subfleetId !== subfleetId) continue;
      if (s === candidate) continue;
      const rel = s.position.clone().sub(candidate.position);
      s.slotOffset = new THREE.Vector3(
        rel.dot(candidate.basis.right),
        rel.dot(candidate.basis.up),
        rel.dot(candidate.basis.forward)
      );
    }
    sub.leader = candidate;
  }

  // The subfleet leader's call: nearest enemy ship (across ALL enemy
  // subfleets) to this subfleet's leader. If our subfleet leader is gone
  // mid-promotion, fall back to the first surviving subfleet member as
  // the reference point. Returns null if the subfleet is extinct or no
  // enemies remain.
  //
  // `takenIds` (optional Set of ship ids) lets the caller exclude enemies
  // already chosen as primary by sibling subfleets on the same team, so
  // sibling subfleets fan their fire across distinct targets instead of
  // dogpiling the same ship. If every reachable enemy is taken (e.g.,
  // more subfleets than enemies remain), we fall back to the nearest
  // taken enemy so the subfleet still has SOMETHING to shoot.
  _pickPrimary(team, subfleetId, takenIds = null) {
    const enemyTeam = team === "green" ? "red" : "green";
    const sub = this.subfleets[team][subfleetId];
    const leader = sub.leader;
    let ref = null;
    if (leader && leader.alive) {
      ref = leader.position;
    } else {
      for (const s of this.ships) {
        if (!s.alive) continue;
        if (s.team !== team || s.subfleetId !== subfleetId) continue;
        ref = s.position;
        break;
      }
    }
    if (!ref) return null;

    let best = null;
    let bestD = Infinity;
    let fallbackBest = null;
    let fallbackBestD = Infinity;
    for (const o of this.ships) {
      if (!o.alive || o.team !== enemyTeam) continue;
      const d = ref.distanceToSquared(o.position);
      if (takenIds && takenIds.has(o.id)) {
        if (d < fallbackBestD) {
          fallbackBestD = d;
          fallbackBest = o;
        }
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best || fallbackBest;
  }

  // For each team: keep existing live primaries (so we don't disrupt
  // already-progressing locks), but ensure they are unique across the
  // team's subfleets. If two subfleets share a live primary -- which
  // shouldn't happen now but is checked defensively -- the higher-index
  // subfleet drops its primary and re-picks. Subfleets that need a fresh
  // primary then pick one that's NOT already claimed by a sibling
  // subfleet, with a fallback to "any nearest enemy" if every enemy is
  // already claimed (more subfleets than surviving enemies).
  _updatePrimaries() {
    for (const team of ["green", "red"]) {
      // 1) Defensive dedup of currently-live primaries.
      const seen = new Set();
      for (const sub of this.subfleets[team]) {
        if (sub.primary && sub.primary.alive) {
          if (seen.has(sub.primary.id)) {
            sub.primary = null;
          } else {
            seen.add(sub.primary.id);
          }
        }
      }
      // 2) takenIds = ids still claimed after the dedup pass.
      const takenIds = new Set(seen);
      // 3) Re-pick for any subfleet without a live primary, excluding
      //    siblings' claims; add the new pick to takenIds so the next
      //    sibling subfleet can't immediately collide with it.
      for (const sub of this.subfleets[team]) {
        if (!sub.primary || !sub.primary.alive) {
          sub.primary = this._pickPrimary(team, sub.id, takenIds);
          if (sub.primary) takenIds.add(sub.primary.id);
        }
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
      const sub = this.subfleets[s.team][s.subfleetId];
      const primary = sub ? sub.primary : null;

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
    // Promote leaders for every subfleet on both sides; iterating directly
    // over the subfleets array keeps the call count bounded by N (typically
    // 1-6 per team) regardless of fleet size.
    for (const team of ["green", "red"]) {
      for (const sub of this.subfleets[team]) {
        this._maybePromoteLeader(team, sub.id);
      }
    }
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
