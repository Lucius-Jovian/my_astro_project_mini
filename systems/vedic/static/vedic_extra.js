"use strict";
/*
 * 印占的扩展部分：尊贵、行星状态、特殊点、力量、八重点、敌友、分盘汇总、历法的设置，
 * 以及力量、八重点、敌友、分盘汇总、Vishesha Lagna、Upagraha、Arudha 七个标签页和星盘里的特殊点。
 *
 * 设置存在 settings.json → systems.vedic.jyotish（后端 bridge.py 的 JYOTISH_SPEC 校验）。
 * 其中行星战、力量、特殊点的时点、历法由后端计算：它们进排盘请求，改了以后按原来的时刻重算；
 * 其余只在页面上计算（jyotish.js），改了立即重画，不重新排盘。
 *
 * 性能：七个新标签页只在显示时才画（切过去时画一次，换盘或改设置后标记为需要重画）。
 */

// ---------------------------------------------------------------- 设置

function jyotishDefaults() {
    return state.optionsMeta?.jyotish_defaults || {};
}

function jyotishSettings() {
    if (!state.settings.jyotish) state.settings.jyotish = JSON.parse(JSON.stringify(jyotishDefaults()));
    return state.settings.jyotish;
}

// 由后端计算、要进排盘请求的几项（与 bridge.py 的 backend_jyotish 对应）
const JY_BACKEND = {
    status: ["war", "war_orb", "war_rule"],
    bala: null,
    points: ["lagna_base", "gulika_at", "mandi_at", "kalavela_at"],
    calendar: null,
};

function backendJyotishOptions() {
    const cfg = jyotishSettings();
    const out = {};
    for (const [section, keys] of Object.entries(JY_BACKEND)) {
        const src = cfg[section] || {};
        out[section] = keys ? Object.fromEntries(keys.map((k) => [k, src[k]])) : {...src};
    }
    return out;
}

// 罗计的旺座也用于 Yoga（exalted、debilitated 等），两边一致
function applyNodeExalt() {
    const ex = YogaEngine?.tables?.EXALT;
    if (!ex) return;
    const nodes = jyotishSettings().dignity?.nodes === "gemini" ? {Ra: 2, Ke: 8} : {Ra: 1, Ke: 7};
    if (ex.Ra !== nodes.Ra || ex.Ke !== nodes.Ke) {
        Object.assign(ex, nodes);
        yogaSettingsChanged();
    }
}

let jySaveChain = Promise.resolve();

function saveJyotish(changes) {
    const cfg = jyotishSettings();
    for (const [section, values] of Object.entries(changes)) {
        const merged = {...(cfg[section] || {})};
        for (const [k, v] of Object.entries(values)) {
            merged[k] = v && typeof v === "object" && !Array.isArray(v) ? {...(merged[k] || {}), ...v} : v;
        }
        cfg[section] = merged;
    }
    jySaveChain = jySaveChain
        .then(() => api(systemApi("/jyotish"), {method: "POST", body: JSON.stringify(changes)}))
        .catch((error) => showError(`设置没能保存：${error.message}`));
    applyNodeExalt();
    updateJyotishMeta();
    // 后端计算的几项改了：排盘请求跟着变，ensureComputed 按原来的时刻重算；其余的直接重画。
    if (state.charts[chartKind()].results) ensureComputed();
    renderView();
}

function readJyInput(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return Number(el.value);
    return el.value;
}

function jyValue(path) {
    return path.split(".").reduce((node, key) => node?.[key], jyotishSettings());
}

function fillJyInputs() {
    document.querySelectorAll("[data-jy]").forEach((el) => {
        const v = jyValue(el.dataset.jy);
        if (el.type === "checkbox") el.checked = Boolean(v);
        else el.value = v ?? "";
    });
    const chosen = new Set(jyotishSettings().points?.chart || []);
    document.querySelectorAll("[data-jy-code]").forEach((el) => { el.checked = chosen.has(el.dataset.jyCode); });
}

// 星盘里可以画的特殊点（顺序 = 设置里的顺序 = 后端 POINT_CODES）
const POINT_GROUPS = [
    {label: "Vishesha Lagna", codes: ["BL", "HL", "GL", "VG", "VL", "SL", "PP", "IL", "BB"]},
    {label: "Upagraha", codes: ["Dh", "Vy", "Pv", "Ic", "Uk", "Kl", "Mr", "Ap", "Yg", "Gk", "Md"]},
    {label: "Arudha", codes: ["AL", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "UL"]},
];

