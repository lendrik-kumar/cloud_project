import { useEffect, useRef, useState } from 'react';
import { formatDate } from '../api';

type Datum = { date: string; value: number };

type Props = {
  data: Datum[];
  /** Upper bound of the y-axis (e.g. roster size). */
  max: number;
  title: string;
  unit: string;
};

const H = 220;
const PAD = { top: 16, right: 12, bottom: 44, left: 36 };

/** Single-series column chart in plain SVG with a per-column hover tooltip. */
export function BarChart({ data, max, title, unit }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvail(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yMax = Math.max(1, max, ...data.map((d) => d.value));
  // Fill the card; below ~48px per session, scroll horizontally instead of squeezing.
  const n = Math.max(1, data.length);
  const band = Math.min(96, Math.max(48, (avail - PAD.left - PAD.right) / n));
  const plotRight = PAD.left + n * band;
  const width = Math.max(320, avail, plotRight + PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const ticks = niceTicks(yMax);

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <div className="chart-scroll" ref={wrap}>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          role="img"
          aria-label={`${title}: ${data.map((d) => `${d.date} ${d.value}`).join(', ')}`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={plotRight} y1={y(t)} y2={y(t)} />
              <text className="chart-axis" x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.left + band * i + band / 2;
            const top = y(d.value);
            const h = PAD.top + plotH - top;
            return (
              <g
                key={d.date}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${formatDate(d.date)}: ${d.value} ${unit}`}
              >
                {/* hit target: the whole band */}
                <rect x={cx - band / 2} y={PAD.top} width={band} height={plotH} fill="transparent" />
                {h > 0 && <path className={hover === i ? 'chart-bar chart-bar-hover' : 'chart-bar'} d={columnPath(cx - barW / 2, top, barW, h)} />}
                <text className="chart-axis" x={cx} y={H - PAD.bottom + 16} textAnchor="middle">
                  {shortDate(d.date)}
                </text>
              </g>
            );
          })}
          <line className="chart-baseline" x1={PAD.left} x2={plotRight} y1={y(0)} y2={y(0)} />
          {hover !== null && data[hover] && (
            <Tooltip
              x={PAD.left + band * hover + band / 2}
              y={y(data[hover].value)}
              width={width}
              lines={[formatDate(data[hover].date), `${data[hover].value} ${unit}`]}
            />
          )}
        </svg>
      </div>
    </figure>
  );
}

function Tooltip({ x, y, width, lines }: { x: number; y: number; width: number; lines: string[] }) {
  const w = 150;
  const h = 40;
  const left = Math.min(Math.max(4, x - w / 2), width - w - 4);
  const top = Math.max(2, y - h - 8);
  return (
    <g className="chart-tooltip" pointerEvents="none">
      <rect x={left} y={top} width={w} height={h} rx={6} />
      <text x={left + 10} y={top + 16} className="chart-tooltip-title">
        {lines[0]}
      </text>
      <text x={left + 10} y={top + 32}>
        {lines[1]}
      </text>
    </g>
  );
}

/** Column with a 4px rounded data end and a square baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1] ?? m}`;
}
