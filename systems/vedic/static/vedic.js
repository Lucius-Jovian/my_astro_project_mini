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

// 大运起算行星：所有行星（包括罗睺 / 计都）都可以选。
function fillDashaStartOptions() {
    const planets = state.optionsMeta.main_planets;
    fillSelect($("dashaStartPlanet"), planets.map((code) => ({value: code, label: code})));
    const wanted = state.settings.calculation_defaults.dasha_start_planet || "Mo";
    $("dashaStartPlanet").value = planets.includes(wanted) ? wanted : "Mo";
}

// KS-N 上限 249，CIL-N 上限 2193（对应 kp.py 的 get_horary_ascendant）。
function updateHoraryRange() {
    const mode = $("horaryMode").value;
    const max = mode === "CIL-N" ? 2193 : 249;
    const input = $("horaryNumber");
    input.max = String(max);
    input.placeholder = `1-${max}`;

    const current = Number(input.value);
    if (!current || current < 1) input.value = "1";
    else if (current > max) input.value = String(max);
}

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

function kpEnabled() {
    return $("kpEnabled").checked;
}

// KP 面板：右边的摘要，以及启用 KP 之前卜卦设置变灰。
function updateKpUI() {
    const on = kpEnabled();
    const horary = $("horaryActive").checked ? ` · 卜卦 ${$("horaryMode").value} ${$("horaryNumber").value}` : "";
    $("kpMeta").textContent = on ? `已启用${horary}` : "未启用";
    $("kpHoraryBox").classList.toggle("disabled", !on);
    for (const id of ["horaryActive", "horaryMode", "horaryNumber"]) $(id).disabled = !on;
}

// 「启用 KP」一改：关掉的模块结果马上清掉、标签页隐藏；已经排过盘时立即按新设置重算一次
// （卜卦会改变宫位，所以关掉 KP 也要重算）。
function setKpEnabled(on) {
    state.modules = resolveModules(on);
    for (const [m, keys] of Object.entries(MODULE_RESULT_KEYS)) {
        if (state.modules[m]) continue;
        keys.forEach((k) => delete state.results[k]);
        state.computedModules[m] = false;
    }
    updateKpUI();
    updateTabVisibility();
    renderModuleResults();
    saveVedicCalc({kp_enabled: on});
    if (state.charts[chartKind()].results) ensureComputed();     // Gochara 时本命、过境两张盘都要按新设置重算
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

function horaryPayload() {
    return {
        is_active: $("horaryActive").checked,
        mode: $("horaryMode").value,
        number: Number($("horaryNumber").value || 1),
    };
}

function bindVedicCalc() {
    $("kpEnabled").addEventListener("change", () => setKpEnabled(kpEnabled()));
    $("horaryMode").addEventListener("change", updateHoraryRange);
    for (const id of ["horaryActive", "horaryMode", "horaryNumber"]) {
        $(id).addEventListener("change", () => {
            if (id === "horaryNumber") updateHoraryRange();
            updateKpUI();
            saveVedicCalc({KP_HORARY: horaryPayload()});
        });
    }
    $("dashaStartPlanet").addEventListener("change", () => saveVedicCalc({dasha_start_planet: $("dashaStartPlanet").value}));
    $("dashaDaysInYear").addEventListener("change", () => {
        const days = Number($("dashaDaysInYear").value);
        if (!Number.isFinite(days) || days < 300 || days > 400) {
            showError("Dasha 年长度必须是 300–400 之间的天数。");
            return;
        }
        saveVedicCalc({dasha_days_in_year: days});
    });
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
// 当前显示哪一种记在 calculation_defaults.dasha_system，只在 Dasha 标签页顶部的下拉框里切换（左侧 Dasha 设置里不再重复放这一项）。

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
    const select = document.createElement("select");
    select.setAttribute("aria-label", "大运体系");
    fillSelect(select, dashaSystemOptions());
    select.value = data.value;
    select.addEventListener("change", () => selectDashaSystem(select.value));
    head.appendChild(select);
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

// 放在按钮条上的 D 盘（其余在下拉菜单里）。想多放一张，只改这一处。
const PINNED_VARGAS = ["D9"];

const signIndex = (lon) => Math.floor(norm360(lon) / 30) % 12;

function vargaSettings() {
    state.settings.varga = state.settings.varga || {};
    return state.settings.varga;
}

// Rashi 盘以哪个星座为第一宫：null = 跟随上升点；0–11 = 转宫。
function rashiLagna() {
    const v = vargaSettings().rashi_lagna;
    return Number.isInteger(v) && v >= 0 && v <= 11 ? v : null;
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
let vargaSaveChain = Promise.resolve();

function saveVarga(changes) {
    Object.assign(vargaSettings(), changes);
    vargaSaveChain = vargaSaveChain
        .then(() => api(systemApi("/varga"), {method: "POST", body: JSON.stringify(changes)}))
        .catch((error) => showError(`分盘设置没能保存：${error.message}`));
    updateVargaMeta();
    $("lagnaPick").classList.toggle("is-rotated", rashiLagna() !== null);
    renderChart();          // 正在看的盘受影响时立即重画（别的分盘等点到时再按新设置换算）
    yogaSettingsChanged();  // 分盘算法、Bhava 宫位制会影响对应分盘的 Yoga
}

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

    return {
        planet_pos: natal.planet_pos,
        house_result: {house_system: houses.house_system, axes: {Asc: asc}, houses: {}},
        chart_meta: {lagna_sign: base, hide_cusps: true, cells, ranks, notes},
    };
}

// 按钮条的顺序：Rashi、Transit 固定在最前，后面按这里的数字从小到大。想调整顺序，只改这几个数字。
const BAR_ORDER = {moon: 10, bhava: 20, D9: 30, gochara: 40};

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
        items: VedicVargas.list().map((v) => ({
            value: v.view, label: v.id, note: v.name, sub: v.topic,
            title: `${v.id} ${v.name} · ${v.topic}`,
        })),
    };
}

