// All numerical inputs for the Nightmare-vs-Nightmare fleet simulation.
// Sources:
//   - nightmare_stats.txt   (provided ship/weapon stats)
//   - scimitar_stats.txt    (logistics ship stats)
//   - formulae.txt          (EVE hit-chance + range/tracking formula and
//                            remote-rep range attenuation)
//   - nightmare_fitting.txt (modules used to derive damage_modifiers)
//   - scimitar_fitting.txt  (4x Gistum C-Type Medium Remote Shield Booster)
//
// Out of scope for v1: drones (Vespa II), energy neutralizers, capacitor,
// module overheating, ammo swap, smartbombs/e-war.
//
// All units are SI: meters, seconds, radians (radians/second for tracking).

export const NIGHTMARE = {
  // --- Weapons (4x Tachyon Beam Laser II) -----------------------------------
  // optimalRange / falloff / trackingSpeed / emDamage / thermalDamage are now
  // per-CRYSTAL stats (see CRYSTALS below); the values kept here match the
  // multifrequency crystal (DEFAULT_CRYSTAL_IDX) and remain as documentation
  // of the "default loaded" weapon profile. Live combat code reads from the
  // ship's currently loaded crystal via Ship.currentCrystal() instead.
  optimalRange: 39_500, // m  (multifrequency)
  falloff: 35_215, // m  (multifrequency)
  // 13.92 mrad/s = 0.01392 rad/s for multifrequency. This is the OLD-style
  // EVE attribute value (paired with TURRET_SIG_RESOLUTION = 400 below);
  // equivalent to the modern in-game "Turret Tracking" of 1.39205 paired
  // with the 40,000m unified signature resolution. The previous value of
  // 0.00284 was the modern attribute mistakenly divided by 1000 (off by
  // ~5x), which made hit chance collapse to ~0% the moment the target had
  // any non-trivial transversal -- ships orbiting at AB speed never landed
  // a single shot in long sims. See computeHitChance in ship.js.
  trackingSpeed: 0.01392, // rad/s  (= 13.92 mrad/s, multifrequency)
  // Pilot/fitting multiplier on raw tracking_speed. Mirrors the role of
  // FLEET_CONFIG damageMean for damage. Derivation for the canonical
  // Nightmare fit (see nightmare_fitting.txt):
  //   2x Tracking Enhancer II, +20% each, stacking penalty:
  //     1st module: 1.000 * 0.20 = 0.200
  //     2nd module: 0.869 * 0.20 = 0.174   (penalty exp(-(1/2.22)^2))
  //     combined module multiplier = 1 + 0.200 + 0.174 = 1.374
  //   Trajectory Analysis L5: +25% turret tracking = 1.25
  //   Total: 1.374 * 1.25 = 1.7175
  // Applied in Ship.computeHitChance as effective_tracking = tracking_speed
  // * trackingModifier. Set to 1.0 to disable fitting/skill bonuses.
  trackingModifier: 1.7175,
  emDamage: 32.2, // per laser per cycle, before multiplier (multifrequency)
  thermalDamage: 23, // per laser per cycle, before multiplier (multifrequency)
  damageMultiplier: 28.2, // turret damage multiplier
  rateOfFire: 6.79, // s per cycle, all 4 lasers fire together
  numLasers: 4,

  // --- Mobility -------------------------------------------------------------
  signatureRadius: 462, // m
  abSpeed: 791, // m/s, with Domination 100MN AB

  // --- Defenses ------------------------------------------------------------
  // Three shield resist profiles, applied in sequence as the pilot reacts:
  //   shieldResistsBase                - hardeners OFF (passive only)
  //   shieldResistsHardenersOn         - hardeners ON (active modules running)
  //   shieldResistsHardenersOverheated - hardeners ON + overheated
  // The transitions OFF -> ON and ON -> OVERHEATED are independent per-ship
  // reaction delays driven from FLEET_CONFIG (see hardenerReaction* and
  // overheatReaction* below). Armor / structure are unchanged by hardeners.
  shieldHP: 40_700,
  shieldResistsBase: {
    em: 0.431,
    thermal: 0.30,
    kinetic: 0.475,
    explosive: 0.562,
  },
  shieldResistsHardenersOn: {
    em: 0.829,
    thermal: 0.835,
    kinetic: 0.688,
    explosive: 0.74,
  },
  // Overheated values: roughly +15% to the active "hardener bonus"
  // (the resist gained from BAse -> On). Capped at 0.95 to avoid
  // unrealistic ~100% mitigation. Edit freely.
  shieldResistsHardenersOverheated: {
    em: 0.890,
    thermal: 0.890,
    kinetic: 0.720,
    explosive: 0.770,
  },

  armorHP: 11_900,
  armorResists: { em: 0.4, thermal: 0.4, kinetic: 0.4, explosive: 0.4 },

  structureHP: 11_300,
  structureResists: { em: 0.6, thermal: 0.6, kinetic: 0.6, explosive: 0.6 },
};

