import type { RekognitionUsage } from './api';

export type UsageSummary = {
  used: number;
  cap: number;
  pct: number;
  level: 'ok' | 'high' | 'reached';
  monthLabel: string;
};

/** The free-tier cap applies per API group; the busier group is what runs out first. */
export function summarizeUsage(u: RekognitionUsage): UsageSummary {
  const used = Math.max(u.group1, u.group2);
  const pct = u.cap > 0 ? (used / u.cap) * 100 : 100;
  const [y, m] = u.month.split('-').map(Number);
  const monthLabel =
    y && m ? new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : u.month;
  return { used, cap: u.cap, pct, level: used >= u.cap ? 'reached' : pct >= 80 ? 'high' : 'ok', monthLabel };
}