function rotationNote(natal) {
    const lagna = rashiLagna();
    if (lagna === null) return "";
    const asc = natal?.house_result?.axes?.Asc;
    const real = asc ? `，上升点实际在${SIGN_LIST[signIndex(asc.lon)]}` : "";
    return `转宫：以${SIGN_LIST[lagna]}为第一宫${real}`;
}

function vargaCaption(view, results) {
    if (view === "natal") return rotationNote(results);
    if (view === "gochara") {
        const when = results?.transit?.context?.local_dt;
        const text = `Gochara · 内圈 Rashi，外圈过境${when ? `（${localTimeText(when)}）` : ""}`;
        const rot = rotationNote(results?.natal);
        return rot ? `${text} · ${rot}` : text;
    }
    if (view === "moon") return "Moon · 以月亮所在星座为第一宫";
    if (view === "bhava") return `Bhava · ${bhavaHouseSystem()} 宫位制 · 一个格子是一个宫位`;
    const varga = VedicVargas.get(view);
    if (!varga) return "";
    const method = varga.methods[vargaMethod(varga.id)];
    return `${varga.id} ${varga.name} · ${varga.topic} · ${method.label}`;
}

// ---------- 计算设置 → 分盘 ----------

function updateVargaMeta() {
    $("vargaMeta").textContent = `Bhava ${bhavaHouseSystem()}`;
    const vargas = VedicVargas.list().filter((v) => v.view !== "natal");
    const changed = vargas.filter((v) => vargaMethod(v.id) !== VedicVargas.defaultMethod(v.id)).length;
    $("vargaMethodCount").textContent = changed ? `${changed} 张非默认` : `${vargas.length} 张`;
}

function fillVargaSelects() {
    fillSelect($("rashiLagna"), [
        {value: "asc", label: "跟随上升点"},
        ...SIGN_LIST.map((name, i) => ({value: String(i), label: `${i + 1} ${name}`})),
    ]);
    const lagna = rashiLagna();
    $("rashiLagna").value = lagna === null ? "asc" : String(lagna);
    fillSelect($("bhavaHouseSystem"), state.optionsMeta.house_systems);
    $("bhavaHouseSystem").value = bhavaHouseSystem();
    updateVargaMeta();
}

