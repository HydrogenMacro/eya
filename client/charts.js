const NS = 'http://www.w3.org/2000/svg';
const COLORS = ['var(--ui-accent,#7fdbc5)', '#74b5ff', '#d49bff', '#f5c96b', '#ff8e9b', '#78d4e4'];
const number = value => typeof value === 'number' && Number.isFinite(value);
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function svgNode(tag, attrs = {}) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
function niceMaximum(value) {
  if (!(value > 0)) return 1;
  const scale = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].find(step => step * scale >= value) * scale;
}
const defaultFormat = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: Math.abs(value) >= 10000 ? 'compact' : 'standard' }).format(value);
const timeFormat = time => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Bounded, dependency-free live chart. Samples use millisecond timestamps. */
export function createChart({ label = 'Resource usage', series = [], format = defaultFormat, height = 130, maxPoints = 120,
  style = 'area', rangeMs = null, min = 0, max = null, paused = false } = {}) {
  const element = node('section', 'live-chart');
  const header = node('div', 'live-chart-header');
  const title = node('span', 'live-chart-title', label);
  const state = node('span', 'live-chart-state'); header.append(title, state);
  const plot = node('div', 'live-chart-plot');
  const svg = svgNode('svg', { class: 'live-chart-svg', role: 'img', tabindex: '0', 'aria-label': label, preserveAspectRatio: 'none' });
  const empty = node('div', 'live-chart-empty', 'Collecting data');
  const tooltip = node('div', 'live-chart-tooltip'); tooltip.hidden = true;
  const legend = node('div', 'live-chart-legend'); legend.setAttribute('role', 'list');
  plot.append(svg, empty, tooltip); element.append(header, plot, legend);
  let definitions = [], samples = [], frozen = paused ? [] : null, width = 520, disposed = false, frame, hovered = -1;
  const options = { height, style, rangeMs, min, max, paused, maxPoints: Math.max(2, Math.min(3600, Math.floor(maxPoints) || 120)) };
  const abort = new AbortController();
  let geometry = null;
  function display(value) { if (!number(value)) return '—'; try { return String(format(value)); } catch { return defaultFormat(value); } }
  function schedule(force = false) {
    if (disposed || (options.paused && !force) || frame) return;
    frame = requestAnimationFrame(() => { frame = undefined; render(); });
  }
  function setSeries(next) {
    definitions = (Array.isArray(next) ? next : []).filter(item => item && typeof item.key === 'string').map((item, index) => ({ ...item, label: item.label || item.key, color: item.color || COLORS[index % COLORS.length] }));
    hovered = -1; schedule(true);
  }
  function selection(index) {
    if (!geometry || !geometry.data.length || index < 0) {
      hovered = -1; tooltip.hidden = true; svg.querySelector('.live-chart-crosshair')?.remove();
      const latest = (frozen || samples).at(-1);
      svg.setAttribute('aria-label', `${label}. ${definitions.map(item => `${item.label}: ${display(latest?.[item.key])}`).join('; ')}. ${geometry?.data.length || 0} samples.`);
      return;
    }
    hovered = Math.max(0, Math.min(geometry.data.length - 1, index));
    const sample = geometry.data[hovered], x = geometry.x(sample.time);
    svg.querySelector('.live-chart-crosshair')?.remove();
    const crosshair = svgNode('g', { class: 'live-chart-crosshair' });
    crosshair.append(svgNode('line', { x1: x, x2: x, y1: geometry.top, y2: geometry.bottom }));
    for (const item of definitions) if (number(sample[item.key])) crosshair.append(svgNode('circle', { cx: x, cy: geometry.y(sample[item.key]), r: 3, fill: item.color }));
    svg.append(crosshair);
    tooltip.replaceChildren(node('div', 'live-chart-tooltip-time', timeFormat(sample.time)));
    for (const item of definitions) {
      const row = node('div', 'live-chart-tooltip-row');
      const name = node('span', '', item.label), value = node('strong', '', display(sample[item.key]));
      row.append(name, value); tooltip.append(row);
    }
    tooltip.hidden = false;
    const plotWidth = plot.clientWidth || width, anchor = x / width * plotWidth;
    tooltip.style.left = `${Math.max(5, Math.min(plotWidth - tooltip.offsetWidth - 5, anchor + (anchor > plotWidth / 2 ? -tooltip.offsetWidth - 12 : 12)))}px`;
    tooltip.style.top = '7px';
    svg.setAttribute('aria-label', `${label}, ${timeFormat(sample.time)}. ${definitions.map(item => `${item.label}: ${display(sample[item.key])}`).join('; ')}`);
  }
  function render() {
    if (disposed) return;
    const chartHeight = Math.max(80, Math.min(400, Number(options.height) || 130));
    plot.style.height = `${chartHeight}px`; svg.setAttribute('viewBox', `0 0 ${width} ${chartHeight}`);
    state.textContent = options.paused ? 'Paused' : '';
    const history = frozen || samples;
    const latest = history.at(-1), cutoff = latest && number(options.rangeMs) && options.rangeMs > 0 ? latest.time - options.rangeMs : -Infinity;
    const data = history.filter(sample => sample.time >= cutoff);
    const allValues = data.flatMap(sample => definitions.map(item => sample[item.key]).filter(number));
    empty.hidden = allValues.length > 0;
    const lower = number(options.min) ? options.min : allValues.reduce((lowest, value) => Math.min(lowest, value), 0);
    const highest = allValues.reduce((highest, value) => Math.max(highest, value), lower + 1);
    const upper = number(options.max) && options.max > lower ? options.max : Math.max(lower + 1, niceMaximum(highest));
    const axisChars = Math.max(...[lower, lower + (upper - lower) / 2, upper].map(value => display(value).length));
    const left = Math.min(Math.max(42, axisChars * 6 + 9), Math.max(42, width * .45)), right = Math.max(left + 20, width - 9), top = 8, bottom = chartHeight - 24;
    const lastTime = latest?.time ?? Date.now();
    const firstTime = cutoff !== -Infinity ? cutoff : data[0]?.time ?? lastTime - 1000;
    const start = firstTime === lastTime ? firstTime - 1000 : firstTime;
    const x = time => left + (time - start) / Math.max(1, lastTime - start) * (right - left);
    const y = value => bottom - Math.max(0, Math.min(1, (value - lower) / (upper - lower))) * (bottom - top);
    geometry = { data, x, y, top, bottom };
    svg.replaceChildren();
    for (let index = 0; index <= 2; index++) {
      const value = lower + (upper - lower) * index / 2, cy = y(value);
      svg.append(svgNode('line', { class: 'live-chart-grid', x1: left, x2: right, y1: cy, y2: cy }));
      const text = svgNode('text', { class: 'live-chart-axis', x: left - 7, y: cy + 3, 'text-anchor': 'end' }); text.textContent = display(value); svg.append(text);
    }
    for (const [time, anchor, coordinate] of [[start, 'start', left], [lastTime, 'end', right]]) {
      const text = svgNode('text', { class: 'live-chart-axis', x: coordinate, y: chartHeight - 5, 'text-anchor': anchor }); text.textContent = timeFormat(time); svg.append(text);
    }
    for (const item of definitions) {
      const segments = []; let segment = [];
      for (const sample of data) {
        if (!number(sample[item.key])) { if (segment.length) segments.push(segment); segment = []; }
        else segment.push([x(sample.time), y(sample[item.key])]);
      }
      if (segment.length) segments.push(segment);
      for (const points of segments) {
        const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');
        if (options.style === 'area' && points.length > 1) svg.append(svgNode('path', { class: 'live-chart-area', d: `${line} L${points.at(-1)[0]},${bottom} L${points[0][0]},${bottom} Z`, fill: item.color }));
        svg.append(svgNode('path', { class: 'live-chart-line', d: line, stroke: item.color }));
      }
      const last = data.at(-1);
      if (last && number(last[item.key])) svg.append(svgNode('circle', { class: 'live-chart-last', cx: x(last.time), cy: y(last[item.key]), r: 2.5, fill: item.color }));
    }
    legend.replaceChildren();
    for (const item of definitions) {
      const row = node('div', 'live-chart-legend-item'); row.setAttribute('role', 'listitem');
      const dot = node('i', 'live-chart-dot'); dot.style.background = item.color; dot.setAttribute('aria-hidden', 'true');
      row.append(dot, node('span', 'live-chart-legend-name', item.label), node('strong', 'live-chart-value', display(latest?.[item.key]))); legend.append(row);
    }
    svg.setAttribute('aria-label', `${label}. ${definitions.map(item => `${item.label}: ${display(latest?.[item.key])}`).join('; ')}. ${data.length} samples.`);
    selection(hovered);
  }
  function point(event) {
    if (!geometry?.data.length) return;
    const rect = svg.getBoundingClientRect(), target = (event.clientX - rect.left) / Math.max(1, rect.width) * width;
    let nearest = 0;
    geometry.data.forEach((sample, index) => { if (Math.abs(geometry.x(sample.time) - target) < Math.abs(geometry.x(geometry.data[nearest].time) - target)) nearest = index; });
    selection(nearest);
  }
  svg.addEventListener('pointermove', point, { signal: abort.signal });
  svg.addEventListener('pointerdown', point, { signal: abort.signal });
  svg.addEventListener('pointerleave', () => selection(-1), { signal: abort.signal });
  svg.addEventListener('blur', () => selection(-1), { signal: abort.signal });
  svg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { selection(-1); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !geometry?.data.length) return;
    event.preventDefault();
    selection(event.key === 'Home' ? 0 : event.key === 'End' ? geometry.data.length - 1 : hovered < 0 ? geometry.data.length - 1 : hovered + (event.key === 'ArrowLeft' ? -1 : 1));
  }, { signal: abort.signal });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const measured = entries[0]?.contentRect.width;
    if (measured > 0 && Math.abs(width - measured) > .5) { width = Math.max(160, measured); schedule(true); }
  }) : null;
  observer?.observe(element);
  setSeries(series); render();
  return {
    element,
    push(sample) {
      if (disposed || !sample || typeof sample !== 'object') return;
      const entry = { ...sample, time: number(sample.time) ? sample.time : Date.now() };
      const index = samples.findIndex(value => value.time >= entry.time);
      if (index < 0) samples.push(entry);
      else if (samples[index].time === entry.time) samples[index] = entry;
      else samples.splice(index, 0, entry);
      if (samples.length > options.maxPoints) samples.splice(0, samples.length - options.maxPoints);
      schedule();
    },
    setSeries,
    setOptions(next = {}) {
      if (next.paused === true && !options.paused) frozen = samples.slice();
      if (next.paused === false) frozen = null;
      Object.assign(options, next);
      if (next.maxPoints !== undefined) options.maxPoints = Math.max(2, Math.min(3600, Math.floor(next.maxPoints) || 120));
      if (samples.length > options.maxPoints) samples.splice(0, samples.length - options.maxPoints);
      schedule(true);
    },
    clear() { samples = []; frozen = options.paused ? [] : null; hovered = -1; render(); },
    destroy() { disposed = true; cancelAnimationFrame(frame); observer?.disconnect(); abort.abort(); element.remove(); samples = []; },
  };
}
