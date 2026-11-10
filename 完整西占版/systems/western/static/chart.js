"use strict";
/*
 * 西方圆形星盘（纯前端 SVG 绘制，不依赖任何第三方库）。
 *
 * 用法：AstroChart.render(容器元素, 排盘结果, {emptyText, symbols, showAllStars, onError})
 *   showAllStars：true 时没有相位的恒星也画出来（颜色淡一些），默认只画有相位的恒星
 *   symbols：{planets: {Su: "☉", …}, specials: {MeanApog: "⚸", …}}（来自 /api/bootstrap 的 options）
 *   onError(message)：盘中元素太多、排不下时调用（星盘仍画出框架，但不画盘中元素）。
 *
 * 13 个同心圆（从外往里编号 1–13）：
 *   1、3、5、11、13  画出来的边界圆
 *   2                宫头的星座度数。顺着逆时针方向依次是：分、星座符号、度；离得太近时自动挤开到刚好不挨着
 *   4                恒星：默认只画与行星构成相位的恒星（showAllStars 时全部画出），一律用星号，点击看详情
 *   6–10             盘中元素（行星、小行星、特殊点、Lot）：符号、度、星座符号、分、逆行标志 R
 *   12               宫位数字
 *   宫位线           从第 13 圈画到第 5 圈
 *
 * 约定：
 * - 第 1 宫宫头永远在正左边（整宫制也一样），黄道度数沿逆时针增加。
 * - 所有文字水平正向显示，不随位置旋转。
 * - 一个盘中元素的 5 个子项排在同一条从圆心出发的射线上。两个元素的任何子项会重叠时，
 *   不单独挪动某个子项，而是调整射线之间的角度（见 spreadOnCircle）。挤不下时报“排盘错误”。
 * - 边界圆和宫位线画在最下层，盘中元素在最上层。第 5 圈内侧的短刻度标出每个元素的真实黄经。
 * - 颜色全部由 CSS 变量控制。
 *
 * 点击交互：点一个盘中元素 → 高亮它，以及与它构成相位的元素和恒星；再点一次或点空白处取消。
 *
 * 推运盘的附加内容（都在排盘结果里，没有就不画）：
 *   results.predictive.caption / results.chart_caption   星盘上方的一行说明（推运时刻、弧、地点……）
 *   results.outer_rings   星盘外面再加几圈，从里往外排：
 *     {type: "zodiac", cells: [12 × {symbol, color, title}], highlight: 星座序号, marker: 黄经 | null}
 *         每格就是一个星座（与盘面的星座对齐），格子里是这个星座的主星；highlight 那一格高亮（小限）
 *     {type: "time", segments: [{start, end, symbol, color, title, state}], marker: 0–1}
 *         一整圈代表一段时间，从上升一侧（正左）开始沿逆时针走；state 为 past / current / future（法达）
 *
 * 双盘：AstroChart.render(容器, 本命结果, {..., outer: 外圈的盘, cross: 双盘相位})
 *   内圈就是完整的本命盘（星座、宫位、恒星、盘中元素）；外圈的盘（过境 / 推运盘）的行星、小行星、特殊点、
 *   Lot 和上升、中天画在第 1 圈外面的一圈里，子项顺序与内圈对称（符号离星座圈最近）。
 *   cross = {aspects: [{a: 外圈点 id（o: 前缀）, b: 内圈点 id, ...}], outer: [点的说明], inner: [...]}；
 *   双盘时点一个元素，高亮的是与它构成双盘相位的元素。
 */