function updateJyotishMeta() {
    const cfg = jyotishSettings();
    const d = jyotishDefaults().dignity || {};
    const same = Number(cfg.dignity?.orb) === Number(d.orb) &&
        Jyotish.P7.every((p) => Number(cfg.dignity?.deep?.[p]) === Number(d.deep?.[p]));
    $("dignityMeta").textContent = same ? "BPHS" : "自定义";
    const n = (cfg.points?.chart || []).length;
    $("pointsMeta").textContent = n ? `星盘 ${n}` : "";
}

function bindJyotishSettings() {
    $("deepGrid").innerHTML = Jyotish.P7.map((p) => `
        <label class="combust-field"><span>${p}</span>
            <input type="number" min="0" max="30" step="0.5" data-jy="dignity.deep.${p}">°</label>`).join("");
    $("pointChartGrid").innerHTML = POINT_GROUPS.map((g) => `
        <span class="pc-group">${escapeHtml(g.label)}</span>
        ${g.codes.map((c) => `<label><input type="checkbox" data-jy-code="${c}">${c}</label>`).join("")}`).join("");
    fillJyInputs();
    updateJyotishMeta();
    applyNodeExalt();

    document.querySelectorAll("[data-jy]").forEach((el) => {
        el.addEventListener("change", () => {
            const [section, key, sub] = el.dataset.jy.split(".");
            const value = readJyInput(el);
            if (el.type === "number") {
                const min = Number(el.min), max = Number(el.max);
                if (!Number.isFinite(value) || value < min || value > max || el.value === "") {
                    showError(`请填 ${min} 到 ${max} 之间的数字。`);
                    fillJyInputs();
                    return;
                }
            }
            saveJyotish({[section]: sub ? {[key]: {[sub]: value}} : {[key]: value}});
        });
    });
    $("pointChartGrid").addEventListener("change", () => {
        const chart = [...document.querySelectorAll("[data-jy-code]")].filter((el) => el.checked).map((el) => el.dataset.jyCode);
        saveJyotish({points: {chart}});
    });
    $("dignityResetBtn").addEventListener("click", () => {
        saveJyotish({dignity: JSON.parse(JSON.stringify(jyotishDefaults().dignity))});
        fillJyInputs();
    });
}

// ---------------------------------------------------------------- 星盘里的特殊点

const ARUDHA_NAMES = {AL: "Arudha Lagna", UL: "Upapada"};

// 某张盘里要画的特殊点。view：natal / transit / moon / bhava / gochara（本命那一层）/ D 盘
function chartExtraPoints(results, view, base) {
    const codes = jyotishSettings().points?.chart || [];
    if (!codes.length || !results || !base) return [];
    const varga = VedicVargas.get(view);
    const toLon = varga && view !== "natal" ? varga.methods[vargaMethod(varga.id)].toLon : null;
    const pos = results.planet_pos || {};
    const asc = results.house_result?.axes?.Asc?.lon;
    let arudha = null;
    const out = [];
    for (const code of codes) {
        const p = base.vishesha_lagnas?.[code] || base.upagrahas?.[code];
        if (p) {
            const lon = toLon ? toLon(p.lon) : p.lon;
            out.push({code, lon, sign_only: Boolean(p.sign_only),
                title: `${code} ${p.name}  ${SIGN_LIST[Jyotish.signOf(lon)]}${p.sign_only ? "" : ` ${dmsShort(lon)}`}`});
            continue;
        }
        if (Jyotish.ARUDHA_CODES.includes(code) && Number.isFinite(Number(asc))) {
            if (!arudha) {
                const signs = Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, Jyotish.signOf(v.lon)]));
                const degs = Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, Jyotish.degIn(v.lon)]));
                arudha = Jyotish.arudhas(signs, degs, Jyotish.signOf(asc), jyotishSettings().points);
            }
            if (arudha[code] !== undefined) {
                out.push({code, lon: arudha[code] * 30 + 15, sign_only: true,
                    title: `${code}${ARUDHA_NAMES[code] ? ` ${ARUDHA_NAMES[code]}` : ""}  ${SIGN_LIST[arudha[code]]}`});
            }
        }
    }
    return out;
}

