import * as THREE from "three";
import { NIGHTMARE, SIM } from "./constants.js";

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _tmpD = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Targeting note: per-ship target assignment lives in sim.js as part of the
// team-wide primary call + per-ship reaction/lock state machine.

// --- Steering helpers -------------------------------------------------------
// Linear "thrust toward desired velocity" model -- used by followers, who
// need to accelerate / decelerate to chase a moving slot position.
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
  // Clamp to AB speed.
  const sp = ship.velocity.length();
  if (sp > NIGHTMARE.abSpeed) {
    ship.velocity.multiplyScalar(NIGHTMARE.abSpeed / sp);
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
// Heading-commitment model: a leader picks a heading and commits to it for
// SIM.headingCommitTime seconds before re-evaluating, instead of chasing the
// rotating line-of-sight every tick. Early re-evaluation fires if range goes
// critically close or far. Each new commit alternates the perpendicular sign,
// so the leader effectively zigzags but with a much longer dwell on each
// heading. Per-leader jitter desynchronises the two teams.
//
// State stored ad-hoc on the leader Ship instance (initialised lazily):
//   committedHeading : THREE.Vector3   (unit vector, world-space)
//   headingExpiry    : number          (simTime when commitment expires)
//   headingFlip      : -1 | +1         (next perpendicular sign to use)
function _recomputeLeaderHeading(leader, enemyLeader, simTime) {
  _tmpA.copy(enemyLeader.position).sub(leader.position);
  const range = _tmpA.length();
  if (range < 1) {
    // Degenerate; just commit to current forward.
    if (!leader.committedHeading) {
      leader.committedHeading = leader.basis.forward.clone();
    }
    leader.headingExpiry = simTime + SIM.headingCommitTime;
    return;
  }
  const losDir = _tmpB.copy(_tmpA).divideScalar(range);

  const perp = _tmpC.copy(losDir).cross(WORLD_UP);
  if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
  else perp.normalize();

  if (leader.headingFlip === undefined) leader.headingFlip = 1;
  perp.multiplyScalar(leader.headingFlip);
  leader.headingFlip = -leader.headingFlip;

  // Radial weighting: only push closing/opening when out of the dead zone.
  let radialSign = 0;
  if (range > SIM.idealRange + SIM.idealRangeBand) radialSign = +1; // close
  else if (range < SIM.minRange) radialSign = -1; // open
  const radial = losDir.multiplyScalar(radialSign * 0.4);

  const desired = perp.add(radial);
  if (desired.lengthSq() < 1e-6) desired.set(1, 0, 0);
  desired.normalize();

  if (!leader.committedHeading) leader.committedHeading = new THREE.Vector3();
  leader.committedHeading.copy(desired);

  // Deterministic per-leader jitter so the two teams don't recommit in sync.
  const jitter = ((leader.id * 0.6180339) % 1) * SIM.headingCommitJitter * 2 -
    SIM.headingCommitJitter;
  leader.headingExpiry = simTime + SIM.headingCommitTime + jitter;
}

// `engagementRef` is the enemy ship the leader uses to drive its heading
// commitments and range thresholds. Was always the enemy team leader; with
// subfleets each subfleet leader steers against its OWN primary call so
// independent subfleets can pursue different enemy concentrations.
function steerLeader(leader, engagementRef, simTime, dt) {
  if (!engagementRef || !engagementRef.alive) {
    // No engagement reference: just keep current velocity / basis.
    updateLeaderBasis(leader);
    return;
  }

  const range = leader.position.distanceTo(engagementRef.position);
  const expired =
    !leader.committedHeading ||
    leader.headingExpiry === undefined ||
    simTime >= leader.headingExpiry;
  const tooClose = range < SIM.criticalCloseRange;
  const tooFar = range > SIM.criticalFarRange;

  if (expired || tooClose || tooFar) {
    _recomputeLeaderHeading(leader, engagementRef, simTime);
  }

  // Leaders maintain constant AB speed and steer by rotating their velocity
  // vector (no stop-and-start when reversing direction on a new commit).
  _tmpD.copy(leader.committedHeading).multiplyScalar(NIGHTMARE.abSpeed);
  steerByRotation(leader, _tmpD, SIM.leaderTurnAccel, dt);
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
  if (dlen > NIGHTMARE.abSpeed) desired.multiplyScalar(NIGHTMARE.abSpeed / dlen);

  steerTowards(follower, desired, SIM.followerTurnAccel, dt);
  // Followers inherit the leader's basis for any consumers that care.
  follower.basis.forward.copy(leader.basis.forward);
  follower.basis.right.copy(leader.basis.right);
  follower.basis.up.copy(leader.basis.up);
}

// --- Top-level driver -------------------------------------------------------
// Subfleet-aware. Each subfleet's leader steers against its own primary
// target (independent engagement reference per subfleet); each follower
// chases its own subfleet's leader. Subfleets with a null leader (extinct)
// or null primary (no enemies left in range) are skipped harmlessly.
export function updateAI(battle, dt) {
  const { ships, subfleets, simTime } = battle;
  // Steer leaders first so followers see the new basis.
  for (const team of ["green", "red"]) {
    for (const sub of subfleets[team]) {
      const leader = sub.leader;
      if (!leader || !leader.alive) continue;
      steerLeader(leader, sub.primary, simTime, dt);
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
