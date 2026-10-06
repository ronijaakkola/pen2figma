// Builds Figma copies of Pen frames. The UI fetches Pen data from the bridge and posts it here.
declare const DEBUG: boolean;

type Pen = any;
type Bounds = Record<string, [number, number, number, number]>;
type Payload = { file: string; frames: { id: string; tree: Pen; bounds: Bounds }[]; icons: Record<string, string>; images: Record<string, string>; warnings: string[] };

figma.showUI(__html__, { width: 280, height: 220, themeColors: true });

const GAP = 100;
let warnings: string[] = [];
const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };

// ---------- colours & paints ----------
function rgba(h: string) {
  h = h.replace("#", "");
  if (h.length <= 4) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}
const BLEND: Record<string, BlendMode> = {
  normal: "NORMAL", darken: "DARKEN", multiply: "MULTIPLY", linearBurn: "LINEAR_BURN", colorBurn: "COLOR_BURN", light: "LIGHTEN",
  screen: "SCREEN", linearDodge: "LINEAR_DODGE", colorDodge: "COLOR_DODGE", overlay: "OVERLAY", softLight: "SOFT_LIGHT", hardLight: "HARD_LIGHT",
  difference: "DIFFERENCE", exclusion: "EXCLUSION", hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};

// Inverse of a 2x3 affine [[a,b,c],[d,e,f]].
function invert([[a, b, c], [d, e, f]]: Transform): Transform {
  const det = a * e - b * d;
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}

// Pen gradients are described in bbox-normalized space: center, size, rotation (deg CCW, 0 = up).
// Figma wants the transform from that space into gradient space, where the gradient runs (0,.5) → (1,.5).
function gradientTransform(f: Pen): Transform {
  const cx = f.center?.x ?? 0.5, cy = f.center?.y ?? 0.5;
  const w = f.size?.width ?? 1, h = f.size?.height ?? 1;
  const t = ((f.rotation ?? 0) * Math.PI) / 180;
  const up = { x: -Math.sin(t), y: -Math.cos(t) };      // gradient direction (screen space, y down)
  const side = { x: Math.cos(t), y: -Math.sin(t) };     // perpendicular
  if ((f.gradientType ?? "linear") === "linear") {
    // gradient space x: 0..1 along the direction, length h, centred on c
    const sx = cx - up.x * h / 2, sy = cy - up.y * h / 2;
    return invert([[up.x * h, side.x * h, sx - side.x * h / 2], [up.y * h, side.y * h, sy - side.y * h / 2]]);
  }
  // radial / angular: unit circle at (.5,.5) maps onto the w×h ellipse around c
  return invert([[side.x * w, up.x * h, cx - (side.x * w + up.x * h) / 2], [side.y * w, up.y * h, cy - (side.y * w + up.y * h) / 2]]);
}

function paint(f: Pen, images: Record<string, string>): Paint | null {
  if (f == null) return null;
  if (typeof f === "string") f = { type: "color", color: f };
  const visible = f.enabled !== false;
  const blendMode = BLEND[f.blendMode] ?? "NORMAL";
  if (f.type === "color") {
    const c = rgba(f.color);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a, visible, blendMode };
  }
  if (f.type === "gradient") {
    const type = ({ linear: "GRADIENT_LINEAR", radial: "GRADIENT_RADIAL", angular: "GRADIENT_ANGULAR" } as const)[f.gradientType as "linear"] ?? "GRADIENT_LINEAR";
    const gradientStops = (f.colors || []).map((s: Pen) => { const c = rgba(s.color); return { position: s.position, color: c }; });
    return { type, gradientTransform: gradientTransform(f), gradientStops, opacity: f.opacity ?? 1, visible, blendMode };
  }
  if (f.type === "image") {
    const data = images[f.url];
    if (!data) return null;
    const imageHash = figma.createImage(figma.base64Decode(data)).hash;
    const scaleMode = f.mode === "contain" ? "FIT" : f.mode === "stretch" ? "CROP" : "FILL";
    if (f.transform) warn("Image crop ignored");
    return { type: "IMAGE", imageHash, scaleMode, opacity: f.opacity ?? 1, visible, blendMode } as ImagePaint;
  }
  warn(`Fill type ${f.type} not supported`);
  return null;
}
const paints = (f: Pen, images: Record<string, string>): Paint[] =>
  f === undefined ? [] : [f].flat().map(p => paint(p, images)).filter((p): p is Paint => !!p);