function dmsShort(lon) {
    const total = Math.floor(Jyotish.degIn(lon) * 60 + 1e-7);
    return `${Math.floor(total / 60)}°${String(total % 60).padStart(2, "0")}'`;
}

// 把特殊点放进要画的盘：Bhava 盘按宫头把它们放进对应的宫位格子
function withExtras(results, view, base) {
    if (!results) return results;
    const extras = chartExtraPoints(results, view === "gochara" ? "natal" : view, base);
    if (!extras.length) return results;
    const meta = results.chart_meta || {};
    if (view === "bhava" && meta.placeOf) {
        const cells = {...(meta.cells || {})};
        const ranks = {...(meta.ranks || {})};
        for (const x of extras) {
            const {cell, rank} = meta.placeOf(x.lon);
            cells[x.code] = cell;
            ranks[x.code] = rank;
        }
        return {...results, extra_points: extras, chart_meta: {...meta, cells, ranks}};
    }
    return {...results, extra_points: extras};
}

// ---------------------------------------------------------------- 七个按需绘制的标签页

const LAZY_TABS = {
    tabBala: renderBalaTab,
    tabAv: renderAvTab,
    tabFriends: renderFriendsTab,
    tabVargas: renderVargasTab,
    tabLagnas: renderLagnaTab,
    tabUpagraha: renderUpagrahaTab,
    tabArudha: renderArudhaTab,
};
const lazyDirty = new Set(Object.keys(LAZY_TABS));

function markLazyTabs() {
    Object.keys(LAZY_TABS).forEach((id) => lazyDirty.add(id));
    renderVisibleLazyTab();
}

function renderVisibleLazyTab() {
    for (const id of [...lazyDirty]) {
        const panel = $(id);
        if (!panel || panel.classList.contains("hidden")) continue;
        lazyDirty.delete(id);
        const box = panel.firstElementChild;
        if (!Object.keys(state.results || {}).length) {
            box.innerHTML = "";
            continue;
        }
        try {
            LAZY_TABS[id](box, state.results);
        } catch (error) {
            box.innerHTML = `<p class="muted">${escapeHtml(error.message || String(error))}</p>`;
        }
    }
}

function bindLazyTabs() {
    $("resultTabs").addEventListener("click", (event) => {
        if (event.target.closest("[data-tab]")) renderVisibleLazyTab();
    });
}

const fixed = (v, n = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : "—");

// ---------- 力量（Shadbala）

const BALA_PARTS = [
    ["sthana", "Sthana"], ["dig", "Dig"], ["kala", "Kala"], ["cheshta", "Cheshta"], ["naisargika", "Naisargika"], ["drik", "Drik"],
];
const STHANA_PARTS = [["uccha", "Uccha"], ["saptavargaja", "Saptavargaja"], ["ojayugma", "Ojayugma"], ["kendradi", "Kendradi"], ["drekkana", "Drekkana"]];
const KALA_PARTS = [["nathonnatha", "Nathonnatha"], ["paksha", "Paksha"], ["tribhaga", "Tribhaga"], ["abda", "Abda"], ["masa", "Masa"],
    ["vara", "Vara"], ["hora", "Hora"], ["ayana", "Ayana"], ["yuddha", "Yuddha"]];

function renderBalaTab(box, results) {
    const bala = results.shadbala;
    if (!bala) {
        box.innerHTML = "";
        return;
    }
    const planets = Jyotish.P7.filter((p) => bala[p]);
    const table = (parts, extra = []) => rowsTableHtml(
        [{key: "name", label: "名称"}, ...parts.map(([k, label]) => ({key: k, label, cls: "num-col"})), ...extra],
        planets.map((p) => Object.fromEntries([["name", p], ...parts.map(([k]) => [k, fixed(bala[p][k])]),
            ...extra.map((c) => [c.key, c.value(bala[p])])])),
    ).replace("info-table", "info-table bala-table");
    const summary = [
        {key: "rupa", label: "Rupa", cls: "num-col", value: (r) => fixed(r.rupa)},
        {key: "required", label: "需要", cls: "num-col", value: (r) => fixed(r.required, 1)},
        {key: "ratio", label: "比值", cls: "num-col", value: (r) => ({text: fixed(r.ratio), cls: r.ratio < 1 ? "bad" : ""})},
        {key: "ishta", label: "Ishta", cls: "num-col", value: (r) => fixed(r.ishta)},
        {key: "kashta", label: "Kashta", cls: "num-col", value: (r) => fixed(r.kashta)},
    ];
    box.innerHTML = `<h3>Shadbala</h3>${table(BALA_PARTS, summary)}<h3>Sthana</h3>${table(STHANA_PARTS)}<h3>Kala</h3>${table(KALA_PARTS)}`;
}