// Scimitar (Minmatar logistics cruiser). Stats from scimitar_stats.txt.
// Structure HP "1790k" in the source was treated as a typo; real EVE
// scimitar structure is ~1790 HP, which is consistent with the nightmare
// "11.3k" -> 11300 convention used elsewhere. If the source value really
// did mean 1.79M, change structureHP below.
export const SCIMITAR = {
  // --- Mobility -------------------------------------------------------------
  signatureRadius: 65, // m, much smaller than the nightmare battleship
  abSpeed: 1701, // m/s, Federation Navy 100MN AB

  // --- Defenses ------------------------------------------------------------
  // Same three-stage hardener model as the nightmare: hardeners OFF -> ON ->
  // OVERHEATED, transitions driven by the same per-ship reaction timers in
  // FLEET_CONFIG. Resists from scimitar_stats.txt.
  shieldHP: 2_020,
  shieldResistsBase: {
    em: 0.781,
    thermal: 0.65,
    kinetic: 0.475,
    explosive: 0.562,
  },
  shieldResistsHardenersOn: {
    em: 0.894,
    thermal: 0.83,
    kinetic: 0.746,
    explosive: 0.788,
  },
  shieldResistsHardenersOverheated: {
    em: 0.915,
    thermal: 0.859,
    kinetic: 0.788,
    explosive: 0.824,
  },

  armorHP: 2_100,
  armorResists: {
    em: 0.915,
    thermal: 0.724,
    kinetic: 0.363,
    explosive: 0.235,
  },

  structureHP: 1_790,
  structureResists: { em: 0.6, thermal: 0.6, kinetic: 0.6, explosive: 0.6 },
};

// Per-ship-type stats lookup, indexed by Ship.shipType. Keep this in sync
// with any new types we add later.
export const SHIP_STATS = {
  nightmare: NIGHTMARE,
  scimitar: SCIMITAR,
};

// --- Frequency crystals (Tachyon Beam Laser ammo) ---------------------------
// Stats from crystals_stats.txt. Each entry overrides the
// optimalRange / falloff / trackingSpeed / emDamage / thermalDamage of the
// nightmare's lasers when loaded; damageMultiplier and numLasers are the
// turret's stats and stay in NIGHTMARE.
//
// Sorted from longest optimal to shortest so the "ideal crystal" search
// below is easy to reason about (smaller index = longer range = lower
// damage). All four lasers on a single nightmare share the same crystal,
// so this is per-ship state, not per-laser.
// Tracking values are in rad/s and correspond to the OLD-style EVE
// "Turret Tracking" attribute paired with TURRET_SIG_RESOLUTION = 400
// (see below). Per-crystal modifiers vs. the base Tachyon Beam Laser II
// tracking (13.92 mrad/s) follow the in-game crystal multipliers:
//   aurora        x0.25
//   radio..gamma  x1.00
//   multifrequency x1.00
//   gleam         x1.25
// Previous values were ~5x lower (the modern unified-format attribute
// mistakenly divided by 1000) which made hit chance collapse to ~0% the
// moment target transversal exceeded a few hundred m/s -- see comment on
// NIGHTMARE.trackingSpeed.
export const CRYSTALS = [
  { name: "aurora",         abbr: "AU", optimalRange: 142_000, falloff: 35_200, emDamage: 20,   thermalDamage: 12,   trackingSpeed: 0.00348 },
  { name: "radio",          abbr: "RA", optimalRange: 126_000, falloff: 35_200, emDamage: 23,   thermalDamage: 0,    trackingSpeed: 0.01392 },
  { name: "microwave",      abbr: "MW", optimalRange: 110_000, falloff: 35_200, emDamage: 18.4, thermalDamage: 9.2,  trackingSpeed: 0.01392 },
  { name: "infrared",       abbr: "IR", optimalRange: 94_700,  falloff: 35_200, emDamage: 23,   thermalDamage: 9.2,  trackingSpeed: 0.01392 },
  { name: "standard",       abbr: "ST", optimalRange: 78_900,  falloff: 35_200, emDamage: 23,   thermalDamage: 13.8, trackingSpeed: 0.01392 },
  { name: "ultraviolet",    abbr: "UV", optimalRange: 69_000,  falloff: 35_200, emDamage: 27.6, thermalDamage: 13.8, trackingSpeed: 0.01392 },
  { name: "xray",           abbr: "XR", optimalRange: 59_200,  falloff: 35_200, emDamage: 27.6, thermalDamage: 18.4, trackingSpeed: 0.01392 },
  { name: "gamma",          abbr: "GM", optimalRange: 49_300,  falloff: 35_200, emDamage: 32.2, thermalDamage: 18.4, trackingSpeed: 0.01392 },
  { name: "multifrequency", abbr: "MF", optimalRange: 39_500,  falloff: 35_500, emDamage: 32.2, thermalDamage: 23,   trackingSpeed: 0.01392 },
  { name: "gleam",          abbr: "GL", optimalRange: 19_700,  falloff: 35_200, emDamage: 28,   thermalDamage: 28,   trackingSpeed: 0.01740 },
];

