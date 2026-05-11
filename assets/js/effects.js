/* =========================================================
   Pierce Jamieson, Ph.D. - site effects
   - Ambient drifting atoms with a proximity-bond network.
   - A pool of independent "molecule instances" of varied
     type / size / rotation / position. Each has its own
     scroll activation window, so at any scroll position the
     viewport shows a varied mix of structures (some forming,
     some fully present, some fading out).
     Types: hexagon, naphthalene, indole, DNA helix.
   - Scroll reveal observer
   - Mobile nav toggle
   - Year stamp
   ========================================================= */

(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Atom + molecule-instance background ----------
  function initMoleculeBackground() {
    const canvas = document.getElementById('molecule-bg');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let atoms = [];
    let instances = [];
    let running = true;
    let scrollProgress = 0;

    const COLORS = ['#3a3d44', '#52565e', '#8a8e95', '#b0b4ba', '#d9dce0'];

    function size() {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeAtoms() {
      const area = width * height;
      const target = Math.max(50, Math.min(95, Math.floor(area / 20000)));
      atoms = new Array(target).fill(0).map(() => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 1.2 + Math.random() * 1.8,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
        rx: 0,
        ry: 0,
        engaged: 0,
      }));
    }

    // ---------- Formation builders ----------
    // Each returns { points: [[dx, dy], ...], bonds: [[i, j, order], ...] }
    // in coords relative to the formation's center, at the given scale.

    function buildHexagon(s) {
      const r = s;
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 3;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      const bonds = [];
      for (let i = 0; i < 6; i++) {
        bonds.push([i, (i + 1) % 6, i % 2 === 0 ? 2 : 1]);
      }
      return { points: pts, bonds };
    }

    function buildNaphthalene(s) {
      const r = s;
      const dx = r * Math.sqrt(3) / 2;
      function hexVerts(cx) {
        const arr = [];
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 3;
          arr.push([cx + r * Math.cos(a), r * Math.sin(a)]);
        }
        return arr;
      }
      const A = hexVerts(-dx);
      const B = hexVerts(+dx);
      const merged = [...A, B[0], B[1], B[2], B[3]];
      const bMap = [6, 7, 8, 9, 2, 1];
      const bonds = [];
      for (let i = 0; i < 6; i++) {
        bonds.push([i, (i + 1) % 6, i % 2 === 0 ? 2 : 1]);
      }
      for (let i = 0; i < 6; i++) {
        if (i === 4) continue;
        bonds.push([bMap[i], bMap[(i + 1) % 6], i % 2 === 0 ? 2 : 1]);
      }
      return { points: merged, bonds };
    }

    function buildIndole(s) {
      const r = s;
      const r5 = r / (2 * Math.sin(Math.PI / 5));
      const hexCx = r * Math.sqrt(3) / 2;
      const pentCx = -r5 * Math.cos(Math.PI / 5);

      const hex = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 3;
        hex.push([hexCx + r * Math.cos(a), r * Math.sin(a)]);
      }
      const pent = [];
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 5 + i * (2 * Math.PI / 5);
        pent.push([pentCx + r5 * Math.cos(a), r5 * Math.sin(a)]);
      }
      const merged = [...hex, pent[2], pent[3], pent[4]];

      const bonds = [];
      for (let i = 0; i < 6; i++) {
        bonds.push([i, (i + 1) % 6, i % 2 === 0 ? 2 : 1]);
      }
      bonds.push([4, 6, 1]);
      bonds.push([6, 7, 2]);
      bonds.push([7, 8, 1]);
      bonds.push([8, 5, 1]);
      return { points: merged, bonds };
    }

    function buildDNA(s) {
      const N = 4;
      const stepY = s * 1.05;
      const ampX = s * 0.95;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const t = i - (N - 1) / 2;
        const phase = i * 1.05;
        pts.push([Math.sin(phase) * ampX, t * stepY]);
        pts.push([Math.sin(phase + Math.PI) * ampX, t * stepY]);
      }
      const bonds = [];
      for (let i = 0; i < N - 1; i++) {
        bonds.push([i * 2, (i + 1) * 2, 1]);
        bonds.push([i * 2 + 1, (i + 1) * 2 + 1, 1]);
      }
      for (let i = 0; i < N; i++) {
        bonds.push([i * 2, i * 2 + 1, 1]);
      }
      return { points: pts, bonds };
    }

    const builders = [buildHexagon, buildNaphthalene, buildIndole, buildDNA];

    function getBBox(points) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const x = points[i][0];
        const y = points[i][1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { minX, maxX, minY, maxY };
    }

    function smoothstep(t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t * t * (3 - 2 * t);
    }

    // 6t^5 - 15t^4 + 10t^3 — flatter ends than smoothstep, smoother feel.
    function smootherstep(t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function instanceWeight(s, inst) {
      if (s >= inst.start && s <= inst.end) return 1;
      if (s < inst.start && s > inst.start - inst.fadeIn) {
        return smootherstep((s - (inst.start - inst.fadeIn)) / inst.fadeIn);
      }
      if (s > inst.end && s < inst.end + inst.fadeOut) {
        return 1 - smootherstep((s - inst.end) / inst.fadeOut);
      }
      return 0;
    }

    function updateScrollProgress() {
      const docH = (document.documentElement.scrollHeight || document.body.scrollHeight) - window.innerHeight;
      if (docH <= 0) {
        scrollProgress = 0;
        return;
      }
      const y = window.scrollY || window.pageYOffset || 0;
      scrollProgress = Math.max(0, Math.min(1, y / docH));
    }

    // ---------- Instance pool ----------
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
    }

    function buildInstances() {
      instances = [];
      for (let i = 0; i < atoms.length; i++) atoms[i].owner = null;
      const area = width * height;
      // Number of instances scales with viewport area.
      const targetInstances = Math.max(4, Math.min(10, Math.floor(area / 260000)));

      // Pre-sample K per builder type.
      const Ks = builders.map((b) => b(1).points.length);

      // Build a roughly-even mix of types in a random order so we don't
      // always start with the same one.
      const typeOrder = [];
      for (let i = 0; i < targetInstances; i++) typeOrder.push(i % builders.length);
      shuffle(typeOrder);

      // Stratified scroll start positions, then shuffled and jittered, so
      // every scroll position has a mix of fading-in / stable / fading-out
      // instances rather than a single global step.
      const startSlots = [];
      for (let i = 0; i < targetInstances; i++) {
        startSlots.push(-0.18 + (i / targetInstances) * 1.10);
      }
      shuffle(startSlots);

      const baseScale = Math.max(46, Math.min(110, Math.min(width, height) * 0.105));
      let totalK = 0;
      const maxK = atoms.length; // hard cap: don't claim more atoms than exist

      for (let i = 0; i < targetInstances; i++) {
        const typeIdx = typeOrder[i];
        const buildFn = builders[typeIdx];
        const k = Ks[typeIdx];
        if (totalK + k > maxK) continue;

        const scale = baseScale * (0.55 + Math.random() * 0.95); // ~0.55x to 1.5x
        const rot = Math.random() * Math.PI * 2;
        const built = buildFn(scale);

        // Bounding circle for non-overlap placement.
        const bbox = getBBox(built.points);
        const bbW = bbox.maxX - bbox.minX;
        const bbH = bbox.maxY - bbox.minY;
        const bbRadius = Math.hypot(bbW, bbH) / 2;

        // Try to place at random position without overlapping existing
        // instances. If no spot found after several tries, skip this one.
        let x = 0, y = 0, placed = false;
        const margin = bbRadius * 0.7;
        const xRange = Math.max(1, width - 2 * margin);
        const yRange = Math.max(1, height - 2 * margin);
        for (let tries = 0; tries < 80; tries++) {
          x = margin + Math.random() * xRange;
          y = margin + Math.random() * yRange;
          let ok = true;
          for (let q = 0; q < instances.length; q++) {
            const other = instances[q];
            const minDist = (bbRadius + other.bbRadius) * 1.05;
            const dx = x - other.x;
            const dy = y - other.y;
            if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
          }
          if (ok) { placed = true; break; }
        }
        if (!placed) continue;

        // Longer fades + shorter plateaus produce slower, smoother forming
        // and unforming as the user scrolls past each instance.
        const duration = 0.16 + Math.random() * 0.16;          // 16-32% plateau
        const start = startSlots[i] + (Math.random() - 0.5) * 0.08;
        const fadeIn = 0.10 + Math.random() * 0.08;            // 10-18% smooth fade
        const fadeOut = 0.10 + Math.random() * 0.08;

        const newInst = {
          x, y, rot, bbRadius,
          points: built.points,
          bonds: built.bonds,
          atomStart: totalK,
          atomCount: k,
          start,
          end: start + duration,
          fadeIn, fadeOut,
          _w: 0,
        };
        instances.push(newInst);
        for (let q = 0; q < k; q++) {
          const aIdx = totalK + q;
          if (aIdx < atoms.length) atoms[aIdx].owner = newInst;
        }
        totalK += k;
      }
    }

    // ---------- Frame ----------
    function step() {
      if (!running) return;
      updateScrollProgress();
      ctx.clearRect(0, 0, width, height);

      // 1) Compute each instance's current weight once per frame.
      //    Cache cos/sin so atom step doesn't recompute them per atom.
      for (let k = 0; k < instances.length; k++) {
        const inst = instances[k];
        inst._w = instanceWeight(scrollProgress, inst);
        inst._cosR = Math.cos(inst.rot);
        inst._sinR = Math.sin(inst.rot);
      }

      // 2) Update atoms with frame-rate-paced smooth pull (not scroll-paced
      //    instant lerp). This makes motion feel like a continuous gather /
      //    release rather than a snap, even when the user scrolls quickly.
      //    During engagement, free drift is dampened by (1 - w) so atoms
      //    don't jitter while sitting at a formation slot.
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        const owner = a.owner;
        let eng = 0;
        if (owner && owner._w > 0.001) {
          const w = owner._w;
          eng = w;
          const slotIdx = i - owner.atomStart;
          const pt = owner.points[slotIdx];
          const tx = owner.x + (pt[0] * owner._cosR - pt[1] * owner._sinR);
          const ty = owner.y + (pt[0] * owner._sinR + pt[1] * owner._cosR);
          // Pull strength caps at ~0.09/frame, so atoms fully gather in
          // ~30 frames (~0.5 s at 60 fps) regardless of how fast the user
          // scrolls past the activation window.
          const pull = w * 0.09;
          a.x += (tx - a.x) * pull;
          a.y += (ty - a.y) * pull;
          if (!reducedMotion) {
            const driftFrac = 1 - w;
            a.x += a.vx * driftFrac;
            a.y += a.vy * driftFrac;
          }
        } else if (!reducedMotion) {
          a.x += a.vx;
          a.y += a.vy;
        }
        // Only wrap when not strongly engaged, so a wrap can't teleport an
        // atom mid-formation.
        if (eng < 0.4) {
          if (a.x < -20) a.x = width + 20;
          if (a.x > width + 20) a.x = -20;
          if (a.y < -20) a.y = height + 20;
          if (a.y > height + 20) a.y = -20;
        }
        a.rx = a.x;
        a.ry = a.y;
        a.engaged = eng;
      }

      // 3) Ambient proximity-bond network (skip heavily engaged atoms so
      //    formations read cleanly).
      const maxDist = Math.min(180, Math.max(110, width / 9));
      const maxDistSq = maxDist * maxDist;
      ctx.lineWidth = 1;
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        if (a.engaged > 0.55) continue;
        for (let j = i + 1; j < atoms.length; j++) {
          const b = atoms[j];
          if (b.engaged > 0.55) continue;
          const dx = a.rx - b.rx;
          const dy = a.ry - b.ry;
          const d2 = dx * dx + dy * dy;
          if (d2 < maxDistSq) {
            const fade = 1 - Math.max(a.engaged, b.engaged) * 1.7;
            if (fade <= 0) continue;
            const alpha = (1 - d2 / maxDistSq) * fade;
            ctx.strokeStyle = `rgba(200, 204, 210, ${0.13 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.rx, a.ry);
            ctx.lineTo(b.rx, b.ry);
            ctx.stroke();
          }
        }
      }

      // 4) Bonds for every active instance.
      for (let k = 0; k < instances.length; k++) {
        const inst = instances[k];
        const w = inst._w || 0;
        if (w <= 0.005) continue;
        drawInstanceBonds(inst, w);
      }

      // 5) Atoms.
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        const eng = a.engaged;
        const drawR = a.r * (1 + eng * 0.4);

        if (eng > 0.05) {
          ctx.globalAlpha = 0.20 * eng;
          ctx.fillStyle = '#e8eaf0';
          ctx.beginPath();
          ctx.arc(a.rx, a.ry, drawR * 3.6, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = eng > 0.2 ? '#e8eaf0' : a.c;
        ctx.beginPath();
        ctx.arc(a.rx, a.ry, drawR, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.16 * (1 + eng * 0.55);
        ctx.fillStyle = eng > 0.2 ? '#e8eaf0' : a.c;
        ctx.beginPath();
        ctx.arc(a.rx, a.ry, drawR * 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      requestAnimationFrame(step);
    }

    function drawInstanceBonds(inst, weight) {
      const alpha = Math.pow(weight, 1.3) * 0.55;
      ctx.strokeStyle = `rgba(232, 234, 240, ${alpha})`;
      ctx.lineWidth = 1;
      for (let bi = 0; bi < inst.bonds.length; bi++) {
        const bond = inst.bonds[bi];
        const iSlot = bond[0];
        const jSlot = bond[1];
        const order = bond[2];
        const aIdx = inst.atomStart + iSlot;
        const bIdx = inst.atomStart + jSlot;
        if (aIdx >= atoms.length || bIdx >= atoms.length) continue;
        const a = atoms[aIdx];
        const b = atoms[bIdx];
        const dx = b.rx - a.rx;
        const dy = b.ry - a.ry;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;

        const inset = 2.5;
        const ax = a.rx + ux * inset;
        const ay = a.ry + uy * inset;
        const bx = b.rx - ux * inset;
        const by = b.ry - uy * inset;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();

        if (order >= 2) {
          const sep = 3.2;
          const trim = 0.18;
          const usable = Math.max(0, len - 2 * inset);
          const ax2 = ax + ux * usable * trim + nx * sep;
          const ay2 = ay + uy * usable * trim + ny * sep;
          const bx2 = bx - ux * usable * trim + nx * sep;
          const by2 = by - uy * usable * trim + ny * sep;
          ctx.beginPath();
          ctx.moveTo(ax2, ay2);
          ctx.lineTo(bx2, by2);
          ctx.stroke();
        }
      }
    }

    size();
    makeAtoms();
    buildInstances();
    updateScrollProgress();
    requestAnimationFrame(step);

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        size();
        makeAtoms();
        buildInstances();
        updateScrollProgress();
      }, 150);
    });

    window.addEventListener('scroll', updateScrollProgress, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        running = false;
      } else {
        running = true;
        requestAnimationFrame(step);
      }
    });
  }

  // ---------- Scroll reveal ----------
  function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window) || reducedMotion) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
  }

  // ---------- Mobile nav toggle ----------
  function initMobileNav() {
    const btn = document.getElementById('nav-toggle');
    const menu = document.getElementById('nav-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => {
      const isHidden = menu.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', String(!isHidden));
    });
  }

  // ---------- Year stamp ----------
  function initYear() {
    const y = document.getElementById('year');
    if (y) y.textContent = new Date().getFullYear();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initMoleculeBackground();
    initReveal();
    initMobileNav();
    initYear();
  });
})();
