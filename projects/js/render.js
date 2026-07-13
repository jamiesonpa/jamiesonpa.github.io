import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VIS, SIM } from "./constants.js";

const Y_UP = new THREE.Vector3(0, 1, 0);
const _velDir = new THREE.Vector3();

// Pool of line segments used for momentary beam visuals. Two shared
// materials (one per team) are swapped onto the recycled line at spawn time
// so green ships fire green beams and red ships fire red beams.
//
// Each active beam keeps a reference to its shooter and target Ship and
// rewrites its line endpoints to the current ship positions every frame,
// so the beam visibly stays attached to both moving ships for its full
// lifetime instead of dangling in space at the firing instant. If either
// endpoint dies mid-beam the beam is recycled immediately so it doesn't
// hang on an invisible mesh.
//
// Pool accepts a `colors` object so we can reuse the same code for both
// turret-flash beams (bright green/red) and rep beams (cool cyan/pink).
// The opacity is also configurable so rep beams can be dimmer than turret
// beams without having to fork the class.
//
// Optional `missOpacity` (only used by the turret pool) builds a second
// pair of per-team materials at that opacity. spawn() picks them when
// `extend !== 1` so miss beams render fainter than hit beams without
// touching the rest of the BeamPool API. Pools that don't pass
// `missOpacity` (e.g. the rep pool) just never enter that branch.
class BeamPool {
  constructor(scene, size, colors, opacity = 0.95, missOpacity = null) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.materials = {
      green: new THREE.LineBasicMaterial({
        color: colors.green,
        transparent: true,
        opacity,
      }),
      red: new THREE.LineBasicMaterial({
        color: colors.red,
        transparent: true,
        opacity,
      }),
    };
    if (missOpacity !== null) {
      this.materials.missGreen = new THREE.LineBasicMaterial({
        color: colors.green,
        transparent: true,
        opacity: missOpacity,
      });
      this.materials.missRed = new THREE.LineBasicMaterial({
        color: colors.red,
        transparent: true,
        opacity: missOpacity,
      });
    }
    for (let i = 0; i < size; i++) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3)
      );
      const line = new THREE.Line(geom, this.materials.green);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.pool.push(line);
    }
  }

  clear() {
    for (const a of this.active) {
      a.line.visible = false;
      this.pool.push(a.line);
    }
    this.active.length = 0;
  }

  // Write the line's vertex buffer. Endpoints are (fromPos, toPos) when
  // extend == 1 (the default, used for hit beams). For miss beams the
  // caller passes extend > 1, and the second endpoint becomes
  // fromPos + extend * (toPos - fromPos) -- i.e. the beam continues past
  // the target along the same direction, as if the photons had not
  // intersected anything. Recomputed every frame in step() from current
  // ship positions, so the miss line keeps extending past the target's
  // current position even as both ships drift.
  _writeEndpoints(line, fromPos, toPos, extend = 1) {
    const pos = line.geometry.attributes.position;
    pos.array[0] = fromPos.x;
    pos.array[1] = fromPos.y;
    pos.array[2] = fromPos.z;
    if (extend === 1) {
      pos.array[3] = toPos.x;
      pos.array[4] = toPos.y;
      pos.array[5] = toPos.z;
    } else {
      pos.array[3] = fromPos.x + extend * (toPos.x - fromPos.x);
      pos.array[4] = fromPos.y + extend * (toPos.y - fromPos.y);
      pos.array[5] = fromPos.z + extend * (toPos.z - fromPos.z);
    }
    pos.needsUpdate = true;
  }

  // `fromShip` and `toShip` are Ship objects; we keep references so step()
  // can re-read their .position vectors each frame. `extend` is a length
  // multiplier on the (to - from) vector applied when computing the second
  // endpoint -- 1 (default) draws shooter -> target (a hit), > 1 draws a
  // miss line that continues past the target.
  spawn(fromShip, toShip, lifetime, team, extend = 1) {
    const line = this.pool.pop();
    if (!line) return;
    // Miss beams (extend !== 1) use the dimmed per-team material if this
    // pool was constructed with a missOpacity; otherwise fall back to the
    // normal hit material (preserves rep-pool behaviour, which doesn't
    // build miss variants and never gets called with extend !== 1).
    const useMiss = extend !== 1 && this.materials.missGreen;
    const matKey = useMiss
      ? team === "green"
        ? "missGreen"
        : "missRed"
      : team;
    line.material = this.materials[matKey] || this.materials.green;
    line.visible = true;
    this._writeEndpoints(line, fromShip.position, toShip.position, extend);
    this.active.push({
      line,
      life: lifetime,
      max: lifetime,
      from: fromShip,
      to: toShip,
      extend,
    });
  }

  // Continuous-beam variant: if there is already an active beam from this
  // shooter (regardless of target), refresh its lifetime + retarget instead
  // of stacking a second beam. This is what scimitar reps want -- a single
  // continuous "tractor beam" that follows the rep target as long as the
  // scimitar is repping it, instead of one beam per cycle stacking on top
  // of the previous (still-fading) one.
  refreshOrSpawnByFromId(fromShip, toShip, lifetime, team) {
    for (const a of this.active) {
      if (a.from.id === fromShip.id) {
        a.life = lifetime;
        a.max = lifetime;
        a.to = toShip;
        a.extend = 1; // rep beams are always shooter -> target, never extended
        a.line.material = this.materials[team] || this.materials.green;
        this._writeEndpoints(a.line, fromShip.position, toShip.position);
        return;
      }
    }
    this.spawn(fromShip, toShip, lifetime, team);
  }

  // Decrement lifetimes; recycle expired or orphaned beams; otherwise
  // refresh endpoints from current ship positions so the beam tracks both
  // ends as the ships move.
  step(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.life -= dt;
      if (a.life <= 0 || !a.from.alive || !a.to.alive) {
        a.line.visible = false;
        this.pool.push(a.line);
        this.active.splice(i, 1);
        continue;
      }
      this._writeEndpoints(a.line, a.from.position, a.to.position, a.extend);
    }
  }
}

