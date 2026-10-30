"use strict";
/*
 * 南北印度星盘（纯前端 SVG 绘制，不依赖任何第三方库）。
 *
 * 用法：AstroChart.render(容器元素, 排盘结果, {style: "north" | "south"})
 *
 * 约定：
 * - 不论整宫制还是非整宫制，每一个格子永远只代表一个星座的 0°–30°（Bhava 盘例外，见 buildItems 的 chart_meta.cells）。
 *   北印度盘：最上方的菱形 = 上升点所在星座，逆时针依次排下去，格内数字 1–12 = 白羊…双鱼；
 *   南印度盘：星座位置固定（左上角双鱼，顺时针），每格右上角同样标星座数字。
 *   非整宫制时，H1…H12 宫头连同度数当作一个点放进它所在的星座。
 * - 罗睺 / 计都一定画，并投射第 5、7、9 相位。
 * - 所有文字水平正向；逆行用代号下方的红色下划线表示。
 * - 星盘只读每个点的黄经（lon），不关心它来自回归黄道还是恒星黄道。
 * - 颜色全部由 CSS 变量控制。
 *
 * 点击交互（两个方向的相位）：
 * - 点一颗行星 → 高亮它所在的星座和它投射相位到的星座（正向：它看哪里）。宫头、上升点不可点击。
 * - 点一个星座数字 → 高亮这个星座，以及从别的星座向它投射相位的行星（反向：谁在看它）。
 * - 再点一次或点空白处取消。
 * - 各行星投射哪几个相位由 options.aspects 给出（印度占星的设置里可以关掉罗睺、计都的相位），默认见 ASPECTS。
 *
 * Gochara（options.gochara = 过境盘的排盘结果）：在本命盘（Rashi）外面加一圈，放过境的行星和上升点。
 * - 外圈每一段紧贴里面同一个星座的格子，所以外圈的星座永远与本命盘一致，外圈没有宫位。
 * - 北印度盘：外圈每边三段（与里面三个格子对应），四个角按对角线分给相邻两段（与常见软件的画法相同）。
 *   南印度盘：外圈每边中间两段是梯形，四个角的格子分到整个角落（L 形），角落里的文字排在对角线上的菱形区域里。
 * - 点本命或过境的行星 → 它所在的那一层的星座高亮，它投射相位的星座里外两层都高亮。
 * - 点星座数字或外圈空白处（外圈与里面是同一个星座）→ 这个星座里外两层都高亮，
 *   里外两层向它投射相位的行星都标出来。
 *
 * ───────────────────────── 北印度盘：格内排版 ─────────────────────────
 * 格子分三类（由多边形自动识别，不按格子编号写死）：
 *   四方形（菱形）· 侧立三角形（底边竖直，尖朝左 / 右）· 正立 / 倒立三角形（底边水平，尖朝上 / 下）
 *
 * 1. 元素少时按 NORTH_RULES 的固定排法（行数组，从尖角数到底边）：
 *      四方形   ≤3 个竖排；4 个 2×2
 *      侧立三角 ≤4 个竖排
 *      正倒三角 ≤2 个竖排；3 个 1+2；4 个 1+1+2（宽的一行贴着三角形宽的底边）
 *    连续的“一行一个”的元素左边缘对齐成一列，整列居中。
 * 2. 元素更多时（规则表里没有的数量）自由排版：在所有“排成几行 / 几列”的候选里，
 *    选字号够大、与格子形状对称性最一致、最紧凑的那种（详见 chooseFreeLayout）。
 * 3. 字号：先求每个格子能“撑开”到的最大字号，再取全盘统一字号
 *    = 各格最大字号里的最小值（但不低于 FONT_UNIFORM_MIN、不高于 FONT_MAX），
 *    只有特别挤的格子才单独缩小。这样整张盘字号一致、又尽量大。
 * 4. 摆放：整块元素的中心对准格子的几何重心；放不下时移到离重心最近的可行位置。
 */
