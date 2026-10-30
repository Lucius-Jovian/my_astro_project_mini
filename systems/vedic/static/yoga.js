"use strict";
/*
 * Yoga 标签页和「管理 Yoga」浮窗。
 *
 * - 计算哪张盘：跟着星盘走。Rashi 和 Gochara 算本命（Gochara 的结果区本来就是 Rashi），Transit 算过境盘，
 *   Moon 以月亮为第一宫，Bhava 按宫位，各个 D 盘按当前分盘算法换算后的位置。
 * - 只在 Yoga 标签页正显示时才计算；同一张盘、同一套设置只算一次（结果缓存到盘或设置改变为止）。
 * - 默认清单在 yogas_default.js；使用者的改动（停用、删除、修改、新建）存在 settings.json → systems.vedic.yogas。
 * - 公式由 yoga_engine.js 编译，一条写错只影响它自己（列表里标出错误），不影响别的。
 */

const YOGA_CAT_STORE = "quant-astro.yoga.cat.";     // 结果里每个分类折叠与否（只存在这台电脑的浏览器里）

const yogaState = {
    version: 0,                 // 设置（Yoga、相位、分盘算法）每改一次加一，缓存随之失效
    compiled: new Map(),        // id → {rule, compiled}
    cache: new WeakMap(),       // 盘面数据对象 → {version, results}
    pending: false,
    editing: null,              // 正在编辑的 Yoga：{id, origin}；null = 在列表里
};

function yogaConfig() {
    const cfg = state.settings.yogas = state.settings.yogas || {};
    cfg.disabled = cfg.disabled || [];
    cfg.removed = cfg.removed || [];
    cfg.custom = cfg.custom || [];
    return cfg;
}

const yogaDefaults = () => VedicYogaDefaults.YOGAS;
const yogaDefaultById = new Map(VedicYogaDefaults.YOGAS.map((y) => [y.id, y]));

// 实际使用的清单：默认的（去掉删掉的，改过的换成改过的）+ 自定义的。
function yogaList() {
    const cfg = yogaConfig();
    const removed = new Set(cfg.removed);
    const disabled = new Set(cfg.disabled);
    const custom = new Map(cfg.custom.map((y) => [y.id, y]));
    const out = [];
    for (const d of yogaDefaults()) {
        if (removed.has(d.id)) continue;
        const mod = custom.get(d.id);
        out.push({...d, ...(mod || {}), origin: mod ? "modified" : "default", enabled: !disabled.has(d.id)});
    }
    for (const y of cfg.custom) {
        if (yogaDefaultById.has(y.id)) continue;
        out.push({cat: "custom", ...y, origin: "custom", enabled: !disabled.has(y.id)});
    }
    return out;
}

function yogaCategoryLabel(cat) {
    return VedicYogaDefaults.CATEGORIES.find((c) => c.id === cat)?.label || cat || "自定义";
}

function compiledYoga(y) {
    const hit = yogaState.compiled.get(y.id);
    if (hit && hit.rule === y.rule) return hit.compiled;
    const compiled = YogaEngine.compile(y.rule);
    yogaState.compiled.set(y.id, {rule: y.rule, compiled});
    return compiled;
}

function compileAllYogas() {
    for (const y of yogaList()) compiledYoga(y);
}

// 设置变了：缓存作废，Yoga 标签页正显示时重算。
function yogaSettingsChanged() {
    yogaState.version++;
    scheduleYogaRender();
    if ($("yogaManagerCount")) updateYogaManagerCount();
}

let yogaSaveChain = Promise.resolve();

function saveYogaConfig(changes) {
    Object.assign(yogaConfig(), changes);
    yogaSettingsChanged();
    yogaSaveChain = yogaSaveChain
        .then(() => api(systemApi("/yogas"), {method: "POST", body: JSON.stringify(changes)}))
        .catch((error) => showError(`Yoga 设置没能保存：${error.message}`));
}

// ---------------------------------------------------------------- 当前要算哪张盘

// 返回 {label, data, base} 或 {pending: true} 或 null（没有盘）。
function yogaSource() {
    const view = state.view;
    if (view === "transit") {
        const t = state.charts.transit.results;
        return t ? {label: "Transit", data: t, base: t} : null;
    }
    const natal = state.charts.natal.results;
    if (!natal) return null;
    const derived = SYSTEM.derivedViews[view];
    if (!derived || view === "gochara") return {label: "Rashi", data: natal, base: natal};
    const entry = state.derived[view];
    if (!entry || entry.source !== natal || !entry.results) return entry?.error ? null : {pending: true};
    const varga = VedicVargas.get(view);
    const label = varga ? `${varga.id} ${varga.name}` : derived.label;
    return {label, data: entry.results, base: natal};
}