// Default crystal loaded on every freshly-spawned nightmare. Multifrequency
// matches the original nightmare_stats.txt (and the documentation values in
// NIGHTMARE above), so the "before any swap" behaviour is unchanged.
export const DEFAULT_CRYSTAL_IDX = 8; // multifrequency

// Pick the "ideal" crystal index for a target at distance `d` (meters):
// the smallest-optimal crystal whose optimal range still covers `d`. Since
// the table is sorted long->short and damage strictly increases as optimal
// shrinks, this is also the highest-damage crystal that puts the target
// inside optimal -- i.e., the user spec's "puts target in optimal, keeps
// damage as high as possible".
//
// If `d` is greater than every crystal's optimal range (target very far),
// no crystal can put it in optimal; we fall back to the longest-range
// crystal (index 0, aurora) so the pilot at least has *some* chance of a
// shot landing in falloff.
export function pickIdealCrystalIdx(d) {
  let bestIdx = -1;
  let bestOpt = Infinity;
  for (let i = 0; i < CRYSTALS.length; i++) {
    const opt = CRYSTALS[i].optimalRange;
    if (opt >= d && opt < bestOpt) {
      bestIdx = i;
      bestOpt = opt;
    }
  }
  if (bestIdx === -1) {
    // No crystal's optimal covers d: use the longest-range crystal.
    let longestIdx = 0;
    let longestOpt = -Infinity;
    for (let i = 0; i < CRYSTALS.length; i++) {
      if (CRYSTALS[i].optimalRange > longestOpt) {
        longestOpt = CRYSTALS[i].optimalRange;
        longestIdx = i;
      }
    }
    return longestIdx;
  }
  return bestIdx;
}

// 4x Gistum C-Type Medium Remote Shield Booster (Scimitar fit). The user-
// confirmed "stack-one" allocation has every Scimitar lock a single friendly
// and pump all four boosters into them simultaneously, so a successful
// in-optimal cycle restores rep_amount * count = 1336 HP every cycle_time
// seconds (~185 HPS) before range attenuation. Range attenuation follows the
// EVE turret-style optimal+falloff curve from formulae.txt.
export const REMOTE_REP = {
  optimalRange: 27_000, // m
  falloff: 40_500, // m
  repAmount: 334, // HP per booster per cycle, before range attenuation
  cycleTime: 7.2, // s per cycle
  lockTime: 2.0, // s, fixed scimitar lock time on a friendly broadcaster
  count: 4, // boosters per Scimitar (all stacked on the same target)
};

// Hit-formula extras not directly in nightmare_stats.txt -----------------
// Standard signature resolution for large turrets in EVE = 400 m.
// (chruker reports 40000 in raw DB units; the in-formula value is 400.)
export const TURRET_SIG_RESOLUTION = 400;