// ---------- 八重点（Ashtakavarga）

function renderAvTab(box, results) {
    const pos = results.planet_pos;
    const asc = results.house_result?.axes?.Asc?.lon;
    if (!pos || !Number.isFinite(Number(asc))) {
        box.innerHTML = "";
        return;
    }
    const {bav, sav} = Jyotish.ashtakavarga(pos, asc);
    const lagna = Jyotish.signOf(asc);
    const byLagna = jyotishSettings().av?.columns === "lagna";
    const order = Array.from({length: 12}, (_, i) => (byLagna ? (lagna + i) % 12 : i));
    const head = order.map((s, i) => `<th class="${s === lagna ? "lagna-col" : ""}">${byLagna ? i + 1 : SIGN_ABBR_LIST[s]}</th>`).join("");
    const row = (name, values, cls = "") => {
        const total = values.reduce((a, b) => a + b, 0);
        return `<tr class="${cls}"><th>${name}</th>${order.map((s) => `<td>${values[s]}</td>`).join("")}<td>${total}</td></tr>`;
    };
    box.innerHTML = `<div class="table-wrap"><table class="info-table av-table"><thead><tr><th>名称</th>${head}<th>合计</th></tr></thead><tbody>
        ${Jyotish.P7.map((p) => row(p, bav[p])).join("")}${row("SAV", sav, "sav-row")}</tbody></table></div>`;
}

// ---------- 敌友

let friendsView = "compound";

function renderFriendsTab(box, results) {
    const pos = results.planet_pos;
    if (!pos) {
        box.innerHTML = "";
        return;
    }
    const data = Jyotish.friendship(pos, Boolean(jyotishSettings().friends?.nodes));
    const views = [["compound", "五重"], ["natural", "天然"], ["temporal", "临时"]];
    const matrix = data[friendsView];
    const cell = (a, b) => {
        if (a === b) return "<td class='dim'>·</td>";
        const v = matrix[a][b];
        const text = friendsView === "temporal" ? (v > 0 ? "友" : "敌") : Jyotish.REL_TEXT[v];
        return `<td class="${v > 0 ? "good" : v < 0 ? "bad" : ""}">${text}</td>`;
    };
    box.innerHTML = `
        <div class="tab-tools"><div class="segmented compact" role="radiogroup" aria-label="友敌">
            ${views.map(([v, label]) => `<label><input type="radio" name="friendsView" value="${v}" ${v === friendsView ? "checked" : ""}><span>${label}</span></label>`).join("")}
        </div></div>
        <div class="table-wrap"><table class="info-table rel-table"><thead><tr><th>名称</th>${data.list.map((p) => `<th>${p}</th>`).join("")}</tr></thead>
        <tbody>${data.list.map((a) => `<tr><th>${a}</th>${data.list.map((b) => cell(a, b)).join("")}</tr>`).join("")}</tbody></table></div>`;
    box.querySelectorAll("input[name='friendsView']").forEach((radio) => radio.addEventListener("change", () => {
        friendsView = radio.value;
        renderFriendsTab(box, results);
    }));
}

// ---------- 分盘汇总（16 张分盘的落座 + Vimsopaka + Vaiseshikamsa）

