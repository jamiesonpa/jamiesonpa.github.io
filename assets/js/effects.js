/* =========================================================
   Pierce Jamieson, Ph.D. - site effects
   - Animated atom + bond background
   - Scroll reveal observer
   - Mobile nav toggle
   - Year stamp
   ========================================================= */

(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Atom + bond background ----------
  function initMoleculeBackground() {
    const canvas = document.getElementById('molecule-bg');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let atoms = [];
    let running = true;

    // Monochrome palette: dim grey -> off-white (no blue).
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
      const target = Math.max(28, Math.min(72, Math.floor(area / 22000)));
      atoms = new Array(target).fill(0).map(() => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 1.2 + Math.random() * 1.8,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
      }));
    }

    function step() {
      if (!running) return;
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < -20) a.x = width + 20;
        if (a.x > width + 20) a.x = -20;
        if (a.y < -20) a.y = height + 20;
        if (a.y > height + 20) a.y = -20;
      }

      // Bonds (lines between near neighbors)
      const maxDist = Math.min(180, Math.max(110, width / 9));
      const maxDistSq = maxDist * maxDist;
      ctx.lineWidth = 1;
      for (let i = 0; i < atoms.length; i++) {
        for (let j = i + 1; j < atoms.length; j++) {
          const a = atoms[i];
          const b = atoms[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < maxDistSq) {
            const alpha = 1 - d2 / maxDistSq;
            ctx.strokeStyle = `rgba(200, 204, 210, ${0.13 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Atoms
      for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        ctx.fillStyle = a.c;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      requestAnimationFrame(step);
    }

    size();
    makeAtoms();
    if (!reducedMotion) requestAnimationFrame(step);
    else {
      // Draw a single static frame so the background still has presence.
      step();
      running = false;
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        size();
        makeAtoms();
      }, 150);
    });

    // Pause when tab hidden to save battery
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        running = false;
      } else if (!reducedMotion) {
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