// Per-ship damage modifier (heat sinks + skills + hull bonus) is rolled at
// spawn from a normal distribution per fleet -- see FLEET_CONFIG.damageMean
// / damageSigma below. Each ship keeps its rolled value for the rest of the
// battle, so the fleet's aggregate damage is normally distributed (sum of
// independent normals = normal). The previous fleet-wide constant ~2.5
// corresponds to mean=2.5, sigma=0 (no spread).

// --- Sim tuning -------------------------------------------------------------
export const SIM = {
  // Per-fleet team size now lives in FLEET_CONFIG.<team>.nightmareCount /
  // scimitarCount so each side can be independently sized between battles.
  // Battle._spawn reads those values directly.
  startSeparation: 50_000, // m, between the two leader spawn points
  // Followers form a 3D "blob" trailing behind the leader. Slots are sampled
  // inside a half-ellipsoid (z <= 0 in leader-local frame, i.e. behind) with
  // rejection sampling enforcing min center-to-center spacing, so the cone
  // pips don't overlap and have a visible gap. Cone bounding radius is
  // ~290 m, so 800 m gives a clean visible gap.
  formationMinSpacing: 800, // m, min center-to-center between any two slots / leader
  formationBlobX: 2_800, // m, half-width of trailing blob (left/right)
  formationBlobY: 1_300, // m, half-height (up/down)
  formationBlobZ: 6_000, // m, depth of blob behind leader
  // Vertical spacing between sibling subfleets at spawn. Each subfleet is
  // stacked along Y so the blobs (formationBlobY = 1300 half-height) don't
  // overlap and the camera can immediately see them as distinct groups.
  subfleetVerticalSpacing: 4_000, // m
  // Leaders steer to maximise the perpendicular component of the relative
  // velocity vs. their tracked engagement reference (the enemy primary)
  // while keeping range <= maxRange. Each tick steerLeader (ai.js) builds
  // a desired AB-speed velocity vector: the LOS-radial component is set
  // to match the enemy's radial component (zero range change) PLUS a
  // closing rate proportional to (range - maxRange) once range exceeds
  // maxRange; the perpendicular component is anti-aligned to the enemy's
  // perpendicular velocity, which is the choice that mathematically
  // maximises |v_us_perp - v_enemy_perp| (= the transversal). The two
  // components are sized so |desired| = AB speed, so the leader holds
  // AB speed throughout. Steering toward that desired vector goes through
  // steerByRotation, so the heading just rotates at the centripetal rate
  // set by leaderTurnAccel. There is no per-leader heading commitment or
  // zigzag any more -- the desired vector is recomputed every tick and
  // the slow turn rate provides all the smoothing.
  maxRange: 170_000, // m, upper bound the leader tries not to exceed
  // Lateral acceleration caps. Battleships have high inertia, so turns are
  // deliberately sluggish:
  //   leaderTurnAccel  = 40 m/s^2 -> at AB speed (791 m/s nightmare) the
  //                       centripetal turn rate is ~0.051 rad/s = 2.9 deg/s,
  //                       so a 90 deg turn takes ~31 s and a 180 deg flip
  //                       takes ~62 s. Steering is a centripetal-rotation
  //                       model (steerByRotation in ai.js) so leaders hold
  //                       AB speed throughout the turn while their heading
  //                       continually chases the per-tick desired velocity.
  //   followerTurnAccel = 80 m/s^2 -> followers use a linear thrust-toward-
  //                       desired-velocity model (steerTowards in ai.js),
  //                       not centripetal, so this directly caps how fast
  //                       a follower can change its velocity vector. Lower
  //                       = followers visibly lag their slot when the
  //                       leader maneuvers, which reads as inertia.
  leaderTurnAccel: 40,
  followerTurnAccel: 80,
  simDt: 0.1, // s, fixed sim sub-step
  beamFlashDuration: 0.32, // s, hit-line visible time
  // Rep beams are shown for the entire scimitar rep cycle so the visual
  // reads as a continuous "tractor beam" while reps are flowing, instead
  // of flashing once per cycle like turret hits.
  repBeamDuration: REMOTE_REP.cycleTime,
  // Maximum time a ship's hardeners can stay overheated before they "burn
  // out": both hardenersOn and hardenersOverheated drop to false and
  // hardenersBurnedOut latches true for the rest of the battle. The seed
  // happens in _updateHardeners on the same tick that hardenersOverheated
  // first flips true, so each ship's burnout fires exactly this many
  // seconds after it transitioned to the overheated state. Module-level
  // property (not pilot-driven), so it's a single global rather than a
  // per-team config.
  overheatBurnoutDuration: 45.0,
};

