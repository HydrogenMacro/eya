# Live resource charts

Task Manager and Docker share a dependency-free SVG chart component in `client/charts.js`. Styles in `client/charts.css` inherit workspace theme, accent, and radius variables. The chart resizes with its panel and works in both HTML and SVG/XHTML clients.

```js
const chart = createChart({
  label: 'CPU',
  series: [{ key: 'cpu', label: 'CPU' }],
  format: value => `${value.toFixed(1)}%`,
  max: 100,
  maxPoints: 900,
  rangeMs: 5 * 60 * 1000,
});
panel.append(chart.element);
chart.push({ time: Date.now(), cpu: 35 });
chart.setOptions({ style: 'line' });
```

Samples use millisecond timestamps. Duplicate timestamps replace the existing sample; out-of-order samples are inserted chronologically. Non-finite or null series values create gaps instead of misleading zeroes. History is bounded independently of the visible range (120 points by default, configurable up to 3600). Each series can specify a color; otherwise the chart supplies contrasting colors, starting with the current accent.

`setSeries(series)` updates the legend and plotted fields. `setOptions` accepts `style` (`area` or `line`), `rangeMs`, `height`, `min`, `max`, `maxPoints`, and `paused`. A null `rangeMs` shows all retained history. A null `max` enables automatic scaling. Pausing freezes the visible sample set while retaining incoming samples; resizing still works, and resuming displays the latest history. `clear()` resets history and `destroy()` removes observers, listeners, and DOM.

Hover or touch a graph to inspect its nearest sample. Keyboard users can focus it and use Left/Right, Home/End, and Escape. Accessible labels provide current values and sample counts; legends expose current values as text. `tests/charts.cjs` verifies history bounds, null gaps, visible ranges, keyboard/pointer/touch inspection, pause/resume, light-theme inheritance, mobile bounds, cleanup, and SVG/XHTML rendering.