// ---------- fonts ----------
const STYLES = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"];
let available: Map<string, { family: string; styles: string[] }> | null = null;
const loaded = new Set<string>();

async function fontFor(n: Pen): Promise<FontName> {
  if (!available) {
    available = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const k = f.fontName.family.toLowerCase();
      if (!available.has(k)) available.set(k, { family: f.fontName.family, styles: [] });
      available.get(k)!.styles.push(f.fontName.style);
    }
  }
  const want = String(n.fontFamily || "Inter");
  let key = want.toLowerCase();
  if (!available.has(key)) { warn(`Font ${want} not available in Figma, used Inter`); key = "inter"; }
  const { family, styles } = available.get(key)!;
  const w = n.fontWeight === "bold" ? 700 : n.fontWeight === "normal" || n.fontWeight === undefined ? 400 : +n.fontWeight || 400;
  const italic = n.fontStyle === "italic";
  const norm = (s: string) => s.replace(/[\s-]/g, "").toLowerCase();
  // Closest weight among the family's styles, italics matched to the request.
  let best = styles[0], bestScore = Infinity;
  for (const s of styles) {
    const ns = norm(s), isItalic = ns.includes("italic");
    const base = ns.replace("italic", "") || "regular";
    const idx = STYLES.findIndex(x => norm(x) === base || (base === "book" && x === "Regular") || (base === "demibold" && x === "SemiBold") || (base === "heavy" && x === "Black"));
    const score = (idx < 0 ? 500 : Math.abs((idx + 1) * 100 - w)) + (isItalic === italic ? 0 : 1000);
    if (score < bestScore) { best = s; bestScore = score; }
  }
  const font = { family, style: best };
  const id = family + "/" + best;
  if (!loaded.has(id)) { await figma.loadFontAsync(font); loaded.add(id); }
  return font;
}

// ---------- naming ----------
const GENERIC = new Set(["div", "span", "a", "button", "li", "ul", "p", "svg", "header", "h1", "h2", "h3", "section", "input", "path", "nav", "main", "footer", "img", "label", "table", "tr", "td", "th"]);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function firstText(n: Pen): string | null {
  if (n.type === "text") return n.content;
  for (const c of n.children || []) { const t = firstText(c); if (t) return t; }
  return null;
}
function nameOf(n: Pen): string {
  if (n.name && !GENERIC.has(n.name)) return n.name;
  if (n.type === "text") return String(n.content || "Text").slice(0, 40);
  const base = cap(n.context && !["div", "span"].includes(n.context) ? n.context : n.name || n.type);
  const t = firstText(n);
  return t ? `${base} · ${String(t).slice(0, 30)}` : base;
}

// ---------- node building ----------
const PRI: Record<string, "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"> = { start: "MIN", center: "CENTER", end: "MAX", space_between: "SPACE_BETWEEN", space_around: "SPACE_BETWEEN" };
const SEC: Record<string, "MIN" | "CENTER" | "MAX"> = { start: "MIN", center: "CENTER", end: "MAX" };
const isFill = (v: unknown) => typeof v === "string" && v.startsWith("fill_container");
const isAL = (n: BaseNode) => n.type === "FRAME" && (n as FrameNode).layoutMode !== "NONE";

type Ctx = { bounds: Bounds; icons: Record<string, string>; images: Record<string, string> };

function strokes(node: SceneNode, n: Pen, ctx: Ctx) {
  if (n.stroke === undefined || !("strokes" in node)) return;
  node.strokes = paints(n.stroke, ctx.images);
  const align = n.strokeAlignment === "inner" ? "INSIDE" : n.strokeAlignment === "outer" ? "OUTSIDE" : "CENTER";
  if ("strokeAlign" in node) (node as any).strokeAlign = align;
  const sw = n.strokeWidth ?? 1;
  if (typeof sw === "number") (node as any).strokeWeight = sw;
  else if ("strokeTopWeight" in node) Object.assign(node, { strokeTopWeight: sw.top || 0, strokeRightWeight: sw.right || 0, strokeBottomWeight: sw.bottom || 0, strokeLeftWeight: sw.left || 0 });
  if (n.strokeLinecap && "strokeCap" in node) (node as any).strokeCap = ({ butt: "NONE", round: "ROUND", square: "SQUARE" } as any)[n.strokeLinecap];
  if (n.strokeLinejoin && "strokeJoin" in node) (node as any).strokeJoin = ({ miter: "MITER", bevel: "BEVEL", round: "ROUND" } as any)[n.strokeLinejoin];
}

