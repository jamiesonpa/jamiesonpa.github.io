import * as THREE from "three";
import { SHIP_STATS, SIM, FLEET_CONFIG } from "./constants.js";

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _tmpD = new THREE.Vector3();
const _tmpE = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Targeting note: per-ship target assignment lives in sim.js as part of the
// team-wide primary call + per-ship reaction/lock state machine.

// --- Steering helpers -------------------------------------------------------
// Linear "thrust toward desired velocity" model -- used by followers, who
// need to accelerate / decelerate to chase a moving slot position. Top-speed
// clamp uses the ship's own type stats so a Scimitar (1701 m/s) isn't
// artificially throttled to the nightmare's 791 m/s -- in practice the
// follower-on-leader controller pins them to the slower leader anyway.
function steerTowards(ship, desiredVel, maxAccel, dt) {
  _tmpA.copy(desiredVel).sub(ship.velocity);
  const need = _tmpA.length();
  const cap = maxAccel * dt;
  if (need <= cap) {
    ship.velocity.copy(desiredVel);
  } else {
    _tmpA.multiplyScalar(cap / need);
    ship.velocity.add(_tmpA);
  }
  const maxSp = SHIP_STATS[ship.shipType].abSpeed;
  const sp = ship.velocity.length();
  if (sp > maxSp) {
    ship.velocity.multiplyScalar(maxSp / sp);
  }
}

// Constant-speed rotation model -- used by leaders so they fly at a steady
// AB speed and turn by rotating the velocity vector around an axis, instead
// of slowing through zero when reversing direction. Lateral acceleration is
// converted to a turn rate via omega = a_lat / v (centripetal). Speed is
// bumped toward desiredSpeed by the same accel cap when nearly aligned, so a
// stopped leader will spin up cleanly.
function steerByRotation(ship, desiredVel, maxAccel, dt) {
  const speed = ship.velocity.length();
  const desiredSpeed = desiredVel.length();

  if (desiredSpeed < 1e-3) return;

  if (speed < 1e-3) {
    // From rest: kick straight toward desired direction up to accel cap.
    const kick = Math.min(maxAccel * dt, desiredSpeed);
    _tmpA.copy(desiredVel).divideScalar(desiredSpeed).multiplyScalar(kick);
    ship.velocity.add(_tmpA);
    return;
  }

  const currentDir = _tmpA.copy(ship.velocity).divideScalar(speed);
  const desiredDir = _tmpB.copy(desiredVel).divideScalar(desiredSpeed);
  const cosA = Math.max(-1, Math.min(1, currentDir.dot(desiredDir)));

  // Always nudge speed toward desiredSpeed (longitudinal accel up to the cap).
  const accelStep = maxAccel * dt;
  let newSpeed = speed;
  if (Math.abs(desiredSpeed - speed) > 1e-3) {
    const dir = Math.sign(desiredSpeed - speed);
    newSpeed = speed + dir * Math.min(accelStep, Math.abs(desiredSpeed - speed));
  }

  if (cosA > 0.9999) {
    // Already aligned; just match speed in current direction.
    ship.velocity.copy(currentDir).multiplyScalar(Math.max(0, newSpeed));
    return;
  }

  // Centripetal turn rate, capped so we never overshoot the angle this tick.
  const angle = Math.acos(cosA);
  const omegaMax = maxAccel / Math.max(speed, 50); // rad/s
  const turn = Math.min(angle, omegaMax * dt);

  // Rotation axis = currentDir x desiredDir; if anti-parallel, prefer
  // rotating around world up (yaw) so a 180-deg flip is a horizontal turn,
  // not a pitch up and over.
  const axis = _tmpC.copy(currentDir).cross(desiredDir);
  if (axis.lengthSq() < 1e-6) {
    if (Math.abs(currentDir.y) < 0.99) {
      axis.set(0, 1, 0);
    } else {
      axis.set(1, 0, 0);
    }
  } else {
    axis.normalize();
  }

  // Rotate currentDir in place, then re-magnitude with the (possibly bumped)
  // newSpeed -- so a turning leader holds AB speed throughout.
  currentDir.applyAxisAngle(axis, turn);
  ship.velocity.copy(currentDir).multiplyScalar(Math.max(0, newSpeed));
}

