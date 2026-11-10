"use strict";
/*
 * 印度占星的前端部分。共用的页面逻辑（档案、时间地点、过境、外观……）在 common/static/common.js，
 * 这里只放本体系自己的东西，通过 registerSystem({...}) 挂进去：
 *   - 计算设置里的「启用 KP」（含 KP 卜卦）、Dasha 设置（起算行星、年长度）；改了就写回 settings.json
 *   - KP 星主表、象征宫位 / 象征星、主宰星、Dasha（多种大运体系）的结果标签页
 *   - 分盘：Moon、Bhava、Gochara（Rashi 外加一圈过境）、BPHS 的 16 张 D 盘（规则和算法登记在 vargas.js），Rashi 转宫
 *   - 相位设置（罗睺、计都是否投射相位）；Yoga 标签页和管理浮窗在 yoga.js
 *   - 南北印度盘（chart.js 提供 AstroChart）
 * 本体系的接口都在 /vedic/api/ 下，用 systemApi("/...") 拼地址。
 */

// 本体系自己的状态（挂在共用的 state 上）
// 模块开关：五个 KP 模块随「启用 KP」一起开关（systems.vedic.calculation_defaults.kp_enabled），大运永远开着。
state.modules = {};
// 每张盘（natal / transit）排盘时实际启用的模块：用来判断“刚打开、还没算过”的模块。
state.chartModules = {natal: {}, transit: {}};
state.computedModules = {};
// 星盘样式：north 北印度 / south 南印度
state.chartStyle = "north";

// ---------- 可开关的模块 ----------
// 每个模块：结果放在哪个容器、用哪个后端结果键、怎么画。Dasha 单独处理（逐层展开）。
const MODULE_VIEWS = {
    kp_planet_lords: {target: "kp1", key: "kp_planet_results", draw: (t, d) => { $(t).innerHTML = kpLordsHtml(d, (k) => k); }},
    kp_house_lords: {target: "kp2", key: "kp_house_results", draw: (t, d) => { $(t).innerHTML = kpLordsHtml(d, houseName); }},
    kp_planet_sigs: {target: "kp3", key: "kp_planet_sigs", draw: (t, d) => { $(t).innerHTML = kpPlanetSigsHtml(d); }},
    kp_house_sigs: {target: "kp4", key: "kp_house_sigs", draw: (t, d) => { $(t).innerHTML = kpHouseSigsHtml(d); }},
    kp_ruling: {target: "kp5", key: "kp_ruling_planets", draw: (t, d) => { $(t).innerHTML = kpRulingHtml(d); }},
    dasha: {target: "dashaResult", key: "dasha", draw: () => renderDashaRoot()},
};

// 关掉某个模块时，要从当前结果里一并删掉的键（与后端 MODULE_RESULT_KEYS 一致）。
const MODULE_RESULT_KEYS = {
    kp_planet_lords: ["kp_planet_results"],
    kp_house_lords: ["kp_house_results"],
    kp_planet_sigs: ["kp_planet_sigs"],
    kp_house_sigs: ["kp_house_sigs"],
    kp_ruling: ["kp_ruling_planets", "asc_kp_result"],
    dasha: ["dasha"],
};

// 由「启用 KP」得到完整的模块开关表（与后端 resolve_modules 同一规则）：五个 KP 模块随它一起开关，大运永远开着。
function resolveModules(kpOn) {
    const result = {dasha: true};
    for (const name of state.optionsMeta?.kp_modules || []) result[name] = Boolean(kpOn);
    return result;
}

// 计算设置里本体系自己的选项（启用 KP、卜卦、大运）一改就写回 settings.json，下次打开沿用。
// 排队依次发送：连续快速修改时，后改的一定在先改的之后写入。
let vedicCalcSaveChain = Promise.resolve();

function saveVedicCalc(changes) {
    vedicCalcSaveChain = vedicCalcSaveChain
        .then(async () => {
            state.settings.calculation_defaults = await api(systemApi("/calc-defaults"), {
                method: "POST", body: JSON.stringify(changes),
            });
        })
        .catch((error) => showError(`计算设置没能保存：${error.message}`));
}

function renderModuleResults() {
    const hasResults = Object.keys(state.results).length > 0;
    for (const [name, view] of Object.entries(MODULE_VIEWS)) {
        if (!state.modules[name]) {
            $(view.target).innerHTML = "";
        } else if (hasResults && !state.computedModules[name]) {
            $(view.target).innerHTML = "<p class='muted'>未计算</p>";
        } else {
            view.draw(view.target, state.results[view.key] || {});
        }
    }
}

// 标记「当前所在大运」的符号；想换成别的符号，只改这一处。
const DASHA_NOW_MARK = "●";