// --- Per-fleet runtime config -----------------------------------------------
// Mutable. UI inputs in main.js bind to these; sim.js reads them every time a
// new primary is called to seed each ship's reaction-delay roll. Editing
// these mid-battle only affects the *next* reaction roll a ship makes; ships
// already mid-react / mid-lock continue with their existing timers.
export const FLEET_CONFIG = {
  green: {
    // Number of nightmares (DPS battleships) in this fleet. Applied at the
    // next Battle spawn -- i.e., on Restart. Min 0 (you can run a pure-logi
    // fleet if you want; nothing will shoot).
    nightmareCount: 50,
    // Number of scimitars (logistics) in this fleet. Applied on Restart.
    scimitarCount: 5,
    // Number of subfleets to split the team into at spawn. Each subfleet is
    // a fully-independent unit: own leader (own primary-target call), own
    // formation, own steering, own lock progression. Total team size
    // (nightmares + scimitars) is divided as evenly as possible across them,
    // with nightmares allocated first so each subfleet's leader is a
    // nightmare whenever possible. Clamped to <= total team size at spawn.
    subfleetCount: 1,
    // When true, all subfleets in this fleet move as one coordinated body:
    // the first subfleet's leader is the team movement leader (it does the
    // heading commitment / steering), and every other subfleet leader
    // mirrors its velocity and basis each tick. Targeting / locking /
    // firing remain per-subfleet (each subfleet still calls its own
    // independent primary), so subfleets shoot multiple primaries
    // simultaneously while flying in formation. Live toggle, no restart.
    unifiedMovement: false,
    reactionMin: 0.0, // seconds; lower bound of uniform reaction roll
    reactionMax: 1.0, // seconds; upper bound of uniform reaction roll
    // Per-ship hardener-on reaction. Counted from the moment THIS ship is
    // first locked by any enemy ship (i.e., when the first enemy completes
    // its 3.5 s lock cycle on it). Roll is fresh per ship per first-lock.
    hardenerReactionMin: 0.5,
    hardenerReactionMax: 3.0,
    // Per-ship overheat reaction. Counted from the moment THIS ship's
    // hardeners come on (i.e., from hardenerActivateAt). Models the pilot
    // noticing they're being shot hard enough to justify cooking modules.
    // Roll is fresh per ship per hardener-activation.
    overheatReactionMin: 1.0,
    overheatReactionMax: 5.0,
    // Per-ship "broadcast for repairs" reaction. Counted from the same
    // first-lock event as the hardener reaction (independent roll). Once
    // the timer elapses the ship flips isBroadcasting = true and becomes
    // a candidate rep target for friendly Scimitars. One-shot per ship.
    broadcastReactionMin: 1.5,
    broadcastReactionMax: 4.0,
    // Per-Scimitar reaction delay between observing a friendly broadcast
    // and starting the 2 s lock cycle on that friendly. Fresh roll each
    // time a Scimitar transitions from idle -> reacting (i.e., each time
    // it picks a new rep target).
    logiReactionMin: 0.5,
    logiReactionMax: 2.0,
    // Per-subfleet "time on target before swapping" timer. Counted from the
    // moment a subfleet first calls a given enemy as its primary. If the
    // primary is still alive when this timer elapses, the subfleet drops it
    // and re-picks (excluding the just-dropped target). The intent is to
    // model fleets noticing that a target isn't dying (e.g. because it's
    // being repped by enemy Scimitars) and switching to a softer target.
    // Defaults are tuned so a typical un-repped primary dies well before
    // the timer fires; a sustained reaction in [25, 40] s strongly suggests
    // the target is being held alive.
    targetSwitchReactionMin: 25.0,
    targetSwitchReactionMax: 40.0,
    // Per-nightmare "notice I should swap crystals" reaction. Counted from
    // the moment the pilot's currently-loaded crystal becomes wrong for the
    // current target distance (either target is past optimal+0.5*falloff,
    // OR a shorter-range crystal would put the target in optimal and so
    // out-damage the current load). Roll is fresh each time the situation
    // first becomes wrong; not re-rolled if the "ideal" crystal updates
    // mid-wait, and cancelled if the situation resolves before the timer
    // fires. Crystal swap itself takes 0 s once the pilot reacts.
    crystalReactionMin: 1.0,
    crystalReactionMax: 4.0,
    // Per-ship damage modifier (heat sinks + skills + hull bonus). Rolled
    // ONCE at ship spawn from N(damageMean, damageSigma^2), clamped to >= 0.
    // Edits to these values only affect ships spawned by the NEXT battle
    // (i.e., after Restart) -- alive ships keep the modifier they rolled.
    // Scimitars never fire turrets so they skip this roll entirely.
    damageMean: 2.5,
    damageSigma: 0.4,
  },
  red: {
    nightmareCount: 50,
    scimitarCount: 5,
    subfleetCount: 1,
    unifiedMovement: false,
    reactionMin: 0.0,
    reactionMax: 1.0,
    hardenerReactionMin: 0.5,
    hardenerReactionMax: 3.0,
    overheatReactionMin: 1.0,
    overheatReactionMax: 5.0,
    broadcastReactionMin: 1.5,
    broadcastReactionMax: 4.0,
    logiReactionMin: 0.5,
    logiReactionMax: 2.0,
    targetSwitchReactionMin: 25.0,
    targetSwitchReactionMax: 40.0,
    crystalReactionMin: 1.0,
    crystalReactionMax: 4.0,
    damageMean: 2.5,
    damageSigma: 0.4,
  },
};

