// All numerical inputs for the Nightmare-vs-Nightmare fleet simulation.
// Sources:
//   - nightmare_stats.txt   (provided ship/weapon stats)
//   - formulae.txt          (EVE hit-chance + range/tracking formula)
//   - nightmare_fitting.txt (modules used to derive damage_modifiers)
//
// Out of scope for v1: drones (Vespa II), energy neutralizers, capacitor,
// module overheating, ammo swap, smartbombs/e-war.
//
// All units are SI: meters, seconds, radians (radians/second for tracking).

export const NIGHTMARE = {
  // --- Weapons (4x Tachyon Beam Laser II) -----------------------------------
  optimalRange: 39_500, // m
  falloff: 35_215, // m
  trackingSpeed: 0.00284, // rad/s  (= 2.84 mrad/s)
  emDamage: 32.2, // per laser per cycle, before multiplier
  thermalDamage: 23, // per laser per cycle, before multiplier
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
  // Per-fleet team size now lives in FLEET_CONFIG.<team>.teamSize so each
  // side can be independently sized between battles. Battle._spawn reads
  // those values directly.
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
  idealRange: 36_000, // m, leader prefers to sit just inside optimal
  idealRangeBand: 2_000, // m, dead-zone hysteresis around idealRange
  minRange: 28_000, // m, leader pulls away if closer than this
  // Heading commitment: leaders pick a heading and fly it for this long
  // before re-evaluating, so they aren't constantly chasing the rotating
  // line-of-sight as ships pass each other. Re-evaluation also fires early
  // if range goes critical (very close or beyond optimal+falloff).
  headingCommitTime: 22, // s, baseline commit duration
  headingCommitJitter: 6, // s, +/- per-leader randomization to desync teams
  // Critical-range overrides force a re-evaluation before headingCommitTime.
  criticalCloseRange: 18_000, // m, force open
  criticalFarRange: 65_000, // m, force close (well into falloff)
  leaderTurnAccel: 200, // m/s^2, how snappy leaders steer
  followerTurnAccel: 350, // m/s^2, followers correct harder to hold formation
  simDt: 0.1, // s, fixed sim sub-step
  beamFlashDuration: 0.32, // s, hit-line visible time
};

// --- Per-fleet runtime config -----------------------------------------------
// Mutable. UI inputs in main.js bind to these; sim.js reads them every time a
// new primary is called to seed each ship's reaction-delay roll. Editing
// these mid-battle only affects the *next* reaction roll a ship makes; ships
// already mid-react / mid-lock continue with their existing timers.
export const FLEET_CONFIG = {
  green: {
    // Number of ships in this fleet (1 leader + (teamSize - 1) followers).
    // Applied at the next Battle spawn -- i.e., on Restart.
    teamSize: 50,
    // Number of subfleets to split the team into at spawn. Each subfleet is
    // a fully-independent unit: own leader (own primary-target call), own
    // formation, own steering, own lock progression. teamSize is divided
    // as evenly as possible across them. Clamped to <= teamSize at spawn.
    // Applied on Restart.
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
    // Per-ship damage modifier (heat sinks + skills + hull bonus). Rolled
    // ONCE at ship spawn from N(damageMean, damageSigma^2), clamped to >= 0.
    // Edits to these values only affect ships spawned by the NEXT battle
    // (i.e., after Restart) -- alive ships keep the modifier they rolled.
    damageMean: 2.5,
    damageSigma: 0.4,
  },
  red: {
    teamSize: 50,
    subfleetCount: 1,
    unifiedMovement: false,
    reactionMin: 0.0,
    reactionMax: 1.0,
    hardenerReactionMin: 0.5,
    hardenerReactionMax: 3.0,
    overheatReactionMin: 1.0,
    overheatReactionMax: 5.0,
    damageMean: 2.5,
    damageSigma: 0.4,
  },
};

// --- Visuals ----------------------------------------------------------------
export const VIS = {
  // 1 world unit = 1 meter. Pips are sized to be visible at ~80 km cam dist.
  pipRadius: 180,
  leaderRadius: 320,
  hitColor: 0xffd060, // legacy; not used now that beams are team-coloured
  beamGreen: 0x6fff8a, // bright lime for green-team laser beams
  beamRed: 0xff5a5a, // bright coral for red-team laser beams
  greenColor: 0x4cd57a,
  redColor: 0xf06464,
  leaderGreen: 0x9bff9b,
  leaderRed: 0xff9b9b,
  gridSize: 200_000,
  gridDivisions: 20,
  initialCameraDistance: 90_000,
};
