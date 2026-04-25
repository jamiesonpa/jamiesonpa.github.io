// Lightweight, dependency-free violin plot for the per-ship damage modifier
// distribution of a fleet. One instance per fleet (green / red).
//
// Design:
//   - Vertical violin: y-axis = damage modifier, x-axis = density (mirrored).
//   - Filled SVG <path> for the kernel-density shape (Gaussian KDE,
//     Silverman's rule for bandwidth, sane floor so it doesn't degenerate
//     when the surviving fleet is small or all-equal).
//   - One persistent <circle> per ship (built once on rebuild). Dead ships
//     are hidden via opacity, not removed, so we never touch the DOM in the
//     hot per-frame update path beyond attribute writes.
//   - The violin shape is normalised per fleet (max KDE -> max half-width)
//     so shape comparisons stay readable as a fleet shrinks. Y-axis scale
//     is set externally by the caller so both fleets can share an axis.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const k in attrs) el.setAttribute(k, attrs[k]);
  }
  return el;
}

// 0xRRGGBB integer -> "#rrggbb"
function hexFromInt(n) {
  return "#" + n.toString(16).padStart(6, "0");
}

const DEFAULTS = {
  width: 184,
  height: 120,
  // Left margin must be wide enough that the rotated "dmg mod" label
  // (centered at x=8, roughly 9px wide after -90 rotation) doesn't collide
  // with the right-anchored Y-axis tick numbers (rendered at marginLeft - 5).
  // For typical 4-char ticks like "10.0" (~16px), 34 keeps a few px of gap.
  marginLeft: 34,
  marginRight: 6,
  marginTop: 6,
  marginBottom: 16,
  axisColor: "rgba(170, 200, 230, 0.4)",
  textColor: "rgba(220, 230, 245, 0.7)",
  gridSamples: 80, // KDE grid resolution along y; 80 is plenty for 50 dots.
  dotRadius: 1.6,
  jitterPx: 6, // total horizontal jitter band for dots (centered on axis)
};

export class ViolinPlot {
  constructor(container, options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.colorHex =
      typeof options.color === "number" ? hexFromInt(options.color) : options.color || "#7af";
    this.yMax = options.yMax ?? 5;

    const o = this.opts;
    this.plotW = o.width - o.marginLeft - o.marginRight;
    this.plotH = o.height - o.marginTop - o.marginBottom;
    this.centerX = o.marginLeft + this.plotW / 2;

    this.svg = svgEl("svg", {
      viewBox: `0 0 ${o.width} ${o.height}`,
      class: "violin-svg",
      preserveAspectRatio: "xMidYMid meet",
    });
    container.appendChild(this.svg);

    this._buildAxis();

    this.violinPath = svgEl("path", {
      fill: this.colorHex,
      "fill-opacity": "0.32",
      stroke: this.colorHex,
      "stroke-width": "1",
      "stroke-opacity": "0.9",
      "stroke-linejoin": "round",
    });
    this.svg.appendChild(this.violinPath);

    // Median tick: short horizontal line across the violin centerline.
    this.medianLine = svgEl("line", {
      stroke: this.colorHex,
      "stroke-width": "1.5",
      "stroke-opacity": "0",
    });
    this.svg.appendChild(this.medianLine);

    this.dotsGroup = svgEl("g", {});
    this.svg.appendChild(this.dotsGroup);
    this.dots = []; // [{ circle, ship }]

    // Status text (count of alive ships) bottom-right of plot area.
    this.countText = svgEl("text", {
      x: o.width - o.marginRight,
      y: o.height - 4,
      fill: o.textColor,
      "font-size": "9",
      "text-anchor": "end",
    });
    this.countText.textContent = "";
    this.svg.appendChild(this.countText);
  }

  _buildAxis() {
    const o = this.opts;
    const axis = svgEl("line", {
      x1: o.marginLeft,
      x2: o.marginLeft,
      y1: o.marginTop,
      y2: o.marginTop + this.plotH,
      stroke: o.axisColor,
      "stroke-width": "1",
    });
    this.svg.appendChild(axis);

    this.tickGroup = svgEl("g", {});
    this.svg.appendChild(this.tickGroup);

    // Y-axis title rotated up the left edge.
    const labelY = o.marginTop + this.plotH / 2;
    const label = svgEl("text", {
      x: 8,
      y: labelY,
      fill: o.textColor,
      "font-size": "9",
      "text-anchor": "middle",
      transform: `rotate(-90, 8, ${labelY})`,
    });
    label.textContent = "dmg mod";
    this.svg.appendChild(label);

    this._renderTicks();
  }

  _renderTicks() {
    while (this.tickGroup.firstChild) {
      this.tickGroup.removeChild(this.tickGroup.firstChild);
    }
    const o = this.opts;
    const ticks = [0, this.yMax * 0.5, this.yMax];
    for (const t of ticks) {
      const y = this._yToPx(t);
      this.tickGroup.appendChild(
        svgEl("line", {
          x1: o.marginLeft - 3,
          x2: o.marginLeft,
          y1: y,
          y2: y,
          stroke: o.axisColor,
        })
      );
      const txt = svgEl("text", {
        x: o.marginLeft - 5,
        y: y + 3,
        fill: o.textColor,
        "font-size": "8",
        "text-anchor": "end",
      });
      txt.textContent = t.toFixed(1);
      this.tickGroup.appendChild(txt);
    }
  }