function renderVargaDialog() {
    const list = $("vargaMethodList");
    list.innerHTML = "";
    for (const varga of VedicVargas.list()) {
        if (varga.view === "natal") continue;
        const keys = Object.keys(varga.methods);
        const current = vargaMethod(varga.id);
        const row = document.createElement("div");
        row.className = "varga-row";
        row.innerHTML = `
            <span class="varga-id">${escapeHtml(varga.id)}</span>
            <span class="varga-name">${escapeHtml(varga.name)}<span class="muted"> · ${escapeHtml(varga.topic)}</span></span>
            <select aria-label="${escapeHtml(varga.id)} 的算法" ${keys.length > 1 ? "" : "disabled"}></select>
            <span class="varga-note muted"></span>`;
        const select = row.querySelector("select");
        fillSelect(select, keys.map((k) => ({value: k, label: varga.methods[k].label})));
        select.value = current;
        const note = row.querySelector(".varga-note");
        const showNote = () => {
            const m = varga.methods[select.value];
            note.textContent = [m.note, m.source ? `出处：${m.source}` : ""].filter(Boolean).join("。");
        };
        showNote();
        select.addEventListener("change", () => {
            showNote();
            const methods = {...(vargaSettings().methods || {})};
            if (select.value === VedicVargas.defaultMethod(varga.id)) delete methods[varga.id];
            else methods[varga.id] = select.value;
            saveVarga({methods});
        });
        list.appendChild(row);
    }
}

function bindVargaSettings() {
    fillVargaSelects();
    // 转宫在星盘上方（Rashi、Gochara 时显示），设置仍存在 varga.rashi_lagna。
    $("rashiLagna").addEventListener("change", () => {
        const v = $("rashiLagna").value;
        saveVarga({rashi_lagna: v === "asc" ? "asc" : Number(v)});
    });
    $("lagnaPick").classList.toggle("is-rotated", rashiLagna() !== null);
    $("bhavaHouseSystem").addEventListener("change", () => saveVarga({bhava_house_system: $("bhavaHouseSystem").value}));
    $("openVargaMethodsBtn").addEventListener("click", () => {
        renderVargaDialog();
        openDialog("vargaDialog");
    });
    $("vargaResetBtn").addEventListener("click", () => {
        saveVarga({methods: {}});
        renderVargaDialog();
    });
}

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

function updateAspectMeta() {
    const cfg = aspectSettings();
    const on = ["Ra", "Ke"].filter((k) => cfg[k] !== false).map((k) => (k === "Ra" ? "罗睺" : "计都"));
    $("aspectMeta").textContent = on.length ? `${on.join("、")}投射相位` : "罗计不投射相位";
}

function bindAspectSettings() {
    const cfg = aspectSettings();
    $("aspectRa").checked = cfg.Ra !== false;
    $("aspectKe").checked = cfg.Ke !== false;
    updateAspectMeta();
    let chain = Promise.resolve();
    for (const [id, key] of [["aspectRa", "Ra"], ["aspectKe", "Ke"]]) {
        $(id).addEventListener("change", () => {
            const changes = {[key]: $(id).checked};
            Object.assign(aspectSettings(), changes);
            updateAspectMeta();
            AstroChart.clearSelection();
            renderChart();
            yogaSettingsChanged();
            chain = chain
                .then(() => api(systemApi("/aspects"), {method: "POST", body: JSON.stringify(changes)}))
                .catch((error) => showError(`相位设置没能保存：${error.message}`));
        });
    }
}

// ---------- 结果表 ----------
// 行星、宫位：黄经（星座 + 星座内度分秒）、星宿、宿主星、Pada（后端 basics.py 算好）。
// KP 各表用同样的写法：行星写代号，星座写中文，星宿写「梵文名 中文宿名」，宫位写「第 N 宫」。

const SIGN_CN = {
    Aries: "白羊", Taurus: "金牛", Gemini: "双子", Cancer: "巨蟹", Leo: "狮子", Virgo: "处女",
    Libra: "天秤", Scorpio: "天蝎", Sagittarius: "射手", Capricorn: "摩羯", Aquarius: "水瓶", Pisces: "双鱼",
};

