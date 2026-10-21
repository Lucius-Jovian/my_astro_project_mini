"use strict";
/*
 * 西方占星的前端部分。共用的页面逻辑（档案、时间地点、过境、外观……）在 common/static/common.js，
 * 这里只放本体系自己的东西，通过 registerSystem({...}) 挂进去：
 *   - 计算设置里「星体配置」「相位」两组浮窗（草稿模式：点「完成」才保存并重算）
 *   - 小行星、恒星、Lot、特殊点、映点与反映点、相位的结果标签页
 *   - 圆形星盘（chart.js 提供 AstroChart）
 * 本体系的接口都在 /western/api/ 下，用 systemApi("/...") 拼地址。
 */

// 本体系自己的状态（挂在共用的 state 上）
state.points = null;        // 行星 / 小行星 / 恒星 / Lot / 特殊点 / 映点 / 配色
state.aspects = null;       // 相位：参与的点、容许度、相位类型
state.aspectView = "main";  // 相位标签页：main 主相位表 / others 其它点相位

// ---------- 小行星 / 恒星 / Lot / 特殊点的结果表 ----------
// 某一类一个都没勾选时，对应的标签页整个隐藏（见 updateTabVisibility）。
// 某几个点算不出来（例如缺少小行星的星历文件）时，表格下面逐条列出原因，其余照常显示。
const POINT_VIEWS = {
    asteroids: {target: "asteroidResult", table: "asteroid_table", errors: "asteroids"},
    stars: {target: "starResult", table: "star_table", errors: "fixed_stars"},
    lots: {target: "lotResult", table: "lot_table", errors: "lots"},
    specials: {target: "specialResult", table: "special_table", errors: "special_points"},
    antiscia: {target: "antisciaResult", table: "antiscia_table", errors: "antiscia"},
};

// 每一类“有没有勾选任何一项”，决定标签页显示与否。
function pointCategoryEnabled(category) {
    const p = state.points || {};
    if (category === "asteroids") return (p.asteroids || []).some((a) => a.enabled);
    if (category === "stars") return (p.stars || []).some((s) => s.enabled);
    if (category === "lots") return (p.lots?.items || []).some((l) => l.enabled);
    if (category === "specials") return (p.specials || []).length > 0;
    if (category === "antiscia") return (p.antiscia || []).some((a) => a.enabled && (p.planets || []).includes(a.planet));
    return true;
}

// ---------- 结果表共用的写法 ----------
// 行星写符号（按设置里的颜色），星座写符号，黄经 = 星座符号 + 星座内度分秒；只有速度用小数。

const SIGN_GLYPHS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"];
const SIGN_NAMES = ["白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼"];

function glyphHtml(text, color) {
    const style = color ? ` style="color:${escapeHtml(color)}"` : "";
    return `<span class="glyph"${style}>${escapeHtml(symText(text))}</span>`;
}

function planetGlyph(code) {
    if (!code) return "—";
    return glyphHtml(state.optionsMeta.planet_symbols[code] || code, state.points?.planet_colors?.[code]);
}

function positionCell(row) {
    return {html: `${glyphHtml(SIGN_GLYPHS[row.sign_index], state.points?.sign_colors?.[row.sign_index])} ${escapeHtml(row.dms)}`};
}

const COL = {
    name: {key: "name", label: "名称"},
    position: {key: "position", label: "黄经"},
    lat: {key: "lat", label: "黄纬"},
    ra: {key: "ra", label: "赤经"},
    dec: {key: "dec", label: "赤纬"},
    speed: {key: "speed", label: "速度"},
};

function pointRow(r, name) {
    return {name, position: positionCell(r), lat: r.lat_dms, ra: r.ra_dms, dec: r.dec_dms, speed: speedText(r.speed)};
}

const POINT_RENDERERS = {
    asteroids: (rows) => rowsTableHtml([COL.name, COL.position, COL.lat, COL.ra, COL.dec, COL.speed], rows.map((r) => pointRow(r, r.name))),
    specials: (rows) => rowsTableHtml([COL.name, COL.position, COL.lat, COL.ra, COL.dec, COL.speed], rows.map((r) => pointRow(r, r.name))),
    stars: (rows) => rowsTableHtml(
        [COL.name, COL.position, COL.lat, COL.ra, COL.dec, COL.speed, {key: "mag", label: "星等"}, {key: "bayer", label: "拜耳命名"}],
        rows.map((r) => ({...pointRow(r, r.name), mag: Number(r.mag).toFixed(2), bayer: r.bayer})),
    ),
    lots: (rows) => rowsTableHtml(
        [COL.name, COL.position, COL.speed, {key: "formula", label: "公式"}, {key: "sect", label: "日夜"}],
        rows.map((r) => ({name: r.name, position: positionCell(r), speed: speedText(r.speed), formula: r.formula, sect: r.sect})),
    ),
    antiscia: (rows) => rowsTableHtml(
        [COL.name, COL.position, COL.speed],
        rows.map((r) => ({name: {html: glyphHtml(r.symbol, r.color)}, position: positionCell(r), speed: speedText(r.speed)})),
    ),
};

function renderPointResults() {
    const errors = state.results.point_errors || {};
    const hasResults = Object.keys(state.results).length > 0;
    for (const [category, view] of Object.entries(POINT_VIEWS)) {
        const box = $(view.target);
        if (!pointCategoryEnabled(category)) {
            box.innerHTML = "";
            continue;
        }
        const rows = state.results[view.table];
        if (hasResults && rows === undefined) {
            box.innerHTML = "<p class='muted'>未计算</p>";
            continue;
        }
        box.innerHTML = POINT_RENDERERS[category](rows || []);
        const list = errors[view.errors] || [];
        if (list.length) {
            box.insertAdjacentHTML("beforeend", list.map((e) =>
                `<p class="point-error"><b>${escapeHtml(e.label)}</b>：${escapeHtml(e.error)}</p>`).join(""));
        }
    }
}

function renderWesternHouses(container, results) {
    const rows = (results.house_table || []).map((r) => pointRow(r, houseName(r.name)));
    container.innerHTML = rowsTableHtml([COL.name, COL.position, COL.ra, COL.dec, COL.speed], rows);
}

// ================= 设置浮窗：星体配置、相位 =================
// 设置面板里每一项只占一行（右边显示摘要），点开在浮窗里详细修改。
// 浮窗里的所有修改都只改一份“草稿”：点「完成」时才一次性校验、写回 settings.json，并按新设置重算一次；
// 点「取消」、×、按 Esc 或点浮窗外面，都放弃草稿（有改动时先确认）。
// 例外：添加小行星 / 恒星时要立即向后端查名字和星历文件，编辑 Lot 公式时即时检查写法，这些都不会保存。

const SETTINGS_DIALOGS = {
    points: {
        endpoint: "/points",
        categories: {
            planets: {title: "行星", render: renderPlanetsDialog, bulk: ["all", "none"]},
            asteroids: {title: "小行星", render: renderAsteroidsDialog, bulk: ["all", "none", "clear"]},
            stars: {title: "恒星", render: renderStarsDialog, bulk: ["all", "none", "clear"]},
            lots: {title: "Lot", render: renderLotsDialog, bulk: ["all", "none", "clear"]},
            specials: {title: "特殊点", render: renderSpecialsDialog, bulk: ["all", "none"]},
            antiscia: {title: "映点与反映点", render: renderAntisciaDialog, bulk: ["all", "none"]},
            signs: {title: "星座配色", render: renderSignsDialog, bulk: []},
        },
    },
    aspects: {
        endpoint: "/aspects",
        categories: {
            selection: {title: "相位 · 行星选用", render: renderAspectSelectionDialog, bulk: ["all", "none"]},
            orbs: {title: "相位 · 容许度", render: renderAspectOrbsDialog, bulk: []},
            types: {title: "相位 · 相位类型", render: renderAspectTypesDialog, bulk: []},
        },
    },
    classical: {
        endpoint: "/classical",
        categories: {
            dignity: {title: "先天尊贵", render: renderDignityDialog, bulk: []},
            sect: {title: "得时", render: renderSectDialog, bulk: []},
            speed: {title: "速度", render: renderSpeedDialog, bulk: []},
            sun: {title: "太阳光束", render: renderSunDialog, bulk: []},
        },
    },
};

