// Validated categorical palette (dataviz skill — node scripts/validate_palette.js
// "<hexes>" --mode dark --surface "#141a25") — all 6 pass lightness band,
// chroma floor, CVD separation, and contrast against our actual card surface.
// Assign in this fixed order; never cycle or reassign by rank.
export const CATEGORICAL: string[] = [
  '#3987e5', // blue
  '#199e70', // aqua/green
  '#c98500', // amber
  '#9085e9', // violet
  '#e66767', // red
  '#d95926', // orange
]

export function categoricalColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length]
}
