import { renderAllianceViolin } from "./violin_alliance.js";

// IMPORTANT: after deploying tools/cors-worker/ via `wrangler deploy`, paste
// the URL Cloudflare prints (e.g. https://wb-violin-proxy.<account>.workers.dev)
// into PROXY_BASE below. The local-storage override is just a convenience for
// pointing at a different worker (e.g. a preview deploy) without editing
// source.
const DEFAULT_PROXY_BASE = "https://wb-violin-proxy.jamiesonpa.workers.dev";
function getProxyBase() {
  try {
    const v = window.localStorage.getItem("wb_proxy_base");
    if (v && /^https?:\/\//.test(v)) return v.replace(/\/+$/, "");
  } catch (_) {}
  return DEFAULT_PROXY_BASE.replace(/\/+$/, "");
}

const SMALL_ALLIANCE_THRESHOLD = 4;
const OTHER_ALLIANCE_LABEL = "OTHER";

const inpUrl = document.getElementById("inp-url");
const inpShip = document.getElementById("inp-ship");
const inpAlliance = document.getElementById("inp-alliance");
const btnAnalyze = document.getElementById("btn-analyze");
const btnDownload = document.getElementById("btn-download");
const statusText = document.getElementById("status-text");
const chartContainer = document.getElementById("chart");
const chartFootnote = document.getElementById("chart-footnote");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function setStatus(text, kind) {
  statusText.textContent = text;
  statusText.classList.remove("ok", "err", "busy");
  if (kind) statusText.classList.add(kind);
}

function extractUuid(url) {
  const m = String(url || "").match(UUID_RE);
  return m ? m[0] : null;
}

async function fetchReport(uuid) {
  const base = getProxyBase();
  if (base.includes("YOUR_ACCOUNT")) {
    throw new Error(
      "PROXY_BASE not configured. Deploy tools/cors-worker/ and paste the worker URL into js/analyzer.js (or set window.localStorage 'wb_proxy_base')."
    );
  }
  const resp = await fetch(`${base}/report/${uuid}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Proxy returned HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (!json || json.success === false || !json.data) {
    throw new Error(
      `Warbeacon error: ${(json && json.error) || "unknown response shape"}`
    );
  }
  return json.data;
}

// Resolve a user-typed name to an entity id by reverse-looking up the
// `names.entities` map (id -> name). Case-insensitive substring match if the
// exact name doesn't exist, with a tie-break preferring exact case-insensitive
// equality.
function resolveEntityId(entities, query) {
  if (!query) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let exact = null;
  const partials = [];
  for (const [idStr, name] of Object.entries(entities)) {
    const id = Number(idStr);
    if (!Number.isFinite(id)) continue;
    const n = String(name || "");
    const nl = n.toLowerCase();
    if (nl === q) {
      exact = { id, name: n };
      break;
    }
    if (nl.includes(q)) partials.push({ id, name: n });
  }
  if (exact) return exact;
  if (partials.length === 1) return partials[0];
  return null;
}

function teamKeys(teamObj) {
  // teamObj is like { alliance_99012122: 95, corporation_98741329: 2, ... }
  // Build two sets of numeric ids: alliance ids and corporation ids.
  const alliances = new Set();
  const corps = new Set();
  for (const k of Object.keys(teamObj || {})) {
    const m = k.match(/^(alliance|corporation)_(\d+)$/);
    if (!m) continue;
    const id = Number(m[2]);
    if (!Number.isFinite(id)) continue;
    if (m[1] === "alliance") alliances.add(id);
    else corps.add(id);
  }
  return { alliances, corps };
}

function findTeamIndex(teams, allianceId) {
  for (let i = 0; i < teams.length; i++) {
    const k = `alliance_${allianceId}`;
    if (teams[i] && Object.prototype.hasOwnProperty.call(teams[i], k)) return i;
  }
  return -1;
}

// Build per-pilot aggregates from killmails. Each pilot is one row, keyed by
// character_id, summed across however many ships they flew.
function aggregatePilots(data) {
  const pilots = new Map(); // char_id -> { name, allianceId, corpId, damage, shipCounts, killed, killedShipId }
  const killmails = Array.isArray(data.killmails) ? data.killmails : [];

  for (const km of killmails) {
    // Attackers: contribute damage and ship-frequency.
    const attackers = Array.isArray(km.attackers) ? km.attackers : [];
    for (const a of attackers) {
      const cid = Number(a && a.character_id);
      if (!Number.isFinite(cid) || cid <= 0) continue;
      let p = pilots.get(cid);
      if (!p) {
        p = {
          characterId: cid,
          name: null,
          allianceId: 0,
          corpId: 0,
          damage: 0,
          shipCounts: new Map(),
          killed: false,
          killedShipId: 0,
        };
        pilots.set(cid, p);
      }
      const dmg = Number(a.damage_done) || 0;
      p.damage += dmg;
      // Latest non-zero alliance/corp wins; non-zero only so we don't
      // wipe a real id with a 0 from a structure-shoot or NPC.
      if (Number(a.alliance_id) > 0) p.allianceId = Number(a.alliance_id);
      if (Number(a.corporation_id) > 0) p.corpId = Number(a.corporation_id);
      const sid = Number(a.ship_type_id) || 0;
      if (sid > 0) {
        p.shipCounts.set(sid, (p.shipCounts.get(sid) || 0) + 1);
      }
    }

    // Victim: marks the pilot as killed at least once during the battle.
    const v = km.victim;
    if (v && Number.isFinite(Number(v.character_id)) && Number(v.character_id) > 0) {
      const cid = Number(v.character_id);
      let p = pilots.get(cid);
      if (!p) {
        p = {
          characterId: cid,
          name: null,
          allianceId: 0,
          corpId: 0,
          damage: 0,
          shipCounts: new Map(),
          killed: false,
          killedShipId: 0,
        };
        pilots.set(cid, p);
      }
      p.killed = true;
      const sid = Number(v.ship_type_id) || 0;
      if (sid > 0) p.killedShipId = sid;
      if (Number(v.alliance_id) > 0 && p.allianceId === 0) {
        p.allianceId = Number(v.alliance_id);
      }
      if (Number(v.corporation_id) > 0 && p.corpId === 0) {
        p.corpId = Number(v.corporation_id);
      }
    }
  }

  return pilots;
}

function primaryShipId(p) {
  // Most-used attacker ship; fall back to the ship they died in if they
  // never attacked. `0` means "unknown" and the pilot will fail any ship
  // filter (which is the correct conservative behaviour).
  let best = 0;
  let bestCount = -1;
  for (const [sid, c] of p.shipCounts) {
    if (c > bestCount) {
      bestCount = c;
      best = sid;
    }
  }
  if (best > 0) return best;
  return p.killedShipId || 0;
}

function buildGroups(filteredPilots, allTeamPilots, entities) {
  // OTHER bucketing is computed against the *full* team roster so labels
  // don't change depending on the ship filter, exactly mirroring
  // bucket_small_alliances() in battle_analyzer.py.
  const allianceCounts = new Map(); // allianceId -> count on team
  for (const p of allTeamPilots) {
    allianceCounts.set(p.allianceId, (allianceCounts.get(p.allianceId) || 0) + 1);
  }
  const allianceNameOf = (id) => {
    if (!id) return "";
    return entities[id] || "";
  };
  const remappedName = (allianceId) => {
    const count = allianceCounts.get(allianceId) || 0;
    const name = allianceNameOf(allianceId);
    if (!name || count <= SMALL_ALLIANCE_THRESHOLD) return OTHER_ALLIANCE_LABEL;
    return name;
  };

  // Group filtered pilots by displayed-alliance.
  const groupsMap = new Map(); // displayName -> array of { name, damage, killed }
  for (const p of filteredPilots) {
    const display = remappedName(p.allianceId);
    if (!groupsMap.has(display)) groupsMap.set(display, []);
    groupsMap.get(display).push({
      name: p.name || `char ${p.characterId}`,
      damage: p.damage,
      killed: !!p.killed,
    });
  }

  // Order: descending member count, OTHER pinned right (matches python's
  // _order_alliances). Ties broken by name ascending for stability.
  const ordered = Array.from(groupsMap.entries())
    .map(([name, members]) => ({ name, members }))
    .sort((a, b) => {
      const aOther = a.name === OTHER_ALLIANCE_LABEL ? 1 : 0;
      const bOther = b.name === OTHER_ALLIANCE_LABEL ? 1 : 0;
      if (aOther !== bOther) return aOther - bOther;
      if (b.members.length !== a.members.length) return b.members.length - a.members.length;
      return a.name.localeCompare(b.name);
    });
  return ordered;
}

let lastSvgString = null;
let lastFileBaseName = null;

async function runAnalyze() {
  setStatus("Working...", "busy");
  btnAnalyze.disabled = true;
  btnDownload.disabled = true;
  chartContainer.replaceChildren();
  chartFootnote.textContent = "";
  lastSvgString = null;

  try {
    const url = inpUrl.value.trim();
    const shipQuery = inpShip.value.trim();
    const allianceQuery = inpAlliance.value.trim();

    if (!url) throw new Error("Please paste a warbeacon battle report URL.");
    if (!shipQuery) throw new Error("Please enter a ship type (e.g. Nightmare).");
    if (!allianceQuery) throw new Error("Please enter an alliance to identify which side to analyze.");

    const uuid = extractUuid(url);
    if (!uuid) throw new Error("Could not find a battle report UUID in that URL.");

    setStatus(`Fetching report ${uuid}...`, "busy");
    const data = await fetchReport(uuid);

    const entities = (data.names && data.names.entities) || {};

    setStatus("Resolving ship and alliance names...", "busy");
    const ship = resolveEntityId(entities, shipQuery);
    if (!ship) {
      throw new Error(
        `Ship "${shipQuery}" not found in this battle. Try the exact in-game ship name (e.g. "Nightmare").`
      );
    }
    const alliance = resolveEntityId(entities, allianceQuery);
    if (!alliance) {
      throw new Error(
        `Alliance "${allianceQuery}" not found in this battle. Try the exact in-game alliance name.`
      );
    }

    const teams = Array.isArray(data.teams) ? data.teams : [];
    const teamIdx = findTeamIndex(teams, alliance.id);
    if (teamIdx < 0) {
      throw new Error(
        `Alliance "${alliance.name}" doesn't appear on either team in this battle.`
      );
    }
    const { alliances: teamAllianceSet, corps: teamCorpSet } = teamKeys(teams[teamIdx]);

    setStatus("Aggregating per-pilot damage...", "busy");
    const pilots = aggregatePilots(data);
    for (const p of pilots.values()) {
      p.name = entities[p.characterId] || `char ${p.characterId}`;
    }

    const onTargetTeam = (p) =>
      teamAllianceSet.has(p.allianceId) || teamCorpSet.has(p.corpId);

    const allTeamPilots = Array.from(pilots.values()).filter(onTargetTeam);

    const filteredPilots = allTeamPilots.filter(
      (p) => primaryShipId(p) === ship.id
    );

    if (filteredPilots.length === 0) {
      throw new Error(
        `No pilots on ${alliance.name}'s side flew a ${ship.name} in this battle (per killmail data).`
      );
    }

    setStatus("Rendering chart...", "busy");
    const groups = buildGroups(filteredPilots, allTeamPilots, entities);

    const title = `Damage Distribution by Alliance  (ship: ${ship.name})`;
    const svg = renderAllianceViolin(chartContainer, { groups, title });
    lastSvgString = new XMLSerializer().serializeToString(svg);
    lastFileBaseName = `${slug(alliance.name)}_${slug(ship.name)}_damage_violin`;
    btnDownload.disabled = false;

    chartFootnote.textContent =
      `Showing ${filteredPilots.length} pilot(s) on ${alliance.name}'s side flying ${ship.name}, ` +
      `out of ${allTeamPilots.length} pilot(s) on that side total (per killmail data; ` +
      `pilots with zero damage who never appeared on a killmail are not in warbeacon's JSON ` +
      `participant list and are therefore excluded).`;
    setStatus(
      `Done. ${filteredPilots.length} pilot(s) plotted across ${groups.length} alliance group(s).`,
      "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus(err && err.message ? err.message : String(err), "err");
  } finally {
    btnAnalyze.disabled = false;
  }
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "team";
}

function downloadSvg() {
  if (!lastSvgString) return;
  // Some renderers need the xmlns explicitly in standalone files.
  let s = lastSvgString;
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) {
    s = s.replace(/<svg /, '<svg xmlns="http://www.w3.org/2000/svg" ');
  }
  const blob = new Blob([s], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${lastFileBaseName || "damage_violin"}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

btnAnalyze.addEventListener("click", runAnalyze);
btnDownload.addEventListener("click", downloadSvg);
inpUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runAnalyze();
});
inpShip.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runAnalyze();
});
inpAlliance.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runAnalyze();
});