  _yToPx(yVal) {
    const o = this.opts;
    const t = Math.min(1, Math.max(0, yVal / this.yMax));
    return o.marginTop + this.plotH * (1 - t);
  }

  setYMax(yMax) {
    this.yMax = Math.max(yMax, 0.001);
    this._renderTicks();
    for (const d of this.dots) {
      d.circle.setAttribute("cy", this._yToPx(d.ship.damageModifier));
    }
  }

  // Build one persistent dot per ship. Jitter is deterministic per ship so
  // dots don't dance around between updates.
  rebuild(ships) {
    while (this.dotsGroup.firstChild) {
      this.dotsGroup.removeChild(this.dotsGroup.firstChild);
    }
    this.dots = [];
    const j = this.opts.jitterPx;
    for (const s of ships) {
      const r = (Math.sin(s.id * 73.13 + 1.7) + 1) / 2; // 0..1, deterministic
      const cx = this.centerX + (r - 0.5) * j;
      const cy = this._yToPx(s.damageModifier);
      const circle = svgEl("circle", {
        cx,
        cy,
        r: this.opts.dotRadius,
        fill: this.colorHex,
        "fill-opacity": "0.85",
        stroke: "rgba(0,0,0,0.35)",
        "stroke-width": "0.4",
      });
      this.dotsGroup.appendChild(circle);
      this.dots.push({ circle, ship: s });
    }
  }

  // Update violin shape, dot visibility, median tick, and count text.
  // `aliveShips` should be the subset of the ships passed to rebuild() that
  // are currently alive.
  update(aliveShips) {
    const aliveIds = new Set();
    for (const s of aliveShips) aliveIds.add(s.id);
    for (const d of this.dots) {
      d.circle.style.opacity = aliveIds.has(d.ship.id) ? "0.85" : "0";
    }

    this.countText.textContent = `n=${aliveShips.length}`;

    if (aliveShips.length < 2) {
      this.violinPath.setAttribute("d", "");
      this.medianLine.setAttribute("stroke-opacity", "0");
      return;
    }

    const values = aliveShips.map((s) => s.damageModifier);

    let mean = 0;
    for (const v of values) mean += v;
    mean /= values.length;
    let varSum = 0;
    for (const v of values) varSum += (v - mean) * (v - mean);
    const std = Math.sqrt(varSum / values.length);
    // Silverman's rule with a floor so a tightly-clustered surviving group
    // (or sigma=0 fleet) still gets a visible blob instead of a delta spike.
    const h = Math.max(0.05, 0.9 * std * Math.pow(values.length, -0.2));

    const o = this.opts;
    const N = o.gridSamples;
    const densities = new Float64Array(N);
    let maxD = 0;
    for (let i = 0; i < N; i++) {
      const y = (i / (N - 1)) * this.yMax;
      let s = 0;
      for (const v of values) {
        const u = (y - v) / h;
        s += Math.exp(-0.5 * u * u);
      }
      densities[i] = s;
      if (s > maxD) maxD = s;
    }
    if (maxD <= 0) {
      this.violinPath.setAttribute("d", "");
      this.medianLine.setAttribute("stroke-opacity", "0");
      return;
    }

    const halfW = this.plotW / 2 - 4;

    // Up the right side, then back down the left side, closed.
    const parts = [];
    for (let i = 0; i < N; i++) {
      const y = (i / (N - 1)) * this.yMax;
      const w = (densities[i] / maxD) * halfW;
      parts.push((i === 0 ? "M" : "L") + (this.centerX + w).toFixed(2) + "," + this._yToPx(y).toFixed(2));
    }
    for (let i = N - 1; i >= 0; i--) {
      const y = (i / (N - 1)) * this.yMax;
      const w = (densities[i] / maxD) * halfW;
      parts.push("L" + (this.centerX - w).toFixed(2) + "," + this._yToPx(y).toFixed(2));
    }
    parts.push("Z");
    this.violinPath.setAttribute("d", parts.join(""));

    // Median tick.
    const sorted = values.slice().sort((a, b) => a - b);
    const m =
      sorted.length % 2
        ? sorted[(sorted.length - 1) >> 1]
        : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
    const my = this._yToPx(m);
    this.medianLine.setAttribute("x1", (this.centerX - halfW * 0.6).toFixed(2));
    this.medianLine.setAttribute("x2", (this.centerX + halfW * 0.6).toFixed(2));
    this.medianLine.setAttribute("y1", my.toFixed(2));
    this.medianLine.setAttribute("y2", my.toFixed(2));
    this.medianLine.setAttribute("stroke-opacity", "0.85");
  }
}
