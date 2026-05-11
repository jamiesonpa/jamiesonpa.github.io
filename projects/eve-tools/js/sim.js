import * as THREE from "three";
import {
  NIGHTMARE,
  SHIP_STATS,
  REMOTE_REP,
  SIM,
  FLEET_CONFIG,
  CRYSTALS,
  pickIdealCrystalIdx,
} from "./constants.js";
import { Ship } from "./ship.js";
import { updateAI, buildFormationSlots } from "./ai.js";

const LOCK_TIME = 3.5; // seconds, per-ship lock-on (nightmare on enemy primary)

export class Battle {
  constructor() {
    this.ships = [];
    // Per-team list of subfleets. Each entry is:
    //   { id, leader, primary, primaryStartTime, primarySwapAt, originalCount }
    //     id                : index in the array; matches Ship.subfleetId
    //     leader            : Ship currently leading this subfleet (null if
    //                         extinct)
    //     primary           : Ship the subfleet is calling as primary target
    //                         (null if no live enemies / leader gone)
    //     primaryStartTime  : simTime at which `primary` was last assigned;
    //                         null when there is no primary
    //     primarySwapAt     : simTime at which the subfleet will force-drop
    //                         its current primary if it's still alive (i.e.
    //                         the "target-switch reaction" has expired);
    //                         null when there is no primary
    //     originalCount     : number of ships (nightmares + scimitars) that
    //                         spawned into this subfleet. Constant after
    //                         spawn; used by _maybeMergeSubfleets to compute
    //                         the team-wide alive/spawn ratio against
    //                         FLEET_CONFIG[team].survivorProportion.
    // Entries are never removed mid-battle so subfleetId stays a stable
    // index. A wiped-out subfleet keeps its slot with leader/primary = null.
    this.subfleets = { green: [], red: [] };
    // Latches true the first time _maybeMergeSubfleets folds this team's
    // subfleets together. The merge is irreversible (all surviving ships
    // get reassigned to a single subfleetId), so once set we skip the
    // per-tick threshold check entirely. Set per-team because each side
    // has its own mergeSubfleetsAfterLosses toggle.
    this.subfleetsMerged = { green: false, red: false };
    this.simTime = 0;
    this.over = false;
    this.winner = null;
    // Hit events queued each tick for the renderer to consume:
    //   { kind, fromId, toId, hit?, amount?, t }
    //     kind: "fire" - turret laser shot; carries `hit` (bool)
    //     kind: "rep"  - scimitar rep cycle; carries `amount` (HP applied)
    //   t is the simTime the event was emitted.
    this.hitEvents = [];

    this._spawn();
  }