// 第 1、2 层只显示日期；从第 3 层起显示到分钟。想改分界，只改这一处。
const DASHA_TIME_FROM_LEVEL = 3;

// 后端给的是 ISO 时间（如 2031-04-17T09:12:45.123+08:00），这里只取当地的「日期 [时:分]」，
// 不经过 Date 对象，所以不会被浏览器所在时区改动，也不会出现 T、秒和时区后缀。
function formatDashaTime(iso, level) {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso || ""));
    if (!m) return String(iso || "");
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return level >= DASHA_TIME_FROM_LEVEL ? `${date} ${m[4]}:${m[5]}` : date;
}

function findNowIndex(items, now) {
    for (let i = 0; i < items.length; i++) {
        const start = new Date(items[i].start);
        const end = new Date(items[i].end);
        if (now >= start && now < end) return i;
    }
    return -1;
}

// ---------- 大运体系 ----------
// 后端一次算好全部体系的第一层（results.dasha.systems），标签页里切换只是换一份数据重画，不重新排盘。
// 当前显示哪一种记在 calculation_defaults.dasha_system，在计算设置 → Dasha → 体系里切换。

function dashaSystemOptions() {
    return (state.optionsMeta.dasha_systems || []).map((s) => ({value: s.value, label: `${s.label}（${s.years} 年）`}));
}

function currentDashaSystem() {
    const wanted = state.settings.calculation_defaults.dasha_system;
    const known = (state.optionsMeta.dasha_systems || []).map((s) => s.value);
    return known.includes(wanted) ? wanted : (known[0] || "vimshottari");
}

function selectDashaSystem(id) {
    state.settings.calculation_defaults.dasha_system = id;
    saveVedicCalc({dasha_system: id});
    if (state.results.dasha) renderDashaRoot();
}

function dashaLabel(item) {
    return item.label === item.planet ? item.planet : `${item.label} · ${item.planet}`;
}

function fetchDashaChildren(item) {
    return api(systemApi("/dasha/expand"), {
        method: "POST",
        body: JSON.stringify({
            system: item.system,
            lord: item.lord,
            start: item.start,
            duration_seconds: item.duration_seconds,
        }),
    });
}

// 排盘后只显示第一层大运（已由后端算好）；当前所在的一支会高亮并加符号标出，但不自动展开。
// 需要看下一层时，点击某个区间才向后端请求并展开（见 buildDashaLevel），再点一次收起。
function renderDashaRoot() {
    const root = $("dashaResult");
    root.innerHTML = "";
    const systems = state.results.dasha?.systems || [];
    if (!systems.length) {
        root.innerHTML = "<p class='muted'>没有大运数据。</p>";
        return;
    }
    const id = currentDashaSystem();
    const data = systems.find((s) => s.value === id) || systems[0];
    // Yogini 的名称较长（如 Bhramari · Ma）：主星一栏放宽，各层的日期仍上下对齐。
    root.toggleAttribute("data-wide", data.periods.some((p) => p.label !== p.planet));

    const head = document.createElement("div");
    head.className = "dasha-head";
    const name = document.createElement("span");
    name.className = "dasha-system-name";
    name.textContent = `${data.label} · ${data.years} 年`;
    head.appendChild(name);
    if (data.condition) {
        const note = document.createElement("span");
        note.className = "dasha-condition";
        note.textContent = `BPHS 适用：${data.condition}`;
        head.appendChild(note);
    }
    root.appendChild(head);
    root.appendChild(buildDashaLevel(data.periods, 1, findNowIndex(data.periods, new Date())));
}

function buildDashaLevel(items, level, nowIndex) {
    const wrapper = document.createElement("div");
    wrapper.className = "dasha-level";
    wrapper.dataset.level = String(level);

    items.forEach((item, index) => {
        const holder = document.createElement("div");
        const row = document.createElement("div");
        row.className = "dasha-row" + (index === nowIndex ? " current-dasha" : "");
        row.innerHTML = `
            <div class="dasha-level-tag">L${level}</div>
            <div class="dasha-planet">${escapeHtml(dashaLabel(item))}${
                index === nowIndex ? `<span class="dasha-now-mark">${DASHA_NOW_MARK}</span>` : ""
            }</div>
            <div class="dasha-time">${escapeHtml(formatDashaTime(item.start, level))}</div>
            <div class="dasha-time">${escapeHtml(formatDashaTime(item.end, level))}</div>
        `;

        row.addEventListener("click", async (event) => {
            event.stopPropagation();

            const existing = holder.querySelector(":scope > .dasha-level");
            if (existing) {
                existing.remove();
                return;
            }

            try {
                const children = await fetchDashaChildren(item);
                holder.appendChild(buildDashaLevel(children, level + 1, findNowIndex(children, new Date())));
            } catch (error) {
                showError(error.message);
            }
        });

        holder.appendChild(row);
        wrapper.appendChild(holder);
    });

    return wrapper;
}