// Update leader's local frame so followers can place their slot offsets.
// forward = current heading; right = forward x worldUp.
function updateLeaderBasis(leader) {
  if (leader.velocity.lengthSq() < 1) return;
  leader.basis.forward.copy(leader.velocity).normalize();
  leader.basis.right
    .copy(leader.basis.forward)
    .cross(WORLD_UP)
    .normalize();
  if (leader.basis.right.lengthSq() < 1e-6) {
    leader.basis.right.set(1, 0, 0);
  }
  leader.basis.up.copy(leader.basis.right).cross(leader.basis.forward).normalize();
}

// --- Leader steering --------------------------------------------------------
// Transversal-maximisation model. Each tick the leader builds a desired
// AB-speed velocity vector that:
//
//   1. Sets the LOS-radial component equal to the enemy reference's LOS-
//      radial component, so the rate-of-change of range is zero (the
//      leader and the engagement reference recede / approach at the same
//      rate along the line of sight, holding range constant).
//   2. If range > SIM.maxRange, adds a closing rate proportional to the
//      excess on top of (1), so the leader pulls back into bound. The
//      gain and the cap are tuned so that being just past 170 km adds
//      only a slight inward bias (mostly perpendicular flight is
//      preserved), while being far past it dedicates most of the speed
//      budget to closing.
//   3. Spends the remaining (Pythagorean) speed budget perpendicular to
//      the LOS in the direction OPPOSITE the enemy's perpendicular
//      velocity. This is the velocity choice that maximises
//      |v_us_perp - v_enemy_perp| (= the transversal of the relative
//      velocity, which is what the EVE turret hit formula uses to
//      compute angular velocity / tracking term -- see Ship.computeHitChance
//      in ship.js). When the enemy's perp velocity is ~0 (typically only
//      at battle start), we fall back to a deterministic horizontal perp
//      to LOS, with sign keyed off leader.id parity so the two teams
//      pick opposite initial perp directions and immediately set up an
//      orbital chase rather than flying parallel.
//
// By construction |desired| = AB speed, so steerByRotation will hold the
// leader at AB speed throughout. The per-tick recompute is fine because
// the slow leaderTurnAccel (40 m/s^2 -> ~2.9 deg/s at AB speed) provides
// all the smoothing -- there is no need for an explicit heading-commit
// timer or jitter to stop the leader from twitching every frame.
//
// `engagementRef` is the enemy ship the leader steers against. Was always
// the enemy team leader; with subfleets each subfleet leader steers
// against its OWN primary call so independent subfleets can pursue
// different enemy concentrations.
function steerLeader(leader, engagementRef, dt) {
  if (!engagementRef || !engagementRef.alive) {
    // No engagement reference: just keep current velocity / basis.
    updateLeaderBasis(leader);
    return;
  }

  const maxSp = SHIP_STATS[leader.shipType].abSpeed;

  // _tmpA = enemy.pos - leader.pos. Used briefly for range, then reused
  // as the desired-velocity scratch buffer below.
  _tmpA.copy(engagementRef.position).sub(leader.position);
  const range = _tmpA.length();
  if (range < 1) {
    // Degenerate stack-up; nothing meaningful to steer toward.
    updateLeaderBasis(leader);
    return;
  }

  // _tmpB = unit LOS direction from leader to engagement reference.
  const losDir = _tmpB.copy(_tmpA).divideScalar(range);

  // Decompose the enemy's velocity into its LOS-radial scalar and its
  // perpendicular vector component.
  //   eRadialScalar > 0  =>  enemy moving away from leader along LOS
  //   ePerp              =  enemy velocity minus its LOS-radial part
  const eRadialScalar = engagementRef.velocity.dot(losDir);
  _tmpC.copy(losDir).multiplyScalar(eRadialScalar);
  const ePerp = _tmpD.copy(engagementRef.velocity).sub(_tmpC);
  const ePerpMag = ePerp.length();

  // Pick our LOS-radial component. Default = match enemy (hold range).
  // If we're past maxRange, add a closing rate proportional to the excess
  // (capped so we don't blow the entire speed budget on closing alone).
  // 0.01 1/s gain: 10 km past gives +100 m/s closing, 50 km past gives
  // +500 m/s closing -- enough to recover but still leaves a meaningful
  // perpendicular budget unless we're catastrophically out of bound.
  let usRadial = eRadialScalar;
  if (range > SIM.maxRange) {
    const excess = range - SIM.maxRange;
    const closeRate = Math.min(maxSp * 0.7, excess * 0.01);
    usRadial = eRadialScalar + closeRate;
  }
  // Clamp the radial so the perp budget stays well-defined even when the
  // enemy is sprinting along LOS faster than we can match.
  const radialCap = maxSp * 0.95;
  if (usRadial > radialCap) usRadial = radialCap;
  else if (usRadial < -radialCap) usRadial = -radialCap;

  // Pythagorean perp budget so |desired| = maxSp exactly.
  const perpBudget = Math.sqrt(Math.max(0, maxSp * maxSp - usRadial * usRadial));

  // Choose the perpendicular direction. _tmpE = unit perp direction.
  // Want |v_us_perp - v_enemy_perp| max -> v_us_perp opposite to ePerp.
  if (ePerpMag > 1) {
    _tmpE.copy(ePerp).divideScalar(-ePerpMag); // opposite to enemy perp
  } else {
    // Enemy perp ~ 0 (typically only at battle start). Fall back to a
    // deterministic horizontal perp-to-LOS; flip sign by leader.id parity
    // so the two teams pick opposite initial perp directions and start
    // an orbital chase rather than translating in parallel.
    _tmpE.copy(losDir).cross(WORLD_UP);
    if (_tmpE.lengthSq() < 1e-6) {
      _tmpE.set(1, 0, 0);
    } else {
      _tmpE.normalize();
    }
    if (leader.id % 2 === 1) _tmpE.multiplyScalar(-1);
  }

  // desired = usRadial * losDir + perpBudget * usPerpDir. Reuse _tmpA
  // (no longer needed for the original LOS displacement).
  _tmpA
    .copy(losDir)
    .multiplyScalar(usRadial)
    .addScaledVector(_tmpE, perpBudget);

  steerByRotation(leader, _tmpA, SIM.leaderTurnAccel, dt);
  updateLeaderBasis(leader);
}