function nakshatraText(name, cn) {
    return cn ? `${name} ${cn}` : name;
}

function basicRow(row, name) {
    return {
        name,
        position: `${row.sign_cn} ${row.dms}`,
        nakshatra: nakshatraText(row.nakshatra, row.nakshatra_cn),
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

function renderVedicPlanets(container, results) {
    const rows = (results.planet_table || []).map((r) => basicRow(r, r.name));
    container.innerHTML = rowsTableHtml([...BASIC_COLUMNS, {key: "motion", label: "顺 / 逆"}], rows);
}

function renderVedicHouses(container, results) {
    const rows = (results.house_table || []).map((r) => basicRow(r, houseName(r.name)));
    container.innerHTML = rowsTableHtml(BASIC_COLUMNS, rows);
}

function kpLordsHtml(data, nameOf) {
    const rows = Object.entries(data || {}).map(([key, r]) => ({
        name: nameOf(key),
        sign: `${r.sign_cn || SIGN_CN[r.sign] || r.sign}${r.dms ? ` ${r.dms}` : ""}`,
        star: nakshatraText(r.star, r.star_cn),
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
        {key: "sign_lord", label: "星座主"},
        {key: "star_lord", label: "宿主星"},
        {key: "sub_lord", label: "子主星"},
        {key: "sub_sub_lord", label: "子子主星"},
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
    Asc_Sign_Lord: "上升星座主", Asc_Star_Lord: "上升宿主星", Asc_Sub_Lord: "上升子主星",
    Moon_Sign_Lord: "月亮星座主", Moon_Star_Lord: "月亮宿主星", Moon_Sub_Lord: "月亮子主星",
    Day_Lord: "值日星",
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
        updateHoraryRange();
        bindVedicCalc();
        updateKpUI();
        bindChartStyle();
        bindVargaSettings();
        bindAspectSettings();
        bindYoga();
    },
    applyDefaults(calc) {
        $("kpEnabled").checked = calc.kp_enabled !== false;
        $("horaryActive").checked = Boolean(calc.KP_HORARY?.is_active);
        $("horaryMode").value = calc.KP_HORARY?.mode || "KS-N";
        $("horaryNumber").value = calc.KP_HORARY?.number ?? 78;
        $("dashaDaysInYear").value = calc.dasha_days_in_year ?? 365.25;
        fillDashaStartOptions();
        updateKpUI();
    },
    collectOptions() {
        return {
            kp_enabled: kpEnabled(),
            KP_HORARY: horaryPayload(),
            dasha_days_in_year: Number($("dashaDaysInYear").value || 365.25),
            dasha_start_planet: $("dashaStartPlanet").value || "Mo",
        };
    },
    afterCalculate(kind, result) {
        state.chartModules[kind] = {...(result.modules || {})};
    },
    renderResults() {
        state.computedModules = state.chartModules[resultsKind()] || {};
        renderModuleResults();
        scheduleYogaRender();
    },
    onDerivedReady() {
        scheduleYogaRender();          // Bhava 盘要等后端，算好后 Yoga 再按它算一次
    },
    renderPlanetTab: renderVedicPlanets,
    planetName: (code) => escapeHtml(code || "—"),
    renderHouseTab: renderVedicHouses,
    renderChart(container, results, {emptyText, view}) {
        // 转宫只用于 Rashi 和 Gochara（里面那张就是 Rashi）；星盘上方的「第一宫」也只在这两种盘显示。
        $("lagnaPick").hidden = !(view === "natal" || view === "gochara");
        const rotate = (natal) => {
            const lagna = rashiLagna();
            return natal && lagna !== null ? {...natal, chart_meta: {...(natal.chart_meta || {}), lagna_sign: lagna}} : natal;
        };
        const options = {style: state.chartStyle, emptyText, aspects: vedicAspects()};
        if (view === "gochara") {
            AstroChart.render(container, rotate(results?.natal), {...options, gochara: results?.transit,
                emptyText: state.activeProfile ? "排盘后显示 Gochara" : "选择人物后显示 Gochara"});
        } else {
            AstroChart.render(container, view === "natal" ? rotate(results) : results, options);
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
    viewCaption: vargaCaption,
});