// ================= 分盘：Moon、Bhava、D 盘，以及 Rashi 转宫 =================
// 星盘上方的按钮条：Rashi（本命）、Transit（过境）、Moon、Bhava、D9；其余 D 盘在右边的「分盘」下拉菜单里。
// 所有分盘都只在点到时才换算（common.js 的 derivedEntry），并缓存到本命盘重算或这张分盘的设置改变为止。
// D 盘有哪些、各有哪些算法，全部登记在 vargas.js；这里不写任何一张 D 盘的规则。

const SIGN_LIST = ["白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼"];

// 放在按钮条上的 D 盘（默认都在「分盘」按钮里，D9 是分盘按钮的默认盘）。想单独放一张，只改这一处。
const PINNED_VARGAS = [];

const signIndex = (lon) => Math.floor(norm360(lon) / 30) % 12;

function vargaSettings() {
    state.settings.varga = state.settings.varga || {};
    return state.settings.varga;
}

// ---------- 转宫 ----------
// 每张盘（Moon 除外）各自可以转宫：以选定的星座为第一宫，只旋转星盘，点仍画在真实星座里，结果表和 Yoga 不变。
// Gochara 与 Rashi 共用一个设置（里面那张就是 Rashi）。转宫是看盘时的临时操作：只在这一页里记住，换人时清掉。
state.rotation = {};

const rotationKey = (view) => (view === "gochara" ? "natal" : view);
const canRotate = (view) => view !== "moon";

function currentRotation(view = state.view) {
    const v = state.rotation[rotationKey(view)];
    return canRotate(view) && Number.isInteger(v) ? v : null;
}

function withRotation(results, view) {
    const lagna = currentRotation(view);
    return results && lagna !== null ? {...results, chart_meta: {...(results.chart_meta || {}), lagna_sign: lagna}} : results;
}

function updateRotationPicker(view = state.view) {
    const pick = $("lagnaPick");
    pick.hidden = !canRotate(view);
    const lagna = currentRotation(view);
    $("rashiLagna").value = lagna === null ? "asc" : String(lagna);
    pick.classList.toggle("is-rotated", lagna !== null);
}

function bindRotation() {
    fillSelect($("rashiLagna"), [
        {value: "asc", label: "转宫"},
        ...SIGN_LIST.map((name, i) => ({value: String(i), label: String(i + 1)})),
    ]);
    $("rashiLagna").addEventListener("change", () => {
        const v = $("rashiLagna").value;
        if (v === "asc") delete state.rotation[rotationKey(state.view)];
        else state.rotation[rotationKey(state.view)] = Number(v);
        AstroChart.clearSelection();
        renderChart();
    });
}

function bhavaHouseSystem() {
    const wanted = vargaSettings().bhava_house_system;
    const known = state.optionsMeta?.house_systems || [];
    return known.includes(wanted) ? wanted : "Sripati";
}

function vargaMethod(id) {
    return VedicVargas.resolveMethod(id, vargaSettings().methods?.[id]);
}

// 分盘设置一改就写回 settings.json（排队依次发送）；页面上以本地状态为准，不等后端返回。

// Moon：行星位置不变，以月亮所在星座为第一宫；不画宫头。
function deriveMoonChart(natal) {
    const moon = natal.planet_pos?.Mo;
    if (!moon) return null;
    return {
        planet_pos: natal.planet_pos,
        house_result: {house_system: "Whole Sign", axes: {Asc: natal.house_result.axes.Asc}, houses: {}},
        chart_meta: {lagna_sign: signIndex(moon.lon), hide_cusps: true},
    };
}

// D 盘：每个点（行星、罗计、上升点）按所选算法换算成分盘黄经；不画宫头。
function deriveVarga(id) {
    return (natal) => {
        const varga = VedicVargas.get(id);
        const toLon = varga.methods[vargaMethod(id)].toLon;
        const planet_pos = Object.fromEntries(
            Object.entries(natal.planet_pos || {}).map(([code, p]) => [code, {...p, lon: toLon(p.lon)}])
        );
        const asc = natal.house_result.axes.Asc;
        return {
            planet_pos,
            house_result: {house_system: "Whole Sign", axes: {Asc: {...asc, lon: toLon(asc.lon)}}, houses: {}},
            chart_meta: {hide_cusps: true},
        };
    };
}