function renderVargasTab(box, results) {
    const pos = results.planet_pos;
    const ascPoint = results.house_result?.axes?.Asc;
    if (!pos || !ascPoint) {
        box.innerHTML = "";
        return;
    }
    const cfg = jyotishSettings();
    const vargas = VedicVargas.list();
    const codes = ["Asc", ...Object.keys(pos)];
    const lonOf = (code) => (code === "Asc" ? ascPoint.lon : pos[code].lon);
    const signsByVarga = {};
    for (const v of vargas) {
        const toLon = v.methods[vargaMethod(v.id)].toLon;
        signsByVarga[v.id] = Object.fromEntries(codes.map((c) => [c, Jyotish.signOf(toLon(lonOf(c)))]));
    }
    const groups = cfg.vargas || {};
    const summary = Jyotish.vargaSummary(signsByVarga, codes, cfg.dignity, groups, Boolean(cfg.friends?.nodes));
    const dig = cfg.dignity;
    const cell = (code, s) => {
        if (code === "Asc") return `<td>${SIGN_ABBR_LIST[s]}</td>`;
        const ex = Jyotish.exaltSign(code, dig);
        const good = Jyotish.dignifiedSign(code, s, dig);
        const bad = ex !== undefined && (ex + 6) % 12 === s;
        return `<td class="${good ? "good" : bad ? "bad" : ""}">${SIGN_ABBR_LIST[s]}</td>`;
    };
    const vg = Jyotish.GROUPS[groups.vimsopaka] || Jyotish.GROUPS.shodasha;
    const vs = Jyotish.GROUPS[groups.vaiseshikamsa] || Jyotish.GROUPS.dasha;
    box.innerHTML = `<div class="table-wrap"><table class="info-table vargas-table"><thead><tr><th>名称</th>
        ${vargas.map((v) => `<th>${v.id}</th>`).join("")}<th title="${escapeHtml(vg.label)}">Vimsopaka</th><th title="${escapeHtml(vs.label)}">Vaiseshikamsa</th></tr></thead><tbody>
        ${codes.map((c) => {
            const s = summary[c] || {};
            const vaise = s.count === null || s.count === undefined ? "—" : `${s.count}${s.name ? ` ${s.name}` : ""}`;
            return `<tr><th>${c}</th>${vargas.map((v) => cell(c, signsByVarga[v.id][c])).join("")}
                <td class="num-col">${s.vimsopaka === null || s.vimsopaka === undefined ? "—" : fixed(s.vimsopaka)}</td><td>${escapeHtml(vaise)}</td></tr>`;
        }).join("")}</tbody></table></div>`;
}

// ---------- Vishesha Lagna、Upagraha、Arudha

function nakshatraOf(lon) {
    const n = Math.floor(((Number(lon) % 360 + 360) % 360) * 3 / 40 + 1e-9) % 27;
    return NAKSHATRA_NAMES[n];
}

function pointTable(entries) {
    const rows = entries.map(([code, p]) => ({
        name: {html: `<span class="code-tag">${escapeHtml(code)}</span>${escapeHtml(p.name)}`},
        position: p.sign_only ? posCell(SIGN_NAMES_EN[Jyotish.signOf(p.lon)], "") : posCell(SIGN_NAMES_EN[Jyotish.signOf(p.lon)], dmsText(p.lon)),
        nakshatra: p.sign_only ? "" : nakshatraOf(p.lon),
    }));
    return rowsTableHtml([{key: "name", label: "名称"}, {key: "position", label: "黄经"}, {key: "nakshatra", label: "星宿"}], rows);
}

function dmsText(lon) {
    const total = Math.floor(Jyotish.degIn(lon) * 3600 + 1e-6);
    const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″`;
}

function renderLagnaTab(box, results) {
    box.innerHTML = results.vishesha_lagnas ? pointTable(Object.entries(results.vishesha_lagnas)) : "";
}

function renderUpagrahaTab(box, results) {
    box.innerHTML = results.upagrahas ? pointTable(Object.entries(results.upagrahas)) : "";
}

function renderArudhaTab(box, results) {
    const pos = results.planet_pos;
    const asc = results.house_result?.axes?.Asc?.lon;
    if (!pos || !Number.isFinite(Number(asc))) {
        box.innerHTML = "";
        return;
    }
    const signs = Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, Jyotish.signOf(v.lon)]));
    const degs = Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, Jyotish.degIn(v.lon)]));
    const lagna = Jyotish.signOf(asc);
    const pads = Jyotish.arudhas(signs, degs, lagna, jyotishSettings().points);
    const rows = Jyotish.ARUDHA_CODES.filter((c) => pads[c] !== undefined).map((code, i) => ({
        name: {html: `<span class="code-tag">${code}</span>${escapeHtml(ARUDHA_NAMES[code] || "")}`},
        bhava: String(i + 1),
        sign: SIGN_ABBR_LIST[pads[code]],
        house: String((pads[code] - lagna + 12) % 12 + 1),
    }));
    box.innerHTML = rowsTableHtml([
        {key: "name", label: "名称"}, {key: "bhava", label: "本宫"}, {key: "sign", label: "星座"}, {key: "house", label: "所在宫"},
    ], rows);
}