function yogaChartFrom(source) {
    const {data, base} = source;
    const points = {...data.planet_pos, Asc: data.house_result?.axes?.Asc};
    const phys = {...base.planet_pos, Asc: base.house_result?.axes?.Asc};
    const meta = data.chart_meta || {};
    return YogaEngine.makeChart({
        points,
        cells: meta.cells,
        lagna: Number.isInteger(meta.lagna_sign) ? meta.lagna_sign : undefined,
        phys,
        aspects: vedicAspects(),
        combust: combustTable(),
        // dsign(P, n)：按本命（或过境）D1 的真实黄经，用当前的分盘算法换算
        dsign: (code, n) => {
            const lon = phys[code]?.lon;
            if (!Number.isFinite(Number(lon))) return 0;
            const varga = VedicVargas.get(`D${n}`);
            if (!varga) throw new Error(`没有 D${n} 分盘`);
            const toLon = varga.methods[vargaMethod(varga.id)].toLon;
            return Math.floor(toLon(lon) / 30) % 12 + 1;
        },
    });
}

function computeYogas(source) {
    const hit = yogaState.cache.get(source.data);
    if (hit && hit.version === yogaState.version) return hit.results;
    const chart = yogaChartFrom(source);
    const results = [];
    for (const y of yogaList()) {
        if (!y.enabled) continue;
        const r = YogaEngine.run(compiledYoga(y), chart);
        results.push({yoga: y, value: r.value === true, error: r.error || null});
    }
    yogaState.cache.set(source.data, {version: yogaState.version, results});
    return results;
}

// ---------------------------------------------------------------- 标签页

function yogaTabVisible() {
    const panel = $("tabYoga");
    return panel && !panel.classList.contains("hidden");
}

// 只在 Yoga 标签页显示着的时候算；同一帧里多次请求合并成一次。
function scheduleYogaRender() {
    if (!yogaTabVisible() || yogaState.pending) return;
    yogaState.pending = true;
    requestAnimationFrame(() => {
        yogaState.pending = false;
        if (yogaTabVisible()) renderYogaTab();
    });
}

function renderYogaTab() {
    const box = $("yogaResult");
    const source = yogaSource();
    if (!source || source.pending) {
        box.innerHTML = "";
        return;
    }
    compileAllYogas();                   // 只在第一次（或公式改过时）真正编译
    const results = computeYogas(source);
    const hits = results.filter((r) => r.value);
    const errors = results.filter((r) => r.error).length;

    const groups = new Map();
    for (const r of hits) {
        const cat = r.yoga.cat || "custom";
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(r);
    }
    const order = VedicYogaDefaults.CATEGORIES.map((c) => c.id);
    const cats = [...groups.keys()].sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99));

    const head = `
        <div class="yoga-head">
            <span class="yoga-scope">${escapeHtml(source.label)}</span>
            <span class="yoga-total">${hits.length}</span>
            ${errors ? `<button type="button" class="yoga-err-count" data-open-yoga-manager title="有 ${errors} 条公式算不出来，点开检查">${errors} 条公式有错</button>` : ""}
        </div>`;
    const body = cats.map((cat) => {
        const rows = groups.get(cat);
        let open = true;
        try {
            const saved = localStorage.getItem(YOGA_CAT_STORE + cat);
            if (saved !== null) open = saved === "1";
        } catch (_) { /* 存不了就用默认 */ }
        return `
            <details class="yoga-group" data-cat="${escapeHtml(cat)}" ${open ? "open" : ""}>
                <summary><span class="yoga-group-name">${escapeHtml(yogaCategoryLabel(cat))}</span><span class="yoga-group-count">${rows.length}</span></summary>
                <div class="yoga-items">${rows.map(yogaRowHtml).join("")}</div>
            </details>`;
    }).join("");
    box.innerHTML = head + body;

    box.querySelectorAll("details.yoga-group").forEach((d) => d.addEventListener("toggle", () => {
        try { localStorage.setItem(YOGA_CAT_STORE + d.dataset.cat, d.open ? "1" : "0"); } catch (_) {}
    }));
    box.querySelector("[data-open-yoga-manager]")?.addEventListener("click", () => openYogaManager());
}

function yogaRowHtml(r) {
    const y = r.yoga;
    const tip = [y.src, y.rule].filter(Boolean).join("\n");
    return `
        <div class="yoga-row" title="${escapeHtml(tip)}">
            <div class="yoga-line">
                <span class="yoga-name">${escapeHtml(y.name || y.id)}</span>
                ${y.cn ? `<span class="yoga-cn">${escapeHtml(y.cn)}</span>` : ""}
                ${y.effect ? `<span class="yoga-effect">${escapeHtml(y.effect)}</span>` : ""}
            </div>
            ${y.desc ? `<div class="yoga-desc">${escapeHtml(y.desc)}</div>` : ""}
        </div>`;
}

