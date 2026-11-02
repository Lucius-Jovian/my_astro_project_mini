"use strict";
/*
 * 印占的计算设置：和西占一样，抽屉里每一项只占一行（右边是摘要），点开在浮窗里修改。
 *
 * 浮窗的内容来自 index.html 里的 <template id="vdlg-类别">。表单控件用 data-set="根.路径" 对应设置：
 *   calc.*     计算设置（calculation_defaults）      → POST /calc-defaults
 *   aspects.*  相位                                  → POST /aspects
 *   combust.*  燃烧度数                              → POST /combust
 *   varga.*    分盘（Bhava 宫位制；各分盘算法另用 data-varga） → POST /varga
 *   jy.*       尊贵、状态、特殊点等（jyotish）       → POST /jyotish
 * 浮窗里的修改只改表单：点「完成」才一次性校验、保存、按新设置重算一次；
 * 点「取消」、×、Esc 或浮窗外面都放弃（有改动时先确认）。「恢复默认」把表单填回默认值，同样点「完成」才生效。
 */

const VDLG_ROOTS = {
    calc: {endpoint: "/calc-defaults", key: "calculation_defaults"},
    aspects: {endpoint: "/aspects", key: "aspects"},
    combust: {endpoint: "/combust", key: "combust"},
    varga: {endpoint: "/varga", key: "varga"},
    jy: {endpoint: "/jyotish", key: "jyotish"},
};

let vedicDialog = null;          // {category, original}

function systemDefaults() {
    return state.optionsMeta?.system_defaults || {};
}

function rootSource(root, defaults = false) {
    const key = VDLG_ROOTS[root].key;
    const base = systemDefaults()[key] || {};
    return defaults ? base : {...base, ...(state.settings[key] || {})};
}

function pathValue(obj, parts) {
    return parts.reduce((node, k) => (node == null ? undefined : node[k]), obj);
}