/*
 * Bhava 盘：一个格子就是一个宫位，不再是一个星座。
 * 宫位按 Bhava 宫位制的十二个宫头划分：第 n 宫 = 从第 n 宫宫头到第 n+1 宫宫头（Sripati 的宫头就是宫的起点 Sandhi）。
 * 格子的摆法与 Rashi 相同：第 1 宫放在上升星座的位置，往后依次排；格子里的数字照常是星座数字（Bhava Chalit 的惯例）。
 * 点的度数照常是它在真实星座里的度数；宫头度数不画。鼠标停在点上时说明它在第几宫。
 * Bhava 宫位制与本命盘相同时直接用本命盘的宫头；不同时向后端要一次宫头（点到 Bhava 盘时才要）。
 */
async function deriveBhava(natal, {payload}) {
    const houseSystem = bhavaHouseSystem();
    let houses = natal.house_result;
    if (houses.house_system !== houseSystem) {
        if (!payload) throw new Error("请先排盘。");
        houses = await api(systemApi("/bhava"), {
            method: "POST",
            body: JSON.stringify({...payload, house_system: houseSystem}),
        });
    }
    return buildBhavaChart(natal, houses);
}

function buildBhavaChart(natal, houses) {
    const cusps = Array.from({length: 12}, (_, i) => norm360(houses.houses?.[`house ${i + 1}`]?.lon));
    if (cusps.some((c) => !Number.isFinite(c))) throw new Error("缺少宫头数据。");
    const asc = houses.axes?.Asc || natal.house_result.axes.Asc;
    const base = signIndex(asc.lon);

    // 黄经落在第几宫（0–11），以及离这一宫宫头的距离（同一格子里按它排先后）。
    const houseOf = (lon) => {
        let best = {h: 0, off: Infinity};
        for (let i = 0; i < 12; i++) {
            const span = norm360(cusps[(i + 1) % 12] - cusps[i]);
            const off = norm360(lon - cusps[i]);
            if (off < span) return {h: i, off};
            if (off < best.off) best = {h: i, off};      // 浮点误差落在缝里时，归到最近的宫头之后
        }
        return best;
    };

    const cells = {};
    const ranks = {};
    const notes = {};
    const place = (code, lon) => {
        const {h, off} = houseOf(norm360(lon));
        cells[code] = (base + h) % 12;
        ranks[code] = off;
        notes[code] = `第 ${h + 1} 宫（Bhava）`;
    };
    for (const [code, p] of Object.entries(natal.planet_pos || {})) place(code, p.lon);
    place("Asc", asc.lon);
    // 特殊点（vedic_extra.js 的 withExtras）也按同样的宫头放进格子
    const placeOf = (lon) => {
        const {h, off} = houseOf(norm360(lon));
        return {cell: (base + h) % 12, rank: off};
    };

    return {
        planet_pos: natal.planet_pos,
        house_result: {house_system: houses.house_system, axes: {Asc: asc}, houses: {}},
        chart_meta: {lagna_sign: base, hide_cusps: true, cells, ranks, notes, placeOf},
    };
}

// 按钮条的顺序：Rashi、Transit 固定在最前，后面按这里的数字从小到大。想调整顺序，只改这几个数字。
const BAR_ORDER = {moon: 10, bhava: 20, gochara: 30};

/*
 * Gochara：Rashi 外面加一圈过境。左侧的时间与地点是过境的（form: "transit"），右下角结果区仍是 Rashi。
 * 外圈的星座就是本命盘的星座，所以过境的地点只影响过境上升点本身，不影响外圈怎么排。
 */
function deriveGochara(natal, {transit}) {
    return {natal, transit};
}

function buildDerivedViews() {
    const views = {
        moon: {label: "Moon", derive: deriveMoonChart, order: BAR_ORDER.moon},
        bhava: {label: "Bhava", derive: deriveBhava, signature: () => bhavaHouseSystem(), order: BAR_ORDER.bhava},
        gochara: {label: "Gochara", derive: deriveGochara, form: "transit", order: BAR_ORDER.gochara},
    };
    for (const varga of VedicVargas.list()) {
        if (varga.view === "natal") continue;          // D1 就是 Rashi 本身
        views[varga.view] = {
            label: varga.id,
            derive: deriveVarga(varga.id),
            signature: () => vargaMethod(varga.id),
            bar: PINNED_VARGAS.includes(varga.id),
            order: BAR_ORDER[varga.id],
        };
    }
    return views;
}

function buildViewMenu() {
    return {
        label: "分盘",
        defaultValue: "D9",
        items: VedicVargas.list().map((v) => ({
            value: v.view, label: v.id, note: v.name, sub: v.topic,
            title: `${v.id} ${v.name} · ${v.topic}`,
        })),
    };
}

// ---------- 计算设置 → 分盘 ----------