// 当前打开的浮窗：{section, category, draft, original}。draft 是整个 points / aspects 设置的副本。
let settingsDialog = null;

function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

function draft() {
    return settingsDialog.draft;
}

function dialogMeta() {
    return SETTINGS_DIALOGS[settingsDialog.section].categories[settingsDialog.category];
}

function draftDirty() {
    return Boolean(settingsDialog) && JSON.stringify(settingsDialog.draft) !== settingsDialog.original;
}

// 修改草稿并重画浮窗（不保存、不计算）。
function updateDraft(mutator, {rerender = true} = {}) {
    mutator(settingsDialog.draft);
    if (rerender) renderSettingsDialog();
}

function openSettingsDialog(section, category) {
    const source = state[section];
    settingsDialog = {section, category, draft: deepCopy(source), original: JSON.stringify(source)};
    $("pointsTitle").textContent = dialogMeta().title;
    showError("");
    renderSettingsDialog();
    openDialog("pointsDialog");
}

function renderSettingsDialog() {
    const body = $("pointsBody");
    const scroller = body.parentElement;
    const scroll = scroller.scrollTop;
    // 记住正在编辑的输入框，重画后把光标放回去（例如在公式框里按回车）。
    body.innerHTML = "";
    renderBulkBar(body);
    dialogMeta().render(body);
    scroller.scrollTop = scroll;
}

function closeSettingsDialog() {
    settingsDialog = null;
    closeDialog("pointsDialog");
}

// 取消：有改动时先确认，再丢弃草稿。
function requestCancelSettings() {
    if (!settingsDialog) return closeDialog("pointsDialog");
    if (draftDirty() && !confirm("放弃这次的修改？")) return;
    closeSettingsDialog();
}

// 完成：一次性校验并保存；成功后关闭浮窗、按新设置重算。失败时浮窗不关，草稿保留。
async function finishSettingsDialog() {
    if (!settingsDialog) return;
    // 让还没触发 change 的输入框先把内容写进草稿（例如正在输入的名称）。
    document.activeElement?.blur?.();
    await Promise.resolve();
    if (!draftDirty()) {
        closeSettingsDialog();
        return;
    }
    const {section, draft: payload} = settingsDialog;
    const button = $("pointsDoneBtn");
    button.disabled = true;
    try {
        showError("");
        const saved = await api(systemApi(SETTINGS_DIALOGS[section].endpoint), {method: "POST", body: JSON.stringify(payload)});
        state[section] = saved;
        closeSettingsDialog();
        renderSettingsEntries();
        updateTabVisibility();
        if (state.charts[chartKind()].results) calculateFull();
        else renderAllResults();
    } catch (error) {
        showError(error.message);
    } finally {
        button.disabled = false;
    }
}

function restoreSettingsDefaults() {
    const {section, category} = settingsDialog;
    if (section === "classical") {
        const defaults = deepCopy(state.optionsMeta.default_classical);
        const keys = {dignity: ["scores", "triplicity_system", "triplicity_mode", "term_system"], sect: ["sect"], speed: ["speed"], sun: ["sun"]}[category];
        for (const key of keys) settingsDialog.draft[key] = defaults[key];
        renderSettingsDialog();
        showNotice("已恢复默认（点「完成」后生效）。");
        return;
    }
    const defaults = section === "points" ? state.optionsMeta.default_points : state.optionsMeta.default_aspects;
    updateDraft((d) => {
        for (const key of DIALOG_KEYS[category] || [category]) d[key] = deepCopy(defaults[key]);
        if (section === "aspects" && category === "types") d.cross_sign = defaults.cross_sign;
    });
    showNotice("已恢复默认（点「完成」后生效）。");
}

// ---------- 全选 / 全不选 / 清空 ----------

const BULK_LABELS = {all: "全选", none: "全不选", clear: "清空"};

// 浮窗类别 → 它管的设置键（「恢复默认」时一起恢复）。
const DIALOG_KEYS = {
    planets: ["planets", "planet_colors", "retro_color"],
    specials: ["specials", "special_styles"],
    signs: ["sign_colors"],
};

function renderBulkBar(body) {
    const actions = dialogMeta().bulk;
    if (!actions.length) return;
    const bar = el("div", {class: "bulk-bar"});
    for (const action of actions) {
        const button = el("button", {type: "button", class: "small-btn" + (action === "clear" ? " danger" : "")}, BULK_LABELS[action]);
        button.addEventListener("click", () => bulkAction(action));
        bar.appendChild(button);
    }
    body.appendChild(bar);
}

function bulkAction(action) {
    const {section, category} = settingsDialog;
    if (action === "clear") {
        const title = dialogMeta().title;
        if (!confirm(`清空后，「${title}」列表里的所有条目都会被删除（包括你自己添加的）。\n点「完成」才会真正保存；点「取消」可以放弃。\n\n确定清空？`)) return;
        updateDraft((d) => {
            if (category === "lots") d.lots.items = [];
            else d[category] = [];
        });
        return;
    }
    const on = action === "all";
    updateDraft((d) => {
        if (section === "points") {
            if (category === "planets") d.planets = on ? state.optionsMeta.planets.map((p) => p.value) : [];
            else if (category === "specials") d.specials = on ? state.optionsMeta.special_points.map((p) => p.value) : [];
            else if (category === "lots") d.lots.items.forEach((x) => { x.enabled = on; });
            else if (category === "antiscia") d.antiscia.forEach((x) => { if (state.points.planets.includes(x.planet)) x.enabled = on; });
            else d[category].forEach((x) => { x.enabled = on; });
        } else if (category === "selection") {
            const ids = aspectCandidates().filter((c) => c.kind !== "axis").map((c) => c.id);
            const excluded = new Set(d.selection.excluded);
            ids.forEach((id) => (on ? excluded.delete(id) : excluded.add(id)));
            d.selection.excluded = [...excluded];
            d.selection.axes = on ? state.optionsMeta.axes.map((a) => a.value) : [];
        }
    });
}

// ---------- 设置面板里的入口 ----------

function pointCounts() {
    const p = state.points || {};
    const lots = p.lots?.items || [];
    return {
        planets: [(p.planets || []).length, (state.optionsMeta?.planets || []).length],
        asteroids: [(p.asteroids || []).filter((a) => a.enabled).length, (p.asteroids || []).length],
        stars: [(p.stars || []).filter((s) => s.enabled).length, (p.stars || []).length],
        lots: [lots.filter((l) => l.enabled).length, lots.length],
        specials: [(p.specials || []).length, (state.optionsMeta?.special_points || []).length],
        antiscia: (() => {
            const avail = (p.antiscia || []).filter((a) => (p.planets || []).includes(a.planet));
            return [avail.filter((a) => a.enabled).length, avail.length];
        })(),
        signs: null,
    };
}

function aspectSummary() {
    const a = state.aspects;
    const candidates = aspectCandidates();
    const chosen = candidates.filter((c) => aspectCandidateOn(a, c)).length;
    const rule = {moiety: "古典半径法", max: "取较大值", min: "取较小值"}[a.orbs.rule] || a.orbs.rule;
    return {
        selection: `${chosen} / ${candidates.length}`,
        orbs: rule,
        types: `${a.types.length} 种`,
    };
}

function renderSettingsEntries() {
    const counts = pointCounts();
    document.querySelectorAll("[data-point-dialog]").forEach((button) => {
        const count = counts[button.dataset.pointDialog];
        button.querySelector(".point-count").textContent = count ? `${count[0]} / ${count[1]}` : "12 色";
    });
    const summary = aspectSummary();
    document.querySelectorAll("[data-aspect-dialog]").forEach((button) => {
        button.querySelector(".point-count").textContent = summary[button.dataset.aspectDialog] || "";
    });
    const c = state.classical;
    const o = state.optionsMeta.classical_options;
    const label = (list, v) => list.find((x) => x.value === v)?.label || v;
    const classical = {
        dignity: `${label(o.triplicity_systems, c.triplicity_system)} · ${label(o.term_systems, c.term_system)}`,
        sect: c.sect.day_rule === "apparent" ? "视高度" : "几何高度",
        speed: label(o.speed_presets, c.speed.preset),
        sun: c.sun.phases.map((p) => p.label).join(" · ") || "不判断",
    };
    document.querySelectorAll("[data-classical-dialog]").forEach((button) => {
        button.querySelector(".point-count").textContent = classical[button.dataset.classicalDialog] || "";
    });
}