// ---------------------------------------------------------------- 管理浮窗

function openYogaManager() {
    $("yogaSearch").value = "";
    renderYogaCatFilter();
    showYogaList();
    openDialog("yogaDialog");
}

function updateYogaManagerCount() {
    const list = yogaList();
    $("yogaManagerCount").textContent = `${list.filter((y) => y.enabled).length} / ${list.length}`;
}

function renderYogaCatFilter() {
    const select = $("yogaCatFilter");
    const keep = select.value;
    const cats = [...new Set(yogaList().map((y) => y.cat || "custom"))];
    fillSelect(select, [{value: "", label: "全部分类"}, ...cats.map((c) => ({value: c, label: yogaCategoryLabel(c)}))]);
    select.value = cats.includes(keep) ? keep : "";
    $("yogaCatList").innerHTML = [...new Set([...VedicYogaDefaults.CATEGORIES.map((c) => c.id), ...cats])]
        .map((c) => `<option value="${escapeHtml(yogaCategoryLabel(c))}"></option>`).join("");
}

function showYogaList() {
    const returning = yogaState.editing !== null;
    yogaState.editing = null;
    showError("");
    $("yogaEditor").classList.add("hidden");
    $("yogaListView").classList.remove("hidden");
    $("yogaBackBtn").classList.add("hidden");
    $("yogaDialogMeta").classList.remove("hidden");
    $("yogaDialogTitle").textContent = "管理 Yoga";
    $("yogaRestoreAllBtn").classList.remove("hidden");
    renderYogaManageList();
    if (returning) $("yogaSearch").focus();
}

function renderYogaManageList() {
    const list = yogaList();
    const q = $("yogaSearch").value.trim().toLowerCase();
    const cat = $("yogaCatFilter").value;
    const removedCount = yogaConfig().removed.length;
    $("yogaDialogMeta").textContent = `共 ${list.length} 条，启用 ${list.filter((y) => y.enabled).length} 条${removedCount ? `，删掉的默认 ${removedCount} 条` : ""}`;
    const rows = list.filter((y) => (!cat || (y.cat || "custom") === cat) &&
        (!q || [y.name, y.cn, y.desc, y.rule, y.id].some((t) => String(t || "").toLowerCase().includes(q))));
    // 一次最多画 300 行（全部 Yoga 不到 300 条；以后多了，用搜索或分类缩小范围）
    const shown = rows.slice(0, 300);
    $("yogaManageList").innerHTML = shown.map((y) => {
        const compiled = compiledYoga(y);
        const badge = y.origin === "custom" ? "自定义" : y.origin === "modified" ? "已修改" : "";
        return `
            <div class="ym-row${y.enabled ? "" : " disabled"}" data-id="${escapeHtml(y.id)}">
                <input type="checkbox" class="ym-on" ${y.enabled ? "checked" : ""} aria-label="启用 ${escapeHtml(y.name)}">
                <div class="ym-main">
                    <div><b>${escapeHtml(y.name || y.id)}</b> <span class="muted">${escapeHtml(y.cn || "")}</span>
                        ${badge ? `<span class="yoga-badge">${badge}</span>` : ""}
                        ${compiled.ok ? "" : "<span class='yoga-error'>公式有错</span>"}</div>
                    <div class="ym-rule">${escapeHtml(y.rule)}</div>
                </div>
                <span class="ym-cat muted">${escapeHtml(yogaCategoryLabel(y.cat))}</span>
                <button type="button" class="icon-btn ym-del" aria-label="删除" title="${y.origin === "custom" ? "删除这条自定义 Yoga" : "删掉这条默认 Yoga（可以用「恢复全部默认」找回）"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg></button>
            </div>`;
    }).join("") + (rows.length > shown.length ? `<p class="muted">还有 ${rows.length - shown.length} 条，请用搜索或分类缩小范围。</p>` : "") +
        (rows.length ? "" : "<p class='muted'>没有符合条件的 Yoga。</p>");
}