function effects(node: SceneNode, n: Pen) {
  if (!n.effect || !("effects" in node)) return;
  const out: Effect[] = [];
  for (const e of [n.effect].flat()) {
    const visible = e.enabled !== false;
    if (e.type === "shadow") {
      const c = rgba(e.color || "#00000040");
      out.push({ type: e.shadowType === "inner" ? "INNER_SHADOW" : "DROP_SHADOW", color: c, offset: { x: e.offset?.x || 0, y: e.offset?.y || 0 }, radius: e.blur || 0, spread: e.spread || 0, visible, blendMode: BLEND[e.blendMode] ?? "NORMAL" });
    } else if (e.type === "blur") out.push({ type: "LAYER_BLUR", blurType: "NORMAL", radius: e.radius || 0, visible });
    else if (e.type === "background_blur") out.push({ type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: e.radius || 0, visible });
  }
  (node as BlendMixin).effects = out;
}

function common(node: SceneNode, n: Pen, ctx: Ctx) {
  node.name = nameOf(n);
  if (n.opacity !== undefined && "opacity" in node) node.opacity = n.opacity;
  if (n.enabled === false) node.visible = false;
  if ("fills" in node && node.type !== "TEXT") (node as GeometryMixin).fills = paints(n.fill, ctx.images);
  strokes(node, n, ctx);
  effects(node, n);
  if (n.cornerRadius !== undefined && "cornerRadius" in node) {
    const r = n.cornerRadius;
    if (typeof r === "number") (node as any).cornerRadius = Math.min(r, 9999);
    else Object.assign(node, { topLeftRadius: r[0], topRightRadius: r[1], bottomRightRadius: r[2], bottomLeftRadius: r[3] });
  }
  if (n.flipX || n.flipY) warn("Flip ignored");
}

// Size from Pen's resolved bounds, then let auto layout take over where Pen uses fit/fill.
function size(node: SceneNode, n: Pen, b: number[] | undefined, parent: BaseNode & ChildrenMixin) {
  if (b && "resize" in node) (node as any).resize(Math.max(b[2], 0.01), Math.max(b[3], 0.01));
  const parentAL = isAL(parent) && n.layoutPosition !== "absolute";
  const selfAL = isAL(node);
  const mode = (v: unknown): "FIXED" | "HUG" | "FILL" | null => {
    if (typeof v === "number") return "FIXED";
    if (isFill(v)) return parentAL ? "FILL" : "FIXED";
    return selfAL ? "HUG" : "FIXED";
  };
  if (!parentAL && !selfAL) return;
  const h = mode(n.width), v = mode(n.height);
  if (h) (node as FrameNode).layoutSizingHorizontal = h;
  if (v) (node as FrameNode).layoutSizingVertical = v;
}

function place(node: SceneNode, n: Pen, b: number[] | undefined, parent: BaseNode & ChildrenMixin) {
  const parentAL = isAL(parent);
  if (n.layoutPosition === "absolute" && parentAL) (node as FrameNode).layoutPositioning = "ABSOLUTE";
  if (!parentAL || n.layoutPosition === "absolute") {
    node.x = b ? b[0] : n.x || 0;
    node.y = b ? b[1] : n.y || 0;
  }
  if (n.rotation && "rotation" in node) node.rotation = n.rotation;
}

function svgNode(svg: string, w: number, h: number): FrameNode {
  const f = figma.createNodeFromSvg(svg);
  f.fills = [];
  f.clipsContent = false;
  f.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  return f;
}