// ---------- 小工具 ----------

function el(tag, attrs = {}, text = null) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
    }
    if (text !== null) node.textContent = text;
    return node;
}

function checkbox(checked, onChange) {
    const input = el("input", {type: "checkbox"});
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    return input;
}

function dialogHint(body, html) {
    const p = el("p", {class: "muted point-hint"});
    p.innerHTML = html;
    body.appendChild(p);
}

function sectionTitle(body, text) {
    body.appendChild(el("div", {class: "dialog-section-title"}, text));
}

// 星体符号里的 ☉ ♀ ♂ 等字符在部分系统上会显示成彩色表情：后面加 U+FE0E，强制按普通文字显示。
function symText(text) {
    return String(text ?? "").replace(/[☀-➿⯐-⯿]/g, (c) => c + "︎");
}

function colorInput(value, onChange) {
    const input = el("input", {type: "color", value: value || "#cccccc", class: "color-input", title: "颜色（星盘和相位表里这个符号的颜色）"});
    input.addEventListener("input", () => onChange(input.value));
    return input;
}

function symbolInput(value, onChange) {
    const input = el("input", {type: "text", value, maxlength: 6, class: "symbol-input", title: "符号或简称（相位表里显示），最多 6 个字符"});
    input.addEventListener("change", () => onChange(input.value.trim()));
    return input;
}

// ---------- 行星 ----------

function renderPlanetsDialog(body) {
    const grid = el("div", {class: "check-grid colored planet-grid"});
    const enabled = new Set(draft().planets);
    for (const {value, label} of state.optionsMeta.planets) {
        const item = el("div", {class: "check-item"});
        const text = el("label", {class: "check-label"});
        text.append(checkbox(enabled.has(value), (on) => updateDraft((d) => {
            const next = new Set(d.planets);
            if (on) next.add(value); else next.delete(value);
            d.planets = state.optionsMeta.planets.map((p) => p.value).filter((c) => next.has(c));
        }, {rerender: false})), el("span", {}, label));
        item.append(text, colorInput(draft().planet_colors[value], (c) => updateDraft((d) => { d.planet_colors[value] = c; }, {rerender: false})));
        grid.appendChild(item);
    }
    body.appendChild(grid);

    sectionTitle(body, "逆行标志");
    const retroGrid = el("div", {class: "check-grid colored planet-grid"});
    const retro = el("div", {class: "check-item"});
    const sample = el("span", {class: "retro-swatch"}, "R");
    sample.style.color = draft().retro_color;
    const retroLabel = el("span", {class: "check-label"});
    retroLabel.append(sample, el("span", {}, "逆行标志 R 的颜色"));
    retro.append(retroLabel, colorInput(draft().retro_color, (c) => {
        sample.style.color = c;
        updateDraft((d) => { d.retro_color = c; }, {rerender: false});
    }));
    retroGrid.appendChild(retro);
    body.appendChild(retroGrid);
}

// ---------- 通用：可勾选、可改名、可删除的列表（小行星、恒星） ----------

function renderItemList(body, {category, describe}) {
    const items = draft()[category];
    const list = el("div", {class: "point-list"});
    if (!items.length) list.appendChild(el("p", {class: "muted"}, "列表是空的。"));
    items.forEach((item, index) => {
        const row = el("div", {class: "point-row"});
        const patch = (change, rerender = false) => updateDraft((d) => Object.assign(d[category][index], change), {rerender});
        const label = el("input", {type: "text", value: item.label, maxlength: 30, title: "显示名称"});
        label.addEventListener("change", () => patch({label: label.value.trim() || item.label}));
        const remove = el("button", {type: "button", class: "icon-btn small", title: "从列表中删除", "aria-label": "删除"}, "×");
        remove.addEventListener("click", () => updateDraft((d) => d[category].splice(index, 1)));
        row.append(
            checkbox(item.enabled, (on) => patch({enabled: on})),
            label,
            symbolInput(item.symbol || "", (v) => patch({symbol: v || item.symbol})),
            colorInput(item.color, (c) => patch({color: c})),
            el("span", {class: "point-meta"}, describe(item)),
            remove,
        );
        list.appendChild(row);
    });
    body.appendChild(list);
}

// ---------- 小行星 ----------

function renderAsteroidsDialog(body) {
    dialogHint(body, "输入 MPC 编号添加。主小行星文件以外的小行星需要对应的星历文件（<code>ast*/se*.se1</code>）。");
    renderItemList(body, {category: "asteroids", describe: (a) => `#${a.number}`});
    const form = el("form", {class: "point-add"});
    const number = el("input", {type: "text", inputmode: "numeric", placeholder: "编号", class: "point-add-num", "aria-label": "小行星编号"});
    const label = el("input", {type: "text", placeholder: "名称（可不填）", maxlength: 30, "aria-label": "名称"});
    form.append(number, label, el("button", {type: "submit", class: "accent-btn"}, "添加"));
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const n = number.value.trim();
        if (!/^\d+$/.test(n)) {
            showError("请输入小行星的编号（正整数）。");
            return;
        }
        if (draft().asteroids.some((a) => String(a.number) === String(Number(n)))) {
            showError(`小行星 #${Number(n)} 已经在列表里了。`);
            return;
        }
        try {
            showError("");
            const info = await api(systemApi("/points/check-asteroid"), {method: "POST", body: JSON.stringify({number: n})});
            const name = label.value.trim() || info.name || `#${info.number}`;
            const symbol = info.name ? info.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3) : `#${info.number}`;
            updateDraft((d) => d.asteroids.push({number: info.number, label: name, symbol, color: "#b7a8c9", enabled: true}));
            if (!info.ok) showNotice(`已加入「${name}」，但现在还算不出来：${info.error}`);
        } catch (error) {
            showError(error.message);
        }
    });
    body.appendChild(form);
}

// ---------- 恒星 ----------

function renderStarsDialog(body) {
    dialogHint(body, "输入 <code>sefstars.txt</code> 里的名称或命名（如 <code>,alLeo</code>）添加。");
    renderItemList(body, {category: "stars", describe: (s) => s.query});
    const form = el("form", {class: "point-add"});
    const query = el("input", {type: "text", placeholder: "恒星名称或命名", "aria-label": "恒星名称"});
    const label = el("input", {type: "text", placeholder: "显示名称（可不填）", maxlength: 30, "aria-label": "显示名称"});
    form.append(query, label, el("button", {type: "submit", class: "accent-btn"}, "添加"));
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!query.value.trim()) return;
        try {
            showError("");
            const info = await api(systemApi("/points/check-star"), {method: "POST", body: JSON.stringify({query: query.value})});
            if (draft().stars.some((s) => s.query.toLowerCase() === info.query.toLowerCase())) {
                showError(`「${info.name || info.query}」已经在列表里了。`);
                return;
            }
            const name = label.value.trim() || info.name || info.query;
            const symbol = (info.name || info.nomenclature || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3) || "★";
            updateDraft((d) => d.stars.push({query: info.query, label: name, symbol, color: "#e6c46a", enabled: true}));
        } catch (error) {
            showError(error.message);
        }
    });
    body.appendChild(form);
}

// ---------- 特殊点 ----------

function renderSpecialsDialog(body) {
    const list = el("div", {class: "point-list"});
    const enabled = new Set(draft().specials);
    for (const {value, label, description} of state.optionsMeta.special_points) {
        const row = el("div", {class: "point-row special-row"});
        const text = el("label", {class: "special-text"});
        const box = checkbox(enabled.has(value), (on) => updateDraft((d) => {
            const next = new Set(d.specials);
            if (on) next.add(value); else next.delete(value);
            d.specials = state.optionsMeta.special_points.map((p) => p.value).filter((c) => next.has(c));
        }, {rerender: false}));
        text.append(box, el("span", {}, ""));
        text.lastChild.append(el("b", {}, label), el("span", {class: "point-meta"}, ` ${value}`), el("br"), el("span", {class: "muted"}, description));
        const style = draft().special_styles[value];
        row.append(
            text,
            symbolInput(style.symbol, (v) => updateDraft((d) => { d.special_styles[value].symbol = v || style.symbol; }, {rerender: false})),
            colorInput(style.color, (c) => updateDraft((d) => { d.special_styles[value].color = c; }, {rerender: false})),
        );
        list.appendChild(row);
    }
    body.appendChild(list);
}