(function () {
    // ------------------------------------------------------------ 可调参数

    // Parashari 星座相位（从所在星座数起的第 n 个星座，所在星座本身算第 1 个）。
    // 这是默认值；render 的 options.aspects 可以整份替换（例如关掉罗睺 / 计都的相位）。
    const ASPECTS = {
        Su: [7], Mo: [7], Me: [7], Ve: [7],
        Ma: [4, 7, 8],
        Ju: [5, 7, 9],
        Sa: [3, 7, 10],
        Ra: [5, 7, 9],
        Ke: [5, 7, 9],
    };

    // 北印度盘格内的固定排法：键是元素个数，值是从“尖角一侧”数到“底边一侧”的每行个数。
    // 四方形没有尖角，从上往下数。没写到的个数交给自由排版。
    const NORTH_RULES = {
        square: {1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [2, 2]},
        side: {1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [1, 1, 1, 1]},
        updown: {1: [1], 2: [1, 1], 3: [1, 2], 4: [1, 1, 2]},
    };

    const FONT_FAMILY = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

    // 元素尺寸（以字号为单位）
    const LINE_H = 1.18;             // 一个元素的高度
    const GAP_X = 0.45;              // 同一行两个元素之间的水平间距
    const GAP_Y = 0.16;              // 上下两个元素之间的垂直间距
    const DEG_SCALE = 0.9;           // 度数文字相对代号的字号比例
    const CODE_DEG_GAP = 0.24;       // 代号与度数之间的空隙

    // 南北两种星盘共用的字号。两种盘都是 560 × 560 的正方形 viewBox（南印度盘 4 × 4 格，每格 140），
    // 页面上以同样大小显示，所以同一个字号在两种盘里看起来一样大。
    const ITEM_FONT_MAX = 20;        // 元素（行星、宫头）的字号上限；挤的格子会自动缩小
    const SIGN_NUM_SIZE = 15;        // 星座数字的字号

    // 北印度盘（viewBox 边长 = 南印度盘的宽度）
    const SOUTH_COL_W = 140;         // 南印度盘每列宽度（4 列）
    const NORTH_SIZE = SOUTH_COL_W * 4;
    const FONT_MAX = ITEM_FONT_MAX;
    const FONT_UNIFORM_MIN = 16;     // 全盘统一字号的下限：低于它的格子单独缩小，不拖累别的格子
    const FONT_MIN = 7;              // 最挤的格子最小缩到多少
    const NORTH_PAD = 4;             // 文字与格子边线的最小距离
    const MAX_PER_LINE = 4;          // 自由排版时一行 / 一列最多几个元素
    // 自由排版：为了更对称、更紧凑的排法，最多愿意把字号缩到最佳字号的多少倍。
    const READABLE_RATIO = 0.72;
    // 自由排版：两种排法的紧凑程度相差不到这个比例，就算一样紧凑。
    const INERTIA_TOLERANCE = 0.12;
    const MAX_CANDIDATES = 800;

    // 南印度盘
    const SOUTH_FONT = ITEM_FONT_MAX;
    const SOUTH_PAD_X = 8;           // 元素与格子左右边线的最小距离
    const SOUTH_PAD_Y = 6;           // 元素与格子上下边线（以及右上角星座数字）的最小距离
    const SOUTH_FONT_MIN = 8;        // 一个格子挤得再满，元素也不小于这个字号

    const PLANET_NAMES = {
        Su: "太阳", Mo: "月亮", Me: "水星", Ve: "金星", Ma: "火星", Ju: "木星", Sa: "土星",
        Ra: "罗睺", Ke: "计都",
    };
    const SIGN_NAMES = ["白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼"];

    const EPS = 1e-6;

    // ------------------------------------------------------------ 小工具

    const SVG_NS = "http://www.w3.org/2000/svg";

    function el(tag, attrs = {}, parent = null) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v !== undefined && v !== null) node.setAttribute(k, String(v));
        }
        if (parent) parent.appendChild(node);
        return node;
    }

    function norm360(x) {
        return ((Number(x) % 360) + 360) % 360;
    }

    function signOf(lon) {
        return Math.floor(norm360(lon) / 30) % 12;
    }

    // 星座内度数，只到角分；截断而不是四舍五入，避免 29°59.9′ 显示成 30°00′。
    function degLabel(lon) {
        const totalMin = Math.floor((norm360(lon) % 30) * 60 + 1e-7);
        return `${Math.floor(totalMin / 60)}°${String(totalMin % 60).padStart(2, "0")}'`;
    }

    const measureCtx = document.createElement("canvas").getContext("2d");
    const measureCache = new Map();

    // 文字在字号 1 时的宽度（字宽与字号成正比，所以只量一次）。
    function unitTextWidth(text, weight = 400) {
        const key = `${text}|${weight}`;
        let w = measureCache.get(key);
        if (w === undefined) {
            measureCtx.font = `${weight} 100px ${FONT_FAMILY}`;
            w = measureCtx.measureText(text).width * 1.03 / 100;   // 3% 余量，抵消字体渲染差异
            measureCache.set(key, w);
        }
        return w;
    }

    function codeUnitWidth(item) {
        return unitTextWidth(item.code, 700);
    }

    // 一个元素“Su 12°34'”在字号 1 时的宽度。
    function itemUnitWidth(item) {
        return codeUnitWidth(item) + CODE_DEG_GAP + unitTextWidth(item.deg, 400) * DEG_SCALE;
    }

    // ------------------------------------------------------------ 数据准备

    // 把排盘结果整理成“点”的列表：{key, kind, code, deg, sign, lon, retro, title}
    function buildItems(results) {
        const items = [];
        const house = results.house_result || {};
        // 分盘（Moon、Bhava、各个 D 盘）和转宫后的 Rashi 盘由 vedic.js 换算后传进来，并附带 chart_meta：
        //   lagna_sign  以哪个星座作为第一宫（Moon = 月亮所在星座；Rashi 转宫 = 设置里选的星座）
        //   hide_cusps  不画宫头（分盘没有宫头度数）
        //   cells       {代号: 格子}：点放进哪个格子，不按黄经所在星座（Bhava 盘：格子 = 宫位）。
        //               格子仍用 0–11 编号，显示的数字也照常是 格子 + 1；度数照常按黄经显示。
        //   ranks       {代号: 数值}：同一格子里的先后（Bhava 盘：离宫头的距离）；默认按星座内度数
        //   notes       {代号: 文字}：鼠标停留时附加的说明（Bhava 盘：第几宫）
        const meta = results.chart_meta || {};
        const cells = meta.cells || {};
        const ranks = meta.ranks || {};
        const notes = meta.notes || {};
        const cellOf = (code, lon) => (Number.isInteger(cells[code]) ? cells[code] : signOf(lon));
        const noteOf = (code) => (notes[code] ? `  · ${notes[code]}` : "");
        const wholeSign = house.house_system === "Whole Sign" || Boolean(meta.hide_cusps);
        const ascLon = house.axes?.Asc?.lon;

        for (const [code, p] of Object.entries(results.planet_pos || {})) {
            if (p?.lon === undefined) continue;
            const isNode = code === "Ra" || code === "Ke";
            // 罗计永远逆行，不标；其余行星速度为负即逆行。
            const retro = !isNode && Number(p.speed) < 0;
            items.push({
                key: `P:${code}`, kind: "planet", code, retro,
                lon: norm360(p.lon), deg: degLabel(p.lon), sign: cellOf(code, p.lon), rank: ranks[code],
                title: `${code} ${PLANET_NAMES[code] || ""}${retro ? "（逆行）" : ""}  ${SIGN_NAMES[signOf(p.lon)]} ${degLabel(p.lon)}${noteOf(code)}`,
            });
        }

        const cusp1 = house.houses?.["house 1"]?.lon;
        if (ascLon !== undefined) {
            // 非整宫制下 H1 通常就等于 Asc，只有两者不同（如 Equal/MC 宫制）时才另外标出 As。
            const sameAsCusp = cusp1 !== undefined &&
                Math.abs(((norm360(ascLon) - norm360(cusp1) + 540) % 360) - 180) < 1 / 120;
            if (wholeSign || !sameAsCusp) {
                items.push({
                    key: "A:Asc", kind: "asc", code: "Asc", lon: norm360(ascLon), deg: degLabel(ascLon),
                    sign: cellOf("Asc", ascLon), rank: ranks.Asc,
                    title: `上升点 Asc  ${SIGN_NAMES[signOf(ascLon)]} ${degLabel(ascLon)}${noteOf("Asc")}`,
                });
            }
        }

        if (!wholeSign) {
            for (let n = 1; n <= 12; n++) {
                const c = house.houses?.[`house ${n}`];
                if (c?.lon === undefined) continue;
                items.push({
                    key: `H:${n}`, kind: "cusp", code: `H${n}`, lon: norm360(c.lon), deg: degLabel(c.lon), sign: signOf(c.lon),
                    title: `第 ${n} 宫宫头  ${SIGN_NAMES[signOf(c.lon)]} ${degLabel(c.lon)}`,
                });
            }
        }

        // 同一格子里按度数从小到大排，读盘顺序就是黄道顺序（给了 ranks 时按 ranks）。
        const rankOf = (it) => (Number.isFinite(it.rank) ? it.rank : it.lon % 30);
        items.sort((a, b) => a.sign - b.sign || rankOf(a) - rankOf(b));
        const bySign = Array.from({length: 12}, () => []);
        items.forEach((it) => { it.layer = "in"; bySign[it.sign].push(it); });

        return {
            bySign,
            wholeSign,
            lagnaSign: Number.isInteger(meta.lagna_sign) ? meta.lagna_sign : (ascLon !== undefined ? signOf(ascLon) : 0),
        };
    }

    // Gochara 外圈：过境盘的行星和上升点，按真实星座分进 12 段；不画宫头。
    function buildRingItems(transit) {
        const {bySign} = buildItems({...transit, chart_meta: {hide_cusps: true}});
        return bySign.map((list) => list.map((it) => ({
            ...it, key: `T:${it.key}`, layer: "out", title: `过境 · ${it.title}`,
        })));
    }

    // ------------------------------------------------------------ 相位查询

    // 第 n 个星座（所在星座算第 1 个）
    function nthSign(from, n) {
        return (from + n - 1) % 12;
    }

    // 一颗行星投射相位到哪些星座：[{sign, n}]
    function aspectsFrom(item) {
        if (item.kind !== "planet") return [];
        return (aspectTable[item.code] || []).map((n) => ({sign: nthSign(item.sign, n), n}));
    }

    // 哪些不在本星座的行星向这个星座投射相位：[{item, n}]
    function aspectsTo(data, sign) {
        const found = [];
        for (const list of allLists(data)) {
            for (const item of list) {
                if (item.kind !== "planet" || item.sign === sign) continue;
                for (const n of aspectTable[item.code] || []) {
                    if (nthSign(item.sign, n) === sign) found.push({item, n});
                }
            }
        }
        return found;
    }

    // ------------------------------------------------------------ 选中与高亮

    // 当前选中：null | {type: "item", key} | {type: "sign", sign}
    let selection = null;

    // 当前使用的相位表（render 时按 options.aspects 设定）。
    let aspectTable = ASPECTS;

    // 里层（本命）和外圈（Gochara 的过境）所有格子的元素列表。
    function allLists(data) {
        return data.ring ? [...data.bySign, ...data.ring] : data.bySign;
    }

    function findItem(data, key) {
        for (const list of allLists(data)) {
            const found = list.find((it) => it.key === key);
            if (found) return found;
        }
        return null;
    }

    function applyHighlight(svg, data) {
        let selfSign = null;
        let selfLayer = null;          // "in" 里层 / "out" 外圈 / "both" 两层（点星座时）
        let aspectSigns = new Set();
        let selectedKey = null;
        let aspectingKeys = new Set();

        if (selection?.type === "item") {
            const item = findItem(data, selection.key);
            if (item) {
                selfSign = item.sign;
                selfLayer = item.layer;
                selectedKey = item.key;
                aspectSigns = new Set(aspectsFrom(item).map((t) => t.sign));
            }
        } else if (selection?.type === "sign") {
            selfSign = selection.sign;
            selfLayer = "both";
            aspectingKeys = new Set(aspectsTo(data, selection.sign).map((s) => s.item.key));
        }

        const mark = (cell, sign, layer) => {
            const self = sign === selfSign && (selfLayer === "both" || selfLayer === layer);
            cell.classList.toggle("hl-self", self);
            cell.classList.toggle("hl-aspect", aspectSigns.has(sign) && sign !== selfSign);
        };
        svg.querySelectorAll("[data-sign-cell]").forEach((cell) => mark(cell, Number(cell.dataset.signCell), "in"));
        svg.querySelectorAll("[data-ring-cell]").forEach((cell) => mark(cell, Number(cell.dataset.ringCell), "out"));
        svg.querySelectorAll("[data-sign-num]").forEach((g) => {
            g.classList.toggle("selected", selection?.type === "sign" && Number(g.dataset.signNum) === selection.sign);
        });
        svg.querySelectorAll("[data-item-key]").forEach((g) => {
            g.classList.toggle("selected", g.dataset.itemKey === selectedKey);
            g.classList.toggle("aspecting", aspectingKeys.has(g.dataset.itemKey));
        });
    }

    // 画一个元素：“代号 度数”一行文字。(x, y) 为左上角。
    // 只有行星可以点击（查看它投射的相位）；宫头、上升点所在星座直接点星座数字即可，不再重复设点击。
    function drawItem(parent, item, x, y, size, onSelect) {
        const w = itemUnitWidth(item) * size;
        const h = LINE_H * size;
        const clickable = item.kind === "planet";
        const g = el("g", {
            class: `chart-item kind-${item.kind} layer-${item.layer || "in"}${clickable ? " clickable" : ""}`,
            "data-item-key": item.key,
        }, parent);
        el("title", {}, g).textContent = item.title;
        el("rect", {class: "item-hit", x: x - 2, y: y - 1, width: w + 4, height: h + 2, rx: 3}, g);
        if (clickable) {
            g.addEventListener("click", (event) => {
                event.stopPropagation();
                onSelect({type: "item", key: item.key});
            });
        }

        const baseline = y + h / 2 + size * 0.36;
        const t = el("text", {x, y: baseline, "font-size": size}, g);
        el("tspan", {class: "item-code"}, t).textContent = item.code;
        el("tspan", {class: "item-deg", dx: size * CODE_DEG_GAP, "font-size": size * DEG_SCALE}, t).textContent = item.deg;
        if (item.retro) {
            el("line", {
                class: "retro-mark",
                x1: x, x2: x + codeUnitWidth(item) * size,
                y1: baseline + size * 0.2, y2: baseline + size * 0.2,
                "stroke-width": Math.max(0.9, size * 0.1),
            }, g);
        }
        return g;
    }

    // 可点击的星座数字（带一个比数字大一圈的透明热区，好点中）。
    function drawSignNumber(parent, sign, x, y, size, onSelect, anchor = "middle") {
        const g = el("g", {class: "sign-num", "data-sign-num": sign}, parent);
        const hitX = anchor === "middle" ? x : x - size * 0.35;
        el("circle", {class: "sign-num-hit", cx: hitX, cy: y, r: size * 0.85}, g);
        el("text", {
            class: "sign-number", x, y: y + size * 0.36,
            "font-size": size, "text-anchor": anchor,
        }, g).textContent = String(sign + 1);
        g.addEventListener("click", (event) => {
            event.stopPropagation();
            onSelect({type: "sign", sign});
        });
        return g;
    }

    // ------------------------------------------------------------ 几何：凸多边形

    function polygonCentroid(poly) {
        let a = 0, cx = 0, cy = 0;
        for (let i = 0; i < poly.length; i++) {
            const [x1, y1] = poly[i];
            const [x2, y2] = poly[(i + 1) % poly.length];
            const cross = x1 * y2 - x2 * y1;
            a += cross;
            cx += (x1 + x2) * cross;
            cy += (y1 + y2) * cross;
        }
        return [cx / (3 * a), cy / (3 * a)];
    }

    function polygonArea(poly) {
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
            const [x1, y1] = poly[i];
            const [x2, y2] = poly[(i + 1) % poly.length];
            a += x1 * y2 - x2 * y1;
        }
        return Math.abs(a) / 2;
    }

    // 多边形 → 半平面列表 {nx, ny, d}：内部满足 nx*x + ny*y <= d（法向量朝外、单位长度）。
    function halfPlanes(poly) {
        const [cx, cy] = polygonCentroid(poly);
        const planes = [];
        for (let i = 0; i < poly.length; i++) {
            const [x1, y1] = poly[i];
            const [x2, y2] = poly[(i + 1) % poly.length];
            let nx = y2 - y1, ny = -(x2 - x1);
            const len = Math.hypot(nx, ny);
            nx /= len; ny /= len;
            let d = nx * x1 + ny * y1;
            if (nx * cx + ny * cy > d) {      // 法向量指向了内部：翻过来
                nx = -nx; ny = -ny; d = -d;
            }
            planes.push({nx, ny, d});
        }
        return planes;
    }

    // 用半平面 nx*x + ny*y <= d 裁剪凸多边形（Sutherland–Hodgman）。
    function clipPolygon(poly, nx, ny, d) {
        const out = [];
        for (let i = 0; i < poly.length; i++) {
            const p = poly[i];
            const q = poly[(i + 1) % poly.length];
            const fp = nx * p[0] + ny * p[1] - d;
            const fq = nx * q[0] + ny * q[1] - d;
            if (fp <= EPS) out.push(p);
            if ((fp < -EPS && fq > EPS) || (fp > EPS && fq < -EPS)) {
                const t = fp / (fp - fq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
        return out;
    }

    function nearestPointInPolygon(poly, pt) {
        // 点在凸多边形内（对每条边都在同一侧）：就是它自己。
        const crosses = poly.map(([x1, y1], i) => {
            const [x2, y2] = poly[(i + 1) % poly.length];
            return (x2 - x1) * (pt[1] - y1) - (y2 - y1) * (pt[0] - x1);
        });
        if (crosses.every((c) => c >= -EPS) || crosses.every((c) => c <= EPS)) return pt;
        let best = poly[0], bestD = Infinity;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2));
            const q = [a[0] + dx * t, a[1] + dy * t];
            const dd = (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2;
            if (dd < bestD) { bestD = dd; best = q; }
        }
        return best;
    }

    // 多边形自身的对称变换（在以重心为原点的坐标里）：从 8 种候选里挑出把顶点集合映射回自己的那些。
    const ALL_TRANSFORMS = [
        ([x, y]) => [x, y],
        ([x, y]) => [-x, y],      // 左右镜像
        ([x, y]) => [x, -y],      // 上下镜像
        ([x, y]) => [-x, -y],     // 旋转 180°
        ([x, y]) => [y, x],       // 对角线镜像
        ([x, y]) => [-y, -x],     // 另一条对角线镜像
        ([x, y]) => [-y, x],      // 旋转 90°
        ([x, y]) => [y, -x],      // 旋转 270°
    ];

    function sameSet(a, b, tol) {
        if (a.length !== b.length) return false;
        return a.every((p) => b.some((q) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol));
    }

    function symmetryGroup(poly) {
        const [cx, cy] = polygonCentroid(poly);
        const local = poly.map(([x, y]) => [x - cx, y - cy]);
        return ALL_TRANSFORMS.filter((f) => sameSet(local.map(f), local, 0.5));
    }

    // ------------------------------------------------------------ 北印度盘：排法与撑开

    // 把 n 拆成有序的若干份，每份 1..max。
    function compositions(n, max) {
        const out = [];
        const walk = (left, acc) => {
            if (left === 0) { out.push(acc.slice()); return; }
            for (let c = 1; c <= Math.min(max, left); c++) {
                acc.push(c); walk(left - c, acc); acc.pop();
            }
        };
        walk(n, []);
        return out;
    }

    // 抽象格点：行排法里第 i 行第 j 个 → (j - (c-1)/2, i - (r-1)/2)；列排法互换坐标轴。
    function latticePoints(family, counts) {
        const r = counts.length;
        const pts = [];
        counts.forEach((c, i) => {
            for (let j = 0; j < c; j++) {
                const along = j - (c - 1) / 2;
                const across = i - (r - 1) / 2;
                pts.push(family === "rows" ? [along, across] : [across, along]);
            }
        });
        return pts;
    }

    function symmetryOrder(points, group) {
        return group.filter((f) => sameSet(points.map(f), points, 1e-6)).length;
    }

    function inertia(points) {
        const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
        const my = points.reduce((s, p) => s + p[1], 0) / points.length;
        return points.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0);
    }

    function candidateList(n) {
        let comps = compositions(n, MAX_PER_LINE);
        if (comps.length > MAX_CANDIDATES) {
            comps = comps.filter((c) => Math.max(...c) - Math.min(...c) <= 1);
        }
        const seen = new Set();
        const list = [];
        for (const family of ["rows", "cols"]) {
            for (const counts of comps) {
                const points = latticePoints(family, counts);
                const sig = points.map((p) => `${p[0]},${p[1]}`).sort().join(";");
                if (seen.has(sig)) continue;            // 同一个格点图形只留一个（行排法优先）
                seen.add(sig);
                list.push({family, counts, points});
            }
        }
        return list;
    }

    /*
     * 在字号 = 1 时，把排法真正排出来：返回每个元素的盒子 {x, y, w, h}（以整块中心为原点）。
     * - 行排法：
     *   · 连续的“一行一个”的若干行组成一列：列内左边缘对齐，整列在整块里水平居中；
     *   · 每行个数都相同（≥2）的规整网格：按列对齐；
     *   · 其它多元素行：每行水平居中。
     * - 列排法：每列在整块里垂直居中；同一列里的元素左边缘对齐。
     */
    function unitBoxes(cand, widths) {
        const {family, counts} = cand;
        const boxes = [];
        if (family === "rows") {
            const starts = [];
            let k = 0;
            counts.forEach((c) => { starts.push(k); k += c; });

            // 每个“单元素行”所在的那一段连续单元素行的最大宽度
            const runW = counts.map(() => 0);
            for (let i = 0; i < counts.length;) {
                if (counts[i] !== 1) { i++; continue; }
                let j = i;
                while (j < counts.length && counts[j] === 1) j++;
                const w = Math.max(...counts.slice(i, j).map((_, t) => widths[starts[i + t]]));
                for (let t = i; t < j; t++) runW[t] = w;
                i = j;
            }

            const grid = counts.length > 1 && counts[0] > 1 && counts.every((c) => c === counts[0]);
            const colW = grid
                ? Array.from({length: counts[0]}, (_, j) => Math.max(...counts.map((c, i) => widths[starts[i] + j])))
                : null;

            counts.forEach((c, i) => {
                const y = i * (LINE_H + GAP_Y);
                const ws = widths.slice(starts[i], starts[i] + c);
                if (c === 1) {
                    boxes.push({x: -runW[i] / 2, y, w: ws[0], h: LINE_H});
                } else if (grid) {
                    let x = -(colW.reduce((s, w) => s + w, 0) + GAP_X * (c - 1)) / 2;
                    ws.forEach((w, j) => {
                        boxes.push({x, y, w, h: LINE_H});
                        x += colW[j] + GAP_X;
                    });
                } else {
                    let x = -(ws.reduce((s, w) => s + w, 0) + GAP_X * (c - 1)) / 2;
                    ws.forEach((w) => {
                        boxes.push({x, y, w, h: LINE_H});
                        x += w + GAP_X;
                    });
                }
            });
        } else {
            let k = 0;
            const cols = counts.map((c) => {
                const ws = widths.slice(k, k + c);
                k += c;
                return ws;
            });
            const colW = cols.map((ws) => Math.max(...ws));
            const maxH = Math.max(...counts) * (LINE_H + GAP_Y) - GAP_Y;
            let x = -(colW.reduce((s, w) => s + w, 0) + GAP_X * (cols.length - 1)) / 2;
            cols.forEach((ws, i) => {
                const colH = ws.length * (LINE_H + GAP_Y) - GAP_Y;
                let y = (maxH - colH) / 2;
                ws.forEach((w) => {
                    boxes.push({x, y, w, h: LINE_H});
                    y += LINE_H + GAP_Y;
                });
                x += colW[i] + GAP_X;
            });
        }
        // 以整块的外接矩形中心为原点
        const x0 = Math.min(...boxes.map((b) => b.x));
        const x1 = Math.max(...boxes.map((b) => b.x + b.w));
        const y0 = Math.min(...boxes.map((b) => b.y));
        const y1 = Math.max(...boxes.map((b) => b.y + b.h));
        const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
        return boxes.map((b) => ({...b, x: b.x - ox, y: b.y - oy}));
    }

    // 每个半平面方向上，整块盒子在字号 1 时伸出去最远的距离。
    function reachPerPlane(boxes, planes) {
        return planes.map(({nx, ny}) => {
            let m = -Infinity;
            for (const b of boxes) {
                const xs = nx >= 0 ? b.x + b.w : b.x;
                const ys = ny >= 0 ? b.y + b.h : b.y;
                m = Math.max(m, nx * xs + ny * ys);
            }
            return m;
        });
    }

    // 字号为 size 时，整块中心可以放置的区域（凸多边形，空数组 = 放不下）。
    function feasibleRegion(cell, reach, size) {
        let region = cell.bounds;
        for (let i = 0; i < cell.planes.length && region.length; i++) {
            const {nx, ny, d} = cell.planes[i];
            region = clipPolygon(region, nx, ny, d - NORTH_PAD - reach[i] * size);
        }
        return region.length >= 3 ? region : [];
    }

    function maxFont(cell, reach, lo, hi) {
        if (!feasibleRegion(cell, reach, lo).length) return 0;
        if (feasibleRegion(cell, reach, hi).length) return hi;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (feasibleRegion(cell, reach, mid).length) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function evaluate(cell, cand, widths) {
        const boxes = unitBoxes(cand, widths);
        const reach = reachPerPlane(boxes, cell.planes);
        return {...cand, boxes, reach, fit: maxFont(cell, reach, FONT_MIN, FONT_MAX)};
    }

    // 规则表里的排法（从尖角数到底边）→ 从上往下的行数组。
    function ruleCounts(cell, n) {
        const counts = NORTH_RULES[cell.type]?.[n];
        if (!counts) return null;
        return cell.apexDown ? counts.slice().reverse() : counts.slice();
    }

    /*
     * 自由排版（元素数量超出 NORTH_RULES 时）：
     * ① 只看字号不明显变小（≥ 最佳字号 × READABLE_RATIO）的候选；
     * ② 选与格子对称性最一致的（菱形 8 种对称，正倒三角只有左右镜像，侧立三角只有上下镜像）；
     * ③ 再选最紧凑的（格点相对重心的转动惯量最小）；
     * ④ 最后比字号、撑开的极限字号、留白。
     */
    function chooseFreeLayout(cell, widths) {
        const scored = [];
        for (const cand of candidateList(widths.length)) {
            const e = evaluate(cell, cand, widths);
            if (!e.fit) continue;
            e.sym = symmetryOrder(cand.points, cell.group);
            e.inertia = inertia(cand.points);
            scored.push(e);
        }
        if (!scored.length) return null;

        const bestFit = Math.max(...scored.map((c) => c.fit));
        let pool = scored.filter((c) => c.fit >= bestFit * READABLE_RATIO - EPS);
        const topSym = Math.max(...pool.map((c) => c.sym));
        pool = pool.filter((c) => c.sym === topSym);
        const minInertia = Math.min(...pool.map((c) => c.inertia));
        pool = pool.filter((c) => c.inertia <= minInertia * (1 + INERTIA_TOLERANCE) + EPS);
        for (const c of pool) {
            c.limit = c.fit < FONT_MAX ? c.fit : maxFont(cell, c.reach, FONT_MAX, FONT_MAX * 6);
            c.room = polygonArea(feasibleRegion(cell, c.reach, c.fit * 0.9));
        }
        pool.sort((a, b) =>
            (Math.abs(b.fit - a.fit) > 0.05 ? b.fit - a.fit : 0) ||
            (Math.abs(b.limit - a.limit) > 0.05 ? b.limit - a.limit : 0) ||
            (b.room - a.room)
        );
        return pool[0];
    }

    // 一个格子的排法：先查规则表，规则表没有（或连最小字号都放不下）才自由排版。
    function layoutNorthCell(cell, items) {
        const widths = items.map(itemUnitWidth);
        const counts = ruleCounts(cell, items.length);
        if (counts) {
            const e = evaluate(cell, {family: "rows", counts, points: latticePoints("rows", counts)}, widths);
            if (e.fit) return e;
        }
        return chooseFreeLayout(cell, widths);
    }

    // 中心优先：整块中心尽量对准格子重心；放不下时移到离重心最近的可行位置。
    function placeNorthCell(cell, layout, size) {
        const region = feasibleRegion(cell, layout.reach, size);
        return region.length ? nearestPointInPolygon(region, cell.target) : cell.target;
    }

    // ------------------------------------------------------------ 北印度盘

    function northGeometry(S) {
        const h = S / 2;
        const q = S / 4;
        const P = {
            TL: [0, 0], TR: [S, 0], BR: [S, S], BL: [0, S],
            T: [h, 0], R: [S, h], B: [h, S], L: [0, h], C: [h, h],
            Q1: [q, q], Q2: [S - q, q], Q3: [S - q, S - q], Q4: [q, S - q],
        };
        // 第 1–12 格（从最上方的菱形开始逆时针），anchor = 放星座数字的“朝向中心的尖角”。
        return [
            {poly: [P.T, P.Q2, P.C, P.Q1], anchor: P.C},
            {poly: [P.TL, P.T, P.Q1], anchor: P.Q1},
            {poly: [P.TL, P.Q1, P.L], anchor: P.Q1},
            {poly: [P.L, P.Q1, P.C, P.Q4], anchor: P.C},
            {poly: [P.L, P.Q4, P.BL], anchor: P.Q4},
            {poly: [P.BL, P.Q4, P.B], anchor: P.Q4},
            {poly: [P.B, P.Q4, P.C, P.Q3], anchor: P.C},
            {poly: [P.B, P.Q3, P.BR], anchor: P.Q3},
            {poly: [P.BR, P.Q3, P.R], anchor: P.Q3},
            {poly: [P.R, P.Q3, P.C, P.Q2], anchor: P.C},
            {poly: [P.R, P.Q2, P.TR], anchor: P.Q2},
            {poly: [P.TR, P.Q2, P.T], anchor: P.Q2},
        ];
    }

    // 识别格子类型：四方形 / 侧立三角（底边竖直）/ 正倒三角（底边水平），以及尖角朝向。
    function classifyCell(box) {
        if (box.poly.length === 4) return {type: "square", apexDown: false};
        const base = box.poly.filter((p) => p[0] !== box.anchor[0] || p[1] !== box.anchor[1]);
        if (Math.abs(base[0][0] - base[1][0]) < EPS) return {type: "side", apexDown: false};
        // 底边水平：尖角在底边下方 = 倒立三角（尖朝下），从上往下应当先排宽的一行。
        return {type: "updown", apexDown: box.anchor[1] > base[0][1]};
    }

    // 为一个格子准备排版所需的几何信息（类型、星座数字位置、可用区域、对称群、重心）。
    function prepareNorthCell(box) {
        const target = polygonCentroid(box.poly);
        const dx = target[0] - box.anchor[0];
        const dy = target[1] - box.anchor[1];
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const dist = box.poly.length === 4 ? 15 : 14;
        const numPos = [box.anchor[0] + ux * dist, box.anchor[1] + uy * dist];
        // 切掉星座数字所在的尖角：只保留 (p - anchor)·u >= dist + 半个数字 + 1 的部分。
        const cut = dist + SIGN_NUM_SIZE * 0.55 + 1;
        const planes = halfPlanes(box.poly);
        planes.push({nx: -ux, ny: -uy, d: -(ux * box.anchor[0] + uy * box.anchor[1] + cut) + NORTH_PAD});
        const xs = box.poly.map((p) => p[0]), ys = box.poly.map((p) => p[1]);
        const bounds = [
            [Math.min(...xs) - 1, Math.min(...ys) - 1], [Math.max(...xs) + 1, Math.min(...ys) - 1],
            [Math.max(...xs) + 1, Math.max(...ys) + 1], [Math.min(...xs) - 1, Math.max(...ys) + 1],
        ];
        return {
            ...classifyCell(box),
            poly: box.poly, planes, bounds, group: symmetryGroup(box.poly), target, numPos,
        };
    }

    function renderNorth(svg, data, onSelect) {
        const S = NORTH_SIZE;
        const T = data.ring ? RING_T : 0;
        const W = S + 2 * T;
        svg.setAttribute("viewBox", `-2 -2 ${W + 4} ${W + 4}`);
        const ringLayer = data.ring ? el("g", {class: "ring"}, svg) : null;
        const inner = el("g", T ? {transform: `translate(${T},${T})`} : {}, svg);
        const cellLayer = el("g", {class: "cells"}, inner);
        const labels = el("g", {class: "labels"}, inner);

        const cells = northGeometry(S).map((box, i) => {
            const sign = (data.lagnaSign + i) % 12;
            const cell = prepareNorthCell(box);
            const items = data.bySign[sign];
            return {sign, cell, items, layout: items.length ? layoutNorthCell(cell, items) : null};
        });
        // 外圈第 i 段紧贴里面第 i 个格子（第 i+1 宫），所以是同一个星座。
        const ring = data.ring
            ? northRingGeometry(S, T).map((poly, i) => ringCell(poly, poly, (data.lagnaSign + i) % 12, data.ring, [T, T + S]))
            : [];

        // 全盘统一字号：各格能撑开的最大字号里取最小，再夹在 [FONT_UNIFORM_MIN, FONT_MAX] 之间（里外两层一起算）。
        const fits = [...cells, ...ring].filter((c) => c.layout).map((c) => c.layout.fit);
        const uniform = Math.min(FONT_MAX, Math.max(FONT_UNIFORM_MIN, fits.length ? Math.min(...fits) : FONT_MAX));

        for (const {sign, cell, items, layout} of cells) {
            el("polygon", {
                class: "sign-cell", "data-sign-cell": sign,
                points: cell.poly.map((p) => p.join(",")).join(" "),
            }, cellLayer);
            drawSignNumber(labels, sign, cell.numPos[0], cell.numPos[1], SIGN_NUM_SIZE, onSelect);
            drawCellItems(labels, cell, items, layout, uniform, onSelect);
        }
        if (ringLayer) drawRing(ringLayer, ring, uniform, onSelect);
    }

    // 按排法把一个格子里的元素画出来（北印度盘的格子和 Gochara 外圈的每一段共用）。
    function drawCellItems(parent, cell, items, layout, uniform, onSelect) {
        if (!items.length) return;
        if (!layout) {
            drawFallback(parent, cell, items, onSelect);
            return;
        }
        const size = Math.min(layout.fit, uniform);
        const origin = placeNorthCell(cell, layout, size);
        layout.boxes.forEach((b, k) => {
            drawItem(parent, items[k], origin[0] + b.x * size, origin[1] + b.y * size, size, onSelect);
        });
    }

    // ------------------------------------------------------------ Gochara 外圈

    const RING_T = 96;               // 外圈的宽度（viewBox 单位；里面的星盘仍是 560 × 560）。南印度盘要求 > 140 - SOUTH_RING_SLANT
    const SOUTH_RING_SLANT = 56;     // 南印度盘外圈：角落与中间两段的分界线向角落倾斜多少（让角落多分一些地方）

    // 北印度盘外圈：12 段，顺序与 northGeometry 相同（第 1 宫在上方正中，逆时针）。
    // 每边按里面星盘的三等分点切三段，四个角沿对角线分给相邻的两段。每一段都是凸四边形。
    function northRingGeometry(S, T) {
        const E = S + 2 * T;
        const a = T + S / 3, b = T + (2 * S) / 3, i0 = T, i1 = T + S;
        return [
            [[a, 0], [b, 0], [b, i0], [a, i0]],           // 1 上中
            [[0, 0], [a, 0], [a, i0], [i0, i0]],          // 2 上左
            [[0, 0], [i0, i0], [i0, a], [0, a]],          // 3 左上
            [[0, a], [i0, a], [i0, b], [0, b]],           // 4 左中
            [[0, b], [i0, b], [i0, i1], [0, E]],          // 5 左下
            [[0, E], [i0, i1], [a, i1], [a, E]],          // 6 下左
            [[a, i1], [b, i1], [b, E], [a, E]],           // 7 下中
            [[b, i1], [i1, i1], [E, E], [b, E]],          // 8 下右
            [[i1, b], [E, b], [E, E], [i1, i1]],          // 9 右下
            [[i1, a], [E, a], [E, b], [i1, b]],           // 10 右中
            [[i1, i0], [E, 0], [E, a], [i1, a]],          // 11 右上
            [[b, 0], [E, 0], [i1, i0], [b, i0]],          // 12 上右
        ];
    }

    /*
     * 南印度盘外圈：{星座: {poly 画出来的形状, layout 排文字用的凸多边形}}。
     * 先算上边的三段（左上角、上边第 2、第 3 格），再顺时针旋转 90° 得到另外三边。
     * 角落的形状是 L 形（不是凸的），文字排在对角线上的菱形里；中间两段是梯形。
     */
    function southRingGeometry(C, T) {
        const E = 4 * C + 2 * T;
        const X1 = T + C, X2 = T + 2 * C, X3 = T + 3 * C, s = SOUTH_RING_SLANT;
        const top = [
            {   // 左上角（双鱼）
                poly: [[0, 0], [X1 - s, 0], [X1, T], [T, T], [T, X1], [0, X1 - s]],
                layout: [[0, 0], [X1 - s, 0], [T, T], [0, X1 - s]],
            },
            {poly: [[X1 - s, 0], [X2, 0], [X2, T], [X1, T]]},     // 白羊
            {poly: [[X2, 0], [X3 + s, 0], [X3, T], [X2, T]]},     // 金牛
        ];
        const rotate = (pts, k) => pts.map(([x, y]) => {
            for (let i = 0; i < k; i++) [x, y] = [E - y, x];
            return [x, y];
        });
        const out = {};
        // 顺时针：上边 双鱼 白羊 金牛；右边 双子 巨蟹 狮子；下边 处女 天秤 天蝎；左边 射手 摩羯 水瓶
        for (let side = 0; side < 4; side++) {
            top.forEach((piece, j) => {
                const sign = (11 + side * 3 + j) % 12;
                out[sign] = {poly: rotate(piece.poly, side), layout: rotate(piece.layout || piece.poly, side)};
            });
        }
        return out;
    }

    // 外圈的一段：排版用的几何信息 + 这一段里的过境元素及其排法。
    // 星座数字放在这一段紧贴里面星盘的那条边（角落的那一段是里面的角点）的中点外侧，与里面的数字同样大小、同样可点；
    // 排文字时把数字那一条切掉，元素不会压到数字。inner = 里面星盘的 [起点, 终点] 坐标。
    function ringCell(poly, layoutPoly, sign, ringItems, inner) {
        const xs = layoutPoly.map((p) => p[0]), ys = layoutPoly.map((p) => p[1]);
        const onInner = layoutPoly.filter(([x, y]) =>
            x >= inner[0] - EPS && x <= inner[1] + EPS && y >= inner[0] - EPS && y <= inner[1] + EPS);
        const mid = [onInner.reduce((t, p) => t + p[0], 0) / onInner.length, onInner.reduce((t, p) => t + p[1], 0) / onInner.length];
        const center = polygonCentroid(layoutPoly);
        const len = Math.hypot(center[0] - mid[0], center[1] - mid[1]) || 1;
        const ux = (center[0] - mid[0]) / len, uy = (center[1] - mid[1]) / len;
        const dist = onInner.length > 1 ? 12 : 16;
        const numPos = [mid[0] + ux * dist, mid[1] + uy * dist];
        const cut = dist + SIGN_NUM_SIZE * 0.9;      // 两位数的数字横着也不会碰到元素
        const planes = halfPlanes(layoutPoly);
        planes.push({nx: -ux, ny: -uy, d: -(ux * mid[0] + uy * mid[1] + cut) + NORTH_PAD});
        const cell = {
            type: "ring", apexDown: false,
            poly: layoutPoly,
            numPos,
            planes,
            bounds: [
                [Math.min(...xs) - 1, Math.min(...ys) - 1], [Math.max(...xs) + 1, Math.min(...ys) - 1],
                [Math.max(...xs) + 1, Math.max(...ys) + 1], [Math.min(...xs) - 1, Math.max(...ys) + 1],
            ],
            group: symmetryGroup(layoutPoly),
            target: polygonCentroid(layoutPoly),
        };
        const items = ringItems[sign];
        return {sign, poly, cell, items, layout: items.length ? layoutNorthCell(cell, items) : null};
    }

    // 画外圈：先画每一段（空白处也可以点：等于点这个星座），再画星座数字和过境的元素。
    function drawRing(layer, ring, uniform, onSelect) {
        const polys = el("g", {class: "ring-cells"}, layer);
        const labels = el("g", {class: "labels"}, layer);
        for (const {sign, poly, cell, items, layout} of ring) {
            const shape = el("polygon", {
                class: "ring-cell", "data-ring-cell": sign,
                points: poly.map((p) => p.join(",")).join(" "),
            }, polys);
            shape.addEventListener("click", (event) => {
                event.stopPropagation();
                onSelect({type: "sign", sign});
            });
            drawSignNumber(labels, sign, cell.numPos[0], cell.numPos[1], SIGN_NUM_SIZE, onSelect);
            drawCellItems(labels, cell, items, layout, uniform, onSelect);
        }
    }

    // 极端情况（一个星座里塞了太多点，最小字号也放不下）才会走到这里：最小字号一行一个居中画出。
    function drawFallback(parent, cell, items, onSelect) {
        const size = FONT_MIN;
        const pitch = (LINE_H + GAP_Y) * size;
        const colW = Math.max(...items.map((it) => itemUnitWidth(it) * size));
        let y = cell.target[1] - (items.length * pitch) / 2;
        for (const item of items) {
            drawItem(parent, item, cell.target[0] - colW / 2, y, size, onSelect).classList.add("overflow");
            y += pitch;
        }
    }

    // ------------------------------------------------------------ 南印度盘

    // 星座索引 → [行, 列]；左上角双鱼，顺时针。
    const SOUTH_POS = {
        11: [0, 0], 0: [0, 1], 1: [0, 2], 2: [0, 3],
        3: [1, 3], 4: [2, 3], 5: [3, 3], 6: [3, 2],
        7: [3, 1], 8: [3, 0], 9: [2, 0], 10: [1, 0],
    };

    /*
     * 南印度盘：与北印度盘同样大小的正方形（4 × 4 格，中间 2 × 2 空着），格子大小固定，不随内容伸缩。
     * 格内：每行一个元素，所有元素左边缘对齐成一列，整列在格子里水平、垂直居中；
     * 只有一个元素时，列宽就是它自己的宽度，于是它本身居中。
     * 字号与北印度盘相同（ITEM_FONT_MAX）；某个格子元素太多、放不下时，只把这个格子的字号缩小。
     */
    function renderSouth(svg, data, onSelect) {
        const W = SOUTH_COL_W;
        const T = data.ring ? RING_T : 0;
        const total = W * 4 + 2 * T;
        svg.setAttribute("viewBox", `-2 -2 ${total + 4} ${total + 4}`);
        if (data.ring) {
            const geo = southRingGeometry(W, T);
            // 南印度盘星座位置固定（转宫只移动斜线），外圈每一段也固定对着同一个星座
            const ring = Array.from({length: 12}, (_, sign) => ringCell(geo[sign].poly, geo[sign].layout, sign, data.ring, [T, T + W * 4]));
            const fits = ring.filter((c) => c.layout).map((c) => c.layout.fit);
            const uniform = Math.min(FONT_MAX, Math.max(FONT_UNIFORM_MIN, fits.length ? Math.min(...fits) : FONT_MAX));
            drawRing(el("g", {class: "ring"}, svg), ring, uniform, onSelect);
        }
        const inner = el("g", T ? {transform: `translate(${T},${T})`} : {}, svg);

        const cells = el("g", {class: "cells"}, inner);
        const labels = el("g", {class: "labels"}, inner);
        el("rect", {class: "center-box", x: W, y: W, width: W * 2, height: W * 2}, cells);

        // 右上角星座数字占掉的高度：元素列的上下各留出这么多，列居中时就不会碰到数字。
        const numberBand = SIGN_NUM_SIZE + SOUTH_PAD_Y;

        for (let s = 0; s < 12; s++) {
            const [r, c] = SOUTH_POS[s];
            const x = c * W;
            const y = r * W;
            el("rect", {class: "sign-cell", "data-sign-cell": s, x, y, width: W, height: W}, cells);
            if (s === data.lagnaSign) {
                // 传统写法：上升星座的格子左上角画一道斜线。
                el("line", {class: "lagna-mark", x1: x, y1: y + 16, x2: x + 16, y2: y}, labels);
            }
            // 星座数字：右上角，右对齐。
            drawSignNumber(labels, s, x + W - 7, y + 5 + SIGN_NUM_SIZE * 0.5, SIGN_NUM_SIZE, onSelect, "end");

            const items = data.bySign[s];
            if (!items.length) continue;
            const widest = Math.max(...items.map(itemUnitWidth));
            const heightUnits = items.length * (LINE_H + GAP_Y) - GAP_Y;
            // 字号 = 上限；宽度或高度放不下时，只缩小这一个格子。
            const size = Math.max(SOUTH_FONT_MIN, Math.min(
                SOUTH_FONT,
                (W - 2 * SOUTH_PAD_X) / widest,
                (W - 2 * numberBand) / heightUnits,
            ));
            const pitch = (LINE_H + GAP_Y) * size;
            const left = x + (W - widest * size) / 2;                    // 整列水平居中
            let top = y + (W - heightUnits * size) / 2;                  // 整列垂直居中
            for (const item of items) {
                drawItem(labels, item, left, top, size, onSelect);       // 列内左缘对齐
                top += pitch;
            }
        }
    }

    // ------------------------------------------------------------ 对外接口

    function render(container, results, options = {}) {
        const style = options.style === "south" ? "south" : "north";
        container.innerHTML = "";
        if (!results || !results.planet_pos || !results.house_result) {
            const p = document.createElement("p");
            p.className = "chart-empty";
            p.textContent = options.emptyText || "排盘后显示星盘";
            container.appendChild(p);
            return null;
        }

        aspectTable = options.aspects || ASPECTS;
        const data = buildItems(results);
        if (options.gochara) data.ring = buildRingItems(options.gochara);
        if (selection?.type === "item" && !findItem(data, selection.key)) selection = null;

        const svg = el("svg", {
            class: `astro-chart ${style}${data.ring ? " gochara" : ""}`, xmlns: SVG_NS, role: "img",
            "aria-label": `${style === "north" ? "北印度星盘" : "南印度星盘"}${data.ring ? "（外圈为过境）" : ""}`,
            "font-family": FONT_FAMILY,
        });
        container.append(svg);

        const onSelect = (target) => {
            const same = selection && selection.type === target.type &&
                (target.type === "item" ? selection.key === target.key : selection.sign === target.sign);
            selection = same ? null : target;
            applyHighlight(svg, data);
        };
        svg.addEventListener("click", () => {
            selection = null;
            applyHighlight(svg, data);
        });

        if (style === "north") renderNorth(svg, data, onSelect);
        else renderSouth(svg, data, onSelect);

        applyHighlight(svg, data);
        return data;
    }

    function clearSelection() {
        selection = null;
    }

    window.AstroChart = {
        render,
        clearSelection,
        // 仅供调试 / 测试：查看某个格子会选出哪种排法。
        _debug: {northGeometry, northRingGeometry, southRingGeometry, prepareNorthCell, layoutNorthCell, placeNorthCell, aspectsTo},
        DEFAULT_ASPECTS: ASPECTS,
    };
})();