function bindYogaManager() {
    $("yogaSearch").addEventListener("input", debounce(renderYogaManageList, 120));
    $("yogaCatFilter").addEventListener("change", renderYogaManageList);
    $("yogaNewBtn").addEventListener("click", () => openYogaEditor(null));
    $("yogaManageList").addEventListener("click", (event) => {
        const row = event.target.closest(".ym-row");
        if (!row) return;
        const y = yogaList().find((item) => item.id === row.dataset.id);
        if (!y) return;
        if (event.target.closest(".ym-on")) return;
        if (!event.target.closest(".ym-del")) {
            openYogaEditor(y);              // 点这一行任何地方（勾选框、删除除外）就进入编辑
        } else {
            if (!confirm(`删除「${y.name}${y.cn ? ` ${y.cn}` : ""}」？${y.origin === "custom" ? "\n自定义的 Yoga 删除后不能恢复。" : "\n默认 Yoga 删掉后可以用「恢复全部默认」找回。"}`)) return;
            const cfg = yogaConfig();
            const changes = {
                custom: cfg.custom.filter((item) => item.id !== y.id),
                disabled: cfg.disabled.filter((id) => id !== y.id),
            };
            if (y.origin !== "custom") changes.removed = [...cfg.removed, y.id];
            saveYogaConfig(changes);
            renderYogaCatFilter();
            renderYogaManageList();
        }
    });
    $("yogaManageList").addEventListener("change", (event) => {
        if (!event.target.classList.contains("ym-on")) return;
        const id = event.target.closest(".ym-row").dataset.id;
        const disabled = new Set(yogaConfig().disabled);
        if (event.target.checked) disabled.delete(id);
        else disabled.add(id);
        saveYogaConfig({disabled: [...disabled]});
        event.target.closest(".ym-row").classList.toggle("disabled", !event.target.checked);
        renderYogaManageList();
    });
    $("yogaRestoreAllBtn").addEventListener("click", () => {
        if (!confirm("恢复全部默认 Yoga？\n删掉的默认 Yoga 会回来，改过的默认 Yoga 改回原样，所有默认 Yoga 重新启用。自定义的 Yoga 不受影响。")) return;
        const cfg = yogaConfig();
        saveYogaConfig({
            removed: [],
            custom: cfg.custom.filter((y) => !yogaDefaultById.has(y.id)),
            disabled: cfg.disabled.filter((id) => !yogaDefaultById.has(id)),
        });
        renderYogaCatFilter();
        showYogaList();
    });

    // 编辑器：左上角的返回、「返回列表」、Esc 都回到列表（列表里按 Esc 才关闭浮窗）
    $("yogaBackBtn").addEventListener("click", showYogaList);
    $("yogaDialog").addEventListener("cancel", (event) => {
        if (yogaState.editing === null) return;
        event.preventDefault();
        showYogaList();
    });
    const check = debounce(checkYogaRule, 150);
    $("yeRule").addEventListener("input", check);
    $("yeCancel").addEventListener("click", showYogaList);
    $("yeRestore").addEventListener("click", () => {
        const d = yogaDefaultById.get(yogaState.editing?.id);
        if (d) fillYogaEditor(d);
    });
    $("yogaEditor").addEventListener("submit", (event) => {
        event.preventDefault();
        saveYogaEditor();
    });
    $("yogaRef").innerHTML = yogaReferenceHtml();
}

function fillYogaEditor(y) {
    $("yeName").value = y.name || "";
    $("yeCn").value = y.cn || "";
    $("yeCat").value = yogaCategoryLabel(y.cat || "custom");
    $("yeRule").value = y.rule || "";
    $("yeDesc").value = y.desc || "";
    $("yeEffect").value = y.effect || "";
    $("yeSrc").value = y.src || "";
    checkYogaRule();
}

function openYogaEditor(y) {
    yogaState.editing = y ? {id: y.id, origin: y.origin} : {id: null, origin: "custom"};
    $("yogaListView").classList.add("hidden");
    $("yogaEditor").classList.remove("hidden");
    $("yogaBackBtn").classList.remove("hidden");
    $("yogaDialogMeta").classList.add("hidden");
    $("yogaRestoreAllBtn").classList.add("hidden");
    $("yogaDialogTitle").textContent = y ? `${y.name || y.id}${y.cn ? ` ${y.cn}` : ""}` : "新建 Yoga";
    $("yeRestore").classList.toggle("hidden", !(y && y.origin === "modified"));
    fillYogaEditor(y || {cat: "custom", rule: ""});
    $(y ? "yeRule" : "yeName").focus();
}