// ---------- Lot ----------

const SECT_MODE_LABELS = {auto: "按出生日夜自动选择", day: "固定用日间公式", night: "固定用夜间公式"};

function lotFormulaHelp() {
    const details = el("details", {class: "fold nested lot-help"});
    details.appendChild(el("summary", {}, "公式写法"));
    const box = el("div", {class: "fold-body"});
    const asteroids = draft().asteroids.map((a) => `#${a.number} ${a.label}`).join("、") || "—";
    const specials = state.optionsMeta.special_points.map((p) => `${p.value}（${p.label}）`).join("、");
    box.innerHTML = `
        <p>几项相加减，结果自动对 360° 取余。例如福点日间：<code>Asc + Mo - Su</code>。代码不区分大小写。</p>
        <ul>
            <li>行星：${state.optionsMeta.planets.map((p) => `<code>${p.value}</code>`).join(" ")}</li>
            <li>四轴：<code>Asc</code> <code>MC</code> <code>Desc</code> <code>IC</code>；宫头：<code>H1</code> … <code>H12</code></li>
            <li>特殊点：${escapeHtml(specials)}</li>
            <li>小行星：<code>#编号</code>，例如 ${escapeHtml(asteroids)}</li>
            <li>恒星：<code>*{名称}</code>，例如 <code>*{Regulus}</code>、<code>*{,alLeo}</code></li>
            <li>其它 Lot：<code>@代码</code>，例如 <code>@Fortune</code>。改某个 Lot 的代码时，其它公式里的引用会自动跟着改。</li>
            <li>常数度数：例如 <code>30</code></li>
        </ul>
        <p>公式里用到的点即使没有勾选也会单独算出来。夜间公式不填，表示这个 Lot 不分日夜（日夜规则也就不起作用）。</p>
        <p>日夜规则「自动」：出生时太阳在地平线以上用日间公式，否则用夜间公式。</p>`;
    details.appendChild(box);
    return details;
}

// 把所有公式里的 @旧代码 换成 @新代码（不区分大小写，只换完整的代码）。
function renameLotReferences(lots, oldCode, newCode) {
    const pattern = new RegExp(`@${oldCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gi");
    for (const lot of lots) {
        lot.day = String(lot.day || "").replace(pattern, `@${newCode}`);
        lot.night = String(lot.night || "").replace(pattern, `@${newCode}`);
    }
}

// 即时检查公式写法（只检查，不保存）。
async function checkFormulaInput(input) {
    const text = input.value.trim();
    input.classList.remove("invalid");
    input.title = "";
    if (!text) return;
    try {
        const result = await api(systemApi("/points/check-lot"), {method: "POST", body: JSON.stringify({formula: text})});
        if (input.value.trim() === text) input.title = `规范写法：${result.formula}`;
    } catch (error) {
        if (input.value.trim() !== text) return;
        input.classList.add("invalid");
        input.title = error.message;
        showError(error.message);
    }
}

function sectSelect(value, onChange) {
    const select = el("select", {class: "lot-sect-select", title: "日夜规则"});
    for (const [mode, label] of Object.entries(SECT_MODE_LABELS)) {
        const option = el("option", {value: mode}, label);
        select.appendChild(option);
    }
    select.value = value || "auto";
    select.addEventListener("change", () => onChange(select.value));
    return select;
}

function renderLotsDialog(body) {
    const lots = draft().lots;

    const list = el("div", {class: "lot-list"});
    if (!lots.items.length) list.appendChild(el("p", {class: "muted"}, "还没有 Lot。"));
    lots.items.forEach((lot, index) => {
        const card = el("div", {class: "lot-card"});
        const patch = (change, rerender = false) => updateDraft((d) => Object.assign(d.lots.items[index], change), {rerender});
        const head = el("div", {class: "lot-head"});
        const label = el("input", {type: "text", value: lot.label, maxlength: 30, class: "lot-label", title: "名称"});
        label.addEventListener("change", () => patch({label: label.value.trim() || lot.code}));
        const code = el("input", {type: "text", value: lot.code, maxlength: 20, class: "lot-code", title: "代码（在其它 Lot 公式里用 @代码 引用）"});
        code.addEventListener("change", () => {
            const next = code.value.trim();
            if (!next || next === lot.code) {
                code.value = lot.code;
                return;
            }
            updateDraft((d) => {
                renameLotReferences(d.lots.items, d.lots.items[index].code, next);
                d.lots.items[index].code = next;
            });
        });
        const remove = el("button", {type: "button", class: "icon-btn small", title: "删除这个 Lot", "aria-label": "删除"}, "×");
        remove.addEventListener("click", () => updateDraft((d) => d.lots.items.splice(index, 1)));
        head.append(
            checkbox(lot.enabled, (on) => patch({enabled: on})),
            label,
            symbolInput(lot.symbol || "", (v) => patch({symbol: v || lot.symbol})),
            colorInput(lot.color, (c) => patch({color: c})),
            el("span", {class: "point-meta"}, "@"),
            code,
            remove,
        );

        const formulas = el("div", {class: "lot-formulas"});
        for (const [key, title] of [["day", "日间"], ["night", "夜间"]]) {
            const row = el("label", {class: "lot-formula"});
            const input = el("input", {type: "text", value: lot[key] || "", spellcheck: "false",
                placeholder: key === "night" ? "不填 = 不分日夜" : "如 Asc + Mo - Su"});
            input.addEventListener("input", () => input.classList.remove("invalid"));
            input.addEventListener("change", () => {
                patch({[key]: input.value.trim()}, key === "night");
                checkFormulaInput(input);
            });
            row.append(el("span", {}, title), input);
            formulas.appendChild(row);
        }
        const sectRow = el("label", {class: "lot-formula"});
        const select = sectSelect(lot.sect_mode, (mode) => patch({sect_mode: mode}));
        select.disabled = !String(lot.night || "").trim();
        if (select.disabled) select.title = "没有夜间公式，不分日夜";
        sectRow.append(el("span", {}, "日夜"), select);
        formulas.appendChild(sectRow);

        card.append(head, formulas);
        list.appendChild(card);
    });
    body.appendChild(list);

    const add = el("form", {class: "lot-card lot-add"});
    add.appendChild(el("div", {class: "lot-add-title"}, "新增 Lot"));
    const head = el("div", {class: "lot-head"});
    const label = el("input", {type: "text", placeholder: "名称，如 爱欲点", maxlength: 30, class: "lot-label"});
    const symbol = el("input", {type: "text", placeholder: "符号", maxlength: 6, class: "symbol-input"});
    const code = el("input", {type: "text", placeholder: "代码，如 Eros", maxlength: 20, class: "lot-code"});
    head.append(label, symbol, el("span", {class: "point-meta"}, "@"), code);
    const formulas = el("div", {class: "lot-formulas"});
    const inputs = {};
    for (const [key, title] of [["day", "日间"], ["night", "夜间"]]) {
        const row = el("label", {class: "lot-formula"});
        inputs[key] = el("input", {type: "text", spellcheck: "false",
            placeholder: key === "night" ? "不填 = 不分日夜" : "如 Asc + Ve - @Spirit"});
        inputs[key].addEventListener("change", () => checkFormulaInput(inputs[key]));
        row.append(el("span", {}, title), inputs[key]);
        formulas.appendChild(row);
    }
    const sectRow = el("label", {class: "lot-formula"});
    const sect = sectSelect("auto", () => {});
    sectRow.append(el("span", {}, "日夜"), sect);
    formulas.appendChild(sectRow);
    add.append(head, formulas, el("div", {class: "lot-add-foot"}));
    add.lastChild.appendChild(el("button", {type: "submit", class: "accent-btn"}, "添加"));
    add.addEventListener("submit", (event) => {
        event.preventDefault();
        const item = {
            label: label.value.trim(), code: code.value.trim(), symbol: symbol.value.trim(),
            day: inputs.day.value.trim(), night: inputs.night.value.trim(), sect_mode: sect.value, enabled: true,
        };
        if (!item.code || !item.day) {
            showError("请至少填写代码和日间公式。");
            return;
        }
        if (draft().lots.items.some((x) => x.code.toLowerCase() === item.code.toLowerCase())) {
            showError(`代码「${item.code}」已经有了。`);
            return;
        }
        item.label = item.label || item.code;
        item.symbol = item.symbol || item.code.slice(0, 3);
        item.color = "#e09ab3";
        showError("");
        updateDraft((d) => d.lots.items.push(item));
    });
    body.appendChild(add);
    body.appendChild(lotFormulaHelp());
}

// ---------- 映点与反映点 ----------

function renderAntisciaDialog(body) {
    const planets = new Set(draft().planets);
    for (const [type, title] of [["antiscion", "映点"], ["contra", "反映点"]]) {
        sectionTitle(body, title);
        const items = draft().antiscia.map((item, index) => ({item, index}))
            .filter(({item}) => item.type === type && planets.has(item.planet));
        if (!items.length) {
            body.appendChild(el("p", {class: "muted point-hint"}, "没有启用的行星。"));
            continue;
        }
        const grid = el("div", {class: "check-grid colored wide-items"});
        for (const {item, index} of items) {
            const meta = state.optionsMeta.planets.find((p) => p.value === item.planet);
            const row = el("div", {class: "check-item"});
            const text = el("label", {class: "check-label"});
            const patch = (change) => updateDraft((d) => Object.assign(d.antiscia[index], change), {rerender: false});
            text.append(checkbox(item.enabled, (on) => patch({enabled: on})), el("span", {}, `${meta?.label || item.planet}${title}`));
            row.append(text, symbolInput(item.symbol, (v) => patch({symbol: v || item.symbol})), colorInput(item.color, (c) => patch({color: c})));
            grid.appendChild(row);
        }
        body.appendChild(grid);
    }
}

// ---------- 星座配色 ----------

function renderSignsDialog(body) {
    const grid = el("div", {class: "check-grid colored"});
    draft().sign_colors.forEach((color, i) => {
        const row = el("div", {class: "check-item"});
        const label = el("span", {class: "check-label"});
        const glyph = el("span", {class: "sign-swatch"}, symText(SIGN_GLYPHS[i]));
        glyph.style.color = color;
        label.append(glyph, el("span", {}, SIGN_NAMES[i]));
        row.append(label, colorInput(color, (c) => {
            glyph.style.color = c;
            updateDraft((d) => { d.sign_colors[i] = c; }, {rerender: false});
        }));
        grid.appendChild(row);
    });
    body.appendChild(grid);
}

// ---------- 相位 · 行星选用 ----------
// 候选点 = 「星体配置」里启用的行星、小行星（集合 A），再加四轴。
// 行星、小行星记录“排除了哪些”：在集合 A 里新启用的点默认参与相位。四轴记录“选了哪些”。

function aspectCandidates() {
    const p = state.points;
    const list = [];
    for (const code of p.planets) {
        const meta = state.optionsMeta.planets.find((x) => x.value === code);
        list.push({id: code, kind: "planet", symbol: state.optionsMeta.planet_symbols[code], label: meta?.label || code});
    }
    for (const a of p.asteroids) {
        if (a.enabled) list.push({id: `#${a.number}`, kind: "asteroid", symbol: a.symbol, label: a.label, number: a.number});
    }
    for (const a of state.optionsMeta.axes) list.push({id: a.value, kind: "axis", symbol: a.symbol, label: a.label});
    return list;
}

