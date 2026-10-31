/*part
{"name":"bars","line":"one measure across items or months, as bars","data":{"kind":"bars","items":[{"label":"May","value":310},{"label":"Jun","value":284},{"label":"Jul","value":352},{"label":"Aug","value":298}],"mark":3,"unit":"£"}}
*/
Parts.kinds.bars = (f, { W, svg, fit, rect, mid }) => {
  const items = (f.items || []).slice(0, 12).map((i) => ({ label: String(i?.label ?? ""), value: Math.max(0, Number(i?.value) || 0) }));
  const n = items.length;
  if (!n) return svg("", "No values yet");
  const unit = String(f.unit ?? "");
  const shown = (v) => (unit.length <= 2 && !/^[a-z]/i.test(unit) ? unit + (v >= 10000 ? Math.round(v / 1000) + "k" : String(+v.toFixed(1))) : String(+v.toFixed(1)) + " " + unit);
  const max = Math.max(...items.map((i) => i.value)) || 1, top = 28, base = 148, gap = n > 8 ? 6 : 12, w = (W - 24 - gap * (n - 1)) / n;
  const chars = Math.max(3, Math.floor(w / 5.5));
  const bars = items.map((it, i) => {
    const x = 12 + i * (w + gap), h = Math.max(1, (it.value / max) * (base - top));
    return rect(x, base - h, w, h, i === f.mark ? "fi" : "fc", 3) + mid("tx", x + w / 2, base - h - 6, fit(shown(it.value), chars)) + mid("tx", x + w / 2, base + 16, fit(it.label, chars));
  });
  return svg(`<path class="lq" d="M8 ${base}H${W - 8}"/>` + bars.join(""), (f.title ? f.title + ": " : "") + items.map((i) => `${i.label} ${shown(i.value)}`).join(", "));
};
