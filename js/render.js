import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VIS, SIM } from "./constants.js";

const Y_UP = new THREE.Vector3(0, 1, 0);
const _velDir = new THREE.Vector3();

// Pool of line segments used for momentary beam-flash visuals. Two shared
// materials (one per team) are swapped onto the recycled line at spawn time
// so green ships fire green beams and red ships fire red beams.
//
// Each active beam keeps a reference to its shooter and target Ship and
// rewrites its line endpoints to the current ship positions every frame,
// so the beam visibly stays attached to both moving ships for its full
// lifetime instead of dangling in space at the firing instant. If either
// endpoint dies mid-beam the beam is recycled immediately so it doesn't
// hang on an invisible mesh.
class BeamPool {
  constructor(scene, size = 800) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.materials = {
      green: new THREE.LineBasicMaterial({
        color: VIS.beamGreen,
        transparent: true,
        opacity: 0.95,
      }),
      red: new THREE.LineBasicMaterial({
        color: VIS.beamRed,
        transparent: true,
        opacity: 0.95,
      }),
    };
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

  // Write the current shooter/target positions into the line's vertex buffer.
  _writeEndpoints(line, fromPos, toPos) {
    const pos = line.geometry.attributes.position;
    pos.array[0] = fromPos.x;
    pos.array[1] = fromPos.y;
    pos.array[2] = fromPos.z;
    pos.array[3] = toPos.x;
    pos.array[4] = toPos.y;
    pos.array[5] = toPos.z;
    pos.needsUpdate = true;
  }

  // `fromShip` and `toShip` are Ship objects; we keep references so step()
  // can re-read their .position vectors each frame.
  spawn(fromShip, toShip, lifetime, team) {
    const line = this.pool.pop();
    if (!line) return;
    line.material = this.materials[team] || this.materials.green;
    line.visible = true;
    this._writeEndpoints(line, fromShip.position, toShip.position);
    this.active.push({
      line,
      life: lifetime,
      max: lifetime,
      from: fromShip,
      to: toShip,
    });
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
      this._writeEndpoints(a.line, a.from.position, a.to.position);
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
    this.ringGeom = new THREE.TorusGeometry(VIS.leaderRadius * 1.6, 60, 8, 32);

    this.shipMeshes = new Map(); // ship.id -> { mesh, ring? }

    // Primary-target indicators: one persistent yellow torus per team's call.
    // Positioned each frame at battle.primary[team].position; hidden if no
    // primary or if it's dead.
    const primaryGeom = new THREE.TorusGeometry(VIS.pipRadius * 4, 60, 8, 36);
    const mkPrimaryRing = () => {
      const m = new THREE.Mesh(
        primaryGeom,
        new THREE.MeshBasicMaterial({
          color: 0xffd000,
          transparent: true,
          opacity: 0.9,
        })
      );
      m.rotation.x = Math.PI / 2; // lie flat (horizontal halo)
      m.visible = false;
      return m;
    };
    this.primaryRings = { green: mkPrimaryRing(), red: mkPrimaryRing() };
    this.scene.add(this.primaryRings.green);
    this.scene.add(this.primaryRings.red);

    this.beams = new BeamPool(this.scene);

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
  syncShips(battle) {
    const seen = new Set();
    for (const s of battle.ships) {
      seen.add(s.id);
      let entry = this.shipMeshes.get(s.id);
      if (!entry) {
        const baseColor = s.team === "green" ? VIS.greenColor : VIS.redColor;
        const leaderTint = s.team === "green" ? VIS.leaderGreen : VIS.leaderRed;
        const isLeader = s.isLeader;
        const mat = new THREE.MeshStandardMaterial({
          color: isLeader ? leaderTint : baseColor,
          emissive: isLeader ? leaderTint : baseColor,
          emissiveIntensity: 0.6,
          roughness: 0.5,
          metalness: 0.1,
        });
        const mesh = new THREE.Mesh(
          isLeader ? this.leaderGeom : this.pipGeom,
          mat
        );
        mesh.position.copy(s.position);
        this.scene.add(mesh);
        entry = { mesh, mat, isLeader };
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

      // Orient cone apex (local +Y) along velocity direction. If velocity is
      // near zero (e.g. just spawned static), leave previous orientation.
      if (s.velocity.lengthSq() > 1e-2) {
        _velDir.copy(s.velocity).normalize();
        entry.mesh.quaternion.setFromUnitVectors(Y_UP, _velDir);
      }

      // Promotion: a follower may have been promoted to leader mid-battle.
      // Toggle the ring on if so.
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
        entry.mat.color.setHex(tint);
        entry.mat.emissive.setHex(tint);
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
  consumeHitEvents(battle) {
    if (this._lastEventT === undefined) this._lastEventT = -1;
    for (const ev of battle.hitEvents) {
      if (ev.t <= this._lastEventT) continue;
      const from = battle.ships.find((s) => s.id === ev.fromId);
      const to = battle.ships.find((s) => s.id === ev.toId);
      if (!from || !to) continue;
      // Only show hits as bright beams; misses are silent for clarity.
      if (!ev.hit) continue;
      this.beams.spawn(from, to, SIM.beamFlashDuration, from.team);
    }
    this._lastEventT = battle.simTime;
  }

  // Position the per-team primary-target rings at the current primary's
  // location each frame; hide if no live primary.
  updatePrimaryIndicators(battle) {
    for (const team of ["green", "red"]) {
      const primary = battle.primary[team];
      const ring = this.primaryRings[team];
      if (primary && primary.alive) {
        ring.position.copy(primary.position);
        ring.visible = true;
      } else {
        ring.visible = false;
      }
    }
  }

  // Per render frame: update beam lifetimes, controls damping, render scene.
  render(realDt) {
    this.beams.step(realDt);
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
    this._lastEventT = -1;
    this.primaryRings.green.visible = false;
    this.primaryRings.red.visible = false;
  }
}
