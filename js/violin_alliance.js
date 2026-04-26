// Pure-SVG renderer for the per-alliance damage violin used by analyzer.html.
// Mirrors `make_damage_violin` in the local battle_analyzer.py:
//   - one violin per alliance (Gaussian KDE, Silverman bandwidth with floor)
//   - black dot survivors, red x killed, deterministic horizontal jitter
//   - dotted green line at survivor-only mean
//   - dotted limegreen at mean + 1.4*std (all pilots)
//   - dotted red at mean - 1.4*std (all pilots)
//   - inline right-edge tags ("HIGH PERFORMING ELITE F1 PRESSERS" /
//     "SEVERE COGNITIVE DYSFUNCTION")
//   - outlier name labels with leader lines, stacked in per-violin gutters

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Deterministic 0..1 hash from a string. Used to place per-pilot jitter so a
// re-render of the same battle keeps each pilot in the same spot.
function hash01(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

// Inclusive "nice" upper-bound and tick-step picker for a y-axis whose
// domain is [0, dataMax]. Targets ~5-7 ticks. Returns { yMax, step }.
function niceAxis(dataMax) {
  if (!isFinite(dataMax) || dataMax <= 0) return { yMax: 1, step: 0.2 };
  const target = 6;
  const rawStep = dataMax / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow;
  let stepMul;
  if (norm < 1.5) stepMul = 1;
  else if (norm < 3.5) stepMul = 2;
  else if (norm < 7.5) stepMul = 5;
  else stepMul = 10;
  const step = stepMul * pow;
  const yMax = Math.ceil(dataMax / step) * step;
  return { yMax, step };
}

function fmtCommas(n) {
  if (!isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  return sign + Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Palette matches matplotlib default cycle (tab:blue, tab:orange, ...) so
// the chart reads like the python output at a glance.
const VIOLIN_COLORS = [
  "#4C78A8",
  "#F58518",
  "#54A24B",
  "#E45756",
  "#B279A2",
  "#9D755D",
  "#EECA3B",
  "#72B7B2",
  "#FF9DA6",
  "#79706E",
];

// Compute KDE densities over an evenly-spaced y-grid from 0..yMax. Silverman
// bandwidth with a floor so a tightly-clustered group doesn't spike to a
// pixel-thin needle.
function kde(values, yMax, gridSamples = 96) {
  const N = gridSamples;
  const out = new Float64Array(N);
  if (values.length === 0) return { ys: [], densities: out, maxD: 0 };

  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let varSum = 0;
  for (const v of values) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / Math.max(1, values.length));
  const h = Math.max(yMax * 0.005, 0.9 * std * Math.pow(values.length, -0.2));

  let maxD = 0;
  const ys = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const y = (i / (N - 1)) * yMax;
    ys[i] = y;
    let s = 0;
    for (const v of values) {
      const u = (y - v) / h;
      s += Math.exp(-0.5 * u * u);
    }
    out[i] = s;
    if (s > maxD) maxD = s;
  }
  return { ys, densities: out, maxD };
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/**
 * Render the violin plot.
 *
 * @param {HTMLElement} container - element to (re)populate with the SVG.
 * @param {object} opts
 * @param {Array<{name: string, members: Array<{name: string, damage: number, killed: boolean}>}>} opts.groups
 *        Pre-ordered alliance groups (caller controls order; we just draw
 *        them left-to-right).
 * @param {string} opts.title - chart title.
 * @returns {SVGSVGElement} the SVG element written into `container`.
 */
export function renderAllianceViolin(container, opts) {
  while (container.firstChild) container.removeChild(container.firstChild);

  const groups = opts.groups || [];
  const title = opts.title || "Damage Distribution by Alliance";

  // Flatten everyone for global stats.
  const allDamages = [];
  const survivorDamages = [];
  for (const g of groups) {
    for (const m of g.members) {
      allDamages.push(m.damage);
      if (!m.killed) survivorDamages.push(m.damage);
    }
  }

  const meanAll =
    allDamages.length > 0
      ? allDamages.reduce((a, b) => a + b, 0) / allDamages.length
      : 0;
  let stdAll = 0;
  if (allDamages.length > 1) {
    let varSum = 0;
    for (const v of allDamages) varSum += (v - meanAll) * (v - meanAll);
    stdAll = Math.sqrt(varSum / allDamages.length);
  }
  const hiThresh = allDamages.length > 1 ? meanAll + 1.4 * stdAll : null;
  const loThresh = allDamages.length > 1 ? meanAll - 1.4 * stdAll : null;
  const survivorMean =
    survivorDamages.length > 0
      ? survivorDamages.reduce((a, b) => a + b, 0) / survivorDamages.length
      : null;

  // Y-axis domain: cover all data plus a little headroom so the upper
  // threshold tag never floats outside the plot.
  const dataMax = allDamages.length ? Math.max(...allDamages) : 1;
  const upperCandidate = hiThresh != null ? Math.max(dataMax, hiThresh) : dataMax;
  const { yMax, step } = niceAxis(upperCandidate * 1.08);

  // Layout (in SVG user units; viewBox keeps it scalable). Right margin is
  // intentionally wide to host the right-edge threshold tags AND the
  // outlier-name gutters of the rightmost violin.
  const W = Math.max(900, 140 + groups.length * 140 + 320);
  const H = 620;
  const M = { left: 88, right: 320, top: 60, bottom: 90 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const svg = svgEl("svg", {
    xmlns: SVG_NS,
    viewBox: `0 0 ${W} ${H}`,
    class: "alliance-violin-svg",
    preserveAspectRatio: "xMidYMid meet",
  });
  container.appendChild(svg);

  // X positions: group i goes at left + (i + 0.5) / N * plotW
  const N = groups.length || 1;
  const xCenter = (i) => M.left + ((i + 0.5) / N) * plotW;
  const xSlotW = plotW / N;
  const violinHalfW = Math.min(xSlotW * 0.42, 70);

  const yToPx = (yVal) => {
    const t = Math.min(1, Math.max(0, yVal / yMax));
    return M.top + plotH * (1 - t);
  };

  // --- Title ----------------------------------------------------------------
  const titleEl = svgEl("text", {
    x: M.left,
    y: 28,
    fill: "#e6ecf6",
    "font-size": "16",
    "font-weight": "600",
  });
  titleEl.textContent = title;
  svg.appendChild(titleEl);

  // --- Axes -----------------------------------------------------------------
  const axisColor = "rgba(170, 200, 230, 0.4)";
  const axisText = "rgba(220, 230, 245, 0.85)";

  // Plot border (light box).
  svg.appendChild(
    svgEl("rect", {
      x: M.left,
      y: M.top,
      width: plotW,
      height: plotH,
      fill: "none",
      stroke: "rgba(170, 200, 230, 0.15)",
      "stroke-width": "1",
    })
  );

  // Y-axis ticks + horizontal grid.
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const y = yToPx(v);
    svg.appendChild(
      svgEl("line", {
        x1: M.left,
        x2: M.left + plotW,
        y1: y,
        y2: y,
        stroke: axisColor,
        "stroke-width": "1",
        "stroke-dasharray": "3 4",
        opacity: "0.35",
      })
    );
    svg.appendChild(
      svgEl("line", {
        x1: M.left - 5,
        x2: M.left,
        y1: y,
        y2: y,
        stroke: axisColor,
      })
    );
    const tx = svgEl("text", {
      x: M.left - 8,
      y: y + 4,
      fill: axisText,
      "font-size": "11",
      "text-anchor": "end",
    });
    tx.textContent = fmtCommas(v);
    svg.appendChild(tx);
  }

  // Y-axis label.
  const yLabelX = 22;
  const yLabelY = M.top + plotH / 2;
  const yLabel = svgEl("text", {
    x: yLabelX,
    y: yLabelY,
    fill: axisText,
    "font-size": "12",
    "text-anchor": "middle",
    transform: `rotate(-90, ${yLabelX}, ${yLabelY})`,
  });
  yLabel.textContent = "damage";
  svg.appendChild(yLabel);

  // X-axis baseline.
  svg.appendChild(
    svgEl("line", {
      x1: M.left,
      x2: M.left + plotW,
      y1: M.top + plotH,
      y2: M.top + plotH,
      stroke: axisColor,
      "stroke-width": "1.2",
    })
  );

  // X-axis tick labels (rotated).
  for (let i = 0; i < groups.length; i++) {
    const cx = xCenter(i);
    const ty = M.top + plotH + 12;
    const t = svgEl("text", {
      x: cx,
      y: ty,
      fill: axisText,
      "font-size": "12",
      "text-anchor": "end",
      transform: `rotate(-30, ${cx}, ${ty})`,
    });
    t.textContent = groups[i].name;
    svg.appendChild(t);
  }

  // --- Violins + median ticks ----------------------------------------------
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const color = VIOLIN_COLORS[i % VIOLIN_COLORS.length];
    const cx = xCenter(i);
    const damages = g.members.map((m) => m.damage);

    if (damages.length >= 2 && new Set(damages).size >= 2) {
      const { densities, maxD } = kde(damages, yMax);
      if (maxD > 0) {
        const parts = [];
        const Ns = densities.length;
        for (let k = 0; k < Ns; k++) {
          const y = (k / (Ns - 1)) * yMax;
          const w = (densities[k] / maxD) * violinHalfW;
          parts.push(
            (k === 0 ? "M" : "L") +
              (cx + w).toFixed(2) +
              "," +
              yToPx(y).toFixed(2)
          );
        }
        for (let k = Ns - 1; k >= 0; k--) {
          const y = (k / (Ns - 1)) * yMax;
          const w = (densities[k] / maxD) * violinHalfW;
          parts.push(
            "L" +
              (cx - w).toFixed(2) +
              "," +
              yToPx(y).toFixed(2)
          );
        }
        parts.push("Z");
        svg.appendChild(
          svgEl("path", {
            d: parts.join(""),
            fill: color,
            "fill-opacity": "0.30",
            stroke: color,
            "stroke-width": "1",
            "stroke-opacity": "0.95",
            "stroke-linejoin": "round",
          })
        );
      }
    }

    // Min/max whiskers + median tick (only meaningful when there are points).
    if (damages.length > 0) {
      const lo = Math.min(...damages);
      const hi = Math.max(...damages);
      svg.appendChild(
        svgEl("line", {
          x1: cx,
          x2: cx,
          y1: yToPx(lo),
          y2: yToPx(hi),
          stroke: color,
          "stroke-width": "1",
          "stroke-opacity": "0.55",
        })
      );
      const med = median(damages);
      svg.appendChild(
        svgEl("line", {
          x1: cx - violinHalfW * 0.55,
          x2: cx + violinHalfW * 0.55,
          y1: yToPx(med),
          y2: yToPx(med),
          stroke: color,
          "stroke-width": "1.5",
          "stroke-opacity": "0.95",
        })
      );
    }
  }

  // --- Threshold + survivor-mean lines (with right-edge inline tags) -------
  const lineXEnd = M.left + plotW;
  function thresholdLine(yVal, color, tagText) {
    const y = yToPx(yVal);
    svg.appendChild(
      svgEl("line", {
        x1: M.left,
        x2: lineXEnd,
        y1: y,
        y2: y,
        stroke: color,
        "stroke-width": "2",
        "stroke-dasharray": "2 4",
        opacity: "0.95",
      })
    );
    if (tagText) {
      const t = svgEl("text", {
        x: lineXEnd + 6,
        y: y + 4,
        fill: color,
        "font-size": "11",
        "font-weight": "700",
      });
      t.textContent = tagText;
      svg.appendChild(t);
    }
  }
  if (survivorMean != null) {
    thresholdLine(survivorMean, "#3aa64a", null);
  }
  if (hiThresh != null) {
    thresholdLine(hiThresh, "#3ddd55", "HIGH PERFORMING ELITE F1 PRESSERS");
  }
  if (loThresh != null) {
    thresholdLine(loThresh, "#e04848", "SEVERE COGNITIVE DYSFUNCTION");
  }

  // --- Per-pilot dots ------------------------------------------------------
  // Capture each survivor's plotted (cx, cy, name, group_idx) so the
  // outlier-annotation pass can leader-line back to the exact dot.
  const survivorPoints = []; // { cx, cy, name, groupIdx, dmg }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const cx = xCenter(i);
    for (const m of g.members) {
      const r = hash01(m.name + "|" + g.name);
      const jx = cx + (r - 0.5) * Math.min(violinHalfW * 0.5, 22);
      const jy = yToPx(m.damage);
      if (m.killed) {
        const sz = 6;
        const path = svgEl("path", {
          d: `M${(jx - sz).toFixed(2)},${(jy - sz).toFixed(2)} L${(jx + sz).toFixed(2)},${(jy + sz).toFixed(2)} M${(jx + sz).toFixed(2)},${(jy - sz).toFixed(2)} L${(jx - sz).toFixed(2)},${(jy + sz).toFixed(2)}`,
          stroke: "#ff4d4d",
          "stroke-width": "1.8",
          fill: "none",
        });
        svg.appendChild(path);
      } else {
        const c = svgEl("circle", {
          cx: jx,
          cy: jy,
          r: 2.6,
          fill: "#0f1218",
          stroke: "#cdd6e6",
          "stroke-width": "0.6",
        });
        svg.appendChild(c);
        survivorPoints.push({
          cx: jx,
          cy: jy,
          name: m.name,
          groupIdx: i,
          dmg: m.damage,
        });
      }
    }
  }

  // --- Outlier annotations (survivors only, like the matplotlib version) --
  if (hiThresh != null && loThresh != null && survivorPoints.length) {
    const upperByGroup = new Map(); // groupIdx -> [{ ... }]
    const lowerByGroup = new Map();
    for (const p of survivorPoints) {
      if (!p.name) continue;
      if (p.dmg > hiThresh) {
        if (!upperByGroup.has(p.groupIdx)) upperByGroup.set(p.groupIdx, []);
        upperByGroup.get(p.groupIdx).push(p);
      } else if (p.dmg < loThresh) {
        if (!lowerByGroup.has(p.groupIdx)) lowerByGroup.set(p.groupIdx, []);
        lowerByGroup.get(p.groupIdx).push(p);
      }
    }

    // Step in *pixels* between stacked labels. 14px ~= readable label height.
    const labelStepPx = 14;
    const gutterDx = violinHalfW + 8; // px to the right of the violin centerline

    function annotateStack(items, direction) {
      // direction = +1 means stack downward (lower gutter), -1 means upward.
      // We sort so labels stack toward more-extreme values:
      //   upper: low->high, walk upward (text_y decreases on screen)
      //   lower: high->low, walk downward (text_y increases on screen)
      if (direction === -1) items.sort((a, b) => a.dmg - b.dmg);
      else items.sort((a, b) => b.dmg - a.dmg);

      let prevY = direction === -1 ? Infinity : -Infinity;
      for (const p of items) {
        let textY = p.cy;
        if (direction === -1) {
          // Upper: each label needs to be at least labelStepPx ABOVE prev.
          if (textY > prevY - labelStepPx) textY = prevY - labelStepPx;
          prevY = textY;
        } else {
          // Lower: each label needs to be at least labelStepPx BELOW prev.
          if (textY < prevY + labelStepPx) textY = prevY + labelStepPx;
          prevY = textY;
        }
        const tx = xCenter(p.groupIdx) + gutterDx;
        // Leader line: dot -> label anchor.
        svg.appendChild(
          svgEl("line", {
            x1: p.cx,
            y1: p.cy,
            x2: tx - 2,
            y2: textY,
            stroke: "rgba(180, 195, 215, 0.55)",
            "stroke-width": "0.6",
          })
        );
        const t = svgEl("text", {
          x: tx,
          y: textY + 3,
          fill: "#e6ecf6",
          "font-size": "10",
          "text-anchor": "start",
        });
        t.textContent = p.name;
        svg.appendChild(t);
      }
    }

    for (const [, items] of upperByGroup) annotateStack(items, -1);
    for (const [, items] of lowerByGroup) annotateStack(items, +1);
  }

  // --- Legend (top-right, outside the plot area) ---------------------------
  const legendX = M.left + plotW + 10;
  let legendY = M.top + 4;
  const legendLineHeight = 18;

  function legendDot(color, kind) {
    if (kind === "x") {
      const sz = 5;
      svg.appendChild(
        svgEl("path", {
          d: `M${legendX - sz},${legendY - 4 - sz} L${legendX + sz},${legendY - 4 + sz} M${legendX + sz},${legendY - 4 - sz} L${legendX - sz},${legendY - 4 + sz}`,
          stroke: color,
          "stroke-width": "1.8",
          fill: "none",
        })
      );
    } else {
      svg.appendChild(
        svgEl("circle", {
          cx: legendX,
          cy: legendY - 4,
          r: 3,
          fill: color,
        })
      );
    }
  }

  function legendLine(color) {
    svg.appendChild(
      svgEl("line", {
        x1: legendX - 9,
        x2: legendX + 9,
        y1: legendY - 4,
        y2: legendY - 4,
        stroke: color,
        "stroke-width": "2",
        "stroke-dasharray": "2 3",
      })
    );
  }

  function legendText(text, color) {
    const t = svgEl("text", {
      x: legendX + 14,
      y: legendY,
      fill: color || axisText,
      "font-size": "11",
    });
    t.textContent = text;
    svg.appendChild(t);
  }

  legendDot("#0f1218", "circle");
  legendText("survived");
  legendY += legendLineHeight;

  legendDot("#ff4d4d", "x");
  legendText("killed");
  legendY += legendLineHeight + 4;

  if (survivorMean != null) {
    legendLine("#3aa64a");
    legendText(`mean damage (survivors only) = ${fmtCommas(survivorMean)}`);
    legendY += legendLineHeight;
  }
  if (hiThresh != null) {
    legendLine("#3ddd55");
    legendText(`mean + 1.4σ (all) = ${fmtCommas(hiThresh)}`);
    legendY += legendLineHeight;
  }
  if (loThresh != null) {
    legendLine("#e04848");
    legendText(`mean − 1.4σ (all) = ${fmtCommas(loThresh)}`);
    legendY += legendLineHeight;
  }

  return svg;
}