function setPath(obj, parts, value) {
    let node = obj;
    parts.slice(0, -1).forEach((k) => { node = node[k] = node[k] && typeof node[k] === "object" ? node[k] : {}; });
    node[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------- 生成浮窗里的动态部分

const VDLG_BUILDERS = {
    vargaMethods(box) {
        box.innerHTML = "";
        for (const varga of VedicVargas.list()) {
            if (varga.view === "natal") continue;
            const keys = Object.keys(varga.methods);
            const row = document.createElement("div");
            row.className = "varga-row";
            row.innerHTML = `
                <span class="varga-id">${escapeHtml(varga.id)}</span>
                <span class="varga-name">${escapeHtml(varga.name)}<span class="muted"> · ${escapeHtml(varga.topic)}</span></span>
                <select data-varga="${escapeHtml(varga.id)}" aria-label="${escapeHtml(varga.id)} 的算法" ${keys.length > 1 ? "" : "disabled"}></select>
                <span class="varga-note muted"></span>`;
            const select = row.querySelector("select");
            fillSelect(select, keys.map((k) => ({value: k, label: varga.methods[k].label})));
            const note = row.querySelector(".varga-note");
            const showNote = () => {
                const m = varga.methods[select.value];
                note.textContent = [m?.note, m?.source ? `出处：${m.source}` : ""].filter(Boolean).join("。");
            };
            select.addEventListener("change", showNote);
            select.showNote = showNote;
            box.appendChild(row);
        }
    },
    dashaStart(box) {
        box.innerHTML = `<div class="segmented classical-seg" role="radiogroup">${state.optionsMeta.main_planets.map((p) =>
            `<label><input type="radio" name="calc.dasha_start_planet" data-set="calc.dasha_start_planet" value="${p}"><span>${p}</span></label>`).join("")}</div>`;
    },
    pointChart(box) {
        box.innerHTML = POINT_GROUPS.map((g) => `
            <span class="pc-group">${escapeHtml(g.label)}</span>
            ${g.codes.map((c) => `<label><input type="checkbox" data-code="${c}">${c}</label>`).join("")}`).join("");
    },
    deepGrid(box) {
        box.innerHTML = Jyotish.P7.map((p) => `<label class="num-row"><span class="num-label">${p}</span>
            <input type="number" data-set="jy.dignity.deep.${p}" min="0" max="30" step="0.5"></label>`).join("");
    },
    combustGrid(box) {
        box.innerHTML = COMBUST_FIELDS.map(([key, label]) => `<label class="num-row"><span class="num-label">${escapeHtml(label)}</span>
            <input type="number" data-set="combust.${key}" min="0" max="30" step="0.5"></label>`).join("");
    },
};

function fillOptions(select) {
    const kind = select.dataset.fill;
    if (kind === "house_systems") fillSelect(select, state.optionsMeta.house_systems);
    else if (kind === "dasha_systems") fillSelect(select, dashaSystemOptions());
}

// ---------------------------------------------------------------- 表单 ↔ 设置

function fillVedicForm(body, defaults = false) {
    body.querySelectorAll("[data-set]").forEach((el) => {
        const [root, ...parts] = el.dataset.set.split(".");
        const v = pathValue(rootSource(root, defaults), parts);
        if (el.type === "checkbox") el.checked = Boolean(v);
        else if (el.type === "radio") el.checked = String(v) === el.value;
        else if (el.type === "number" && Number.isFinite(Number(v))) el.value = String(Number(Number(v).toFixed(4)));
        else el.value = v ?? "";
        el.classList.remove("invalid");
    });
    body.querySelectorAll("[data-varga]").forEach((select) => {
        const chosen = defaults ? null : vargaSettings().methods?.[select.dataset.varga];
        select.value = VedicVargas.resolveMethod(select.dataset.varga, chosen);
        select.showNote?.();
    });
    const chart = new Set(defaults ? [] : (jyotishSettings().points?.chart || []));
    body.querySelectorAll("[data-code]").forEach((el) => { el.checked = chart.has(el.dataset.code); });
}

// 读表单：{roots: {根: 嵌套的值}, methods: {...} | null, chart: [...] | null}
function readVedicForm(body) {
    const roots = {};
    body.querySelectorAll("[data-set]").forEach((el) => {
        if (el.type === "radio" && !el.checked) return;
        const [root, ...parts] = el.dataset.set.split(".");
        const value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
        roots[root] = roots[root] || {};
        setPath(roots[root], parts, value);
    });
    const selects = [...body.querySelectorAll("[data-varga]")];
    const methods = selects.length ? Object.fromEntries(selects
        .filter((s) => s.value !== VedicVargas.defaultMethod(s.dataset.varga))
        .map((s) => [s.dataset.varga, s.value])) : null;
    const codes = [...body.querySelectorAll("[data-code]")];
    const chart = codes.length ? codes.filter((el) => el.checked).map((el) => el.dataset.code) : null;
    return {roots, methods, chart};
}

function vedicFormSnapshot() {
    return JSON.stringify(readVedicForm($("vedicDialogBody")));
}

function validateVedicForm(body) {
    let firstBad = null;
    body.querySelectorAll("input[type=number]").forEach((el) => {
        const v = Number(el.value);
        let max = Number(el.max);
        if (el.dataset.set === "calc.KP_HORARY.number") {
            max = body.querySelector("[data-set='calc.KP_HORARY.mode']:checked")?.value === "CIL-N" ? 2193 : 249;
        }
        const ok = el.value !== "" && Number.isFinite(v) && v >= Number(el.min) && v <= max;
        el.classList.toggle("invalid", !ok);
        if (!ok && !firstBad) firstBad = {el, min: el.min, max};
    });
    if (firstBad) {
        const label = firstBad.el.closest(".num-row")?.querySelector(".num-label")?.textContent || "";
        showError(`${label}：请填 ${firstBad.min} 到 ${firstBad.max} 之间的数字。`);
        firstBad.el.focus();
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- 打开、完成、取消

function openVedicDialog(category) {
    const tpl = $(`vdlg-${category}`);
    if (!tpl) return;
    const body = $("vedicDialogBody");
    body.innerHTML = "";
    body.appendChild(tpl.content.cloneNode(true));
    body.querySelectorAll("[data-build]").forEach((box) => VDLG_BUILDERS[box.dataset.build](box));
    body.querySelectorAll("select[data-fill]").forEach(fillOptions);
    fillVedicForm(body);
    $("vedicDialogTitle").textContent = tpl.dataset.title;
    vedicDialog = {category, original: vedicFormSnapshot()};
    showError("");
    openDialog("vedicDialog");
}

function closeVedicDialog() {
    vedicDialog = null;
    closeDialog("vedicDialog");
}

function cancelVedicDialog() {
    if (vedicDialog && vedicFormSnapshot() !== vedicDialog.original && !confirm("放弃这次的修改？")) return;
    closeVedicDialog();
}

async function finishVedicDialog() {
    if (!vedicDialog) return;
    document.activeElement?.blur?.();
    const body = $("vedicDialogBody");
    if (vedicFormSnapshot() === vedicDialog.original) {
        closeVedicDialog();
        return;
    }
    if (!validateVedicForm(body)) return;
    const {roots, methods, chart} = readVedicForm(body);
    if (methods) (roots.varga = roots.varga || {}).methods = methods;
    if (chart) setPath(roots.jy = roots.jy || {}, ["points", "chart"], chart);
    // 嵌套的两项整项发送（与现有设置合并）
    if (roots.calc?.KP_HORARY) roots.calc.KP_HORARY = {...rootSource("calc").KP_HORARY, ...roots.calc.KP_HORARY};
    if (roots.calc?.sunrise) roots.calc.sunrise = {...rootSource("calc").sunrise, ...roots.calc.sunrise};

    const button = $("vedicDialogDone");
    button.disabled = true;
    try {
        showError("");
        for (const [root, payload] of Object.entries(roots)) {
            const saved = await api(systemApi(VDLG_ROOTS[root].endpoint), {method: "POST", body: JSON.stringify(payload)});
            state.settings[VDLG_ROOTS[root].key] = saved;
        }
        closeVedicDialog();
        afterVedicSettings();
    } catch (error) {
        showError(error.message);
    } finally {
        button.disabled = false;
    }
}

// 设置保存后：模块开关、Yoga、星盘选中、摘要；已经排过盘时按新设置重算（只有影响后端的设置会真的重算）
function afterVedicSettings() {
    state.modules = resolveModules(state.settings.calculation_defaults.kp_enabled !== false);
    for (const [m, keys] of Object.entries(MODULE_RESULT_KEYS)) {
        if (state.modules[m]) continue;
        keys.forEach((k) => delete state.results[k]);
        state.computedModules[m] = false;
    }
    updateTabVisibility();
    applyNodeExalt();
    yogaSettingsChanged();
    AstroChart.clearSelection();
    updateVedicEntries();
    if (state.charts[chartKind()].results) ensureComputed();
    renderView();
}

function restoreVedicDefaults() {
    fillVedicForm($("vedicDialogBody"), true);
    showNotice("已恢复默认（点「完成」后生效）。");
}

// ---------------------------------------------------------------- 抽屉里每一项右边的摘要

function updateVedicEntries() {
    const calc = state.settings.calculation_defaults;
    const cfg = jyotishSettings();
    const jd = jyotishDefaults();
    const asp = aspectSettings();
    const horary = calc.KP_HORARY || {};
    const sameDeep = Number(cfg.dignity?.orb) === Number(jd.dignity?.orb) &&
        Jyotish.P7.every((p) => Number(cfg.dignity?.deep?.[p]) === Number(jd.dignity?.deep?.[p]));
    const comb = combustSettings();
    const sameComb = Object.keys(COMBUST_DEFAULT).every((k) => Number(comb[k]) === COMBUST_DEFAULT[k]);
    const vargas = VedicVargas.list().filter((v) => v.view !== "natal");
    const changed = vargas.filter((v) => vargaMethod(v.id) !== VedicVargas.defaultMethod(v.id)).length;
    const sys = (state.optionsMeta.dasha_systems || []).find((s) => s.value === currentDashaSystem());
    const nodesOn = ["Ra", "Ke"].filter((k) => asp[k] !== false).map((k) => (k === "Ra" ? "罗睺" : "计都"));
    const sr = calc.sunrise || {};
    const limbText = {upper: "上边缘", center: "日心", lower: "下边缘"}[sr.limb] || "";
    const groupShort = (g) => ({shad: "Shad", sapta: "Sapta", dasha: "Dasha", shodasha: "Shodasha"}[g] || g);
    const n = (cfg.points?.chart || []).length;
    const text = {
        kp: calc.kp_enabled === false ? "未启用" : horary.is_active ? `卜卦 ${horary.mode} ${horary.number}` : "已启用",
        varga: `Bhava ${bhavaHouseSystem()}${changed ? ` · ${changed} 张非默认` : ""}`,
        dasha: sys?.label || "",
        aspects: asp.jaimini ? "Jaimini" : nodesOn.length ? `${nodesOn.join("、")}投射` : "罗计不投射",
        points: n ? `星盘 ${n}` : "",
        dignity: sameDeep ? "BPHS" : "自定义",
        combust: sameComb ? "BPHS" : "自定义",
        status: `Karaka ${cfg.status?.karaka || 8}`,
        bala: cfg.bala?.mercury === "benefic" ? "水星始终为吉" : "水星随同宫",
        av: cfg.av?.columns === "lagna" ? "从 Lagna 起" : "按星座",
        friends: cfg.friends?.nodes ? "九曜" : "七曜",
        vargas: `${groupShort(cfg.vargas?.vimsopaka)} · ${groupShort(cfg.vargas?.vaiseshikamsa)}`,
        sunrise: sr.limb === "center" && !sr.refraction && !sr.latitude ? "Hindu" : [limbText, sr.refraction === false ? "无折射" : ""].filter(Boolean).join(" · "),
        calendar: `${cfg.calendar?.masa === "purnimanta" ? "Purnimanta" : "Amanta"} · ${cfg.calendar?.samvatsara === "jovian" ? "北印" : "南印"}`,
    };
    document.querySelectorAll("[data-vdlg]").forEach((button) => {
        button.querySelector(".point-count").textContent = text[button.dataset.vdlg] ?? "";
    });
}

function bindVedicSettings() {
    document.querySelectorAll("[data-vdlg]").forEach((button) => {
        button.addEventListener("click", () => openVedicDialog(button.dataset.vdlg));
    });
    const dialog = $("vedicDialog");
    $("vedicDialogDone").addEventListener("click", finishVedicDialog);
    $("vedicDialogCancel").addEventListener("click", cancelVedicDialog);
    $("vedicDialogClose").addEventListener("click", cancelVedicDialog);
    $("vedicDialogRestore").addEventListener("click", restoreVedicDefaults);
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        cancelVedicDialog();
    });
    dialog.addEventListener("mousedown", (event) => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) cancelVedicDialog();
    });
    applyNodeExalt();
    updateVedicEntries();
}
