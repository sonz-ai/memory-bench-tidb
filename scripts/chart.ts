import fs from "node:fs";
import path from "node:path";
import type { Approach } from "../src/types.ts";

/**
 * Turn the newest results/bench-*.json into two artefacts:
 *   1. A compact JSON the Next.js pitch page can read (latest.json).
 *   2. An SVG bar chart per slice, saved into results/.
 *
 * No plotting library — we hand-render SVG so there's zero runtime dep and
 * the image survives deploy as a static asset.
 */

const APPROACHES: Approach[] = [
  "raw_vector",
  "progressive_summary",
  "hierarchical",
  "typed_facts",
  "spo_supersede",
];

const APPROACH_COLORS: Record<Approach, string> = {
  raw_vector: "#525252",
  progressive_summary: "#737373",
  hierarchical: "#a3a3a3",
  typed_facts: "#10b981",
  spo_supersede: "#8b5cf6",
};

const APPROACH_LABELS: Record<Approach, string> = {
  raw_vector: "raw+vec",
  progressive_summary: "progressive",
  hierarchical: "hierarchical",
  typed_facts: "typed-facts",
  spo_supersede: "spo-supersede",
};

const SLICES = [
  "single_session",
  "multi_session",
  "temporal",
  "knowledge_update",
];

function latestResults(): string {
  const dir = path.join(import.meta.dir, "..", "results");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("bench-") && f.endsWith(".json"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0)
    throw new Error("No results/bench-*.json found. Run bench first.");
  return path.join(dir, files[0]!.f);
}

interface SummaryCell {
  n: number;
  acc: number;
}
type Summary = Record<string, Record<string, SummaryCell>>;

function barChart(summary: Summary): string {
  const W = 880;
  const H = 420;
  const margin = { top: 40, right: 24, bottom: 64, left: 48 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const groupW = innerW / SLICES.length;
  const barW = (groupW - 16) / APPROACHES.length;

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,system-ui,sans-serif">`;
  svg += `<rect width="${W}" height="${H}" fill="#0a0a0a"/>`;

  // Title
  svg += `<text x="${margin.left}" y="24" fill="#e5e5e5" font-size="14" font-weight="600">Accuracy by slice · same TiDB cluster · 5 architectures</text>`;

  // Y axis gridlines + labels
  for (const t of yTicks) {
    const y = margin.top + innerH - t * innerH;
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + innerW}" y2="${y}" stroke="#262626" stroke-width="1"/>`;
    svg += `<text x="${margin.left - 8}" y="${y + 4}" fill="#737373" font-size="10" text-anchor="end">${(t * 100).toFixed(0)}%</text>`;
  }

  // Bars
  SLICES.forEach((slice, gi) => {
    const gx = margin.left + gi * groupW + 8;

    APPROACHES.forEach((approach, bi) => {
      const cell = summary[approach]?.[slice];
      const acc = cell?.acc ?? 0;
      const x = gx + bi * barW;
      const h = acc * innerH;
      const y = margin.top + innerH - h;
      svg += `<rect x="${x}" y="${y}" width="${barW - 2}" height="${h}" fill="${APPROACH_COLORS[approach]}" rx="2"/>`;
      if (cell) {
        svg += `<text x="${x + barW / 2}" y="${y - 4}" fill="#e5e5e5" font-size="9" text-anchor="middle">${(acc * 100).toFixed(0)}</text>`;
      }
    });

    // Slice label
    svg += `<text x="${gx + (groupW - 16) / 2}" y="${margin.top + innerH + 20}" fill="#a3a3a3" font-size="11" text-anchor="middle">${slice}</text>`;
  });

  // Legend
  const legendY = H - 14;
  let lx = margin.left;
  APPROACHES.forEach((a) => {
    svg += `<rect x="${lx}" y="${legendY - 10}" width="10" height="10" fill="${APPROACH_COLORS[a]}" rx="2"/>`;
    svg += `<text x="${lx + 14}" y="${legendY - 1}" fill="#a3a3a3" font-size="10">${APPROACH_LABELS[a]}</text>`;
    lx += 140;
  });

  svg += `</svg>`;
  return svg;
}

function main() {
  const resultsPath = latestResults();
  const data = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as {
    summary: Summary;
  };
  const summary = data.summary;

  const svg = barChart(summary);
  const json = JSON.stringify(
    { summary, source: path.basename(resultsPath) },
    null,
    2,
  );

  // Single output directory: results/ alongside the raw bench JSON.
  const targets = [path.join(import.meta.dir, "..", "results")];
  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "chart.svg"), svg);
      fs.writeFileSync(path.join(dir, "latest.json"), json);
      console.log(`Wrote ${path.join(dir, "chart.svg")}`);
      console.log(`Wrote ${path.join(dir, "latest.json")}`);
    } catch (err) {
      console.warn(`skipped ${dir}:`, (err as Error).message.slice(0, 100));
    }
  }

  console.log(`Source: ${resultsPath}`);
}

main();