(function () {
    // ------------------------------------------------------------ 可调参数

    const SIZE = 640;
    const C = SIZE / 2;

    // 13 个同心圆的半径（从外往里）。
    // 13 个同心圆的半径（从外往里，SVG 单位，整张盘 640×640）。
    // 第 1–5 圈（宫头星座度数带、恒星带）保持不变；第 11–13 圈（宫位数字带）尽量往里收，
    // 把空间让给第 6–10 圈的盘中元素。改这里的数字时，相邻两圈的间距要放得下各自的文字。
    const R = [null, 310, 292, 274, 262, 250, 224, 192, 163, 136, 112, 96, 85, 74];
    const VISIBLE_CIRCLES = [1, 3, 5, 11, 13];
    const RING_GAP = 7;                // 外加的圈与第 1 圈之间的空隙
    const RING_WIDTH = {zodiac: 27, time: 31};
    // 双盘外圈：五个子项的半径（从里往外：符号、度、星座、分、R）、字号比例、外边界
    const OUTER_RADIUS = {6: 334, 7: 361, 8: 384, 9: 404, 10: 420};
    const OUTER_SCALE = 0.9;
    const OUTER_EDGE = 430;

    // 字号（SVG 单位，随星盘整体缩放）
    // 第 6–10 圈（盘中元素）从外往里逐级变小：符号 → 度 → 星座符号 → 分 → R，视觉重心落在符号上。
    // 星座符号按“看上去的大小”定字号（符号字体的字形比同字号的数字略小，所以字号数值比度数只小一点）。
    // 行星符号本身（symGlyph）的大小不变；星盘整体大小（SIZE）不变。
    const FONT = {
        cuspDeg: 15.5, cuspSign: 19, cuspMin: 13.5,
        star: 14,
        symGlyph: 25, symText: 15,
        deg: 17.5, sign: 17, min: 13.5, retro: 11.5,
        house: 11,
    };
    const SYM_TEXT_MAX_WIDTH = 31;     // 多个字母的符号（如 Spi、⚸T）超过这个宽度时缩小字号
    const GAP = 2.2;                   // 相邻文字之间至少留出的距离（SVG 单位）
    const TICK = 6;                    // 第 5 圈内侧真实位置刻度的长度

    const TEXT_FAMILY = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
    const SYMBOL_FAMILY = '"Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", "Apple Symbols", "DejaVu Sans", sans-serif';

    const SIGN_GLYPHS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
    const SIGN_NAMES = ["白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼"];
    const PLANET_NAMES = {
        Su: "太阳", Mo: "月亮", Me: "水星", Ve: "金星", Ma: "火星", Ju: "木星", Sa: "土星",
        Ur: "天王星", Ne: "海王星", Pl: "冥王星", Ra: "罗睺（北交点）", Ke: "计都（南交点）",
    };
    const PLANET_ORDER = ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ur", "Ne", "Pl", "Ra", "Ke"];
    const STAR_GLYPH = "✦";

    const SVG_NS = "http://www.w3.org/2000/svg";
    let selection = null;            // 当前选中的盘中元素 id
    let lastErrorResults = null;     // 同一份结果只弹一次排盘错误

    // ------------------------------------------------------------ 小工具

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

    // 占星符号后面加 U+FE0E，避免在部分系统上显示成彩色表情。
    function symText(text) {
        return String(text ?? "").replace(/[☀-➿⯐-⯿]/g, (c) => c + "︎");
    }

    function splitLon(lon) {
        const x = norm360(lon);
        let sign = Math.floor(x / 30);
        let totalMin = Math.round((x - sign * 30) * 60);
        if (totalMin >= 30 * 60) {          // 29°59.5′ 以上四舍五入进位到下一个星座
            totalMin -= 30 * 60;
            sign = (sign + 1) % 12;
        }
        return {sign, deg: Math.floor(totalMin / 60), min: totalMin % 60};
    }

    function lonText(lon) {
        const p = splitLon(lon);
        return `${SIGN_NAMES[p.sign]} ${p.deg}°${String(p.min).padStart(2, "0")}′`;
    }

    // 用 canvas 量文字宽度（与 SVG 用同一套字体），高度取字号。
    const measureCtx = document.createElement("canvas").getContext("2d");
    function textBox(text, size, family, weight = 400) {
        measureCtx.font = `${weight} ${size}px ${family}`;
        return {w: measureCtx.measureText(text).width, h: size * 1.05};
    }

    function rad(deg) {
        return deg * Math.PI / 180;
    }

    // 屏幕角度（数学方向：0° 向右，逆时针增加，y 轴向上）→ SVG 坐标。
    function polar(r, angle) {
        return [C + r * Math.cos(rad(angle)), C - r * Math.sin(rad(angle))];
    }

    // 文字框沿某个角度的切向 / 径向占用长度（文字永远水平，框不旋转）。
    function tangentialExtent(box, angle) {
        return box.w * Math.abs(Math.sin(rad(angle))) + box.h * Math.abs(Math.cos(rad(angle)));
    }

    // 两个文字框中心位于同一圆周（半径 r）上时，至少要相隔多少度才不重叠。
    function angularNeed(boxA, angleA, boxB, angleB, r) {
        const sep = tangentialExtent(boxA, angleA) / 2 + tangentialExtent(boxB, angleB) / 2 + GAP;
        return 2 * Math.asin(Math.min(1, sep / (2 * r))) * 180 / Math.PI;
    }

    // ------------------------------------------------------------ 圆周上的避让排布
    //
    // items：[{angle（真实位置，度）}]，按逆时针排好序。needFn(a, b, angleA, angleB)：a、b 相邻时至少相隔多少度。
    // 返回每一项的显示角度：在不重叠的前提下尽量贴近真实位置（相邻的挤成一团时，整团的平均偏移为 0）。
    // 一圈放不下时抛出错误。

    function spreadOnCircle(items, needFn) {
        const n = items.length;
        if (n === 0) return [];
        if (n === 1) return [items[0].angle];
        let angles = items.map((it) => it.angle);
        for (let pass = 0; pass < 4; pass++) {
            const needs = items.map((it, i) => {
                const j = (i + 1) % n;
                return needFn(items[i], items[j], angles[i], angles[j]);
            });
            const total = needs.reduce((s, x) => s + x, 0);
            if (total > 360) {
                const error = new Error("overflow");
                error.overflow = true;
                throw error;
            }
            // 在真实位置之间最大的空隙处把圆周剪开，变成一条直线上的问题。
            let cut = 0;
            let best = -1;
            for (let i = 0; i < n; i++) {
                const gap = norm360(items[(i + 1) % n].angle - items[i].angle) || (n > 1 ? 0 : 360);
                if (gap > best) { best = gap; cut = (i + 1) % n; }
            }
            const order = [];
            for (let k = 0; k < n; k++) order.push((cut + k) % n);
            const t = [];
            let prev = null;
            for (const idx of order) {
                let a = items[idx].angle;
                if (prev !== null) while (a < prev) a += 360;
                t.push(a);
                prev = a;
            }
            // 相邻“团”合并：团内按最小间距排开，团的位置取成员真实位置的平均。
            const clusters = [];
            for (let k = 0; k < n; k++) {
                let cur = {members: [k], offsets: [0], pos: t[k]};
                while (clusters.length) {
                    const last = clusters[clusters.length - 1];
                    const lastK = last.members[last.members.length - 1];
                    const need = needs[order[lastK]];
                    const lastOff = last.offsets[last.offsets.length - 1];
                    if (last.pos + lastOff + need <= cur.pos + 1e-9) break;
                    clusters.pop();
                    const shift = lastOff + need;
                    const members = last.members.concat(cur.members);
                    const offsets = last.offsets.concat(cur.offsets.map((o) => o + shift));
                    const pos = members.reduce((s, m, i) => s + t[m] - offsets[i], 0) / members.length;
                    cur = {members, offsets, pos};
                }
                clusters.push(cur);
            }
            const linear = new Array(n);
            for (const c of clusters) c.members.forEach((m, i) => { linear[m] = c.pos + c.offsets[i]; });
            // 首尾跨过剪开处也不能重叠；不满足时整圈当作一团。
            const wrapNeed = needs[order[n - 1]];
            if (linear[n - 1] + wrapNeed > linear[0] + 360 + 1e-9) {
                const offsets = [0];
                for (let k = 1; k < n; k++) offsets.push(offsets[k - 1] + needs[order[k - 1]]);
                const pos = t.reduce((s, x, k) => s + x - offsets[k], 0) / n;
                for (let k = 0; k < n; k++) linear[k] = pos + offsets[k];
            }
            const next = new Array(n);
            order.forEach((idx, k) => { next[idx] = norm360(linear[k]); });
            angles = next;
        }
        return angles;
    }

    // ------------------------------------------------------------ 数据整理

    function aspectIndex(results) {
        const index = new Map();
        const labels = new Map();
        const add = (id, other, hit) => {
            if (!index.has(id)) index.set(id, []);
            index.get(id).push({other, hit});
        };
        const aspects = results.aspects || {};
        for (const p of aspects.main?.points || []) labels.set(p.id, p);
        for (const g of aspects.groups || []) for (const p of g.points) labels.set(p.id, p);
        for (const hit of aspects.main?.aspects || []) {
            add(hit.a, hit.b, hit);
            add(hit.b, hit.a, hit);
        }
        for (const g of aspects.groups || []) {
            if (g.key === "antiscia") continue;
            for (const hit of g.aspects) {
                add(hit.a, hit.b, hit);
                add(hit.b, hit.a, hit);
            }
        }
        return {index, labels};
    }

    // 双盘相位的索引（格式与 aspectIndex 相同）
    function crossIndex(cross) {
        const index = new Map();
        const labels = new Map();
        if (!cross) return {index, labels};
        for (const p of [...(cross.outer || []), ...(cross.inner || [])]) labels.set(p.id, p);
        const add = (id, other, hit) => {
            if (!index.has(id)) index.set(id, []);
            index.get(id).push({other, hit});
        };
        for (const hit of cross.aspects || []) {
            add(hit.a, hit.b, hit);
            add(hit.b, hit.a, hit);
        }
        return {index, labels};
    }

    // 双盘外圈的元素：外圈那张盘的全部盘中元素，再加它的上升和中天；id 一律加 o: 前缀。
    function outerElements(outer, symbols) {
        const items = buildElements(outer, symbols);
        const axes = outer.house_result?.axes || {};
        for (const [code, symbol, name] of [["Asc", "Asc", "上升"], ["MC", "Mc", "中天"]]) {
            if (axes[code]) items.push({id: code, kind: "axis", symbol, name, lon: axes[code].lon});
        }
        return items.map((item) => ({...item, id: `o:${item.id}`, outer: true}));
    }

    function buildElements(results, symbols) {
        const items = [];
        const points = results.points || {};
        const pos = results.planet_pos || {};
        for (const code of PLANET_ORDER) {
            if (!pos[code]) continue;
            items.push({id: code, kind: "planet", symbol: symbols.planets?.[code] || code,
                color: points.planet_colors?.[code], name: PLANET_NAMES[code] || code, ...pos[code]});
        }
        const asteroidMeta = new Map((points.asteroids || []).map((a) => [a.number, a]));
        for (const [label, p] of Object.entries(results.asteroids || {})) {
            const meta = asteroidMeta.get(p.number);
            items.push({id: `#${p.number}`, kind: "asteroid", symbol: meta?.symbol || `#${p.number}`, color: meta?.color,
                name: meta ? `${meta.label} #${p.number}` : label, ...p});
        }
        for (const [label, p] of Object.entries(results.special_points || {})) {
            const style = points.special_styles?.[p.code];
            items.push({id: `sp:${p.code}`, kind: "special", symbol: style?.symbol || symbols.specials?.[p.code] || p.code.slice(0, 3),
                color: style?.color, name: label, ...p});
        }
        const lotMeta = new Map((points.lots?.items || []).map((l) => [l.label, l]));
        for (const [label, p] of Object.entries(results.lots || {})) {
            items.push({id: `lot:${label}`, kind: "lot", symbol: lotMeta.get(label)?.symbol || label.slice(0, 3),
                color: lotMeta.get(label)?.color, name: label, ...p});
        }
        return items;
    }

    // 星盘上的恒星。默认只画与行星构成相位的恒星；showAll 时全部画出，active 标出有没有相位。
    function chartStars(results, showAll) {
        const group = (results.aspects?.groups || []).find((g) => g.key === "stars");
        const active = new Set((group?.aspects || []).map((h) => h.a));
        const meta = new Map((results.points?.stars || []).map((s) => [s.label, s]));
        return Object.entries(results.fixed_stars || {})
            .map(([label, p]) => ({id: `st:${label}`, name: label, color: meta.get(label)?.color,
                active: active.has(`st:${label}`), ...p}))
            .filter((s) => showAll || s.active);
    }

    function cuspList(results) {
        const houses = results.house_result?.houses || {};
        const list = [];
        for (let i = 1; i <= 12; i++) {
            const h = houses[`house ${i}`];
            if (!h) return null;
            list.push(Number(h.lon));
        }
        return list;
    }

    // ------------------------------------------------------------ 各层排版

    // 盘中元素：每个元素 5 个子项（符号、度、星座、分、R），各自的文字框。
    // 星座符号的颜色（设置里的星座配色）；没有设置时用 CSS 的默认颜色。
    let signColors = [];
    let retroColor = "";               // 逆行标志 R 的颜色（星体配置 → 行星）
    function fillStyle(color) {
        return color ? `fill:${color}` : undefined;
    }

    // layout：双盘外圈用 {radius: {6..10: 半径}, scale: 字号比例}；不给就是内圈（第 6–10 圈）。
    function elementParts(item, layout = null) {
        const p = splitLon(item.lon);
        const glyphOnly = /^[☀-➿⯐-⯿][′']?$/.test(item.symbol);
        const k = layout?.scale || 1;
        let symSize = (glyphOnly ? FONT.symGlyph : FONT.symText) * k;
        let symBox = textBox(symText(item.symbol), symSize, SYMBOL_FAMILY, glyphOnly ? 400 : 700);
        if (!glyphOnly && symBox.w > SYM_TEXT_MAX_WIDTH * k) {
            symSize = symSize * SYM_TEXT_MAX_WIDTH * k / symBox.w;
            symBox = textBox(symText(item.symbol), symSize, SYMBOL_FAMILY, 700);
        }
        const retro = Number(item.speed) < 0;
        const parts = [
            {ring: 6, cls: "el-sym", text: symText(item.symbol), size: symSize, family: SYMBOL_FAMILY,
                weight: glyphOnly ? 400 : 700, box: symBox, style: fillStyle(item.color)},
            {ring: 7, cls: "el-deg", text: `${p.deg}°`, size: FONT.deg * k, family: TEXT_FAMILY, weight: 600},
            {ring: 8, cls: "el-sign", text: symText(SIGN_GLYPHS[p.sign]),
                size: FONT.sign * k, family: SYMBOL_FAMILY, weight: 400, style: fillStyle(signColors[p.sign])},
            {ring: 9, cls: "el-min", text: `${String(p.min).padStart(2, "0")}'`, size: FONT.min * k, family: TEXT_FAMILY, weight: 400},
        ];
        if (retro) parts.push({ring: 10, cls: "el-retro", text: "R", size: FONT.retro * k, family: TEXT_FAMILY, weight: 700,
            style: fillStyle(retroColor)});
        for (const part of parts) {
            part.box = part.box || textBox(part.text, part.size, part.family, part.weight);
            part.r = layout ? layout.radius[part.ring] : R[part.ring];
        }
        return parts;
    }

    // 两个文字框（各自在半径 ra、rb 的圆上，角度 aa、ab）在屏幕上是否重叠（含间隙）。
    function boxesOverlap(boxA, ra, aa, boxB, rb, ab) {
        const [xa, ya] = polar(ra, aa);
        const [xb, yb] = polar(rb, ab);
        return Math.abs(xa - xb) < (boxA.w + boxB.w) / 2 + GAP && Math.abs(ya - yb) < (boxA.h + boxB.h) / 2 + GAP;
    }

    // 相邻两个元素至少要相隔多少度：同一圈的子项，以及相邻两圈的子项（斜对角）都不能重叠。
    // 以两者当前的中间角度为中心对称张开，二分查找刚好不重叠的角度。
    function elementNeed(a, b, angleA, angleB) {
        const mid = angleA + norm360(angleB - angleA) / 2;
        let need = 0;
        for (const pa of a.parts) {
            for (const pb of b.parts) {
                if (Math.abs(pa.ring - pb.ring) > 1) continue;
                const clash = (d) => boxesOverlap(pa.box, pa.r, mid - d / 2, pb.box, pb.r, mid + d / 2);
                if (!clash(need)) continue;
                let lo = need;
                let hi = 90;
                if (clash(hi)) { need = hi; continue; }
                for (let i = 0; i < 22; i++) {
                    const m = (lo + hi) / 2;
                    if (clash(m)) lo = m; else hi = m;
                }
                need = hi;
            }
        }
        return need;
    }

    // 宫头标签：顺着逆时针依次是 分、星座、度。
    function cuspLabelParts(lon) {
        const p = splitLon(lon);
        const parts = [
            {cls: "cusp-min", text: `${String(p.min).padStart(2, "0")}'`, size: FONT.cuspMin, family: TEXT_FAMILY, weight: 400},
            {cls: "cusp-sign", text: symText(SIGN_GLYPHS[p.sign]), size: FONT.cuspSign,
                family: SYMBOL_FAMILY, weight: 400, style: fillStyle(signColors[p.sign])},
            {cls: "cusp-deg", text: `${p.deg}°`, size: FONT.cuspDeg, family: TEXT_FAMILY, weight: 700},
        ];
        for (const part of parts) part.box = textBox(part.text, part.size, part.family, part.weight);
        return parts;
    }

    function cuspLabelLength(parts, angle) {
        return parts.reduce((s, part) => s + tangentialExtent(part.box, angle), 0) + GAP * (parts.length - 1);
    }

    function cuspNeed(a, b, angleA, angleB) {
        const half = (cuspLabelLength(a.parts, angleA) + cuspLabelLength(b.parts, angleB)) / 2 + GAP * 2;
        return 2 * Math.asin(Math.min(1, half / (2 * R[2]))) * 180 / Math.PI;
    }

    // ------------------------------------------------------------ 绘制

    function drawText(parent, x, y, part, extra = {}) {
        const node = el("text", {
            x: x.toFixed(2), y: y.toFixed(2),
            "text-anchor": "middle", "dominant-baseline": "central",
            "font-size": part.size.toFixed(2), "font-family": part.family, "font-weight": part.weight,
            class: part.cls, style: part.style, ...extra,
        }, parent);
        node.textContent = part.text;
        return node;
    }

    function tooltipFor(item, aspects) {
        const lines = [`${item.symbol} ${item.name}${item.outer ? "（外圈）" : ""}`, `${lonText(item.lon)}${Number(item.speed) < 0 ? "  逆行" : ""}`,
            `黄经 ${norm360(item.lon).toFixed(4)}°`];
        if (item.speed !== undefined) lines.push(`速度 ${Number(item.speed).toFixed(4)}°/日`);
        if (item.mag !== undefined) lines.push(`星等 ${item.mag}`);
        const list = aspects.index.get(item.id) || [];
        if (list.length) {
            lines.push("相位：");
            for (const {other, hit} of list) {
                const o = aspects.labels.get(other);
                const dev = Math.round(Math.abs(hit.deviation) * 60);
                lines.push(`  ${hit.symbol} ${hit.name} ${o ? `${o.symbol} ${o.label}` : other}  `
                    + `${Math.floor(dev / 60)}°${String(dev % 60).padStart(2, "0")}′${hit.motion || ""}`);
            }
        }
        return lines.join("\n");
    }

    function sectorPath(r1, r2, a1, a2) {
        const [x1, y1] = polar(r2, a1);
        const [x2, y2] = polar(r2, a2);
        const [x3, y3] = polar(r1, a2);
        const [x4, y4] = polar(r1, a1);
        const large = norm360(a2 - a1) > 180 ? 1 : 0;
        return `M${x1},${y1} A${r2},${r2} 0 ${large} 0 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 ${large} 1 ${x4},${y4} Z`;
    }

    // ------------------------------------------------------------ 恒星信息弹窗（点击恒星后出现）

    let starPopup = null;

    function closeStarPopup() {
        starPopup?.remove();
        starPopup = null;
    }

    document.addEventListener("mousedown", (event) => {
        if (starPopup && !starPopup.contains(event.target) && !event.target.closest?.(".chart-star")) closeStarPopup();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeStarPopup();
    });

    function openStarPopup(container, anchor, star, aspects) {
        closeStarPopup();
        const pop = document.createElement("div");
        pop.className = "chart-pop";
        const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
        const list = aspects.index.get(star.id) || [];
        const rows = list.map(({other, hit}) => {
            const o = aspects.labels.get(other);
            const dev = Math.round(Math.abs(hit.deviation) * 60);
            const color = o?.color ? ` style="color:${esc(o.color)}"` : "";
            return `<li><span class="pop-sym">${esc(symText(hit.symbol))}</span> ${esc(hit.name)} `
                + `<span class="pop-sym"${color}>${esc(symText(o?.symbol || ""))}</span> ${esc(o?.label || other)}`
                + `<span class="pop-dev motion-${hit.motion || "none"}">${Math.floor(dev / 60)}°${String(dev % 60).padStart(2, "0")}′${hit.motion || ""}</span></li>`;
        }).join("");
        const starColor = star.color ? ` style="color:${esc(star.color)}"` : "";
        pop.innerHTML = `
            <div class="pop-head"><span class="pop-title"><span class="pop-sym"${starColor}>${esc(symText(STAR_GLYPH))}</span> ${esc(star.name)}</span>
                <button type="button" class="icon-btn small pop-close" aria-label="关闭">×</button></div>
            <div class="pop-body">
                <div class="pop-row"><span>位置</span><b>${esc(lonText(star.lon))}</b></div>
                <div class="pop-row"><span>黄经</span><b>${norm360(star.lon).toFixed(4)}°</b></div>
                <div class="pop-row"><span>黄纬</span><b>${Number(star.lat ?? 0).toFixed(4)}°</b></div>
                ${star.mag !== undefined ? `<div class="pop-row"><span>星等</span><b>${esc(star.mag)}</b></div>` : ""}
                ${star.star ? `<div class="pop-row"><span>星表名</span><b>${esc(star.star)}</b></div>` : ""}
                <div class="pop-sub">相位</div>
                <ul class="pop-list">${rows || "<li class='muted'>无</li>"}</ul>
            </div>`;
        pop.querySelector(".pop-close").addEventListener("click", closeStarPopup);
        container.appendChild(pop);
        // 放在恒星旁边，不超出星盘范围。
        const box = container.getBoundingClientRect();
        const a = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        let left = a.left - box.left + a.width + 8;
        if (left + w > box.width) left = a.left - box.left - w - 8;
        let top = a.top - box.top - h / 2 + a.height / 2;
        left = Math.max(0, Math.min(left, box.width - w));
        top = Math.max(0, Math.min(top, box.height - h));
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        starPopup = pop;
    }

    // ------------------------------------------------------------ 外加的圈（小限、法达）

    function ringGlyph(parent, x, y, cell, size) {
        const glyphOnly = /^[☀-➿⯐-⯿]$/.test(cell.symbol || "");
        drawText(parent, x, y, {
            cls: "ring-glyph", text: symText(cell.symbol || ""), size: glyphOnly ? size : size * 0.62,
            family: SYMBOL_FAMILY, weight: glyphOnly ? 400 : 700, style: fillStyle(cell.color),
        });
    }

    function ringMarker(layer, r1, r2, angle) {
        const [x1, y1] = polar(r1, angle);
        const [x2, y2] = polar(r2, angle);
        el("line", {x1, y1, x2, y2, class: "ring-marker"}, layer);
    }

    function drawOuterRings(svg, rings, screen) {
        const layer = el("g", {class: "layer-rings"}, svg);
        let r1 = R[1] + RING_GAP;
        for (const ring of rings) {
            const width = RING_WIDTH[ring.type] || 28;
            const r2 = r1 + width;
            const mid = (r1 + r2) / 2;
            const g = el("g", {class: `outer-ring ring-${ring.type}`}, layer);
            if (ring.type === "zodiac") {
                (ring.cells || []).forEach((cell, sign) => {
                    const a1 = screen(sign * 30);
                    const a2 = a1 + 30;
                    const cellNode = el("g", {class: `ring-cell${sign === ring.highlight ? " current" : ""}`}, g);
                    el("path", {d: sectorPath(r1, r2, a1, a2), class: "ring-bg"}, cellNode);
                    if (cell.title) el("title", {}, cellNode).textContent = cell.title;
                    const [x, y] = polar(mid, a1 + 15);
                    ringGlyph(cellNode, x, y, cell, 16);
                    const [lx1, ly1] = polar(r1, a1);
                    const [lx2, ly2] = polar(r2, a1);
                    el("line", {x1: lx1, y1: ly1, x2: lx2, y2: ly2, class: "ring-divider"}, g);
                });
                if (Number.isFinite(ring.marker)) ringMarker(layer, r1, r2, screen(ring.marker));
            } else {
                const angle = (f) => 180 + f * 360;
                for (const seg of ring.segments || []) {
                    const a1 = angle(seg.start);
                    const a2 = angle(seg.end);
                    const node = el("g", {class: `ring-cell ${seg.state || ""}`}, g);
                    // 一段占满整圈时（如没有子限的交点主限）分成两半画，SVG 的弧画不出整圆
                    const d = a2 - a1 >= 359.999
                        ? sectorPath(r1, r2, a1, a1 + 180) + sectorPath(r1, r2, a1 + 180, a1 + 360)
                        : sectorPath(r1, r2, a1, a2);
                    el("path", {d, class: "ring-bg"}, node);
                    if (seg.title) el("title", {}, node).textContent = seg.title;
                    // 格子太窄时不放符号（悬停仍可看说明）
                    if ((a2 - a1) * Math.PI / 180 * mid >= 15) {
                        const [x, y] = polar(mid, (a1 + a2) / 2);
                        ringGlyph(node, x, y, seg, 17);
                    }
                    const [lx1, ly1] = polar(r1, a1);
                    const [lx2, ly2] = polar(r2, a1);
                    el("line", {x1: lx1, y1: ly1, x2: lx2, y2: ly2, class: "ring-divider"}, g);
                }
                if (Number.isFinite(ring.marker)) ringMarker(layer, r1, r2, angle(ring.marker));
            }
            el("circle", {cx: C, cy: C, r: r2, class: "ring-edge"}, g);
            el("circle", {cx: C, cy: C, r: r1, class: "ring-edge"}, g);
            r1 = r2;
        }
    }

    function render(container, results, options = {}) {
        closeStarPopup();
        container.innerHTML = "";
        const cusps = results ? cuspList(results) : null;
        if (!results || !results.planet_pos || !cusps) {
            const p = document.createElement("p");
            p.className = "chart-empty";
            p.textContent = options.emptyText || "排盘后显示星盘";
            container.appendChild(p);
            return null;
        }
        const symbols = options.symbols || {};
        signColors = results.points?.sign_colors || [];
        retroColor = results.points?.retro_color || "";
        const outer = options.outer || null;
        const aspects = outer ? crossIndex(options.cross) : aspectIndex(results);
        const elements = buildElements(results, symbols);
        const stars = chartStars(results, Boolean(options.showAllStars));
        const outerEls = outer ? outerElements(outer, symbols) : [];
        if (selection && !elements.some((e) => e.id === selection) && !outerEls.some((e) => e.id === selection)) selection = null;

        // 第 1 宫宫头在正左边（180°），黄经沿逆时针增加。
        const rotation = 180 - cusps[0];
        const screen = (lon) => norm360(Number(lon) + rotation);

        const caption = options.caption || results.predictive?.caption || results.chart_caption;
        if (caption) {
            const p = document.createElement("p");
            p.className = "chart-caption";
            p.textContent = caption;
            container.appendChild(p);
        }
        const rings = Array.isArray(results.outer_rings) ? results.outer_rings : [];
        const pad = outer ? OUTER_EDGE - R[1] + 4
            : rings.length ? RING_GAP + rings.reduce((sum, ring) => sum + (RING_WIDTH[ring.type] || 28), 0) + 4 : 0;
        const svg = el("svg", {
            class: `astro-chart round${rings.length || outer ? " with-rings" : ""}${outer ? " biwheel" : ""}`, xmlns: SVG_NS, role: "img", "aria-label": "星盘",
            viewBox: `${-pad} ${-pad} ${SIZE + 2 * pad} ${SIZE + 2 * pad}`, "font-family": TEXT_FAMILY,
        });
        container.append(svg);
        const layerBase = el("g", {class: "layer-base"}, svg);
        const layerHit = el("g", {class: "layer-hit"}, svg);
        const layerText = el("g", {class: "layer-text"}, svg);

        if (rings.length) drawOuterRings(svg, rings, screen);

        // —— 最下层：边界圆、宫位线、真实位置刻度
        for (const i of VISIBLE_CIRCLES) {
            el("circle", {cx: C, cy: C, r: R[i], class: `ring ring-${i}`}, layerBase);
        }
        cusps.forEach((lon, i) => {
            const a = screen(lon);
            const [x1, y1] = polar(R[13], a);
            const [x2, y2] = polar(R[5], a);
            const angular = i % 3 === 0;      // 第 1、4、7、10 宫宫头线稍粗
            el("line", {x1, y1, x2, y2, class: `house-line${angular ? " angular" : ""}`}, layerBase);
        });

        // —— 第 12 圈：宫位数字（两条宫头线的正中间）
        cusps.forEach((lon, i) => {
            const a1 = screen(lon);
            const span = norm360(cusps[(i + 1) % 12] - lon);
            const [x, y] = polar(R[12], a1 + span / 2);
            drawText(layerText, x, y, {cls: "house-num", text: String(i + 1), size: FONT.house, family: TEXT_FAMILY, weight: 600});
        });

        // —— 第 2 圈：宫头的星座度数
        const labels = cusps.map((lon, i) => ({angle: screen(lon), parts: cuspLabelParts(lon), house: i + 1, lon}))
            .sort((a, b) => a.angle - b.angle);
        const labelAngles = spreadOnCircle(labels, cuspNeed);
        labels.forEach((label, k) => {
            const c = labelAngles[k];
            const total = cuspLabelLength(label.parts, c);
            const g = el("g", {class: "cusp-label"}, layerText);
            el("title", {}, g).textContent = `第 ${label.house} 宫宫头  ${lonText(label.lon)}`;
            let offset = -total / 2;
            for (const part of label.parts) {
                const e = tangentialExtent(part.box, c);
                const angle = c + (offset + e / 2) / R[2] * 180 / Math.PI;
                const [x, y] = polar(R[2], angle);
                drawText(g, x, y, part);
                offset += e + GAP;
            }
        });

        // —— 盘中元素：计算射线角度
        const els = elements.map((item) => ({...item, angle: screen(item.lon), parts: elementParts(item)}))
            .sort((a, b) => a.angle - b.angle);
        let elAngles;
        let overflow = false;
        try {
            elAngles = spreadOnCircle(els, elementNeed);
        } catch (error) {
            if (!error.overflow) throw error;
            overflow = true;
        }
        // 双盘外圈
        const outerLayout = {radius: OUTER_RADIUS, scale: OUTER_SCALE};
        const oEls = outerEls.map((item) => ({...item, angle: screen(item.lon), parts: elementParts(item, outerLayout)}))
            .sort((a, b) => a.angle - b.angle);
        let oAngles = [];
        try {
            oAngles = spreadOnCircle(oEls, elementNeed);
        } catch (error) {
            if (!error.overflow) throw error;
            overflow = true;
        }
        if (outer) el("circle", {cx: C, cy: C, r: OUTER_EDGE, class: "ring ring-outer"}, layerBase);

        // —— 第 4 圈：恒星
        const starBox = textBox(symText(STAR_GLYPH), FONT.star, SYMBOL_FAMILY);
        const starNeed = (a, b, aa, ab) => angularNeed(a.box, aa, b.box, ab, R[4]);
        let starItems = stars.map((s) => ({...s, angle: screen(s.lon), box: starBox})).sort((a, b) => a.angle - b.angle);
        let starAngles = [];
        try {
            starAngles = spreadOnCircle(starItems, starNeed);
        } catch (error) {
            if (!error.overflow) throw error;
            // 全部恒星一圈排不下时，退回只画有相位的恒星，不让整张盘报错。
            const onlyActive = starItems.filter((s) => s.active);
            try {
                if (onlyActive.length === starItems.length) throw error;
                starAngles = spreadOnCircle(onlyActive, starNeed);
                starItems = onlyActive;
            } catch (inner) {
                if (!inner.overflow) throw inner;
                overflow = true;
            }
        }
        const starNodes = new Map();
        const starData = new Map();
        starItems.forEach((s, k) => {
            const g = el("g", {class: `chart-star${s.active ? "" : " inactive"}`, "data-id": s.id}, layerText);
            const [x, y] = polar(R[4], starAngles[k]);
            el("circle", {cx: x, cy: y, r: 9, class: "star-hit"}, g);
            drawText(g, x, y, {cls: "star-glyph", text: symText(STAR_GLYPH), size: FONT.star, family: SYMBOL_FAMILY,
                weight: 400, style: fillStyle(s.color)});
            starNodes.set(s.id, g);
            starData.set(s.id, s);
        });

        if (overflow) {
            const message = "排盘错误：盘中元素太多，星盘上一圈排不下。请在「星体配置」里少启用一些小行星、特殊点或 Lot（或少一些有相位的恒星）。";
            const [x, y] = [C, C];
            const t = el("text", {x, y, "text-anchor": "middle", "dominant-baseline": "central", class: "chart-error"}, layerText);
            t.textContent = "排盘错误";
            if (lastErrorResults !== results) {
                lastErrorResults = results;
                options.onError?.(message);
            }
            return {elements: els, overflow: true};
        }

        // —— 盘中元素：真实位置刻度 + 5 个子项（双盘时外圈同样画一遍，刻度在第 1 圈外侧）
        const nodes = new Map();
        const drawElements = (list, angles, {tickFrom, tickTo, hitIn, hitOut}) => list.forEach((item, k) => {
            const a = angles[k];
            const [tx1, ty1] = polar(tickFrom, item.angle);
            const [tx2, ty2] = polar(tickTo, item.angle);
            el("line", {x1: tx1, y1: ty1, x2: tx2, y2: ty2, class: `el-tick kind-${item.kind}`}, layerBase);

            const g = el("g", {class: `chart-element kind-${item.kind}${item.outer ? " outer" : ""}`, "data-id": item.id}, layerText);
            el("title", {}, g).textContent = tooltipFor(item, aspects);
            // 可点击区域：盖住这条射线上所有子项的一小段扇形（画在文字下面）。
            const half = Math.max(...item.parts.map((p) => tangentialExtent(p.box, a) / 2 / p.r * 180 / Math.PI)) + 0.6;
            const hit = el("path", {d: sectorPath(hitIn, hitOut, a - half, a + half), class: "el-hit", "data-id": item.id}, layerHit);
            for (const part of item.parts) {
                const [x, y] = polar(part.r, a);
                drawText(g, x, y, part);
            }
            nodes.set(item.id, {g, hit});
        });
        drawElements(els, elAngles, {tickFrom: R[5], tickTo: R[5] - TICK, hitIn: R[10] - 10, hitOut: R[6] + 14});
        drawElements(oEls, oAngles, {tickFrom: R[1], tickTo: R[1] + TICK, hitIn: OUTER_RADIUS[6] - 14, hitOut: OUTER_RADIUS[10] + 8});

        // —— 点击：高亮选中元素以及与它构成相位的元素和恒星
        function applyHighlight() {
            const related = new Set((aspects.index.get(selection) || []).map((x) => x.other));
            for (const [id, {g, hit}] of nodes) {
                const state = id === selection ? "selected" : related.has(id) ? "aspecting" : "";
                g.classList.toggle("selected", state === "selected");
                g.classList.toggle("aspecting", state === "aspecting");
                hit.classList.toggle("selected", state === "selected");
                hit.classList.toggle("aspecting", state === "aspecting");
                g.classList.toggle("dimmed", Boolean(selection) && !state);
            }
            for (const [id, g] of starNodes) {
                g.classList.toggle("aspecting", related.has(id));
                g.classList.toggle("dimmed", Boolean(selection) && !related.has(id));
            }
        }
        svg.addEventListener("click", (event) => {
            const target = event.target.closest("[data-id]");
            const id = target?.dataset.id;
            // 点恒星：弹出恒星信息框，不改变元素的选中状态。
            if (id && starData.has(id)) {
                event.stopPropagation();
                openStarPopup(container, target, starData.get(id), aspects);
                return;
            }
            closeStarPopup();
            if (id && nodes.has(id)) selection = selection === id ? null : id;
            else selection = null;
            applyHighlight();
        });
        applyHighlight();
        return {elements: [...els, ...oEls], overflow: false};
    }

    function clearSelection() {
        selection = null;
    }

    window.AstroChart = {
        render,
        clearSelection,
        // 仅供调试 / 测试
        _debug: {spreadOnCircle, splitLon},
    };
})();