// --- Follower steering ------------------------------------------------------
// Aim for slot world position = leader.pos + leader.basis * slotOffset.
// Use a simple proportional controller on position error converted into a
// desired velocity, then steer toward it under accel cap.
function steerFollower(follower, leader, dt) {
  if (!leader || !leader.alive) {
    // Leader dead; just coast at current vel (sim.js will reassign leaders).
    return;
  }
  const slot = follower.slotOffset;
  // World offset = right * slot.x + up * slot.y + forward * slot.z
  _tmpA
    .copy(leader.basis.right)
    .multiplyScalar(slot.x)
    .addScaledVector(leader.basis.up, slot.y)
    .addScaledVector(leader.basis.forward, slot.z);
  const targetPos = _tmpB.copy(leader.position).add(_tmpA);

  // Position error -> desired velocity = leader vel + k * error, capped.
  const err = _tmpC.copy(targetPos).sub(follower.position);
  const errLen = err.length();
  // Lookahead gain: at 1000 m off-slot, want ~AB speed of correction.
  const k = 1.0;
  const correction = err.multiplyScalar(k);
  const desired = correction.add(leader.velocity);
  const dlen = desired.length();
  // Cap at this follower's own AB speed -- scimitars (1701 m/s) can chase
  // their slot more aggressively than nightmares (791 m/s) can.
  const maxSp = SHIP_STATS[follower.shipType].abSpeed;
  if (dlen > maxSp) desired.multiplyScalar(maxSp / dlen);

  steerTowards(follower, desired, SIM.followerTurnAccel, dt);
  // Followers inherit the leader's basis for any consumers that care.
  follower.basis.forward.copy(leader.basis.forward);
  follower.basis.right.copy(leader.basis.right);
  follower.basis.up.copy(leader.basis.up);
}