// ---------- 计算设置 → 相位（罗睺、计都是否投射相位） ----------

function aspectSettings() {
    state.settings.aspects = state.settings.aspects || {Ra: true, Ke: true};
    return state.settings.aspects;
}

// 星盘和 Yoga 共用的相位表：默认的 Parashari 星座相位，再按设置关掉罗睺 / 计都的相位。
function vedicAspects() {
    const table = {...AstroChart.DEFAULT_ASPECTS};
    const cfg = aspectSettings();
    if (cfg.Ra === false) table.Ra = [];
    if (cfg.Ke === false) table.Ke = [];
    return table;
}

// Jaimini 星座互看开着时，星盘只能点星座数字（高亮与它互看的星座）
function rasiDrishtiOn() {
    return Boolean(aspectSettings().jaimini);
}

// ---------- 计算设置 → 燃烧（离太阳多少度以内算燃烧） ----------

const COMBUST_DEFAULT = {Mo: 12, Ma: 17, Me: 14, Me_r: 12, Ju: 11, Ve: 10, Ve_r: 8, Sa: 15};
const COMBUST_FIELDS = [
    // 水星、金星逆行时另有一个度数（BPHS：水星 14° / 逆行 12°，金星 10° / 逆行 8°）
    ["Mo", "Mo"], ["Ma", "Ma"], ["Me", "Me"], ["Ju", "Ju"], ["Ve", "Ve"], ["Sa", "Sa"],
    ["Me_r", "Me 逆行时"], ["Ve_r", "Ve 逆行时"],
];

function combustSettings() {
    state.settings.combust = {...COMBUST_DEFAULT, ...(state.settings.combust || {})};
    return state.settings.combust;
}

// 引擎和行星表共用的燃烧度数表：{行星: 度数}，逆行的水星、金星另有 Me_r、Ve_r。
function combustTable() {
    return {...combustSettings()};
}

// 这颗行星离太阳的度数（0–180）；不会燃烧的行星（日、罗、计）返回 null。
function combustInfo(results, code) {
    const table = combustSettings();
    const p = results.planet_pos?.[code], su = results.planet_pos?.Su;
    if (!p || !su || !(code in table)) return null;
    const retro = Number(p.speed) < 0;
    const orb = (retro && table[`${code}_r`]) || table[code];
    const dist = Math.abs(((p.lon - su.lon) % 360 + 540) % 360 - 180);
    return {dist, combust: dist < orb};
}

// ---------- 历法（Panchanga） ----------

// 结束时刻：与盘的当地日期同一天只写时分，否则写月-日 时分。
function panchangaEnd(iso, results) {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso || ""));
    if (!m) return "";
    const day = String(results.context?.local_dt || "").slice(0, 10);
    return `${day === `${m[1]}-${m[2]}-${m[3]}` ? "" : `${m[2]}-${m[3]} `}${m[4]}:${m[5]}`;
}