function aspectCandidateOn(aspects, candidate) {
    if (candidate.kind === "axis") return aspects.selection.axes.includes(candidate.id);
    return !aspects.selection.excluded.includes(candidate.id);
}

function renderAspectSelectionDialog(body) {
    const candidates = aspectCandidates();
    const groups = [["planet", "行星"], ["asteroid", "小行星"], ["axis", "四轴"]];
    for (const [kind, title] of groups) {
        const items = candidates.filter((c) => c.kind === kind);
        sectionTitle(body, title);
        if (!items.length) {
            body.appendChild(el("p", {class: "muted point-hint"}, kind === "asteroid" ? "「星体配置 → 小行星」里没有启用的小行星。" : "没有可选的点。"));
            continue;
        }
        const grid = el("div", {class: "check-grid"});
        for (const c of items) {
            const item = el("label", {class: "check-item"});
            item.append(checkbox(aspectCandidateOn(draft(), c), (on) => updateDraft((d) => {
                if (c.kind === "axis") {
                    const next = new Set(d.selection.axes);
                    if (on) next.add(c.id); else next.delete(c.id);
                    d.selection.axes = state.optionsMeta.axes.map((a) => a.value).filter((v) => next.has(v));
                } else {
                    const next = new Set(d.selection.excluded);
                    if (on) next.delete(c.id); else next.add(c.id);
                    d.selection.excluded = [...next];
                }
            }, {rerender: false})), el("span", {}, c.label));
            grid.appendChild(item);
        }
        body.appendChild(grid);
    }
}

// ---------- 相位 · 容许度 ----------

function orbInput(value, onChange) {
    const input = el("input", {type: "number", min: 0, max: 30, step: 0.5, value, class: "orb-input"});
    input.addEventListener("change", () => {
        const n = Number(input.value);
        if (input.value === "" || !Number.isFinite(n) || n < 0 || n > 30) {
            input.classList.add("invalid");
            showError("容许度必须是 0–30 之间的数字。");
            return;
        }
        input.classList.remove("invalid");
        onChange(n);
    });
    return input;
}

function orbRow(table, label, value, onChange, extra = null) {
    const row = el("div", {class: "orb-row"});
    row.append(el("span", {class: "orb-label"}, label), orbInput(value, onChange), el("span", {class: "orb-unit"}, "°"));
    row.appendChild(extra || el("span"));
    table.appendChild(row);
}

function renderAspectOrbsDialog(body) {
    const orbs = draft().orbs;
    sectionTitle(body, "两个点的容许度怎么合成");
    const seg = el("div", {class: "segmented orb-rule", role: "radiogroup", "aria-label": "容许度合成规则"});
    const short = {moiety: "古典半径法", max: "取较大值", min: "取较小值"};
    for (const {value, label} of state.optionsMeta.orb_rules) {
        const item = el("label", {title: label});
        const radio = el("input", {type: "radio", name: "orbRule", value});
        radio.checked = orbs.rule === value;
        radio.addEventListener("change", () => updateDraft((d) => { d.orbs.rule = value; }));
        item.append(radio, el("span", {}, short[value] || value));
        seg.appendChild(item);
    }
    body.appendChild(seg);

    const setOrb = (fn) => updateDraft(fn, {rerender: false});
    sectionTitle(body, "行星（每颗单独设置）");
    let table = el("div", {class: "orb-table"});
    for (const code of state.optionsMeta.orb_planets) {
        const meta = state.optionsMeta.planets.find((p) => p.value === code);
        orbRow(table, meta?.label || code, orbs.planets[code],
            (n) => setOrb((d) => { d.orbs.planets[code] = n; }));
    }
    orbRow(table, "罗睺计都", orbs.nodes, (n) => setOrb((d) => { d.orbs.nodes = n; }));
    orbRow(table, "四轴（上升、中天、下降、天底）", orbs.axes, (n) => setOrb((d) => { d.orbs.axes = n; }));
    body.appendChild(table);

    sectionTitle(body, "小行星（每颗单独设置）");
    table = el("div", {class: "orb-table"});
    for (const a of state.points.asteroids) {
        const key = String(a.number);
        orbRow(table, `${a.label}${a.enabled ? "" : "（未启用）"}`,
            orbs.asteroids[key] ?? orbs.asteroid_default, (n) => setOrb((d) => { d.orbs.asteroids[key] = n; }));
    }
    orbRow(table, "以后新增的小行星", orbs.asteroid_default, (n) => setOrb((d) => { d.orbs.asteroid_default = n; }));
    body.appendChild(table);

    sectionTitle(body, "其它点（每组一个设置）");
    table = el("div", {class: "orb-table"});
    for (const [key, label] of [["specials", "特殊点"], ["stars", "恒星"], ["lots", "Lot"], ["antiscia", "映点与反映点"]]) {
        const flag = el("label", {class: "orb-flag"});
        flag.append(checkbox(orbs.exclusive[key], (on) => setOrb((d) => { d.orbs.exclusive[key] = on; })), el("span", {}, "不与行星合成"));
        orbRow(table, label, orbs[key], (n) => setOrb((d) => { d.orbs[key] = n; }), flag);
    }
    body.appendChild(table);
}