// --- Top-level driver -------------------------------------------------------
// Subfleet-aware. Two modes per team based on FLEET_CONFIG[team].unifiedMovement:
//
//   independent (default): each subfleet's leader steers against its own
//     primary target. Subfleets diverge to pursue different enemy
//     concentrations. Each follower chases its own subfleet's leader.
//
//   unified: the first subfleet with a live leader is the team's "movement
//     leader" -- it does the per-tick transversal-maximisation steering.
//     Every other subfleet leader copies its velocity and basis each tick, so all
//     subfleets translate in lockstep. Targeting / locking / firing remain
//     per-subfleet (each subfleet still picks its own independent primary
//     and shoots that target). Followers always chase their own subfleet
//     leader regardless of mode -- the formation slots are valid because
//     the basis is now identical across mirrored leaders.
//
// Subfleets with a null leader (extinct) or null primary are skipped
// harmlessly in both modes.
export function updateAI(battle, dt) {
  const { ships, subfleets } = battle;
  // Steer leaders first so followers see the new basis.
  for (const team of ["green", "red"]) {
    const unified = !!FLEET_CONFIG[team].unifiedMovement;
    if (unified) {
      // Find the first subfleet with a live leader; it acts as the team's
      // movement reference. If the original subfleet 0 is wiped, we promote
      // the next surviving subfleet's leader into that role automatically.
      let movementLeaderSub = null;
      for (const sub of subfleets[team]) {
        if (sub.leader && sub.leader.alive) {
          movementLeaderSub = sub;
          break;
        }
      }
      if (!movementLeaderSub) continue; // entire team gone
      // Steer the movement leader against its own primary call.
      steerLeader(movementLeaderSub.leader, movementLeaderSub.primary, dt);
      // Every other subfleet leader mirrors velocity + basis. We avoid
      // calling steerLeader on them so they don't do their own per-tick
      // transversal solve and split the team back apart.
      const refLeader = movementLeaderSub.leader;
      for (const sub of subfleets[team]) {
        if (sub === movementLeaderSub) continue;
        const l = sub.leader;
        if (!l || !l.alive) continue;
        l.velocity.copy(refLeader.velocity);
        l.basis.forward.copy(refLeader.basis.forward);
        l.basis.right.copy(refLeader.basis.right);
        l.basis.up.copy(refLeader.basis.up);
      }
    } else {
      for (const sub of subfleets[team]) {
        const leader = sub.leader;
        if (!leader || !leader.alive) continue;
        steerLeader(leader, sub.primary, dt);
      }
    }
  }
  for (const s of ships) {
    if (!s.alive || s.isLeader) continue;
    const sub = subfleets[s.team][s.subfleetId];
    const leader = sub ? sub.leader : null;
    steerFollower(s, leader, dt);
  }
}

// Build a "blob" of follower slot offsets in the leader's local frame.
// Slots are sampled inside a half-ellipsoid (z <= 0, i.e. behind the leader)
// with min-spacing enforced via rejection sampling, so ships don't overlap
// and there is a visible gap between them. The leader itself occupies (0,0,0)
// and is added as an "occupied" point so no slot crowds it.
//
// Uses a deterministic LCG so the formation shape is reproducible across
// runs / restarts (helpful when eyeballing tuning changes).
export function buildFormationSlots(teamSize, minSpacing, blob) {
  const slots = [];
  const minDistSq = minSpacing * minSpacing;
  const target = teamSize - 1;
  const maxAttempts = target * 600;

  let seed = 0x12345678;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const occupied = [new THREE.Vector3(0, 0, 0)];

  let attempts = 0;
  while (slots.length < target && attempts < maxAttempts) {
    attempts++;
    // Uniform sample in unit half-sphere (z <= 0), then scale by blob extents.
    let ux, uy, uz;
    do {
      ux = rand() * 2 - 1;
      uy = rand() * 2 - 1;
      uz = -rand(); // [0,1] -> [-1,0]
    } while (ux * ux + uy * uy + uz * uz > 1);

    const slot = new THREE.Vector3(ux * blob.x, uy * blob.y, uz * blob.z);

    let ok = true;
    for (const o of occupied) {
      if (o.distanceToSquared(slot) < minDistSq) {
        ok = false;
        break;
      }
    }
    if (ok) {
      slots.push(slot);
      occupied.push(slot);
    }
  }

  // If rejection sampling couldn't pack everyone (blob too tight), fall back
  // to placing remaining slots farther behind on a relaxed grid so the sim
  // still has a full team rather than silently dropping ships.
  if (slots.length < target) {
    const missing = target - slots.length;
    const extraDepth = blob.z + minSpacing;
    for (let i = 0; i < missing; i++) {
      const ang = (i / missing) * Math.PI * 2;
      const r = blob.x * 1.2;
      slots.push(
        new THREE.Vector3(
          Math.cos(ang) * r,
          Math.sin(ang) * blob.y * 0.6,
          -extraDepth - Math.floor(i / 8) * minSpacing
        )
      );
    }
  }

  return slots;
}