// Pool of additive-blended sphere meshes used as one-shot death explosions.
// Spawned by the renderer when a "death" hit event arrives. Each active
// explosion expands its scale from ~0 to maxRadius while fading opacity
// from 1 to 0 over `life` seconds, so the visual reads as a "pop" anchored
// at the ship's last position.
//
// Each pool slot carries its own cloned material instance because per-
// explosion opacity varies independently; sharing one material would make
// the entire pool fade as one. The shared base sphere geometry is fine
// because scale is per-mesh.
class ExplosionPool {
  constructor(scene, size) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.geom = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < size; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb050,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geom, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.scale.setScalar(0.01);
      scene.add(mesh);
      this.pool.push({ mesh, mat });
    }
  }

  clear() {
    for (const a of this.active) {
      a.mesh.visible = false;
      a.mesh.scale.setScalar(0.01);
      this.pool.push({ mesh: a.mesh, mat: a.mat });
    }
    this.active.length = 0;
  }

  // Spawn one explosion at `position` with the given color, max radius, and
  // total lifetime. Silently no-ops if the pool is exhausted (extremely
  // unlikely at the configured size, but a safe degradation).
  spawn(position, color, maxRadius, lifetime) {
    const slot = this.pool.pop();
    if (!slot) return;
    slot.mat.color.setHex(color);
    slot.mat.opacity = 1.0;
    slot.mesh.position.copy(position);
    slot.mesh.scale.setScalar(0.01);
    slot.mesh.visible = true;
    this.active.push({
      mesh: slot.mesh,
      mat: slot.mat,
      life: lifetime,
      max: lifetime,
      maxRadius,
    });
  }

  // Per-frame: advance scale + opacity for each active explosion, recycle
  // any whose lifetime has expired.
  step(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.life -= dt;
      if (a.life <= 0) {
        a.mesh.visible = false;
        a.mesh.scale.setScalar(0.01);
        this.pool.push({ mesh: a.mesh, mat: a.mat });
        this.active.splice(i, 1);
        continue;
      }
      // Normalised progress 0 -> 1 across the explosion's lifetime.
      const t = 1 - a.life / a.max;
      // Ease-out scale so the explosion pops fast then settles, instead
      // of growing linearly (looks more like a flash, less like a balloon).
      const eased = 1 - (1 - t) * (1 - t);
      a.mesh.scale.setScalar(0.01 + eased * a.maxRadius);
      a.mat.opacity = 1 - t;
    }
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000308);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      10,
      4_000_000
    );
    this.camera.position.set(
      VIS.initialCameraDistance * 0.6,
      VIS.initialCameraDistance * 0.55,
      VIS.initialCameraDistance * 0.6
    );

    this.threeRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.threeRenderer.setPixelRatio(window.devicePixelRatio);
    this.threeRenderer.setSize(window.innerWidth, window.innerHeight);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 1_000;
    this.controls.maxDistance = 1_500_000;

    // --- Lighting (subtle; ships are emissive so this is mostly atmospheric)
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);

    // --- Reference grid + axes
    const grid = new THREE.GridHelper(
      VIS.gridSize,
      VIS.gridDivisions,
      0x335577,
      0x223344
    );
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(8000);
    this.scene.add(axes);

    // Star backdrop: scattered points so the camera has motion cues.
    this._addStars();

    // --- Ship rendering ---
    // Shared geometries; per-ship materials so we can mutate emissive when
    // shields drop. (50+50 ships -> 100 materials, fine.)
    // Cones: apex along local +Y; orient via quaternion to align with velocity.
    this.pipGeom = new THREE.ConeGeometry(VIS.pipRadius, VIS.pipRadius * 2.6, 12);
    this.leaderGeom = new THREE.ConeGeometry(
      VIS.leaderRadius,
      VIS.leaderRadius * 2.6,
      16
    );
    // Scimitars use an octahedron so they read as visually distinct from
    // the nightmare cones at any camera angle (cones can look identical
    // when seen end-on; an octahedron has rotational symmetry around all
    // three axes). Smaller than a nightmare pip to match the lore size
    // difference (cruiser vs battleship).
    this.scimitarGeom = new THREE.OctahedronGeometry(VIS.scimitarRadius, 0);
    this.ringGeom = new THREE.TorusGeometry(VIS.leaderRadius * 1.6, 60, 8, 32);

    this.shipMeshes = new Map(); // ship.id -> { mesh, ring? }

    // Primary-target indicators. Each subfleet calls its own primary, so we
    // need up to (max subfleets per team) * 2 simultaneous rings. We pre-
    // allocate a pool and assign them dynamically each frame in
    // updatePrimaryIndicators(); unused rings are hidden. Kept as a single
    // pool (not per-team) since the same enemy ship can be a primary call
    // from multiple subfleets at once -- we just reuse one ring per unique
    // primary ship.
    const primaryGeom = new THREE.TorusGeometry(VIS.pipRadius * 4, 60, 8, 36);
    const primaryMat = new THREE.MeshBasicMaterial({
      color: 0xffd000,
      transparent: true,
      opacity: 0.9,
    });
    this.primaryRingPool = [];
    const POOL_SIZE = 16; // up to 8 per team -- well above the 6-subfleet cap
    for (let i = 0; i < POOL_SIZE; i++) {
      const m = new THREE.Mesh(primaryGeom, primaryMat);
      m.rotation.x = Math.PI / 2; // lie flat (horizontal halo)
      m.visible = false;
      this.scene.add(m);
      this.primaryRingPool.push(m);
    }

    // Two beam pools: turret-flash (bright, short-lived per laser shot) and
    // logi rep beams (dim cyan/pink, lifetime = rep cycle so they read as
    // continuous tractor beams instead of flashes). The rep pool is sized
    // generously to handle several scimitars per side all repping at once
    // without exhausting the pool.
    this.beams = new BeamPool(
      this.scene,
      800,
      { green: VIS.beamGreen, red: VIS.beamRed },
      0.95,
      VIS.missBeamOpacity
    );
    this.repBeams = new BeamPool(
      this.scene,
      120,
      { green: VIS.repBeamGreen, red: VIS.repBeamRed },
      0.55
    );

    // Death explosions. Pool size is well above plausible simultaneous
    // deaths even in a 50v50 fight where one team is collapsing -- a few
    // ships die per tick at most, and explosions are short-lived.
    this.explosions = new ExplosionPool(this.scene, 64);

    window.addEventListener("resize", () => this._onResize());
  }

  _addStars() {
    const N = 1500;
    const positions = new Float32Array(N * 3);
    const R = 1_500_000;
    for (let i = 0; i < N; i++) {
      // Sample on a sphere shell.
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = R * (0.6 + 0.4 * Math.random());
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = r * s * Math.cos(t);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * s * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const m = new THREE.PointsMaterial({
      color: 0xaabbcc,
      size: 1500,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
    });
    this.scene.add(new THREE.Points(g, m));
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.threeRenderer.setSize(window.innerWidth, window.innerHeight);
  }

  // Build / destroy ship meshes to match the battle's ship list.
  //
  // Geometry selection by ship type:
  //   nightmare follower -> small cone (pipGeom)
  //   nightmare leader   -> large cone (leaderGeom) + leader ring
  //   scimitar  follower -> octahedron (scimitarGeom)
  //   scimitar  leader   -> octahedron (scimitarGeom) + leader ring
  //                         (no enlarged variant -- the ring alone is
  //                          enough to call out a logi-led subfleet,
  //                          which only happens if the subfleet has
  //                          zero nightmares.)
  // Color is the team color tinted toward the scimitar accent for logi.
  syncShips(battle) {
    const seen = new Set();
    for (const s of battle.ships) {
      seen.add(s.id);
      let entry = this.shipMeshes.get(s.id);
      if (!entry) {
        const isScimitar = s.shipType === "scimitar";
        const baseColor = isScimitar
          ? s.team === "green"
            ? VIS.scimitarGreen
            : VIS.scimitarRed
          : s.team === "green"
          ? VIS.greenColor
          : VIS.redColor;
        const leaderTint = s.team === "green" ? VIS.leaderGreen : VIS.leaderRed;
        const isLeader = s.isLeader;
        const mat = new THREE.MeshStandardMaterial({
          color: isLeader && !isScimitar ? leaderTint : baseColor,
          emissive: isLeader && !isScimitar ? leaderTint : baseColor,
          emissiveIntensity: 0.6,
          roughness: 0.5,
          metalness: 0.1,
        });
        const geom = isScimitar
          ? this.scimitarGeom
          : isLeader
          ? this.leaderGeom
          : this.pipGeom;
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.copy(s.position);
        this.scene.add(mesh);
        entry = { mesh, mat, isLeader, shipType: s.shipType };
        if (isLeader) {
          const ringMat = new THREE.MeshBasicMaterial({
            color: leaderTint,
            transparent: true,
            opacity: 0.7,
          });
          const ring = new THREE.Mesh(this.ringGeom, ringMat);
          ring.rotation.x = Math.PI / 2;
          mesh.add(ring);
          entry.ring = ring;
          entry.ringMat = ringMat;
        }
        this.shipMeshes.set(s.id, entry);
      }

      // Update transforms + visual state.
      entry.mesh.position.copy(s.position);
      entry.mesh.visible = s.alive;

      // Orient cone apex (local +Y) along velocity direction. Octahedrons
      // are rotationally symmetric so we still apply the rotation -- harmless
      // and keeps the (purely cosmetic) "facing" stable as ships maneuver.
      if (s.velocity.lengthSq() > 1e-2) {
        _velDir.copy(s.velocity).normalize();
        entry.mesh.quaternion.setFromUnitVectors(Y_UP, _velDir);
      }

      // Promotion: a follower may have been promoted to leader mid-battle.
      // Toggle the ring on if so. We don't swap the mesh geometry here --
      // a promoted scimitar keeps its octahedron, and a promoted nightmare
      // follower keeps its small cone (the ring is the "leader" cue).
      if (s.isLeader && !entry.ring) {
        const tint = s.team === "green" ? VIS.leaderGreen : VIS.leaderRed;
        const ringMat = new THREE.MeshBasicMaterial({
          color: tint,
          transparent: true,
          opacity: 0.7,
        });
        const ring = new THREE.Mesh(this.ringGeom, ringMat);
        ring.rotation.x = Math.PI / 2;
        entry.mesh.add(ring);
        entry.ring = ring;
        entry.ringMat = ringMat;
        // Don't repaint a promoted scimitar with the leader tint -- keep
        // its scimitar accent so logi remain visually identifiable even
        // when leading.
        if (s.shipType !== "scimitar") {
          entry.mat.color.setHex(tint);
          entry.mat.emissive.setHex(tint);
        }
      }

      // HP color: dim emissive as ship dies.
      const hp = s.hpFraction();
      entry.mat.emissiveIntensity = 0.25 + 0.6 * hp;
    }

    // Remove meshes for ships no longer in the battle (e.g. after restart).
    for (const [id, entry] of this.shipMeshes) {
      if (!seen.has(id)) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry = null;
        entry.mat.dispose();
        if (entry.ringMat) entry.ringMat.dispose();
        this.shipMeshes.delete(id);
      }
    }
  }

  // Drain the battle's hit events that we haven't shown yet, spawning beams.
  // We track the timestamp of the last consumed event per renderer instance.
  //
  // Two event kinds:
  //   "fire" -> a turret laser shot. Misses are silent (bright beam pool
  //             would be too noisy if we drew misses too); hits spawn a
  //             short bright beam in `this.beams`.
  //   "rep"  -> a scimitar rep cycle. Always drawn; routed through
  //             refreshOrSpawnByFromId on `this.repBeams` so each scimitar
  //             has at most one continuous rep beam at a time, with its
  //             lifetime extended on each new cycle (so the visual reads
  //             as a sustained tractor beam instead of a per-cycle flash).
  consumeHitEvents(battle) {
    if (this._lastEventT === undefined) this._lastEventT = -1;
    for (const ev of battle.hitEvents) {
      if (ev.t <= this._lastEventT) continue;
      if (ev.kind === "death") {
        // Death event: look up the ship by id (it stays in battle.ships
        // even when alive=false, so its last position is still valid for
        // anchoring the explosion). The mesh is hidden by syncShips on
        // the same tick, so the explosion visually replaces the ship.
        const ship = battle.ships.find((s) => s.id === ev.shipId);
        if (!ship) continue;
        const team = ev.team || ship.team;
        const shipType = ev.shipType || ship.shipType;
        const color =
          team === "green" ? VIS.explosionGreen : VIS.explosionRed;
        const radius =
          VIS.explosionRadius[shipType] ?? VIS.explosionRadius.nightmare;
        this.explosions.spawn(
          ship.position,
          color,
          radius,
          VIS.explosionDuration
        );
        continue;
      }
      const from = battle.ships.find((s) => s.id === ev.fromId);
      const to = battle.ships.find((s) => s.id === ev.toId);
      if (!from || !to) continue;
      if (ev.kind === "rep") {
        // Slightly longer than cycle time so the beam doesn't pop off for
        // a frame between cycles if the next cycle event arrives a tick
        // late; refresh-by-from collapses repeats.
        this.repBeams.refreshOrSpawnByFromId(
          from,
          to,
          SIM.repBeamDuration + 0.5,
          from.team
        );
      } else {
        // "fire" (default; legacy events without a `kind` field also fall
        // through here for compatibility). Hits draw shooter -> target;
        // misses draw the same beam in the same direction but extended
        // VIS.missBeamExtend times the shooter->target distance, so the
        // photons visually pass through the target's position and continue
        // into space ("the laser missed and the light kept going").
        const extend = ev.hit ? 1 : VIS.missBeamExtend;
        this.beams.spawn(
          from,
          to,
          SIM.beamFlashDuration,
          from.team,
          extend
        );
      }
    }
    this._lastEventT = battle.simTime;
  }

  // Position one primary-target ring at each unique live primary ship
  // across all subfleets on both teams. Two subfleets calling the same
  // ship share a single ring (deduped via a Set). Unused pool entries are
  // hidden.
  updatePrimaryIndicators(battle) {
    const seen = new Set();
    let used = 0;
    for (const team of ["green", "red"]) {
      for (const sub of battle.subfleets[team]) {
        const p = sub.primary;
        if (!p || !p.alive) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (used >= this.primaryRingPool.length) break;
        const ring = this.primaryRingPool[used++];
        ring.position.copy(p.position);
        ring.visible = true;
      }
    }
    for (let i = used; i < this.primaryRingPool.length; i++) {
      this.primaryRingPool[i].visible = false;
    }
  }

  // Per render frame: update beam lifetimes (both pools), advance any
  // active death explosions, controls damping, render scene.
  render(realDt) {
    this.beams.step(realDt);
    this.repBeams.step(realDt);
    this.explosions.step(realDt);
    this.controls.update();
    this.threeRenderer.render(this.scene, this.camera);
  }

  // Wipe per-battle visuals (call before rebuilding for restart).
  resetBattleVisuals() {
    for (const [id, entry] of this.shipMeshes) {
      this.scene.remove(entry.mesh);
      entry.mat.dispose();
      if (entry.ringMat) entry.ringMat.dispose();
    }
    this.shipMeshes.clear();
    this.beams.clear();
    this.repBeams.clear();
    this.explosions.clear();
    this._lastEventT = -1;
    for (const ring of this.primaryRingPool) ring.visible = false;
  }
}
