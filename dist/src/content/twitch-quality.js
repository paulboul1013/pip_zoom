export function chooseHighestQualityOption(labels) {
  return labels
    .map((label, index) => ({ index, score: qualityScore(label) }))
    .filter(({ score }) => score >= 0)
    .sort((first, second) => second.score - first.score)[0]?.index ?? -1;
}

function qualityScore(label) {
  const text = String(label).toLowerCase();
  if (text.includes('source')) return Number.MAX_SAFE_INTEGER;

  const resolution = Number(text.match(/(\d{3,4})p/)?.[1] ?? 0);
  const frameRate = Number(text.match(/(\d{2,3})\s*fps/)?.[1] ?? 0);
  return resolution > 0 ? resolution * 1_000 + frameRate : -1;
}