async function build(n: Pen, parent: BaseNode & ChildrenMixin, ctx: Ctx): Promise<SceneNode | null> {
  const b = ctx.bounds[n.id];
  let node: SceneNode;
  if (n.type === "frame" || n.type === "group") {
    const f = figma.createFrame();
    node = f;
    if (n.type === "frame" && n.layout !== "none") {
      f.layoutMode = n.layout === "vertical" ? "VERTICAL" : "HORIZONTAL";
      f.itemSpacing = n.gap ?? 0;
      const p = n.padding ?? 0;
      const a = typeof p === "number" ? [p, p, p, p] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
      [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = a;
      f.primaryAxisAlignItems = PRI[n.justifyContent] || "MIN";
      f.counterAxisAlignItems = SEC[n.alignItems] || "MIN";
      if (n.layoutIncludeStroke) f.strokesIncludedInLayout = true;
    }
    common(f, n, ctx);
    f.clipsContent = n.clip === true;
    parent.appendChild(f);
    size(f, n, b, parent);
    place(f, n, b, parent);
    for (const c of n.children || []) await build(c, f, ctx);
    return f;
  }
  if (n.type === "text") {
    const t = figma.createText();
    node = t;
    t.fontName = await fontFor(n);
    t.characters = String(n.content ?? "");
    t.fontSize = n.fontSize || 14;
    t.fills = paints(n.fill ?? "#000000", ctx.images);
    if (n.lineHeight) t.lineHeight = { unit: "PERCENT", value: n.lineHeight * 100 };
    if (n.letterSpacing !== undefined) t.letterSpacing = { unit: "PIXELS", value: n.letterSpacing };
    t.textAlignHorizontal = ({ left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" } as const)[n.textAlign as "left"] || "LEFT";
    t.textAlignVertical = ({ top: "TOP", middle: "CENTER", bottom: "BOTTOM" } as const)[n.textAlignVertical as "top"] || "TOP";
    if (n.underline) t.textDecoration = "UNDERLINE";
    else if (n.strikethrough) t.textDecoration = "STRIKETHROUGH";
    if (n.href) t.hyperlink = { type: "URL", value: n.href };
    common(t, n, ctx);
    parent.appendChild(t);
    const parentAL = isAL(parent) && n.layoutPosition !== "absolute";
    const growth = n.textGrowth ?? "auto";
    if (growth === "auto") t.textAutoResize = "WIDTH_AND_HEIGHT";
    else {
      if (b) t.resize(Math.max(b[2], 0.01), Math.max(b[3], 0.01));
      t.textAutoResize = growth === "fixed-width" ? "HEIGHT" : "NONE";
      if (parentAL && isFill(n.width)) t.layoutSizingHorizontal = "FILL";
      if (parentAL && isFill(n.height) && growth === "fixed-width-height") t.layoutSizingVertical = "FILL";
    }
    place(t, n, b, parent);
    return t;
  }
  if (n.type === "rectangle" || n.type === "ellipse" || n.type === "polygon") {
    node = n.type === "rectangle" ? figma.createRectangle() : n.type === "ellipse" ? figma.createEllipse() : figma.createPolygon();
    if (n.type === "polygon") (node as PolygonNode).pointCount = n.polygonCount || 3;
    if (n.type === "ellipse" && (n.innerRadius || n.startAngle || (n.sweepAngle ?? 360) !== 360)) {
      // Pen: degrees CCW from the right; Figma: radians clockwise.
      const s = -((n.startAngle || 0) + (n.sweepAngle ?? 360)) * Math.PI / 180, e = -(n.startAngle || 0) * Math.PI / 180;
      (node as EllipseNode).arcData = { startingAngle: Math.min(s, e), endingAngle: Math.max(s, e), innerRadius: n.innerRadius || 0 };
    }
    common(node, n, ctx);
    parent.appendChild(node);
    size(node, n, b, parent);
    place(node, n, b, parent);
    return node;
  }
  if (n.type === "path") {
    const w = b ? b[2] : n.width || 1, h = b ? b[3] : n.height || 1;
    const rule = n.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "";
    const path = `<path d="${n.geometry || ""}"${rule} fill="#000"/>`;
    let f: FrameNode | VectorNode;
    if (n.viewBox) f = svgNode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n.viewBox.join(" ")}" width="${w}" height="${h}" preserveAspectRatio="none">${path}</svg>`, w, h);
    else {
      // No viewBox: the geometry's tight bbox maps onto the node box.
      const wrap = figma.createNodeFromSvg(`<svg xmlns="http://www.w3.org/2000/svg">${path}</svg>`);
      const vs = wrap.findAll(c => c.type === "VECTOR");
      if (vs.length === 1) { f = vs[0] as VectorNode; parent.appendChild(f); if (!wrap.removed) wrap.remove(); f.resize(Math.max(w, 0.01), Math.max(h, 0.01)); }
      else { f = wrap; f.fills = []; f.clipsContent = false; f.resize(Math.max(w, 0.01), Math.max(h, 0.01)); }
    }
    node = f;
    const vectors = f.type === "VECTOR" ? [f] : f.findAll(c => c.type === "VECTOR");
    for (const v of vectors) {
      (v as VectorNode).fills = paints(n.fill, ctx.images);
      strokes(v, n, ctx);
    }
    node.name = n.name && !GENERIC.has(n.name) ? n.name : "Vector";
    if (n.opacity !== undefined) node.opacity = n.opacity;
    if (n.enabled === false) node.visible = false;
    effects(node, n);
    if (node.parent !== parent) parent.appendChild(node);
    if (isAL(parent)) { (node as FrameNode).layoutSizingHorizontal = "FIXED"; (node as FrameNode).layoutSizingVertical = "FIXED"; }
    place(node, n, b, parent);
    return node;
  }
  if (n.type === "icon") {
    const w = b ? b[2] : n.width || 24, h = b ? b[3] : n.height || 24;
    const src = ctx.icons[`${n.library || "lucide"}:${n.icon}`];
    const color = typeof n.fill === "string" ? n.fill : "#000000";
    let f: FrameNode;
    if (src) f = svgNode(src.replace(/<!--[\s\S]*?-->/, "").replace(/width="\d+"/, `width="${w}"`).replace(/height="\d+"/, `height="${h}"`).replace(/currentColor/g, color.slice(0, 7)), w, h);
    else { f = figma.createFrame(); f.fills = []; f.resize(w, h); }
    if (src && color.length === 9) f.opacity = rgba(color).a;
    f.name = `icon/${n.icon || "unknown"}`;
    if (n.opacity !== undefined) f.opacity = n.opacity;
    effects(f, n);
    parent.appendChild(f);
    if (isAL(parent)) { f.layoutSizingHorizontal = "FIXED"; f.layoutSizingVertical = "FIXED"; }
    place(f, n, b, parent);
    return f;
  }
  warn(`Pen ${n.type} nodes skipped`);
  return null;
}

// ---------- copy ----------
function target(): { parent: BaseNode & ChildrenMixin; x: number; y: number | null } {
  // Anchor on the selected nodes' top-level ancestors (direct children of the page or a section).
  const top = (n: SceneNode): SceneNode => (n.parent!.type === "PAGE" || n.parent!.type === "SECTION" ? n : top(n.parent as SceneNode));
  const sel = [...new Set(figma.currentPage.selection.map(top))];
  if (sel.length) {
    const right = Math.max(...sel.map(s => s.x + s.width));
    const y = Math.min(...sel.map(s => s.y));
    return { parent: sel[0].parent as BaseNode & ChildrenMixin, x: right + GAP, y };
  }
  return { parent: figma.currentPage, x: figma.viewport.center.x, y: null };
}

async function copy(data: Payload) {
  warnings = [...data.warnings];
  const t0 = Date.now();
  const { parent, x, y } = target();
  const made: SceneNode[] = [];
  let cursor = x;
  const before = new Set(parent.children);
  for (const fr of data.frames) {
    let root: SceneNode | null;
    try { root = await build(fr.tree, parent, { bounds: fr.bounds, icons: data.icons, images: data.images }); }
    catch (e) {
      // Don't leave half-built copies behind.
      for (const c of parent.children) if (!before.has(c)) c.remove();
      throw e;
    }
    if (!root) continue;
    root.setPluginData("penFile", data.file);
    root.setPluginData("penId", fr.id);
    root.x = cursor;
    cursor += root.width + GAP;
    made.push(root);
  }
  // Without a selection the row is centred in the viewport.
  if (y === null && made.length) {
    const shift = (cursor - GAP - x) / 2;
    const top = figma.viewport.center.y - Math.max(...made.map(m => m.height)) / 2;
    for (const m of made) { m.x -= shift; m.y = top; }
  } else for (const m of made) m.y = y!;
  figma.currentPage.selection = made;
  if (made.length) figma.viewport.scrollAndZoomIntoView(made);
  if (DEBUG) for (const m of made) {
    const png = await m.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
    figma.ui.postMessage({ type: "snapshot", name: m.getPluginData("penId"), png: figma.base64Encode(png) });
  }
  return { ms: Date.now() - t0, copies: made.map(m => ({ id: m.id, name: m.name })), warnings };
}

figma.ui.onmessage = async msg => {
  if (msg.type === "copy") {
    try { figma.ui.postMessage({ type: "done", ...(await copy(msg.data)) }); }
    catch (e: any) { figma.ui.postMessage({ type: "error", error: String(e?.message || e) }); }
  } else if (msg.type === "focus") {
    const n = await figma.getNodeByIdAsync(msg.id);
    if (n && "x" in n) { figma.currentPage.selection = [n as SceneNode]; figma.viewport.scrollAndZoomIntoView([n as SceneNode]); }
  }
};