// 实时检查公式：写法对不对、在当前这张盘上成立与否。
function checkYogaRule() {
    const out = $("yeCheck");
    const rule = $("yeRule").value;
    if (!rule.trim()) {
        out.className = "yoga-check";
        out.textContent = "";
        return false;
    }
    const compiled = YogaEngine.compile(rule);
    if (!compiled.ok) {
        out.className = "yoga-check bad";
        out.textContent = `公式有错：${compiled.error}${Number.isInteger(compiled.pos) ? `（第 ${compiled.pos + 1} 个字附近）` : ""}`;
        return false;
    }
    const source = yogaSource();
    if (!source || source.pending) {
        out.className = "yoga-check ok";
        out.textContent = "公式写法正确。（排盘后可以在当前盘上试算）";
        return true;
    }
    const r = YogaEngine.run(compiled, yogaChartFrom(source));
    if (r.error) {
        out.className = "yoga-check bad";
        out.textContent = `在当前盘上算不出来：${r.error}`;
        return false;
    }
    out.className = "yoga-check ok";
    out.textContent = `公式写法正确。在当前盘（${source.label}）上${r.value ? "成立" : "不成立"}。`;
    return true;
}

// 分类框里显示的是分类名称；保存时换回分类的 id（输入了新名称就把它当作新的分类）。
function categoryIdFromText(text) {
    const t = String(text || "").trim();
    if (!t) return "custom";
    const hit = VedicYogaDefaults.CATEGORIES.find((c) => c.label === t || c.id === t);
    return hit ? hit.id : t.slice(0, 40);
}

function saveYogaEditor() {
    const name = $("yeName").value.trim();
    const rule = $("yeRule").value.trim();
    if (!name) {
        showError("请填写 Yoga 的名称。");
        $("yeName").focus();
        return;
    }
    if (!YogaEngine.compile(rule).ok) {
        showError("公式有错，请先改正（下方有提示）。");
        $("yeRule").focus();
        return;
    }
    const cfg = yogaConfig();
    const editing = yogaState.editing;
    const id = editing.id || `u.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const item = {
        id, name, rule,
        cn: $("yeCn").value.trim(),
        cat: categoryIdFromText($("yeCat").value),
        desc: $("yeDesc").value.trim(),
        effect: $("yeEffect").value.trim(),
        src: $("yeSrc").value.trim(),
    };
    // 默认 Yoga 改完和原来一模一样：不必存一份覆盖
    const d = yogaDefaultById.get(id);
    const same = d && ["name", "cn", "cat", "rule", "desc", "effect", "src"].every((k) => (d[k] || "") === item[k]);
    const custom = cfg.custom.filter((y) => y.id !== id);
    if (!same) custom.push(item);
    saveYogaConfig({custom});
    showError("");
    renderYogaCatFilter();
    showYogaList();
}

// 公式写法的速查（从引擎的函数表自动生成，和实际支持的函数始终一致）
function yogaReferenceHtml() {
    const fns = Object.values(YogaEngine.FUNCTIONS)
        .map((f) => `<tr><td><code>${escapeHtml(f.sig)}</code></td><td>${escapeHtml(f.doc)}</td></tr>`).join("");
    const consts = Object.entries(YogaEngine.CONSTANTS)
        .map(([k, c]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(c.doc)}</td></tr>`).join("");
    return `
        <p>行星写代号：<code>Su Mo Ma Me Ju Ve Sa Ra Ke</code>；<code>Asc</code> 是上升点，<code>Lagna</code> 是这张盘的第一宫（Moon 盘就是月亮所在的星座）。
           宫位从 1 数起；星座 1 = 白羊 … 12 = 双鱼。</p>
        <p>运算：<code>and</code> <code>or</code> <code>not</code>（也可以写 且 或 非）、<code>==</code> <code>!=</code> <code>&lt;</code> <code>&gt;</code> <code>&lt;=</code> <code>&gt;=</code>、
           <code>in</code> / <code>not in</code>（在不在列表里）、<code>+</code> <code>-</code>（数字加减；列表合并、去掉）、括号。列表写成 <code>[1, 4, 7, 10]</code>。</p>
        <p>例：<code>house(Ju, Mo) in KENDRA</code>（木星在月亮起的角宫）；<code>assoc(lord(9), lord(10))</code>（9、10 宫主有关联）；
           <code>debilitated(Sa) and house(Sa) in KENDRA</code>。</p>
        <h4>函数</h4><table class="yoga-ref-table">${fns}</table>
        <h4>常数</h4><table class="yoga-ref-table">${consts}</table>`;
}

function bindYoga() {
    document.querySelector('#resultTabs [data-tab="tabYoga"]').addEventListener("click", () => scheduleYogaRender());
    $("openYogaManagerBtn").addEventListener("click", () => openYogaManager());
    bindYogaManager();
    updateYogaManagerCount();
    // 浏览器空闲时先把公式编译好（全部 Yoga 一共几毫秒），第一次打开 Yoga 标签页就不用等。
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(compileAllYogas);
}