function renderPanchanga(container, results) {
    const pa = results.panchanga;
    const sun = results.sun_events;
    const hour = results.planetary_hour_data;
    if (!pa || !sun) {
        container.innerHTML = "";
        return;
    }
    const end = (iso) => panchangaEnd(iso, results);
    const limbs = [
        {name: "Vara", value: `${pa.vara.name} · ${pa.vara.lord}`, end: ""},
        {name: "Tithi", value: `${pa.tithi.paksha} ${pa.tithi.name}（${pa.tithi.index}）`, end: end(pa.tithi.end)},
        {name: "Nakshatra", value: `${pa.nakshatra.name} · Pada ${pa.nakshatra.pada}`, end: end(pa.nakshatra.end)},
        {name: "Yoga", value: `${pa.yoga.name}（${pa.yoga.index}）`, end: end(pa.yoga.end)},
        {name: "Karana", value: `${pa.karana.name}（${pa.karana.index}）`, end: end(pa.karana.end)},
    ];
    const t = (iso) => (iso ? localTimeText(iso) : "—");
    const day = [
        {name: "日出", value: t(sun.sunrise_local)},
        {name: "日落", value: t(sun.sunset_local)},
        {name: "次日日出", value: t(sun.next_sunrise_local)},
    ];
    if (hour) {
        day.push({
            name: "Hora",
            value: `${hour.planetary_hour_lord} · ${hour.hour_number} · ${localTimeText(hour.hour_start).slice(11, 16)}–${localTimeText(hour.hour_end).slice(11, 16)}`,
        });
    }
    // 不要表头：左列就是名称，一眼看完
    const table = (rows) => `<div class="table-wrap"><table class="info-table kv-table"><tbody>${rows.map((r) => `
        <tr><th>${escapeHtml(r.name)}</th><td${r.cls ? ` class="${r.cls}"` : ""}>${escapeHtml(r.value)}</td>${"end" in r ? `<td class="kv-end">${r.end ? `至 ${escapeHtml(r.end)}` : ""}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>`;
    let html = `<h3>Panchanga</h3>${table(limbs)}<h3>日出 · Hora</h3>${table(day)}`;
    const cal = results.calendar;
    if (cal) {
        const span = (x) => `${localTimeText(x.start).slice(11, 16)}–${localTimeText(x.end).slice(11, 16)}`;
        const times = [
            {name: "Rahu Kala", value: span(cal.rahu_kala)},
            {name: "Yamaganda", value: span(cal.yamaganda)},
            {name: "Gulika Kala", value: span(cal.gulika_kala)},
            {name: "Abhijit", value: span(cal.abhijit), cls: cal.abhijit.excluded ? "dim" : ""},
        ];
        const vela = (cal.kalavela?.items || []).map((x) => ({name: x.name, value: span(x)}));
        const year = [
            {name: "Masa", value: `${cal.masa.adhika ? "Adhika " : ""}${cal.masa.name}`},
            {name: "Samvatsara", value: `${cal.samvatsara.name}（${cal.samvatsara.index}）`},
            {name: "Ayana", value: cal.ayana.name},
        ];
        html += `<h3>凶时 · 吉时</h3>${table(times)}<h3>Kala Vela · ${cal.kalavela?.is_day ? "昼" : "夜"}</h3>${table(vela)}<h3>年 · 月</h3>${table(year)}`;
    }
    container.innerHTML = html;
}

// ---------- 结果表 ----------
// 行星、宫位：黄经（星座 + 星座内度分秒）、星宿、宿主星、Pada（后端 basics.py 算好）。
// KP 各表用同样的写法：行星写代号，星座写三个字母的英文缩写，星宿写「梵文名 中文宿名」，宫位只写数字。

const SIGN_ABBR = {
    Aries: "Ari", Taurus: "Tau", Gemini: "Gem", Cancer: "Can", Leo: "Leo", Virgo: "Vir",
    Libra: "Lib", Scorpio: "Sco", Sagittarius: "Sag", Capricorn: "Cap", Aquarius: "Aqu", Pisces: "Pis",
};
const SIGN_NAMES_EN = Object.keys(SIGN_ABBR);
const SIGN_ABBR_LIST = Object.values(SIGN_ABBR);
const signAbbr = (sign) => SIGN_ABBR[sign] || sign || "";
const NAKSHATRA_NAMES = [
    "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu", "Pushya", "Ashlesha",
    "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha",
    "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada", "Revati",
];

// 黄经一格：星座缩写占固定宽度，度分秒紧跟其后，上下行星座对星座、度数对度数
function posCell(sign, dms) {
    return {html: `<span class="pos"><span class="pos-s">${escapeHtml(signAbbr(sign))}</span><span>${escapeHtml(dms || "")}</span></span>`};
}

function basicRow(row, name) {
    return {
        name,
        position: posCell(row.sign, row.dms),
        nakshatra: row.nakshatra,
        star_lord: row.star_lord,
        pada: String(row.pada),
        motion: row.motion ? {text: row.motion, cls: row.retrograde ? "bad" : ""} : null,
    };
}

const BASIC_COLUMNS = [
    {key: "name", label: "名称"},
    {key: "position", label: "黄经"},
    {key: "nakshatra", label: "星宿"},
    {key: "star_lord", label: "宿主星"},
    {key: "pada", label: "Pada"},
];

// 行星表：基础五列、顺逆、燃烧，再加尊贵、Chara Karaka、Avastha（Baladi · Jagradadi）、特殊度数与行星战
function renderVedicPlanets(container, results) {
    const cfg = jyotishSettings();
    const pos = results.planet_pos || {};
    const karakas = Jyotish.charaKarakas(pos, cfg.status?.karaka);
    const wars = results.graha_yuddha || [];
    const rows = (results.planet_table || []).map((r) => {
        const row = basicRow(r, r.name);
        const c = combustInfo(results, r.name);
        row.combust = c?.combust ? {text: "燃烧", cls: "bad"} : "";
        const dig = Jyotish.dignity(r.name, r.lon, cfg.dignity);
        if (dig) {
            row.dignity = {text: dig.text, cls: dig.cls};
        } else if (cfg.dignity?.relation !== false) {
            // 不在庙、旺、根三方、落时：标出它与所在星座主星的五重关系
            const rel = Jyotish.signLordRelation(pos, r.name, Boolean(cfg.friends?.nodes));
            row.dignity = rel === null ? "" : {text: Jyotish.REL_TEXT[rel], cls: rel > 0 ? "good" : rel < 0 ? "bad" : "dim"};
        } else {
            row.dignity = "";
        }
        row.karaka = karakas[r.name] || "";
        const jag = Jyotish.jagradadi(r.name, r.lon, cfg.dignity);
        row.avastha = [Jyotish.baladi(r.lon), jag].filter(Boolean).join(" · ");
        const tags = Jyotish.specialDegrees(r.name, r.lon, cfg.status);
        for (const w of wars) {
            if (w.winner === r.name) tags.push({text: `战胜 ${w.loser}`, cls: "good"});
            else if (w.loser === r.name) tags.push({text: `战败 ${w.winner}`, cls: "bad"});
        }
        row.marks = tags.length ? {html: `<span class="tags">${tags.map((t) => `<span class="${t.cls}">${escapeHtml(t.text)}</span>`).join("")}</span>`} : "";
        return row;
    });
    container.innerHTML = rowsTableHtml([
        BASIC_COLUMNS[0], BASIC_COLUMNS[1], {key: "dignity", label: "尊贵"}, ...BASIC_COLUMNS.slice(2),
        {key: "motion", label: "顺 / 逆"}, {key: "combust", label: "燃烧"},
        {key: "karaka", label: "Karaka"}, {key: "avastha", label: "状态"}, {key: "marks", label: "标记"},
    ], rows);
}

function renderVedicHouses(container, results) {
    const rows = (results.house_table || []).map((r) => basicRow(r, houseName(r.name)));
    container.innerHTML = rowsTableHtml(BASIC_COLUMNS, rows);
}

function kpLordsHtml(data, nameOf) {
    const rows = Object.entries(data || {}).map(([key, r]) => ({
        name: nameOf(key),
        sign: posCell(r.sign, r.dms),
        star: r.star,
        sign_lord: r.sign_lord,
        star_lord: r.star_lord,
        sub_lord: r.sub_lord,
        sub_sub_lord: r.sub_sub_lord,
        pada: String(r.paada),
    }));
    return rowsTableHtml([
        {key: "name", label: "名称"},
        {key: "sign", label: "黄经"},
        {key: "star", label: "星宿"},
        {key: "sign_lord", label: "RL"},
        {key: "star_lord", label: "NL"},
        {key: "sub_lord", label: "SL"},
        {key: "sub_sub_lord", label: "SSL"},
        {key: "pada", label: "Pada"},
    ], rows);
}

const listText = (v) => (Array.isArray(v) && v.length ? v.join(", ") : "");

function kpPlanetSigsHtml(data) {
    const rows = Object.entries(data || {}).map(([code, r]) => ({
        name: code, A: listText(r.A), B: listText(r.B), C: listText(r.C), D: listText(r.D),
    }));
    return rowsTableHtml(["name", "A", "B", "C", "D"].map((k) => ({key: k, label: k === "name" ? "名称" : k})), rows);
}

function kpHouseSigsHtml(data) {
    const rows = Object.entries(data || {}).map(([house, r]) => ({
        name: houseName(house), l1: listText(r["1"]), l2: listText(r["2"]), l3: listText(r["3"]), l4: listText(r["4"]),
    }));
    return rowsTableHtml([
        {key: "name", label: "名称"}, {key: "l1", label: "1"}, {key: "l2", label: "2"}, {key: "l3", label: "3"}, {key: "l4", label: "4"},
    ], rows);
}

const RULING_LABELS = {
    Asc_Sign_Lord: "Lagna Rashi Lord", Asc_Star_Lord: "Lagna Nakshatra Lord", Asc_Sub_Lord: "Lagna Sub Lord",
    Moon_Sign_Lord: "Moon Rashi Lord", Moon_Star_Lord: "Moon Nakshatra Lord", Moon_Sub_Lord: "Moon Sub Lord",
    Day_Lord: "Day Lord",
};

function kpRulingHtml(data) {
    const rows = Object.entries(data || {}).map(([key, v]) => ({name: RULING_LABELS[key] || key, value: v}));
    return rowsTableHtml([{key: "name", label: "名称"}, {key: "value", label: "值"}], rows);
}

// ---------- 星盘样式：北印度 / 南印度 ----------

function bindChartStyle() {
    document.querySelectorAll("input[name='chartStyle']").forEach((radio) => {
        radio.checked = radio.value === state.chartStyle;
        radio.addEventListener("change", async () => {
            state.chartStyle = radio.value;
            renderChart();
            try {
                await api(systemApi("/chart-style"), {method: "POST", body: JSON.stringify({chart_style: radio.value})});
            } catch (error) {
                showError(`星盘样式没能保存：${error.message}`);
            }
        });
    });
}

// ================= 挂到共用页面上 =================

registerSystem({
    init(bootstrap) {
        state.modules = resolveModules(state.settings.calculation_defaults?.kp_enabled !== false);
        state.chartStyle = state.settings.chart_style === "south" ? "south" : "north";
    },
    bind() {
        bindChartStyle();
        bindRotation();
        bindVedicSettings();
        bindLazyTabs();
        bindYoga();
    },
    // 本体系自己的计算选项都从设置里取（设置在浮窗里改，点「完成」才写回）
    collectOptions() {
        const calc = state.settings.calculation_defaults;
        return {
            kp_enabled: calc.kp_enabled !== false,
            KP_HORARY: {is_active: false, mode: "KS-N", number: 78, ...(calc.KP_HORARY || {})},
            dasha_days_in_year: Number(calc.dasha_days_in_year || 365.25),
            dasha_start_planet: calc.dasha_start_planet || "Mo",
            jyotish: backendJyotishOptions(),
        };
    },
    afterCalculate(kind, result) {
        state.chartModules[kind] = {...(result.modules || {})};
    },
    renderResults() {
        state.computedModules = state.chartModules[resultsKind()] || {};
        renderModuleResults();
        scheduleYogaRender();
        markLazyTabs();
    },
    onDerivedReady() {
        scheduleYogaRender();          // Bhava 盘要等后端，算好后 Yoga 再按它算一次
    },
    // 「原始参数」：共用的三类，再加特殊点、力量、历法的后端原始数据
    rawSections: (r) => [
        ...baseRawSections(r).map((sec) => (sec.key === "sun" ? {...sec, title: "日出 · Hora"} : sec)),
        {key: "points", title: "特殊点", tables: [
            {title: "Vishesha Lagna", data: r.vishesha_lagnas}, {title: "Upagraha", data: r.upagrahas},
            {title: "行星战", data: Object.fromEntries((r.graha_yuddha || []).map((w, i) => [String(i + 1), w]))},
        ]},
        {key: "bala", title: "力量", tables: [{title: "", data: r.shadbala}]},
        {key: "calendar", title: "历法", tables: [{title: "Panchanga", data: r.panchanga}, {title: "时段与年月", data: r.calendar}]},
    ],
    renderPlanetTab: renderVedicPlanets,
    planetName: (code) => escapeHtml(code || "—"),
    renderHouseTab: renderVedicHouses,
    renderChart(container, results, {emptyText, view, mini}) {
        if (!mini) updateRotationPicker(view);
        const options = {style: state.chartStyle, emptyText, aspects: vedicAspects(), mini: Boolean(mini)};
        if (rasiDrishtiOn()) options.rasiAspects = Jyotish.rasiAspects;
        // 特殊点从这张盘所依据的那张盘（本命或过境）取
        const base = view === "transit" ? state.charts.transit.results : state.charts.natal.results;
        if (view === "gochara") {
            const natal = withExtras(withRotation(results?.natal, view), view, base);
            AstroChart.render(container, natal, {...options, gochara: results?.transit});
        } else {
            AstroChart.render(container, withExtras(withRotation(results, view), view, base), options);
        }
    },
    onNewChart() {
        AstroChart.clearSelection();
    },
    tabVisible(button) {
        const module = button.dataset.module;
        return module ? Boolean(state.modules[module]) : undefined;
    },
    viewLabels: {natal: "Rashi", transit: "Transit"},
    derivedViews: buildDerivedViews(),
    viewMenu: buildViewMenu(),
    // 三盘视角的小星盘：除 Rashi、Gochara 以外的所有盘
    miniViews: [
        {value: "transit", label: "Transit"}, {value: "moon", label: "Moon"}, {value: "bhava", label: "Bhava"},
        ...VedicVargas.list().filter((v) => v.view !== "natal").map((v) => ({value: v.view, label: `${v.id} ${v.name}`})),
    ],
    miniDefaults: ["D9", "transit"],
    onProfileChange() {
        state.rotation = {};            // 换了人：各张盘的转宫都回到 Lagna
    },
    tabLabels: {tabSun: "历法"},
    // 结果区标签页的默认顺序；改动这里时把 tabOrderRev 加 1，旧的保存顺序就不再使用
    defaultTabOrder: ["tabPlanets", "tabHouses", "tabDasha", "tabYoga", "tabSun", "tabBala", "tabAv", "tabFriends",
        "tabVargas", "tabLagnas", "tabUpagraha", "tabArudha", "tabKpPlanets", "tabKpHouses",
        "tabKpAbcd", "tabKp1234", "tabRuling", "tabProfile"],
    tabOrderRev: 2,
    renderSunTab: renderPanchanga,
});
