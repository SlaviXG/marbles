export function teamReward(score, used, budget, lambda = 0.25) {
  const success = Math.max(0, Math.min(1, Number(score) || 0));
  return success * (1 - lambda * Math.min(1, Math.max(0, used) / Math.max(1, budget)));
}