  // Distribute totalSize across n bins as evenly as possible. The first
  // (totalSize % n) bins get one extra ship. Returns an array of bin sizes
  // summing to totalSize. May contain zeros if totalSize < n (caller is
  // responsible for handling empty-bin semantics).
  _splitTeamSize(totalSize, n) {
    if (n <= 0) return [];
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
    // user can see them as visually distinct groups from frame 1.
    //
    // Per-subfleet composition: nightmares are allocated first (so the
    // leader slot of every subfleet is a nightmare whenever possible),
    // then scimitars fill the remaining slots in the formation. If a
    // subfleet ends up with 0 nightmares (e.g. nightmareCount < subfleetCount),
    // the first scimitar in that subfleet becomes the leader -- it can
    // still steer the formation, it just won't shoot.
    const halfSep = SIM.startSeparation / 2;

    for (const team of ["green", "red"]) {
      const cfg = FLEET_CONFIG[team];
      const nightmareCount = Math.max(0, Math.floor(cfg.nightmareCount));
      const scimitarCount = Math.max(0, Math.floor(cfg.scimitarCount));
      const teamSize = nightmareCount + scimitarCount;
      // Empty fleet: skip spawn entirely. End-condition logic in tick()
      // will treat this as the team being already wiped out.
      if (teamSize <= 0) continue;

      // Clamp subfleet count to teamSize (can't have more subfleets than
      // ships -- empty subfleets aren't useful and break the leader invariant).
      const requested = Math.max(1, Math.floor(cfg.subfleetCount));
      const n = Math.min(requested, teamSize);

      // Distribute nightmares and scimitars independently so each subfleet
      // gets a near-equal share of both types. This keeps the leader-is-
      // nightmare invariant true on every subfleet whenever nightmareCount
      // >= subfleetCount.
      const nightmareSizes = this._splitTeamSize(nightmareCount, n);
      const scimitarSizes = this._splitTeamSize(scimitarCount, n);

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
        const numN = nightmareSizes[i];
        const numS = scimitarSizes[i];
        const subfleetSize = numN + numS;
        if (subfleetSize <= 0) continue;
        // Center subfleets symmetrically around y=0.
        const yOffset = (i - (n - 1) / 2) * SIM.subfleetVerticalSpacing;

        // Leader type: nightmare if any in this subfleet, else scimitar.
        const leaderType = numN > 0 ? "nightmare" : "scimitar";
        const leaderPos = new THREE.Vector3(baseX, yOffset, 0);
        const leader = new Ship({
          team,
          shipType: leaderType,
          isLeader: true,
          position: leaderPos,
          subfleetId: i,
        });
        leader.velocity.set(0, 0, vz);
        leader.basis.forward.set(0, 0, basisFwdZ);
        leader.basis.right.set(basisRightX, 0, 0);
        leader.basis.up.set(0, 1, 0);

        this.ships.push(leader);
        this.subfleets[team].push({
          id: i,
          leader,
          primary: null,
          primaryStartTime: null,
          primarySwapAt: null,
          originalCount: subfleetSize,
        });

        // Build a flat list of remaining (non-leader) ship types for this
        // subfleet, with nightmares first then scimitars. This keeps the
        // per-subfleet roster numbering stable (N01, N02, ..., S01, S02).
        const remainingTypes = [];
        const nightmareFollowers = leaderType === "nightmare" ? numN - 1 : numN;
        const scimitarFollowers = leaderType === "scimitar" ? numS - 1 : numS;
        for (let f = 0; f < nightmareFollowers; f++) {
          remainingTypes.push("nightmare");
        }
        for (let f = 0; f < scimitarFollowers; f++) {
          remainingTypes.push("scimitar");
        }

        // Spawn followers around this subfleet's leader.
        const slots = buildFormationSlots(
          subfleetSize,
          SIM.formationMinSpacing,
          blob
        );
        for (let f = 0; f < remainingTypes.length; f++) {
          const slot = slots[f];
          const worldOff = new THREE.Vector3()
            .addScaledVector(leader.basis.right, slot.x)
            .addScaledVector(leader.basis.up, slot.y)
            .addScaledVector(leader.basis.forward, slot.z);
          const pos = leader.position.clone().add(worldOff);
          const follower = new Ship({
            team,
            shipType: remainingTypes[f],
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
  //
  // Promotion preference: nightmares > scimitars for the same distance,
  // because a nightmare leader can also contribute DPS. If only scimitars
  // remain, we promote a scimitar -- the formation still flies, it just
  // won't shoot.
  _maybePromoteLeader(team, subfleetId) {
    const sub = this.subfleets[team][subfleetId];
    const leader = sub.leader;
    if (leader && leader.alive) return;

    let bestNightmare = null;
    let bestNightmareDistSq = Infinity;
    let bestScimitar = null;
    let bestScimitarDistSq = Infinity;
    const ref = leader ? leader.position : null;
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team !== team || s.subfleetId !== subfleetId) continue;
      if (s.isLeader) continue;
      const d = ref ? s.position.distanceToSquared(ref) : 0;
      if (s.shipType === "nightmare") {
        if (d < bestNightmareDistSq) {
          bestNightmareDistSq = d;
          bestNightmare = s;
        }
      } else if (s.shipType === "scimitar") {
        if (d < bestScimitarDistSq) {
          bestScimitarDistSq = d;
          bestScimitar = s;
        }
      }
    }
    const candidate = bestNightmare || bestScimitar;
    if (!candidate) {
      sub.leader = null;
      sub.primary = null;
      sub.primaryStartTime = null;
      sub.primarySwapAt = null;
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

  // Optional "merge subfleets after losses" collapse, gated by
  // FLEET_CONFIG[team].mergeSubfleetsAfterLosses. Once the team's surviving
  // fraction across its non-empty subfleets drops below survivorProportion,
  // every surviving ship is reassigned into a single subfleet -- the
  // lowest-id subfleet that still has a live leader -- and every other
  // subfleet on the team is emptied out (leader/primary nulled). After the
  // merge the team has exactly one target-calling subfleet again, which is
  // the user-facing intent: pick a single primary instead of fanning fire
  // across the (now reduced) survivors.
  //
  // Cheap-out conditions (any of these skips the work):
  //   - feature toggle off
  //   - team already merged (latched in this.subfleetsMerged[team])
  //   - team has 0 or 1 non-empty subfleets (nothing to merge)
  //   - no spawn-time ships were recorded (defensive divide-by-zero guard)
  //   - alive/spawn ratio still >= survivorProportion
  //
  // Called once per tick in tick() AFTER leader promotion (so the keeper's
  // leader is already valid for the tick) and BEFORE _updatePrimaries (so
  // the primary-call pass below sees one subfleet with one primary).
  _maybeMergeSubfleets(team) {
    const cfg = FLEET_CONFIG[team];
    if (!cfg.mergeSubfleetsAfterLosses) return;
    if (this.subfleetsMerged[team]) return;

    const subs = this.subfleets[team];
    // Count how many subfleets currently have any alive ships, and tally
    // the team-wide alive count + spawn-time count in the same pass.
    let nonEmptyCount = 0;
    let aliveTotal = 0;
    let spawnTotal = 0;
    const aliveBySub = new Array(subs.length).fill(0);
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team !== team) continue;
      aliveBySub[s.subfleetId]++;
    }
    for (let i = 0; i < subs.length; i++) {
      spawnTotal += subs[i].originalCount || 0;
      if (aliveBySub[i] > 0) nonEmptyCount++;
      aliveTotal += aliveBySub[i];
    }
    if (nonEmptyCount <= 1) return;
    if (spawnTotal <= 0) return;

    const proportion = Math.min(1, Math.max(0, cfg.survivorProportion));
    if (aliveTotal / spawnTotal >= proportion) return;

    // Pick the keeper: lowest-id subfleet that has a live leader. If none
    // do (e.g. every leader just died this tick), fall back to lowest-id
    // subfleet with any alive members; _maybePromoteLeader will be called
    // for it below to install a leader before we re-anchor followers.
    let keeperId = -1;
    for (let i = 0; i < subs.length; i++) {
      if (subs[i].leader && subs[i].leader.alive) {
        keeperId = i;
        break;
      }
    }
    if (keeperId === -1) {
      for (let i = 0; i < subs.length; i++) {
        if (aliveBySub[i] > 0) {
          keeperId = i;
          break;
        }
      }
    }
    if (keeperId === -1) return; // entire team gone; nothing to merge

    // Reassign every alive ship from non-keeper subfleets onto the keeper.
    // We collect them first so we can demote any absorbed leaders and
    // re-anchor their slot offsets in a single pass once the keeper's
    // leader is final.
    const absorbed = [];
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.team !== team) continue;
      if (s.subfleetId === keeperId) continue;
      absorbed.push(s);
      s.subfleetId = keeperId;
    }

    // Empty out every non-keeper subfleet's bookkeeping so render / AI /
    // primary-call code stops iterating their stale leader+primary refs.
    for (let i = 0; i < subs.length; i++) {
      if (i === keeperId) continue;
      const sub = subs[i];
      sub.leader = null;
      sub.primary = null;
      sub.primaryStartTime = null;
      sub.primarySwapAt = null;
    }

    // Make sure the keeper has a leader. If the keeper's existing leader
    // is alive this is a no-op; otherwise _maybePromoteLeader picks a new
    // one from the keeper's now-expanded membership (which already
    // includes the absorbed ships' subfleetId rewrite above).
    this._maybePromoteLeader(team, keeperId);
    const keeperLeader = subs[keeperId].leader;

    // Re-anchor absorbed ships' slot offsets relative to the keeper
    // leader's CURRENT basis, the same way _maybePromoteLeader re-anchors
    // surviving subfleet members on a leader change. Without this every
    // absorbed ship would suddenly target whatever slotOffset they had
    // relative to their old (now-defunct) subfleet leader and either
    // teleport-snap or fly toward stale formation slots. Skip if there's
    // no keeper leader (degenerate; merge is harmless anyway).
    if (keeperLeader && keeperLeader.alive) {
      for (const s of absorbed) {
        if (s === keeperLeader) continue;
        if (s.isLeader) s.isLeader = false;
        const rel = s.position.clone().sub(keeperLeader.position);
        s.slotOffset = new THREE.Vector3(
          rel.dot(keeperLeader.basis.right),
          rel.dot(keeperLeader.basis.up),
          rel.dot(keeperLeader.basis.forward)
        );
      }
    }

    this.subfleetsMerged[team] = true;

    // One-shot diagnostic so the user can verify in DevTools that the
    // collapse fired and at what threshold. Logged exactly once per team
    // per battle (gated by the subfleetsMerged latch above) so it can't
    // spam the console.
    if (typeof console !== "undefined" && console.log) {
      console.log(
        `[subfleet-merge] team=${team} simTime=${this.simTime.toFixed(1)}s ` +
          `alive=${aliveTotal}/${spawnTotal} ` +
          `(${((aliveTotal / spawnTotal) * 100).toFixed(0)}% < ` +
          `${(proportion * 100).toFixed(0)}% threshold) ` +
          `keeperSubfleetId=${keeperId} absorbed=${absorbed.length}`
      );
    }
  }

  // The subfleet leader's call: nearest enemy NIGHTMARE (across ALL enemy
  // subfleets) to this subfleet's leader. If our subfleet leader is gone
  // mid-promotion, fall back to the first surviving subfleet member as
  // the reference point. Returns null if the subfleet is extinct or no
  // enemy nightmares remain.
  //
  // Per-user spec, nightmares NEVER shoot enemy scimitars -- only enemy
  // nightmares are valid primary targets. Scimitars are therefore
  // effectively invulnerable (they're never locked, never activate
  // hardeners, never broadcast for reps), and the end-condition in
  // tick() looks at surviving nightmares rather than total ship count
  // so a side that runs out of nightmares loses immediately even if its
  // logistics wing is still alive (it has no offensive capability left).
  //
  // `takenIds` (optional Set of ship ids) lets the caller exclude enemies
  // already chosen as primary by sibling subfleets on the same team, so
  // sibling subfleets fan their fire across distinct targets instead of
  // dogpiling the same ship. If every reachable enemy nightmare is taken
  // (e.g., more subfleets than enemy nightmares remain), we fall back to
  // the nearest taken enemy nightmare so the subfleet still has SOMETHING
  // to shoot.
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
      // Nightmares-only target filter. Scimitars are ignored entirely
      // here so they never get called as primary, never get locked, and
      // never take damage from turret fire.
      if (o.shipType !== "nightmare") continue;
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
  //
  // Target-switch reaction: each subfleet also rolls a "time on target"
  // deadline (primarySwapAt) when it commits to a primary. If that deadline
  // arrives while the primary is still alive, the subfleet drops it and
  // re-picks excluding the just-dropped enemy id. This models a fleet
  // noticing that a target isn't dying (typically because enemy Scimitars
  // are repping it) and switching to a softer target. If the only available
  // candidate is the just-dropped enemy itself (i.e., no real alternative),
  // the fallback in _pickPrimary re-targets it; we still reset the swap
  // timer so we don't loop on every tick.
  _updatePrimaries() {
    for (const team of ["green", "red"]) {
      // 0) Force-swap any alive primary whose target-switch reaction has
      //    expired. Remember the dropped id per-subfleet so the re-pick
      //    pass below can exclude it from the candidate set.
      const justSwappedOff = new Map(); // subfleetId -> dropped enemy id
      for (const sub of this.subfleets[team]) {
        if (
          sub.primary &&
          sub.primary.alive &&
          sub.primarySwapAt !== null &&
          this.simTime >= sub.primarySwapAt
        ) {
          justSwappedOff.set(sub.id, sub.primary.id);
          sub.primary = null;
          sub.primaryStartTime = null;
          sub.primarySwapAt = null;
        }
      }

      // 1) Defensive dedup of currently-live primaries (carried over from
      //    the original logic). A subfleet that loses the dedup race also
      //    has its swap-timer state cleared so the re-pick below seeds a
      //    fresh deadline.
      const seen = new Set();
      for (const sub of this.subfleets[team]) {
        if (sub.primary && sub.primary.alive) {
          if (seen.has(sub.primary.id)) {
            sub.primary = null;
            sub.primaryStartTime = null;
            sub.primarySwapAt = null;
          } else {
            seen.add(sub.primary.id);
          }
        }
      }

      // 2) takenIds = ids still claimed after the dedup pass.
      const takenIds = new Set(seen);

      // 3) Re-pick for any subfleet without a live primary. Exclude
      //    sibling claims AND, if this subfleet just force-swapped, the
      //    just-dropped enemy id (so we genuinely change targets when an
      //    alternative exists). Seed primaryStartTime / primarySwapAt
      //    every time we assign a primary.
      const cfg = FLEET_CONFIG[team];
      const lo = Math.max(0, cfg.targetSwitchReactionMin);
      const hi = Math.max(lo, cfg.targetSwitchReactionMax);
      for (const sub of this.subfleets[team]) {
        if (sub.primary && sub.primary.alive) continue;

        const droppedId = justSwappedOff.get(sub.id);
        let perSubfleetTaken = takenIds;
        if (droppedId !== undefined && !takenIds.has(droppedId)) {
          // Local copy so we don't poison sibling subfleets' candidate sets
          // with this subfleet's just-dropped target.
          perSubfleetTaken = new Set(takenIds);
          perSubfleetTaken.add(droppedId);
        }

        const newPrimary = this._pickPrimary(team, sub.id, perSubfleetTaken);
        sub.primary = newPrimary;
        if (newPrimary) {
          takenIds.add(newPrimary.id);
          sub.primaryStartTime = this.simTime;
          sub.primarySwapAt = this.simTime + lo + Math.random() * (hi - lo);
        } else {
          sub.primaryStartTime = null;
          sub.primarySwapAt = null;
        }
      }
    }
  }

  // Per-ship lock-on progression. When the team primary changes (or is set
  // for the first time), every ship rolls a fresh reaction delay (uniform
  // 0-1 s), then enters a 3.5 s lock cycle. Only ships in the "locked" state
  // are allowed to fire (enforced in the combat loop).
  //
  // Scimitars don't shoot, so they're skipped here -- they have their own
  // rep state machine in _updateLogiLocks. Important side effect we MUST
  // preserve: the nightmare lock progression is what sets `firstLockedAt`
  // on a primary, which in turn arms BOTH the hardener-on reaction AND
  // the broadcast-for-reps reaction below. Under the nightmares-only
  // target rule (see _pickPrimary), scimitars are never selected as
  // primary, so they never get locked, never set firstLockedAt, and
  // therefore never activate hardeners or broadcast -- which is fine
  // because they're also never taking damage.
  _updateLocks(dt) {
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.shipType !== "nightmare") continue; // scimitars don't lock for DPS
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
          // subsequent lockers don't reset or re-roll. Same trigger arms
          // the broadcast-for-reps timer in _updateBroadcasts below.
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

  // Per-nightmare crystal-swap state machine. Each tick:
  //   1. Resolve the engagement reference (the subfleet's primary; we use
  //      the primary call rather than s.target so a pilot can already start
  //      "noticing they need to swap" during the lock cycle, before the
  //      lasers actually start firing -- otherwise long-range engagements
  //      would always open with whatever crystal happened to be loaded at
  //      spawn).
  //   2. Compute the ideal crystal for that distance via pickIdealCrystalIdx.
  //   3. Decide whether a swap is warranted, per the user spec:
  //        outranged: distance > current.optimalRange + 0.5 * current.falloff
  //        over-ranged: distance <= current.optimalRange AND the ideal
  //                     crystal has a *strictly smaller* optimal than current
  //                     (i.e., a higher-damage crystal would still cover the
  //                     target). Crystals with the same optimal but higher
  //                     damage don't exist in the table, so this captures
  //                     the spec's "higher than necessary optimal range".
  //   4. If warranted, set pendingCrystalIdx = ideal. Roll crystalSwapAt
  //      ONCE if not already pending; do NOT re-roll if the ideal target
  //      changes mid-wait (the pilot has already "noticed", they're just
  //      reaching for whatever crystal is now best when they actually swap).
  //   5. If the timer has elapsed this tick, apply the swap (using the
  //      latest ideal at the moment of swap) and clear pending state.
  //   6. If no swap is warranted (or there's no engagement reference),
  //      cancel any pending swap so a transient "I should swap" event
  //      doesn't fire later when the situation has already resolved.
  //
  // Crystal swap itself is instantaneous ("0 s to change the laser crystal"
  // per spec). The "between laser shots" constraint is satisfied implicitly
  // because shots are instantaneous events at cooldown=0, and this method
  // runs before the firing loop in tick(); a swap that fires this tick is
  // applied before the same-tick volley.
  //
  // Scimitars, dead ships, and ships without an engagement reference are
  // skipped. Burned-out hardeners / lock state are NOT consulted -- the
  // crystal choice is independent of defensive state.
  _updateCrystalSwaps() {
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.shipType !== "nightmare") continue;

      const sub = this.subfleets[s.team][s.subfleetId];
      const ref =
        sub && sub.primary && sub.primary.alive ? sub.primary : null;
      if (!ref) {
        s.pendingCrystalIdx = null;
        s.crystalSwapAt = null;
        continue;
      }

      const distance = s.position.distanceTo(ref.position);
      const ideal = pickIdealCrystalIdx(distance);
      const current = CRYSTALS[s.crystalIdx];

      let wantSwap = false;
      if (ideal !== s.crystalIdx) {
        const outOfRange =
          distance > current.optimalRange + 0.5 * current.falloff;
        const overRanged =
          distance <= current.optimalRange &&
          CRYSTALS[ideal].optimalRange < current.optimalRange;
        if (outOfRange || overRanged) wantSwap = true;
      }

      if (!wantSwap) {
        s.pendingCrystalIdx = null;
        s.crystalSwapAt = null;
        continue;
      }

      s.pendingCrystalIdx = ideal;
      if (s.crystalSwapAt === null) {
        const cfg = FLEET_CONFIG[s.team];
        const lo = Math.max(0, cfg.crystalReactionMin);
        const hi = Math.max(lo, cfg.crystalReactionMax);
        s.crystalSwapAt = this.simTime + lo + Math.random() * (hi - lo);
      }

      if (this.simTime >= s.crystalSwapAt) {
        s.crystalIdx = ideal;
        s.pendingCrystalIdx = null;
        s.crystalSwapAt = null;
      }
    }
  }

  // Broadcast-for-repairs progression. Independent of the hardener timer
  // (separate roll) but shares the same trigger: firstLockedAt being set
  // on a ship arms its broadcastingAt. Once simTime crosses that timestamp
  // the ship flips isBroadcasting = true and becomes a candidate rep
  // target for friendly Scimitars (consumed by _updateLogiLocks). One-shot
  // per ship lifetime; we don't re-arm after death or after the shield
  // is restored.
  _updateBroadcasts() {
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.firstLockedAt === null) continue;
      if (s.broadcastingAt === null) {
        const cfg = FLEET_CONFIG[s.team];
        const lo = Math.max(0, cfg.broadcastReactionMin);
        const hi = Math.max(lo, cfg.broadcastReactionMax);
        s.broadcastingAt =
          s.firstLockedAt + lo + Math.random() * (hi - lo);
      }
      if (!s.isBroadcasting && this.simTime >= s.broadcastingAt) {
        s.isBroadcasting = true;
      }
    }
  }

  // Hardener state machine, ticked once per sim step. Linear progression
  // per-ship:
  //   off (waiting)  -> on             at hardenerActivateAt
  //   on             -> overheated     at overheatActivateAt
  //   overheated     -> burned out     at overheatBurnoutAt
  //                                    (fires SIM.overheatBurnoutDuration s
  //                                    after entering the overheated state)
  //
  // Triggers / seeds:
  //   hardenerActivateAt is seeded inside _updateLocks on the first
  //     completed enemy lock against this ship.
  //   overheatActivateAt is seeded HERE the tick hardeners come online,
  //     so the overheat reaction counts from "hardeners on" (not "first
  //     locked"). Per-team config, uniform roll, clamped to >= 0.
  //   overheatBurnoutAt is seeded HERE the tick overheating begins.
  //     Single global SIM constant (module-level property, not a pilot
  //     reaction time).
  //
  // Burned-out ships are skipped entirely so the (well-elapsed)
  // hardenerActivateAt deadline doesn't keep re-activating them every
  // tick. After burnout, both hardenersOn and hardenersOverheated are
  // false, so Ship.takeHit's resist lookup naturally falls back to the
  // BASE resist profile and main.js drops the .hardened / .overheated
  // CSS classes from the roster row.
  _updateHardeners() {
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.hardenersBurnedOut) continue;

      if (!s.hardenersOn) {
        if (s.hardenerActivateAt === null) continue;
        if (this.simTime >= s.hardenerActivateAt) {
          s.hardenersOn = true;
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
          s.overheatBurnoutAt = this.simTime + SIM.overheatBurnoutDuration;
        }
      } else {
        // hardenersOn && hardenersOverheated && !hardenersBurnedOut.
        if (s.overheatBurnoutAt === null) continue;
        if (this.simTime >= s.overheatBurnoutAt) {
          s.hardenersOn = false;
          s.hardenersOverheated = false;
          s.hardenersBurnedOut = true;
        }
      }
    }
  }

  // True if any enemy-team subfleet currently has `ship` as its primary
  // call. Used by the Scimitar logi state machine to decide whether a
  // friendly is still "under attack" and worth repping. We deliberately
  // check at the subfleet (primary) level rather than per-enemy-ship lock
  // state because:
  //   - Ships in "reacting" / "locking" haven't set s.target yet, so a
  //     per-ship check would miss ships that are *committed* to attacking
  //     this friendly but haven't completed their lock cycle yet.
  //   - When an enemy subfleet swaps off (target-switch timer, dedup, or
  //     primary death), every member's lock collapses on the next
  //     _updateLocks pass anyway, so the subfleet-primary signal is the
  //     correct fleet-level "still committed" indicator.
  _isShipUnderAttack(ship) {
    const enemyTeam = ship.team === "green" ? "red" : "green";
    for (const sub of this.subfleets[enemyTeam]) {
      if (sub.primary === ship) return true;
    }
    return false;
  }

  // Pick a rep target for a Scimitar that's currently idle. Returns the
  // nearest friendly ship (any type, including other Scimitars but never
  // self) that is broadcasting, isn't already at full shield, AND is
  // currently being primaried by an enemy subfleet (so reps are still
  // genuinely needed). Returns null if no eligible target exists.
  //
  // The under-attack gate is essential: isBroadcasting is one-shot per
  // ship lifetime, so without it a Scimitar would re-pick a no-longer-
  // attacked friendly every tick after dropping it in _updateLogiLocks.
  //
  // We don't try to load-balance rep coverage across multiple Scimitars --
  // every Scimitar independently picks the nearest broadcaster. With the
  // user-confirmed "all 4 boosters stack on one target" allocation, this
  // just means multiple Scimitars may converge on the same primary
  // broadcaster, which is realistic logi behaviour.
  _pickRepTarget(scimitar) {
    let best = null;
    let bestDistSq = Infinity;
    for (const o of this.ships) {
      if (!o.alive) continue;
      if (o.team !== scimitar.team) continue;
      if (o === scimitar) continue;
      if (!o.isBroadcasting) continue;
      if (!this._isShipUnderAttack(o)) continue;
      const maxShield = SHIP_STATS[o.shipType].shieldHP;
      // Tiny epsilon so we don't thrash between idle <-> reacting on a
      // ship that is technically a hair below max from rounding.
      if (o.shield >= maxShield - 0.5) continue;
      const d = scimitar.position.distanceToSquared(o.position);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = o;
      }
    }
    return best;
  }

  // Apply one rep cycle from `scimitar` to `target`: all 4 boosters stack
  // on the same target with EVE optimal+falloff range attenuation. Adds
  // raw HP to the target's shield (capped at max). Resist amplification
  // is for analytical EHP/s only -- the actual shield HP gain is just
  // rep_amount * count * range_mult per cycle. Emits a "rep" hit-event
  // so the renderer can draw / refresh a rep beam.
  _applyRepCycle(scimitar, target) {
    const d = scimitar.position.distanceTo(target.position);
    const opt = REMOTE_REP.optimalRange;
    const fall = REMOTE_REP.falloff;
    let rangeMult;
    if (d <= opt) {
      rangeMult = 1.0;
    } else {
      const x = (d - opt) / fall;
      rangeMult = Math.pow(0.5, x * x);
    }
    const repPerCycle = REMOTE_REP.repAmount * REMOTE_REP.count * rangeMult;
    const maxShield = SHIP_STATS[target.shipType].shieldHP;
    const before = target.shield;
    target.shield = Math.min(maxShield, target.shield + repPerCycle);
    const applied = target.shield - before;
    this.hitEvents.push({
      kind: "rep",
      fromId: scimitar.id,
      toId: target.id,
      amount: applied,
      t: this.simTime,
    });
  }

  // Scimitar rep state machine. Per-Scimitar:
  //   idle      -> no rep target; if any friendly is broadcasting AND still
  //                under enemy primary call, pick the nearest and roll a
  //                fresh logi-reaction delay.
  //   reacting  -> tick down repTimer; on expiry start the 2 s lock cycle.
  //   locking   -> tick down repTimer (= REMOTE_REP.lockTime initially);
  //                on expiry transition to repping with a randomized initial
  //                cooldown so simultaneously-locking Scimitars don't all
  //                fire their first cycle on the same tick.
  //   repping   -> if target dead OR target.shield is full, drop back to
  //                idle (re-pick next tick after a fresh reaction roll).
  //                Otherwise tick repCooldown; when it expires, fire one
  //                cycle and reset to REMOTE_REP.cycleTime.
  //
  // Universal exit (any state): if the rep target is no longer being
  // primaried by any enemy subfleet, drop and re-evaluate. This lets
  // Scimitars stop wasting cycles on friendlies the enemy has already
  // swapped off (e.g., when the enemy's target-switch reaction fires) and
  // redirect reps to friendlies who are actually still under fire.
  _updateLogiLocks(dt) {
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.shipType !== "scimitar") continue;

      // Drop a target that's dead OR no longer under attack. Applied
      // above the state-specific branches so reacting / locking / repping
      // all release together; the idle branch below will re-pick on the
      // same tick if anyone else still needs reps. We also drop on full
      // shield in the repping branch so the Scimitar can re-evaluate to
      // a more damaged friendly.
      if (
        s.repTarget &&
        (!s.repTarget.alive || !this._isShipUnderAttack(s.repTarget))
      ) {
        s.repState = "idle";
        s.repTarget = null;
        s.repTargetId = null;
      }

      if (s.repState === "idle") {
        const target = this._pickRepTarget(s);
        if (target) {
          s.repTarget = target;
          s.repTargetId = target.id;
          s.repState = "reacting";
          const cfg = FLEET_CONFIG[s.team];
          const lo = Math.max(0, cfg.logiReactionMin);
          const hi = Math.max(lo, cfg.logiReactionMax);
          s.repTimer = lo + Math.random() * (hi - lo);
        }
        continue;
      }

      if (s.repState === "reacting") {
        s.repTimer -= dt;
        if (s.repTimer <= 0) {
          s.repState = "locking";
          s.repTimer = REMOTE_REP.lockTime;
        }
        continue;
      }

      if (s.repState === "locking") {
        s.repTimer -= dt;
        if (s.repTimer <= 0) {
          s.repState = "repping";
          // Stagger the first cycle so a fleet of Scimitars that all
          // finish locking on the same tick don't apply their first cycle
          // in unison (which would create big sawtooth shield refills).
          s.repCooldown = Math.random() * REMOTE_REP.cycleTime;
        }
        continue;
      }

      if (s.repState === "repping") {
        // Target gone? (already nulled above for dead; check full-shield here.)
        const target = s.repTarget;
        if (!target) {
          s.repState = "idle";
          continue;
        }
        const maxShield = SHIP_STATS[target.shipType].shieldHP;
        if (target.shield >= maxShield - 0.5) {
          // Shield topped off; drop and re-pick next tick. We do NOT reset
          // isBroadcasting on the target -- they're still flagged as having
          // broadcast (one-shot), which is fine: the scimitar will just
          // re-pick THIS same target if no one else needs reps and they
          // start taking damage again.
          s.repState = "idle";
          s.repTarget = null;
          s.repTargetId = null;
          continue;
        }
        s.repCooldown -= dt;
        if (s.repCooldown <= 0) {
          this._applyRepCycle(s, target);
          s.repCooldown = REMOTE_REP.cycleTime;
        }
      }
    }
  }

  // One fixed-step tick: dt seconds of sim time.
  tick(dt) {
    if (this.over) return;
    this.simTime += dt;

    // Drain stale beam-flash events older than the longest beam lifetime.
    // We use the rep-beam duration as the cutoff (it's >= the turret beam
    // duration), so the renderer can still find rep events when refreshing
    // their endpoints across the full cycle.
    const cutoff =
      this.simTime - Math.max(SIM.beamFlashDuration, SIM.repBeamDuration);
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
    // Optional post-promotion subfleet collapse: if losses have driven
    // the team below survivorProportion and the user toggled the merge
    // on, fold every surviving ship into one subfleet so the next
    // _updatePrimaries pass calls a single primary again.
    for (const team of ["green", "red"]) {
      this._maybeMergeSubfleets(team);
    }
    this._updatePrimaries();
    this._updateLocks(dt);
    this._updateCrystalSwaps();
    this._updateBroadcasts();
    this._updateHardeners();
    this._updateLogiLocks(dt);
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
    // wasted cycle. Scimitars never enter the firing branch -- they have no
    // turrets and their reps are handled in _updateLogiLocks.
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.shipType !== "nightmare") continue;
      s.weaponCooldown -= dt;
      if (s.weaponCooldown > 0) continue;

      const canFire =
        s.lockState === "locked" && s.target && s.target.alive;
      if (!canFire) {
        s.weaponCooldown = 0; // hold ready; will fire as soon as locked
        continue;
      }
      s.weaponCooldown = NIGHTMARE.rateOfFire;
      // Snapshot the target reference + id BEFORE fireVolley, since
      // fireVolley calls target.takeHit which can flip target.alive
      // to false. We need the snapshot to detect the kill afterwards
      // without losing the team / shipType / position info.
      const targetSnapshot = s.target;
      const targetId = targetSnapshot.id;
      const results = s.fireVolley();
      // Emit one beam-flash event per individual laser shot so multiple
      // bright flashes can stack visually for hits.
      for (const r of results) {
        this.hitEvents.push({
          kind: "fire",
          fromId: s.id,
          toId: targetId,
          hit: r.hit,
          t: this.simTime,
        });
      }
      // The canFire gate above guarantees targetSnapshot.alive was true
      // immediately before fireVolley, so a false reading here means this
      // volley dealt the killing blow. Emit one death event so the
      // renderer can spawn an explosion at the ship's last position.
      // (Multiple shooters can target the same ship in the same tick,
      // but JS is single-threaded and the canFire check is re-evaluated
      // per shooter, so a second shooter sees alive=false and skips its
      // volley; no double-emission.)
      if (!targetSnapshot.alive) {
        this.hitEvents.push({
          kind: "death",
          shipId: targetSnapshot.id,
          team: targetSnapshot.team,
          shipType: targetSnapshot.shipType,
          t: this.simTime,
        });
      }
    }

    // End condition. Counts NIGHTMARES only, not total ships, because
    // under the nightmares-only target rule a side without nightmares has
    // no offensive capability -- its surviving scimitars can't damage
    // anything and the enemy nightmares would have no targets, so without
    // this rule the battle would just stall to the sim-time cap.
    // Surviving scimitars on the losing side simply float around as
    // non-combatants once the battle is called.
    let greenN = 0;
    let redN = 0;
    for (const s of this.ships) {
      if (!s.alive) continue;
      if (s.shipType !== "nightmare") continue;
      if (s.team === "green") greenN++;
      else redN++;
    }
    if (greenN === 0 || redN === 0) {
      this.over = true;
      this.winner =
        greenN === 0 && redN === 0
          ? "draw"
          : greenN > 0
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