// --- Visuals ----------------------------------------------------------------
export const VIS = {
  // 1 world unit = 1 meter. Pips are sized to be visible at ~80 km cam dist.
  pipRadius: 180,
  leaderRadius: 320,
  // Scimitar mesh radius (octahedron). Scimitars are smaller than nightmares
  // in EVE, so we shrink them visually too while still keeping them readable
  // at the default camera distance.
  scimitarRadius: 150,
  hitColor: 0xffd060, // legacy; not used now that beams are team-coloured
  beamGreen: 0x6fff8a, // bright lime for green-team laser beams
  beamRed: 0xff5a5a, // bright coral for red-team laser beams
  // Length multiplier for "miss" turret beams. Hits draw a beam from the
  // shooter to the target (extend = 1). Misses draw a beam in the same
  // direction but extend `missBeamExtend` times the shooter->target
  // distance, so the laser visually "passes through" the target's
  // position and continues into space. Set to 3 per spec ("go past the
  // target 2x further" = 1x to target + 2x past = 3x total).
  missBeamExtend: 3,
  // Per-frame opacity for miss beams. Hit beams stay at the BeamPool's
  // default opacity (0.95) so they pop visually; misses are dimmed so a
  // close-range volley where every shot misses doesn't wash out the scene.
  // Tune freely -- 0.0 makes misses invisible (equivalent to the old
  // "drop misses" behaviour), 0.95 makes them as bright as hits.
  missBeamOpacity: 0.2,
  // Rep beams are dimmer, cooler tones than turret beams so the user can
  // tell at a glance which beams are damage and which are repairs.
  repBeamGreen: 0x4fd0ff,
  repBeamRed: 0xff8fd6,
  greenColor: 0x4cd57a,
  redColor: 0xf06464,
  leaderGreen: 0x9bff9b,
  leaderRed: 0xff9b9b,
  // Scimitar tint: blends the team color with a cool cyan/magenta accent so
  // logi pips read as visually distinct from the DPS cones.
  scimitarGreen: 0x6ff0c4,
  scimitarRed: 0xff7fb0,
  gridSize: 200_000,
  gridDivisions: 20,
  initialCameraDistance: 90_000,

  // --- Death explosions ----------------------------------------------------
  // Spawned by the renderer when a "death" hit event arrives. A single
  // additive-blended sphere expands to explosionRadius[shipType] while
  // fading from full opacity to zero over explosionDuration seconds.
  // Team-tinted (warm yellow-gold for green-team deaths, warm red-orange
  // for red-team deaths) so the side that just lost a ship reads at a
  // glance from the camera.
  explosionDuration: 0.75, // s, total fade-out time
  explosionRadius: {
    nightmare: 800, // m, max sphere radius for a nightmare death
    scimitar: 500, // m, max sphere radius for a scimitar death
  },
  explosionGreen: 0xffd060, // green-team death: golden yellow
  explosionRed: 0xff7030, // red-team death: red-orange
};