// ---------- 相位 · 相位类型 ----------

function renderAspectTypesDialog(body) {
    const d0 = draft();
    const groups = state.optionsMeta.aspect_groups;
    const wrap = el("div", {class: "table-wrap"});
    const table = el("table", {class: "aspect-type-table"});
    const head = el("tr");
    ["名称", "角度", "符号"].forEach((t) => head.appendChild(el("th", {}, t)));
    groups.forEach((g) => head.appendChild(el("th", {class: "center"}, g.label)));
    head.appendChild(el("th"));
    table.appendChild(el("thead")).appendChild(head);
    const tbody = el("tbody");
    d0.types.forEach((t, index) => {
        const row = el("tr");
        const patch = (change) => updateDraft((d) => Object.assign(d.types[index], change), {rerender: false});
        const name = el("input", {type: "text", value: t.name, maxlength: 12, class: "type-name"});
        name.addEventListener("change", () => patch({name: name.value.trim() || t.name}));
        row.appendChild(el("td")).appendChild(name);
        const angleCell = el("td");
        if (t.builtin) {
            angleCell.textContent = `${t.angle}°`;
        } else {
            const angle = el("input", {type: "number", min: 0, max: 180, step: "any", value: t.angle, class: "type-angle"});
            angle.addEventListener("change", () => patch({angle: Number(angle.value)}));
            angleCell.appendChild(angle);
        }
        row.appendChild(angleCell);
        row.appendChild(el("td")).appendChild(symbolInput(t.symbol, (v) => patch({symbol: v || t.symbol})));
        for (const g of groups) {
            const cell = el("td", {class: "center"});
            cell.appendChild(checkbox(t.groups.includes(g.value), (on) => updateDraft((d) => {
                const next = new Set(d.types[index].groups);
                if (on) next.add(g.value); else next.delete(g.value);
                d.types[index].groups = groups.map((x) => x.value).filter((v) => next.has(v));
            }, {rerender: false})));
            row.appendChild(cell);
        }
        const last = el("td");
        if (!t.builtin) {
            const remove = el("button", {type: "button", class: "icon-btn small", title: "删除这种相位", "aria-label": "删除"}, "×");
            remove.addEventListener("click", () => updateDraft((d) => d.types.splice(index, 1)));
            last.appendChild(remove);
        }
        row.appendChild(last);
        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    body.appendChild(wrap);

    const form = el("form", {class: "point-add type-add"});
    const name = el("input", {type: "text", placeholder: "名称，如 八分之三", maxlength: 12});
    const angle = el("input", {type: "number", min: 0, max: 180, step: "any", placeholder: "角度"});
    const symbol = el("input", {type: "text", placeholder: "符号", maxlength: 6});
    form.append(name, angle, symbol, el("button", {type: "submit", class: "accent-btn"}, "添加"));
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const a = Number(angle.value);
        if (!name.value.trim() || angle.value === "" || !Number.isFinite(a) || a < 0 || a > 180 || !symbol.value.trim()) {
            showError("请填写名称、0–180 之间的角度和符号。");
            return;
        }
        if (draft().types.some((t) => Math.abs(Number(t.angle) - a) < 1e-6)) {
            showError(`已经有 ${a}° 的相位了。`);
            return;
        }
        showError("");
        updateDraft((d) => {
            d.types.push({id: `u${Date.now().toString(36)}`, name: name.value.trim(), angle: a,
                symbol: symbol.value.trim(), groups: ["main"], builtin: false});
            d.types.sort((x, y) => Number(x.angle) - Number(y.angle));
        });
    });
    body.appendChild(form);

    sectionTitle(body, "规则");
    const cross = el("label", {class: "check-item wide"});
    cross.append(checkbox(d0.cross_sign, (on) => updateDraft((d) => { d.cross_sign = on; }, {rerender: false})),
        el("span", {}, "计算跨星座的相位（例如白羊 29° 与双子 1° 也算六分）。取消勾选时，只认星座之间也构成该相位的情况（只对 30° 整数倍的相位起作用）。"));
    body.appendChild(cross);
}

// ---------- 绑定 ----------

function bindSettingsDialogs() {
    document.querySelectorAll("[data-point-dialog]").forEach((button) => {
        button.addEventListener("click", () => openSettingsDialog("points", button.dataset.pointDialog));
    });
    document.querySelectorAll("[data-aspect-dialog]").forEach((button) => {
        button.addEventListener("click", () => openSettingsDialog("aspects", button.dataset.aspectDialog));
    });
    document.querySelectorAll("[data-classical-dialog]").forEach((button) => {
        button.addEventListener("click", () => openSettingsDialog("classical", button.dataset.classicalDialog));
    });
    const dialog = $("pointsDialog");
    $("pointsRestoreBtn").addEventListener("click", restoreSettingsDefaults);
    $("pointsDoneBtn").addEventListener("click", finishSettingsDialog);
    $("pointsCancelBtn").addEventListener("click", requestCancelSettings);
    $("pointsCloseBtn").addEventListener("click", requestCancelSettings);
    // Esc：浏览器默认会直接关闭浮窗，这里改成“取消”（有改动先确认）。
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        requestCancelSettings();
    });
    // 点浮窗外面：同样按“取消”处理（bindDialogs 不处理带 data-guarded 的浮窗）。
    dialog.addEventListener("mousedown", (event) => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
            requestCancelSettings();
        }
    });
    renderSettingsEntries();
}

// ================= 相位结果 =================
// 主相位表：下三角矩阵。第 i 行最左边是第 i 个点的符号（第一行留空），中间是它与前面各点的相位，
// 对角线上是它自己的符号。每个相位两行：相位符号；离精确相位的偏差 + 入相 A / 出相 S（两种颜色）。
// 其它点相位：特殊点、恒星、Lot、映点各一组，每组一张普通表格，一行一个相位。

function formatDeviation(deg) {
    const total = Math.round(Math.abs(Number(deg)) * 60);
    return `${Math.floor(total / 60)}°${pad2(total % 60)}'`;
}


function symbolHtml(point, cls = "asp-point-sym") {
    const style = point?.color ? ` style="color:${escapeHtml(point.color)}"` : "";
    return `<span class="${cls}"${style}>${escapeHtml(symText(point?.symbol ?? ""))}</span>`;
}

function aspectHitHtml(hit) {
    const motion = hit.motion || "";
    return `<div class="asp-hit">`
        + `<span class="asp-sym">${escapeHtml(symText(hit.symbol))}</span>`
        + `<span class="asp-dev ${motion ? `motion-${motion}` : "motion-none"}">${escapeHtml(formatDeviation(hit.deviation) + motion)}</span>`
        + `</div>`;
}

function renderAspects() {
    const box = $("aspectResult");
    if (!box) return;
    document.querySelectorAll("#aspectViewSwitch input").forEach((radio) => {
        radio.checked = radio.value === state.aspectView;
    });
    const data = state.results.aspects;
    if (!data) {
        box.innerHTML = Object.keys(state.results).length ? "<p class='muted'>未计算</p>" : "<p class='muted'>无数据</p>";
        return;
    }
    if (state.aspectView === "main") renderAspectMatrix(box, data.main);
    else renderAspectGroups(box, data);
}

function renderAspectMatrix(box, main) {
    const points = main.points || [];
    if (points.length < 2) {
        box.innerHTML = "<p class='muted'>参与相位的点不足两个。请在「计算设置 → 相位 → 行星选用」里勾选。</p>";
        return;
    }
    const index = Object.fromEntries(points.map((p, i) => [p.id, i]));
    const cells = new Map();          // "行,列" → [相位]
    for (const hit of main.aspects || []) {
        let i = index[hit.a];
        let j = index[hit.b];
        if (i === undefined || j === undefined) continue;
        if (i < j) [i, j] = [j, i];
        const key = `${i},${j}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(hit);
    }
    const n = points.length;
    let html = "<div class='table-wrap aspect-matrix-wrap'><table class='aspect-matrix'><tbody>";
    for (let i = 0; i < n; i++) {
        html += "<tr>";
        // 最左侧一列：从第二行开始放本行的点。
        html += i === 0
            ? "<td class='am-label am-empty'></td>"
            : `<th class='am-label'>${symbolHtml(points[i], "am-sym")}</th>`;
        for (let j = 0; j < n; j++) {
            if (j < i) {
                const hits = cells.get(`${i},${j}`) || [];
                html += `<td class='am-cell'>${hits.map(aspectHitHtml).join("")}</td>`;
            } else if (j === i) {
                html += `<td class='am-diag'>${symbolHtml(points[i], "am-sym")}</td>`;
            } else {
                html += "<td class='am-void'></td>";
            }
        }
        html += "</tr>";
    }
    html += "</tbody></table></div>";
    box.innerHTML = html;
}

function renderAspectGroups(box, data) {
    const groups = data.groups || [];
    if (!groups.length) {
        box.innerHTML = "<p class='muted'>没有可计算的组：请在「星体配置」里启用特殊点、恒星或 Lot，或在「相位 → 行星选用」里勾选行星。</p>";
        return;
    }
    const planetInfo = Object.fromEntries((data.main.points || []).map((p) => [p.id, p]));
    let html = "";
    for (const group of groups) {
        const info = Object.fromEntries(group.points.map((p) => [p.id, p]));
        const order = Object.fromEntries(group.points.map((p, i) => [p.id, i]));
        const planetOrder = Object.fromEntries((data.planets || []).map((id, i) => [id, i]));
        const hits = [...group.aspects].sort((x, y) =>
            (order[x.a] - order[y.a]) || (planetOrder[x.b] - planetOrder[y.b]) || (x.deviation - y.deviation));
        // 没有任何相位的组整组不显示（特殊点、恒星、Lot、映点与反映点规则相同）。
        if (!hits.length) continue;
        html += `<details class='aspect-group' open><summary>${escapeHtml(group.title)}`
            + `<span class='muted'> · ${hits.length}</span></summary>`;
        html += "<div class='table-wrap'><table class='aspect-list'>"
            + "<colgroup><col class='c-point'><col class='c-aspect'><col class='c-planet'><col class='c-dev'></colgroup>"
            + "<thead><tr><th>名称</th><th>相位</th><th>行星</th><th>偏差</th></tr></thead><tbody>";
        for (const hit of hits) {
            const a = info[hit.a] || {label: hit.a, symbol: ""};
            const b = planetInfo[hit.b] || {label: hit.b, symbol: ""};
            const motion = hit.motion || "";
            const pointCell = group.key === "antiscia" && a.symbol ? symbolHtml(a) : escapeHtml(a.label);
            html += "<tr>"
                + `<td>${pointCell}</td>`
                + `<td><span class='asp-sym'>${escapeHtml(symText(hit.symbol))}</span></td>`
                + `<td>${symbolHtml(b)}</td>`
                + `<td><span class='asp-dev ${motion ? `motion-${motion}` : "motion-none"}'>${escapeHtml(formatDeviation(hit.deviation) + motion)}</span></td>`
                + "</tr>";
        }
        html += "</tbody></table></div></details>";
    }
    box.innerHTML = html
        || "<p class='muted'>特殊点、恒星、Lot、映点与反映点都没有落在容许度内的相位。</p>";
}

function bindAspectView() {
    document.querySelectorAll("#aspectViewSwitch input").forEach((radio) => {
        radio.addEventListener("change", () => {
            if (!radio.checked) return;
            state.aspectView = radio.value;
            renderAspects();
        });
    });
}


// ================= 古典设置：先天尊贵、得时、速度、太阳光束 =================

function radioGroup(body, title, name, options, current, onChange) {
    if (title) sectionTitle(body, title);
    const seg = el("div", {class: "segmented classical-seg", role: "radiogroup"});
    for (const {value, label} of options) {
        const item = el("label");
        const radio = el("input", {type: "radio", name, value});
        radio.checked = current === value;
        radio.addEventListener("change", () => onChange(value));
        item.append(radio, el("span", {}, label));
        seg.appendChild(item);
    }
    body.appendChild(seg);
}

function numberRow(table, label, value, {min, max, step, unit = "", onChange}) {
    const row = el("div", {class: "orb-row"});
    const input = el("input", {type: "number", min, max, step, value, class: "orb-input"});
    input.addEventListener("change", () => {
        const n = Number(input.value);
        const ok = input.value !== "" && Number.isFinite(n) && n >= min && n <= max;
        input.classList.toggle("invalid", !ok);
        if (ok) onChange(n);
        else showError(`${label}：请填 ${min} 到 ${max} 之间的数字。`);
    });
    row.append(el("span", {class: "orb-label"}, label), input, el("span", {class: "orb-unit"}, unit), el("span"));
    table.appendChild(row);
}

function renderDignityDialog(body) {
    const d = draft();
    const o = state.optionsMeta.classical_options;
    sectionTitle(body, "分值");
    const table = el("div", {class: "orb-table"});
    for (const {value, label} of o.scores) {
        numberRow(table, label, d.scores[value], {min: -100, max: 100, step: 0.5, unit: "分",
            onChange: (n) => updateDraft((x) => { x.scores[value] = n; }, {rerender: false})});
    }
    body.appendChild(table);
    radioGroup(body, "三分主星", "trip-system", o.triplicity_systems, d.triplicity_system,
        (v) => updateDraft((x) => { x.triplicity_system = v; }, {rerender: false}));
    radioGroup(body, "三分计分", "trip-mode", o.triplicity_modes, d.triplicity_mode,
        (v) => updateDraft((x) => { x.triplicity_mode = v; }, {rerender: false}));
    radioGroup(body, "界", "term-system", o.term_systems, d.term_system,
        (v) => updateDraft((x) => { x.term_system = v; }, {rerender: false}));
}

function renderSectDialog(body) {
    const d = draft();
    const o = state.optionsMeta.classical_options;
    radioGroup(body, "日生 / 夜生", "day-rule", o.day_rules, d.sect.day_rule,
        (v) => updateDraft((x) => { x.sect.day_rule = v; }, {rerender: false}));
    sectionTitle(body, "派别");
    const list = el("div", {class: "sect-list"});
    for (const code of Object.keys(d.sect.planets)) {
        const row = el("div", {class: "sect-row"});
        const select = el("select");
        fillSelect(select, code === "Me" ? o.sect_rules_mercury : o.sect_rules);
        select.value = d.sect.planets[code];
        select.addEventListener("change", () => updateDraft((x) => { x.sect.planets[code] = select.value; }, {rerender: false}));
        const name = el("span", {class: "sect-name"});
        name.innerHTML = planetGlyph(code);
        row.append(name, select);
        list.appendChild(row);
    }
    body.appendChild(list);
}

function renderSpeedDialog(body) {
    const d = draft();
    const o = state.optionsMeta.classical_options;
    radioGroup(body, "平均速度", "speed-preset", o.speed_presets, d.speed.preset, (v) => updateDraft((x) => {
        x.speed.preset = v;
        if (v === "custom" && !Object.keys(x.speed.custom || {}).length) {
            const ecl = $("eclipticMode").value === "sidereal" ? "astronomical_sidereal" : "astronomical_tropical";
            x.speed.custom = {...o.mean_speeds[ecl]};
        }
    }));
    radioGroup(body, "比较方式", "speed-compare", o.speed_compare, d.speed.compare,
        (v) => updateDraft((x) => { x.speed.compare = v; }, {rerender: false}));
    sectionTitle(body, d.speed.preset === "custom" ? "自定义平均速度（°/日）" : "当前使用的平均速度（°/日）");
    const sidereal = $("eclipticMode").value === "sidereal";
    const table = el("div", {class: "speed-grid"});
    for (const code of o.speed_planets) {
        let value;
        if (d.speed.preset === "custom") value = d.speed.custom?.[code] ?? "";
        else if (d.speed.preset === "traditional" && o.mean_speeds.traditional[code] !== undefined) value = o.mean_speeds.traditional[code];
        else if (d.speed.preset === "empirical") value = o.mean_speeds.empirical[code];
        else value = o.mean_speeds[sidereal ? "astronomical_sidereal" : "astronomical_tropical"][code];
        const row = el("div", {class: "speed-row"});
        const name = el("span", {class: "sect-name"});
        name.innerHTML = planetGlyph(code);
        const input = el("input", {type: "number", min: 0, step: "any", value: value === "" ? "" : Number(value).toFixed(6),
            class: "speed-input", disabled: d.speed.preset !== "custom"});
        input.addEventListener("change", () => {
            const n = Number(input.value);
            const ok = input.value === "" || (Number.isFinite(n) && n > 0 && n <= 20);
            input.classList.toggle("invalid", !ok);
            if (!ok) return;
            updateDraft((x) => {
                if (input.value === "") delete x.speed.custom[code];
                else x.speed.custom[code] = n;
            }, {rerender: false});
        });
        row.append(name, input);
        table.appendChild(row);
    }
    body.appendChild(table);
}

// 太阳光束：若干档，每档一个名称和一个度数。行星与太阳的黄经距离落在哪一档以内，就显示哪一档的名称；
// 按度数从小到大判断，取最先满足的一档（例如 17′ 以内为日核，8.5° 以内为焦伤，17° 以内为光束下）。
const MAX_SUN_PHASES = 6;

function renderSunDialog(body) {
    const phases = draft().sun.phases;
    sectionTitle(body, "名称与距离太阳的度数");
    const list = el("div", {class: "sun-phase-list"});
    phases.forEach((phase, index) => {
        const row = el("div", {class: "sun-phase-row"});
        const label = el("input", {type: "text", value: phase.label, maxlength: 8, class: "sun-phase-label", "aria-label": "名称"});
        label.addEventListener("change", () => {
            const text = label.value.trim();
            if (!text) { label.value = phase.label; return; }
            updateDraft((d) => { d.sun.phases[index].label = text; }, {rerender: false});
        });
        const orb = el("input", {type: "number", min: 0, max: 40, step: "any", value: phase.orb, class: "orb-input", "aria-label": "度数"});
        orb.addEventListener("change", () => {
            const n = Number(orb.value);
            const ok = orb.value !== "" && Number.isFinite(n) && n >= 0 && n <= 40;
            orb.classList.toggle("invalid", !ok);
            if (!ok) return showError("度数必须是 0 到 40 之间的数字。");
            // 改完度数重新按从小到大排列
            updateDraft((d) => {
                d.sun.phases[index].orb = n;
                d.sun.phases.sort((x, y) => x.orb - y.orb);
            });
        });
        const remove = el("button", {type: "button", class: "icon-btn small", "aria-label": "删除这一档"}, "×");
        remove.addEventListener("click", () => updateDraft((d) => { d.sun.phases.splice(index, 1); }));
        row.append(label, orb, el("span", {class: "orb-unit"}, "° 以内"), remove);
        list.appendChild(row);
    });
    if (!phases.length) list.appendChild(el("p", {class: "muted"}, "没有任何一档时，行星表的「日照」一栏留空。"));
    body.appendChild(list);

    const add = el("button", {type: "button", class: "sun-phase-add"}, "＋ 添加一档");
    add.disabled = phases.length >= MAX_SUN_PHASES;
    add.addEventListener("click", () => updateDraft((d) => {
        const used = new Set(d.sun.phases.map((p) => p.label));
        let n = d.sun.phases.length + 1;
        while (used.has(`新档${n}`)) n += 1;
        const last = d.sun.phases.length ? d.sun.phases[d.sun.phases.length - 1].orb : 0;
        d.sun.phases.push({label: `新档${n}`, orb: Math.min(40, last + 5)});
    }));
    body.appendChild(add);
}

// ================= 行星标签页 =================
// 由后端 systems/western/astro/dignities.py 算好，这里只负责显示。


function speedCell(row) {
    if (row.mean_speed === null || row.mean_speed === undefined) return speedText(row.speed);
    const pct = `${row.speed_percent >= 0 ? "+" : ""}${row.speed_percent.toFixed(1)}%`;
    return {text: `${row.speed_diff > 0 ? "快" : "慢"} ${Math.abs(row.speed_diff).toFixed(4)}°/日（${pct}）`,
        cls: row.speed_diff > 0 ? "" : "dim"};
}

function scoreCell(dignity) {
    if (!dignity) return null;
    const v = dignity.score;
    return {text: v > 0 ? `+${v}` : String(v), cls: v > 0 ? "score-pos" : v < 0 ? "score-neg" : ""};
}

function renderWesternPlanets(container, results) {
    const data = (results.planet_table || []).map((r) => ({
        name: {html: planetGlyph(r.name)},
        position: positionCell(r),
        triplicity: {html: [r.triplicity.day, r.triplicity.night, r.triplicity.participating].filter(Boolean).map(planetGlyph).join(" ")},
        term: {html: planetGlyph(r.term)},
        face: {html: planetGlyph(r.face)},
        score: scoreCell(r.dignity),
        speed: speedCell(r),
        motion: {text: r.retrograde ? "逆行" : "顺行", cls: r.retrograde ? "bad" : ""},
        sect: r.in_sect === null || r.in_sect === undefined ? null : {text: r.in_sect ? "得时" : "不得时", cls: r.in_sect ? "good" : "dim"},
        oriental: r.oriental === null || r.oriental === undefined ? null : (r.oriental ? "东出" : "西入"),
        sun: r.solar_phase || "",
        lat: r.lat_dms,
        ra: r.ra_dms,
        dec: r.dec_dms,
    }));
    const columns = [
        COL.name, COL.position,
        {key: "triplicity", label: "三分"},
        {key: "term", label: "界"},
        {key: "face", label: "面"},
        {key: "score", label: "记分"},
        COL.speed,
        {key: "motion", label: "顺 / 逆"},
        {key: "sect", label: "得时"},
        {key: "oriental", label: "东出 / 西入"},
        {key: "sun", label: "日照"},
        {key: "lat", label: "黄纬"},
        COL.ra, COL.dec,
    ];
    container.innerHTML = rowsTableHtml(columns, data);
}

// 「原始参数」浮窗：行星、宫位、值日星 · 行星时，再加小行星、恒星、特殊点、Lot、映点与反映点。
function westernRawSections(results) {
    return [
        ...baseRawSections(results),
        {key: "asteroids", title: "小行星", tables: [{title: "", data: results.asteroids}]},
        {key: "stars", title: "恒星", tables: [{title: "", data: results.fixed_stars}]},
        {key: "specials", title: "特殊点", tables: [{title: "", data: results.special_points}]},
        {key: "lots", title: "Lot", tables: [{title: "", data: results.lots}]},
        {key: "antiscia", title: "映点与反映点", tables: [{title: "", data: results.antiscia}]},
    ];
}

// ================= 挂到共用页面上 =================

registerSystem({
    init(bootstrap) {
        state.points = state.settings.points;
        state.aspects = state.settings.aspects;
        state.classical = state.settings.classical;
    },
    bind() {
        bindSettingsDialogs();
        bindAspectView();
    },
    collectOptions() {
        return {points: state.points, aspects: state.aspects, classical: state.classical};
    },
    renderResults() {
        renderPointResults();
        renderAspects();
    },
    renderPlanetTab: renderWesternPlanets,
    renderHouseTab: renderWesternHouses,
    planetName: (code) => planetGlyph(code),
    rawSections: westernRawSections,
    renderChart(container, results, {emptyText}) {
        AstroChart.render(container, results, {
            emptyText,
            symbols: {planets: state.optionsMeta.planet_symbols, specials: state.optionsMeta.special_symbols},
            // 盘中元素太多、一圈排不下：弹窗提示一次，页面上也留着错误信息。
            onError: (message) => {
                showError(message);
                setTimeout(() => {
                    setStatus("排盘错误");
                    alert(message);
                }, 0);
            },
        });
    },
    onNewChart() {
        AstroChart.clearSelection();
    },
    tabVisible(button) {
        const category = button.dataset.points;
        return category ? pointCategoryEnabled(category) : undefined;
    },
});
