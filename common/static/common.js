"use strict";
/*
 * 两个占星体系共用的页面逻辑：人物档案（档案库、选择 / 编辑 / 筛选 / 标签 / 自定义字段 / CSV）、
 * 时间与地点输入、时间步进、本命 / 过境切换、外观、结果区的标签页框架、档案库加密。
 *
 * 体系自己的部分（计算设置里的专有选项、结果表、星盘）在 systems/<体系>/static/<体系>.js 里，
 * 通过 registerSystem({...}) 挂进来，挂接点见下面的 SYSTEM_HOOKS。改这里时请照顾到所有体系。
 */

const state = {
    settings: null,
    optionsMeta: null,
    results: {},
    profileFields: [],
    fieldKinds: [],
    tagOptions: [],
    profileList: {items: [], page: 1, pageSize: 50, total: 0, totalPages: 1, hasMore: false},
    profileQuery: {
        // sort / order 是排序（每个档案库单独保存在 settings.json，打开网页时由后端给出）；其余是筛选和搜索，不保存。
        q: "", scope: "name", bornFrom: "", bornTo: "", tags: [], tagMode: "all", sort: "opened", order: "desc", page: 1,
        // 字段条件：[{uid, field, min, max, options: [], empty}]，多条之间是“并且”
        fieldFilters: [],
    },
    libraryTotal: null,      // 档案库总人数（不带筛选时的 total）
    listToken: 0,
    selectToken: 0,
    activeProfileId: null,
    activeProfile: null,     // 当前人物的完整档案（含自定义字段），用于卡片、编辑浮窗和「档案资料」页
    editorMode: "edit",
    stepBase: null,          // 时间步进的起点 {parts, calendar}；手动改时间后清空
    // 当前显示的星盘：natal 本命 / transit 过境 / 体系自己的分盘（见 SYSTEM.derivedViews）
    view: "natal",
    // 两个独立的“时刻”：各自保存表单输入、排盘结果、结果对应的计算设置（signature）、
    // 排盘时发出的请求（payload，分盘需要再向后端要数据时照原样带上）和步进起点。
    charts: {
        natal: {input: null, results: null, signature: "", payload: null, stepBase: null},
        transit: {input: null, results: null, signature: "", payload: null, stepBase: null},
    },
    // 分盘的计算结果缓存：{视图: {source: 本命结果对象, sig: 分盘自己的设置, results, error}}。
    // 本命盘重算、或这个分盘的设置（例如算法）改了，缓存自动失效；没点到的分盘永远不计算。
    derived: {},
    initialized: false,
    requestToken: 0,
    // 当前页面所属的占星体系：{id, title, api}（来自 /api/bootstrap）
    system: null,
    // 页面外观（经纬度格式），两个体系共用，改动后写回。
    appearance: {coord_format: "dms"},
};

// ================= 占星体系的挂接点 =================
// 本文件是两个体系共用的页面逻辑（档案、时间地点、时间步进、过境、外观……）。
// 体系自己的部分写在 systems/<体系>/static/<体系>.js 里，用 registerSystem({...}) 挂进来；
// 下面列出全部可用的挂接点和默认行为，体系只需提供自己用得到的那几个。
const SYSTEM_HOOKS = {
    init(bootstrap) {},                 // bootstrap 数据到手后：读取体系自己的设置
    bind() {},                          // 绑定体系自己的控件、浮窗
    applyDefaults(calc) {},             // 页面打开时，把体系自己的计算默认值填进表单
    collectOptions() { return {}; },    // 排盘请求里体系自己的选项（与共用的四项合并）
    renderResults() {},                 // 画体系自己的结果标签页
    // 行星、宫位两页：默认画原始参数（只放十二宫宫头，四轴在星盘里已经标出）
    renderPlanetTab(container, results) { container.innerHTML = objectMapHtml(results.planet_pos || {}); },
    renderHouseTab(container, results) { container.innerHTML = objectMapHtml(results.house_result?.houses || {}); },
    planetName(code) { return escapeHtml(planetLabel(code)); },   // 结果表里行星的写法（HTML）
    // 「原始参数」浮窗里的分组：[{key, title, tables: [{title, data}]}]；默认是行星、宫位、值日星 · 行星时
    rawSections(results) { return baseRawSections(results); },
    renderChart(container, results, {emptyText, view}) {},
    onNewChart() {},                    // 新的一张盘算好了（例如清掉上一张盘里的选中高亮）
    onProfileChange(profile) {},        // 换了人（例如印度占星清掉各张盘的转宫）
    afterCalculate(kind, result) {},    // 某张盘（natal / transit）刚算完
    tabVisible(button) { return undefined; },   // 体系的标签页是否显示；undefined = 不管
    // 从本命盘换算出来的分盘：{键: {label, derive(natalResults, {payload}), signature?(), bar?}}
    //   derive      可以直接返回结果，也可以返回 Promise（需要向后端要数据时）；只在点到这个分盘时才调用
    //   signature   这个分盘自己的设置（如算法）写成的字符串；变了就重新换算
    //   bar         false = 不放在星盘上方的按钮条里，只出现在 viewMenu 的下拉菜单里
    //   form        "transit" = 左侧表单和「排盘」用过境盘（Gochara）；derive 另外收到 {transit: 过境结果}
    //   order       按钮条上的先后（数字小的在前，本命 / 过境固定在最前）
    derivedViews: {},
    viewLabels: {},                     // 改写本命 / 过境两个按钮的名称：{natal: "...", transit: "..."}
    // 按钮条右边的分盘按钮（分盘多时用）：{label, defaultValue, items: [{value: 视图键, label, note?, sub?, title?}]}；
    // 左半边切到最近用过的那张（没用过时是 defaultValue），右半边 ▾ 打开全部；null = 不要
    viewMenu: null,
    // 「值日星 · 行星时」标签页：默认画共用的表；体系可以换成自己的（印度占星：历法 / Panchanga）
    renderSunTab(container, results) { renderSunTable(container, results); },
    tabLabels: {},                      // 改写共用标签页的名称：{tabSun: "历法"}
    onDerivedReady(view) {},            // 一张要等后端的分盘（如 Bhava）刚算好、已经重画
};
let SYSTEM = {...SYSTEM_HOOKS};

function registerSystem(hooks) {
    SYSTEM = {...SYSTEM_HOOKS, ...hooks};
}

// 体系接口的地址：/<体系>/api/...
function systemApi(path) {
    return `${state.system.api}${path}`;
}

const $ = (id) => document.getElementById(id);

function setStatus(text) {
    $("statusBadge").textContent = text;
}

// 错误 / 提示：有浮窗打开时显示在浮窗顶部，否则显示在页面结果区上方。
function showError(message, {notice = false} = {}) {
    const boxes = [$("errorBox"), ...document.querySelectorAll("[data-dialog-msg]")];
    if (!message) {
        boxes.forEach((b) => { b.textContent = ""; b.classList.add("hidden"); });
        return;
    }
    const dialog = document.querySelector("dialog.modal[open]");
    const box = dialog?.querySelector("[data-dialog-msg]") || $("errorBox");
    box.textContent = String(message);
    box.classList.toggle("notice", notice);
    box.classList.remove("hidden");
}

// 只清掉页面上的错误框，不动浮窗里的提示（设置浮窗打开时，后台重新排盘不应把浮窗里的提示清掉）。
function clearPageError() {
    $("errorBox").textContent = "";
    $("errorBox").classList.add("hidden");
}

function showNotice(message) {
    showError(message, {notice: true});
}

// 返回完整的响应体（除了 data，还有分页列表用的 total / page / has_more 等）。
// ================= 装在外壳页面里（常驻 iframe） =================
// 首页 / 是外壳页面，每个体系的页面装在一个 iframe 里常驻，切换体系只是显示 / 隐藏（见 templates/app.html）。
// 这里负责三件事：
//   1. 顶部的体系切换按钮：不再跳转，而是请外壳页面切换；
//   2. 改了共用的东西（选了别的人、改了档案、换了档案库……）时，通过外壳告诉其它体系；
//   3. 收到其它体系的消息时先攒着，等自己被切换到时再处理，隐藏期间不做任何计算。

const EMBEDDED = (() => {
    try {
        return window.parent !== window && window.parent.location.origin === location.origin;
    } catch (_) {
        return false;
    }
})();

// 这个体系现在是否正显示在外壳里（不在外壳里时永远算“显示中”）。
function frameActive() {
    if (!EMBEDDED) return true;
    try {
        return !window.frameElement?.classList.contains("qa-off");
    } catch (_) {
        return true;
    }
}

function postToShell(message) {
    if (EMBEDDED) window.parent.postMessage(message, location.origin);
}

function notifyOthers(event) {
    postToShell({type: "qa-sync", event});
}

// 一次成功的写操作之后：看它改了什么，告诉其它体系。
//   /api/session 里的 last_profile_id    → 换了人（其它体系切过去时跟着换）
//   /api/session 里的 profile_sort       → 人物排序变了
//   /api/appearance                      → 外观（经纬度格式）
//   /api/profiles、/api/profiles/<id>    → 新建 / 修改 / 删除了某份档案
//   /<体系>/api/...、/api/layout/...       → 只属于这个体系的设置，不用通知
//   其它 /api/...（档案库、加密、字段、标签、导入……）→ 变化面太广，其它体系切过去时整页重新加载
function notifyAfterWrite(url, options, payload) {
    if (!EMBEDDED) return;
    const method = String(options.method || "GET").toUpperCase();
    if (method === "GET") return;
    const path = new URL(url, location.href).pathname;
    if (!path.startsWith("/api/") || path.startsWith("/api/layout/")) return;
    let body = {};
    try { body = JSON.parse(options.body || "{}"); } catch (_) { body = {}; }
    if (path === "/api/session") {
        if ("last_profile_id" in body) notifyOthers({kind: "profile", library: state.library, id: body.last_profile_id || null});
        if (body.profile_sort) notifyOthers({kind: "sort", library: state.library, ...body.profile_sort});
        return;
    }
    if (path === "/api/appearance") {
        notifyOthers({kind: "appearance", data: payload.data || body});
        return;
    }
    const match = /^\/api\/profiles(?:\/(\d+))?$/.exec(path);
    if (match) {
        const id = match[1] ? Number(match[1]) : Number(payload.data?.id) || null;
        notifyOthers({kind: "profile-changed", library: state.library, id, deleted: method === "DELETE"});
        return;
    }
    notifyOthers({kind: "reload"});
}

// 隐藏期间攒下的消息
const pendingSync = {reload: false, profile: undefined, sort: null, appearance: null, changed: new Map()};
let pendingUnlockInfo = null;      // 隐藏时需要弹出的解锁窗口（不在看不见的页面里弹窗、抢焦点）
let resolveInitDone;
const initDone = new Promise((resolve) => { resolveInitDone = resolve; });

function queueSync(event) {
    if (!event) return;
    if (event.kind === "reload") pendingSync.reload = true;
    else if (event.kind === "profile") pendingSync.profile = event;
    else if (event.kind === "sort") pendingSync.sort = event;
    else if (event.kind === "appearance") pendingSync.appearance = event.data;
    else if (event.kind === "profile-changed" && event.id) pendingSync.changed.set(event.id, event);
}

// 被切换到时调用：把攒下的消息一次处理掉。
async function applyPendingSync() {
    if (pendingSync.reload) {
        location.reload();             // 档案库、加密、字段等变了：整页重新加载最稳妥（这种情况很少）
        return;
    }
    if (pendingUnlockInfo) {
        const info = pendingUnlockInfo;
        pendingUnlockInfo = null;
        openUnlockDialog(info);
    }
    await initDone;
    if (!state.initialized) return;
    const {profile, sort, appearance, changed} = pendingSync;
    pendingSync.profile = undefined;
    pendingSync.sort = null;
    pendingSync.appearance = null;
    pendingSync.changed = new Map();

    if (appearance) {
        Object.assign(state.appearance, appearance);
        applyCoordFormat();
        if (state.activeProfile) renderProfileView();
    }
    if (sort && sort.library === state.library) {
        state.profileQuery.sort = sort.sort;
        state.profileQuery.order = sort.order;
        renderSortOptions();
    }
    // 要用的人：另一个体系换了人就用那个人；否则还是自己当前的人。他的档案被改过就重新读，被删了就清空。
    let targetId = state.activeProfileId;
    let reloadProfile = false;
    if (profile && profile.library === state.library && profile.id !== state.activeProfileId) {
        targetId = profile.id;
        reloadProfile = true;
    }
    const change = targetId ? changed.get(targetId) : null;
    if (change) {
        reloadProfile = true;
        if (change.deleted) targetId = null;
    }
    if (!reloadProfile) return;
    try {
        if (!targetId) {
            await useProfileForNatal(null, {save: false});
        } else {
            await useProfileForNatal(await api(`/api/profiles/${targetId}`), {save: false});
        }
    } catch (error) {
        showError(error.message);
    }
}

function bindEmbedding() {
    if (!EMBEDDED) return;
    // 顶部的体系切换：请外壳切换，不跳转。按住 Ctrl / ⌘ / Shift 或用中键时照常在新窗口打开。
    document.querySelectorAll(".system-switch a[data-system]").forEach((link) => {
        link.addEventListener("click", (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            postToShell({type: "qa-switch", system: link.dataset.system});
        });
    });
    window.addEventListener("message", (event) => {
        if (event.origin !== location.origin || event.source !== window.parent) return;
        const message = event.data || {};
        if (message.type === "qa-sync") queueSync(message.event);
        else if (message.type === "qa-activate") applyPendingSync();
    });
}

async function apiRaw(url, options = {}) {
    const response = await fetch(url, {
        headers: {"Content-Type": "application/json"},
        ...options,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
        const error = new Error(payload.error || `请求失败：HTTP ${response.status}`);
        error.status = response.status;
        error.locked = Boolean(payload.locked);
        error.payload = payload;
        // 当前档案库加密且被锁定（例如切换到了加密库，或在别的窗口点了「立即锁定」）：弹出解锁窗口。
        if (error.locked && state.initialized) openUnlockDialog(payload);
        throw error;
    }
    notifyAfterWrite(url, options, payload);
    return payload;
}

async function api(url, options = {}) {
    return (await apiRaw(url, options)).data;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function localDateTimeString(date = new Date()) {
    return [
        date.getFullYear(), "-", pad2(date.getMonth() + 1), "-", pad2(date.getDate()),
        " ", pad2(date.getHours()), ":", pad2(date.getMinutes()), ":", pad2(date.getSeconds()),
    ].join("");
}

function timezoneOffsetString(date = new Date()) {
    const totalMinutes = -date.getTimezoneOffset();
    const sign = totalMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(totalMinutes);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// ---------- 行星名称（过境卡片的日主星、时主星等共用） ----------

const PLANET_NAMES = {
    Su: "太阳", Mo: "月亮", Me: "水星", Ve: "金星", Ma: "火星", Ju: "木星", Sa: "土星",
    Ur: "天王星", Ne: "海王星", Pl: "冥王星", Ra: "罗睺", Ke: "计都",
};

function planetLabel(code) {
    return PLANET_NAMES[code] ? `${code} ${PLANET_NAMES[code]}` : code;
}

// values 里的每一项既可以是字符串，也可以是 {value, label}。
function fillSelect(selectElement, values) {
    selectElement.innerHTML = "";
    for (const entry of values) {
        const isObject = entry !== null && typeof entry === "object";
        const option = document.createElement("option");
        option.value = isObject ? entry.value : entry;
        option.textContent = isObject ? (entry.label ?? entry.value) : entry;
        selectElement.appendChild(option);
    }
}

// 设置下拉菜单的值；如果 settings.json 里写的值不在选项里（例如手改过），
// 临时补一个选项，避免下拉菜单悄悄变成空白、又悄悄用另一个值去计算。
function setSelectValue(selectElement, value) {
    const text = String(value ?? "");
    const exists = Array.from(selectElement.options).some((o) => o.value === text);
    if (!exists && text !== "") {
        const option = document.createElement("option");
        option.value = text;
        option.textContent = `${text}（不在预设列表中）`;
        selectElement.appendChild(option);
    }
    selectElement.value = text;
}

function setFormFromDefaults() {
    const birth = state.settings.birth_defaults;
    const calc = state.settings.calculation_defaults;

    $("calendar").value = birth.calendar || "g";

    $("eclipticMode").value = calc.ecliptic_mode;
    setSelectValue($("ayanamshaMode"), calc.ayanamsha_mode);
    $("nodeMode").value = calc.node_mode;
    $("houseSystem").value = calc.house_system;
    updateAyanamshaState();
    SYSTEM.applyDefaults(calc);
}

// 计算设置里共有的四项一改就写回 settings.json（各体系分开保存），下次打开页面沿用上一次的设置。
const CALC_DEFAULT_FIELDS = {eclipticMode: "ecliptic_mode", ayanamshaMode: "ayanamsha_mode", houseSystem: "house_system", nodeMode: "node_mode"};

function bindCalcDefaults() {
    for (const [id, key] of Object.entries(CALC_DEFAULT_FIELDS)) {
        $(id).addEventListener("change", async () => {
            try {
                state.settings.calculation_defaults = await api(systemApi("/calc-defaults"), {
                    method: "POST", body: JSON.stringify({[key]: $(id).value}),
                });
            } catch (error) {
                showError(`计算设置没能保存：${error.message}`);
            }
        });
    }
}

// 岁差只在恒星黄道（Sidereal）下参与计算；回归黄道时禁用，免得让人以为它在起作用。
function updateAyanamshaState() {
    const sidereal = $("eclipticMode").value === "sidereal";
    $("ayanamshaMode").disabled = !sidereal;
    $("ayanamshaMode").title = sidereal ? "" : "回归黄道（Tropical）不使用岁差";
}

function formComplete() {
    return Boolean(
        getLocalTime() &&
        $("timezone").value.trim() &&
        $("latitude").value !== "" &&
        $("longitude").value !== ""
    );
}

// input = null：用左侧表单；否则用某张盘保存的输入（readForm 的格式），
// 例如 Gochara 盘左侧显示过境的表单，同时还要在后台按档案算本命盘。
function collectPayload(input = null) {
    return {
        birth: input ? birthFromInput(input) : {
            local_time_str: getLocalTime(),
            timezone_str: $("timezone").value.trim(),
            latitude: Number($("latitude").value),
            longitude: Number($("longitude").value),
            calendar: $("calendar").value,
        },
        options: {
            ecliptic_mode: $("eclipticMode").value,
            ayanamsha_mode: $("ayanamshaMode").value,
            node_mode: $("nodeMode").value,
            house_system: $("houseSystem").value,
            sunrise_rsmi: state.settings.calculation_defaults.sunrise_rsmi,
            ...SYSTEM.collectOptions(),
        },
    };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatValue(value) {
    if (value === null || value === undefined) return "";

    // 全是简单值的数组（如 [1, 5, 9]、["Ju", "Sa"]）显示为「1, 5, 9」，不带方括号；
    // 空数组显示「—」。数据本身仍是原样的列表，只改显示。
    if (
        Array.isArray(value) &&
        value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
    ) {
        return value.length ? escapeHtml(value.join(", ")) : "—";
    }

    if (typeof value === "object") {
        return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
    }
    return escapeHtml(String(value));
}

// 键值表（两列：名称、值）的 HTML。
function keyValueHtml(obj) {
    if (!obj || Object.keys(obj).length === 0) return "<p class='muted'>无数据</p>";
    let html = "<div class='table-wrap'><table><thead><tr><th>名称</th><th>值</th></tr></thead><tbody>";
    for (const [key, value] of Object.entries(obj)) {
        html += `<tr><th>${escapeHtml(key)}</th><td>${formatValue(value)}</td></tr>`;
    }
    return html + "</tbody></table></div>";
}

function renderKeyValue(target, obj) {
    $(target).innerHTML = keyValueHtml(obj);
}

// 表格里这几列固定排在最前面、按这个顺序；其余的列（如 mag、formula、sect）排在后面，彼此保持原有顺序。
const COLUMN_ORDER = ["lon", "lat", "ra", "dec", "speed"];

function orderColumns(columns) {
    const rank = (name) => {
        const index = COLUMN_ORDER.indexOf(name);
        return index === -1 ? COLUMN_ORDER.length : index;
    };
    return [...columns].sort((a, b) => rank(a) - rank(b));
}

// {名称: {列: 值}} 的表格 HTML；值不是对象时退回键值表。
function objectMapHtml(obj) {
    if (!obj || Object.keys(obj).length === 0) return "<p class='muted'>无数据</p>";
    const first = Object.values(obj)[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) return keyValueHtml(obj);

    const columns = new Set();
    Object.values(obj).forEach((row) => {
        Object.keys(row || {}).forEach((key) => columns.add(key));
    });
    const cols = orderColumns(Array.from(columns));
    let html = "<div class='table-wrap'><table><thead><tr><th>名称</th>";
    html += cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    html += "</tr></thead><tbody>";
    for (const [name, row] of Object.entries(obj)) {
        html += `<tr><th>${escapeHtml(name)}</th>`;
        for (const col of cols) html += `<td>${formatValue(row?.[col])}</td>`;
        html += "</tr>";
    }
    return html + "</tbody></table></div>";
}

function renderObjectMap(target, obj) {
    $(target).innerHTML = objectMapHtml(obj);
}

// 列表表格：columns = [{key, label, cls?}]，rows = [{key: 值}]。
// 单元格的值可以是字符串，也可以是 {text, html, cls}。结果表不带鼠标悬停说明。
function rowsTableHtml(columns, rows, {nameKey = "name"} = {}) {
    if (!rows || !rows.length) return "<p class='muted'>无数据</p>";
    let html = "<div class='table-wrap'><table class='info-table'><thead><tr>";
    html += columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    html += "</tr></thead><tbody>";
    for (const row of rows) {
        html += "<tr>";
        for (const c of columns) {
            const v = row[c.key];
            const cell = v !== null && typeof v === "object" ? v : {text: v};
            // null / undefined 显示「—」（没有这一项）；空字符串显示为空白。
            const text = cell.text === null || cell.text === undefined ? "—" : String(cell.text);
            const tag = c.key === nameKey ? "th" : "td";
            const cls = [c.cls, cell.cls].filter(Boolean).join(" ");
            html += `<${tag}${cls ? ` class="${cls}"` : ""}>${cell.html ?? escapeHtml(text)}</${tag}>`;
        }
        html += "</tr>";
    }
    return html + "</tbody></table></div>";
}

// ---------- 值日星 · 行星时：只放关键信息，合成一张表 ----------

// 后端给的 ISO 时间（2026-10-19T06:12:34.567+08:00）→ 当地「2026-10-19 06:12:34」，不经过 Date，不受浏览器时区影响。
function localTimeText(iso) {
    const m = /^(-?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(iso || ""));
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(iso || "—");
}

function renderSunTable(container, results) {
    const sun = results.sun_events;
    const day = results.day_lord_result;
    const hour = results.planetary_hour_data;
    if (!sun || !day || !hour) {
        container.innerHTML = "";
        return;
    }
    const rows = [
        {name: "值日星", value: {html: SYSTEM.planetName(day.day_lord)}},
        {name: "行星时主星", value: {html: SYSTEM.planetName(hour.planetary_hour_lord)}},
        {name: "日出", value: localTimeText(sun.sunrise_local)},
        {name: "日落", value: localTimeText(sun.sunset_local)},
        {name: "次日日出", value: sun.next_sunrise_local ? localTimeText(sun.next_sunrise_local) : "—"},
        {name: "第几个行星时", value: String(hour.hour_number)},
        {name: "行星时起止", value: `${localTimeText(hour.hour_start).slice(11)} – ${localTimeText(hour.hour_end).slice(11)}`},
    ];
    container.innerHTML = rowsTableHtml([{key: "name", label: "名称"}, {key: "value", label: "值"}], rows);
}

// ---------- 结果表共用的格式 ----------

// "house 7" / 7 → "第 7 宫"
function houseName(key) {
    const n = String(key).match(/\d+/);
    return n ? `第 ${Number(n[0])} 宫` : String(key);
}

// 速度：保留 4 位小数，单位 °/日（速度是唯一不换成度分秒的数值）。
function speedText(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
    const text = Number(v).toFixed(4);
    return `${/^-0\.0+$/.test(text) ? text.slice(1) : text}°/日`;
}

function renderAllResults() {
    renderChart();

    // 行星、宫位两页由体系决定怎么画（默认是原始参数表）。
    SYSTEM.renderPlanetTab($("planetResult"), state.results);
    SYSTEM.renderHouseTab($("houseResult"), state.results);
    SYSTEM.renderSunTab($("sunResult"), state.results);

    SYSTEM.renderResults();
}

// ---------- 星盘与外观 ----------

function renderChart() {
    const view = state.view;
    const box = $("chartBox");
    const derived = SYSTEM.derivedViews[view];
    const needsNatal = view !== "transit";
    const emptyText = needsNatal && !state.activeProfile ? "选择人物后显示本命盘" : "排盘后显示星盘";
    if (!derived) {
        const base = state.charts[chartKind()].results;
        SYSTEM.renderChart(box, base, {emptyText, view});
        return;
    }
    // 分盘都从本命盘换算；form 为 transit 的分盘（如 Gochara）另外还要过境盘。
    const base = state.charts.natal.results;
    const transit = derived.form === "transit" ? state.charts.transit.results : undefined;
    if (!base || transit === null) {
        SYSTEM.renderChart(box, null, {emptyText, view});
        return;
    }
    const entry = derivedEntry(view, base, transit);
    if (entry.results) {
        SYSTEM.renderChart(box, entry.results, {emptyText, view});
    } else {
        box.innerHTML = "";
        const p = document.createElement("p");
        p.className = "chart-empty";
        p.textContent = entry.error ? `这张分盘算不出来：${entry.error}` : "计算中…";
        box.appendChild(p);
        if (entry.error) entry.errorShown = true;
    }
}


// 外观设置一改就生效，并在后台写回 settings.json；写失败只提示，不影响当前页面。
async function saveAppearance(changes) {
    Object.assign(state.appearance, changes);
    try {
        await api("/api/appearance", {method: "POST", body: JSON.stringify(changes)});
    } catch (error) {
        showError(`外观设置没能保存：${error.message}`);
    }
}

// ---------- 折叠栏：记住每个折叠栏的开 / 合（只存在这台电脑的浏览器里） ----------

function bindFolds() {
    document.querySelectorAll("details.fold[id]").forEach((fold) => {
        const key = `quant-astro.fold.${fold.id}`;
        try {
            const saved = localStorage.getItem(key);
            if (saved !== null) fold.open = saved === "1";
        } catch (_) {}
        fold.addEventListener("toggle", () => {
            try {
                localStorage.setItem(key, fold.open ? "1" : "0");
            } catch (_) {}
        });
    });
}

// ---------- 结果区：标签页切换 ----------

function activateTab(button) {
    document.querySelectorAll("#resultTabs [data-tab]").forEach((b) => {
        const active = b === button;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
        $(b.dataset.tab).classList.toggle("hidden", !active);
    });
}

function bindResultTabs() {
    applyTabOrder();
    document.querySelectorAll("#resultTabs [data-tab]").forEach((button) => {
        button.setAttribute("aria-selected", String(button.classList.contains("active")));
        button.addEventListener("click", () => activateTab(button));
    });
}

// ---------- 结果区标签页的顺序 ----------
// 不能在标签栏上直接拖（防止误触）：在「计算设置 → 工具 → 结果标签页顺序」的浮窗里调整，
// 点「完成」才生效，顺序写回 settings.json（layout.tab_order，每个体系各一份）。

function tabButtons() {
    return [...$("resultTabs").querySelectorAll("[data-tab]")];
}

function defaultTabOrder() {
    return state.defaultTabOrder || tabButtons().map((b) => b.dataset.tab);
}

// 按保存的顺序重排标签页按钮；保存的列表里没有的标签页（例如体系新增的）按默认先后排在后面。
function applyTabOrder(order = null) {
    const bar = $("resultTabs");
    if (!state.defaultTabOrder) state.defaultTabOrder = tabButtons().map((b) => b.dataset.tab);
    const saved = order || state.settings.layout?.tab_order?.[state.system.id] || [];
    const byId = new Map(tabButtons().map((b) => [b.dataset.tab, b]));
    const ids = [...saved.filter((id) => byId.has(id)), ...defaultTabOrder().filter((id) => !saved.includes(id))];
    ids.forEach((id) => bar.appendChild(byId.get(id)));
}

let tabOrderDraft = null;

function openTabOrderDialog() {
    tabOrderDraft = tabButtons().map((b) => b.dataset.tab);
    renderTabOrderDialog();
    openDialog("tabOrderDialog");
}

function tabLabel(id) {
    const button = $("resultTabs").querySelector(`[data-tab="${CSS.escape(id)}"]`);
    return {text: button?.textContent.trim() || id, hidden: Boolean(button?.classList.contains("hidden"))};
}

function renderTabOrderDialog(focusId = null) {
    const list = $("tabOrderList");
    list.innerHTML = "";
    tabOrderDraft.forEach((id, index) => {
        const {text, hidden} = tabLabel(id);
        const row = document.createElement("div");
        row.className = "order-row";
        row.dataset.id = id;
        row.innerHTML = `
            <button type="button" class="drag-handle" aria-label="拖动调整「${escapeHtml(text)}」的位置">⠿</button>
            <span class="order-index">${index + 1}</span>
            <span class="order-name">${escapeHtml(text)}${hidden ? "<span class='muted'>（隐藏）</span>" : ""}</span>
            <button type="button" class="icon-btn small" data-move="-1" aria-label="上移" ${index === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="icon-btn small" data-move="1" aria-label="下移" ${index === tabOrderDraft.length - 1 ? "disabled" : ""}>↓</button>`;
        row.querySelectorAll("[data-move]").forEach((button) => {
            button.addEventListener("click", () => moveTabInDraft(index, Number(button.dataset.move)));
        });
        bindOrderDrag(row.querySelector(".drag-handle"), row);
        list.appendChild(row);
    });
    if (focusId) list.querySelector(`[data-id="${CSS.escape(focusId)}"] .drag-handle`)?.focus();
}

function moveTabInDraft(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= tabOrderDraft.length) return;
    const [id] = tabOrderDraft.splice(index, 1);
    tabOrderDraft.splice(target, 0, id);
    renderTabOrderDialog(id);
}

// 浮窗里的拖动：拖把手上下移动；也可以选中把手后按 ↑ ↓。
function bindOrderDrag(handle, row) {
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const list = row.parentElement;
        row.classList.add("dragging");
        const move = (e) => {
            const others = [...list.querySelectorAll(".order-row:not(.dragging)")];
            const before = others.find((el) => {
                const r = el.getBoundingClientRect();
                return e.clientY < r.top + r.height / 2;
            });
            if (before) {
                if (row.nextElementSibling !== before) list.insertBefore(row, before);
            } else if (list.lastElementChild !== row) {
                list.appendChild(row);
            }
        };
        const end = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", end);
            document.removeEventListener("pointercancel", end);
            row.classList.remove("dragging");
            tabOrderDraft = [...list.querySelectorAll(".order-row")].map((el) => el.dataset.id);
            renderTabOrderDialog(row.dataset.id);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", end);
        document.addEventListener("pointercancel", end);
    });
    handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        moveTabInDraft(tabOrderDraft.indexOf(row.dataset.id), event.key === "ArrowUp" ? -1 : 1);
    });
}

async function finishTabOrder() {
    const order = [...tabOrderDraft];
    try {
        await api("/api/layout/tab-order", {method: "POST", body: JSON.stringify({system: state.system.id, order})});
        state.settings.layout = state.settings.layout || {tab_order: {}};
        state.settings.layout.tab_order = {...(state.settings.layout.tab_order || {}), [state.system.id]: order};
        applyTabOrder(order);
        closeDialog("tabOrderDialog");
        setStatus("标签页顺序已保存");
    } catch (error) {
        showError(`标签页顺序没能保存：${error.message}`);
    }
}

function bindTabOrderDialog() {
    $("openTabOrderBtn").addEventListener("click", openTabOrderDialog);
    $("tabOrderDoneBtn").addEventListener("click", finishTabOrder);
    $("tabOrderResetBtn").addEventListener("click", () => {
        tabOrderDraft = [...defaultTabOrder()];
        renderTabOrderDialog();
    });
}

// ---------- 原始参数：以浮窗查看后端传回的全部原始数据（用来核对、校正计算代码） ----------

function baseRawSections(results) {
    const house = results.house_result || {};
    const houseInfo = Object.fromEntries(Object.entries(house).filter(([, v]) => v === null || typeof v !== "object"));
    return [
        {key: "planets", title: "行星", tables: [{title: "", data: results.planet_pos}]},
        {key: "houses", title: "宫位", tables: [
            {title: "宫位计算", data: houseInfo},
            {title: "十二宫宫头", data: house.houses},
            {title: "四轴", data: house.axes},
            ...(house.extra ? [{title: "附加点", data: house.extra}] : []),
        ]},
        {key: "sun", title: "值日星 · 行星时", tables: [
            {title: "日出日落（sun_events）", data: results.sun_events},
            {title: "值日星（day_lord_result）", data: results.day_lord_result},
            {title: "行星时（planetary_hour_data）", data: results.planetary_hour_data},
        ]},
    ];
}

let rawView = "planets";

function rawSectionsNow() {
    const results = state.charts[resultsKind()].results;
    if (!results) return [];
    return SYSTEM.rawSections(results).filter((sec) => sec.tables.some((t) => t.data && Object.keys(t.data).length));
}

function openRawDialog() {
    const sections = rawSectionsNow();
    $("rawTitleMeta").textContent = sections.length
        ? `${resultsKind() === "transit" ? "过境盘" : "本命盘"} · ${localTimeText(state.charts[resultsKind()].results.context?.local_dt)}`
        : "";
    if (!sections.some((s) => s.key === rawView)) rawView = sections[0]?.key || "planets";
    renderRawDialog(sections);
    openDialog("rawDialog");
}

function renderRawDialog(sections = rawSectionsNow()) {
    const tabs = $("rawTabs");
    const body = $("rawBody");
    if (!sections.length) {
        tabs.innerHTML = "";
        body.innerHTML = "<p class='muted'>还没有排盘结果。先排盘，再打开这里查看原始参数。</p>";
        return;
    }
    tabs.innerHTML = sections.map((sec) => `
        <label><input type="radio" name="rawView" value="${escapeHtml(sec.key)}" ${sec.key === rawView ? "checked" : ""}>
        <span>${escapeHtml(sec.title)}</span></label>`).join("");
    tabs.querySelectorAll("input").forEach((radio) => radio.addEventListener("change", () => {
        rawView = radio.value;
        renderRawDialog(sections);
    }));
    const section = sections.find((s) => s.key === rawView);
    body.innerHTML = section.tables
        .filter((t) => t.data && Object.keys(t.data).length)
        .map((t) => `${t.title ? `<h3 class="raw-title">${escapeHtml(t.title)}</h3>` : ""}${objectMapHtml(t.data)}`)
        .join("");
}

async function copyRawJson() {
    const sections = rawSectionsNow();
    const section = sections.find((s) => s.key === rawView);
    if (!section) return;
    const payload = Object.fromEntries(section.tables.filter((t) => t.data).map((t, i) => [t.title || `table${i + 1}`, t.data]));
    const text = JSON.stringify(payload, null, 2);
    try {
        await navigator.clipboard.writeText(text);
        showNotice(`已复制「${section.title}」的 JSON。`);
    } catch (_) {
        // 剪贴板不可用（例如非安全上下文）：退回选中文本的办法。
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        showNotice(`已复制「${section.title}」的 JSON。`);
    }
}

function bindRawDialog() {
    $("openRawBtn").addEventListener("click", openRawDialog);
    $("rawCopyBtn").addEventListener("click", copyRawJson);
}

// ---------- 导出 / 导入设置 ----------
// 导出：两个体系的计算设置、星体配置、相位、古典设置、外观、标签页顺序等，存成一个 JSON 文件，
// 交给别的项目组或另一台电脑导入后即可沿用。不含服务器地址和档案数据。

function bindSettingsTransfer() {
    $("openTransferBtn").addEventListener("click", () => openDialog("transferDialog"));
    $("exportSettingsBtn").addEventListener("click", () => {
        closeDialog("transferDialog");
        window.location.href = "/api/settings/export";
    });
    $("importSettingsBtn").addEventListener("click", () => $("importSettingsFile").click());
    $("importSettingsFile").addEventListener("change", async (event) => {
        const file = event.target.files[0];
        event.target.value = "";
        if (!file) return;
        if (!confirm(`导入「${file.name}」？\n\n文件里包含的各项设置会替换当前设置（两个体系都适用），档案数据不受影响。导入后页面会重新载入。`)) return;
        const form = new FormData();
        form.append("file", file);
        try {
            const response = await fetch("/api/settings/import", {method: "POST", body: form});
            const payload = await response.json();
            if (!response.ok || !payload.ok) throw new Error(payload.error || `导入失败：HTTP ${response.status}`);
            location.reload();
        } catch (error) {
            showError(error.message);
        }
    });
}

// 体系决定自己的标签页显示与否（例如关掉的模块、没勾选任何一项的类别）；
// 如果当前正看着一个被隐藏的标签页，切到第一个可见的标签页。
function updateTabVisibility() {
    const buttons = Array.from(document.querySelectorAll("#resultTabs [data-tab]"));
    for (const b of buttons) {
        const visible = SYSTEM.tabVisible(b);
        if (typeof visible === "boolean") b.classList.toggle("hidden", !visible);
    }
    const active = buttons.find((b) => b.classList.contains("active"));
    if (!active || active.classList.contains("hidden")) {
        activateTab(buttons.find((b) => !b.classList.contains("hidden")));
    }
}

// 排盘：计算左侧表单对应的那张盘（本命 / 分盘 → 本命盘；过境、Gochara → 过境盘）。
async function calculateFull() {
    const kind = chartKind();
    if (kind === "natal" && !state.activeProfile) {
        showError("本命盘只能从人物档案起盘：请先点「选择人物…」。");
        setStatus("未选择人物");
        return;
    }
    if (!formComplete()) {
        const {message} = validateDateTime();
        showError(getLocalTime() ? "请先填写完整的时区、纬度、经度。" : `本地日期时间不完整或不合法：${message}`);
        setStatus("参数不完整");
        return;
    }

    await calculateChart(kind, collectPayload(), readForm());
}

// 真正发请求的部分。每张盘各自计数：同时算本命和过境（Gochara）时，互不作废对方的结果。
async function calculateChart(kind, payload, input) {
    const chart = state.charts[kind];
    const token = chart.token = (chart.token || 0) + 1;
    clearPageError();
    setStatus("计算中");

    try {
        const result = await api(systemApi("/chart/full"), {
            method: "POST",
            body: JSON.stringify(payload),
        });

        if (token !== chart.token) return;

        chart.results = result;
        chart.input = input;
        chart.payload = payload;
        chart.signature = JSON.stringify(payload.options);
        SYSTEM.afterCalculate(kind, result);
        SYSTEM.onNewChart();             // 新的一张盘：例如清掉上一张盘里的选中高亮
        renderView();
        setStatus("已更新");
    } catch (error) {
        if (token !== chart.token) return;
        showError(error.message);
        setStatus("计算失败");
    }
}

// 不在左侧表单里的那张盘（Gochara 时的本命盘）：用它自己保存的输入在后台计算。
async function calculateStored(kind) {
    const input = state.charts[kind].input;
    if (!input) return;
    await calculateChart(kind, collectPayload(input), input);
}

function birthFromInput(input) {
    const nums = Object.fromEntries(DT_PARTS.map((p, i) => [p, Number(input.parts?.[i])]));
    return {
        local_time_str: formatDtParts(nums),
        timezone_str: String(input.timezone || "").trim(),
        latitude: Number(input.latitude),
        longitude: Number(input.longitude),
        calendar: input.calendar === "j" ? "j" : "g",
    };
}

// 改完参数需要点「排盘」才会重新计算（全量计算只需几毫秒，不做局部增量计算）。
// 在日期时间框里按回车、点时间步进按钮，也会直接排盘。
function bindCalcButton() {
    $("calcBtn").addEventListener("click", () => {
        calculateFull();
    });
}

// ================= 本地日期时间：分段输入 =================
// 年 / 月 / 日 / 时 / 分 / 秒 各是一个小输入框：
// - 只能输入数字；年最多 4 位，其余最多 2 位；秒可以再带最多 3 位小数（如 05.25），多出的位数四舍五入；
// - 一格填满（或第一位数字已经不可能再接第二位，比如月份输入 5）就自动跳到下一格；
// - 点进某一格会全选，直接敲数字即可覆盖；
// - 在空格里按退格回到上一格；← → 在格子之间移动；↑ ↓ 加减当前这一格；
// - 输入 - / . : 空格 会补齐两位并跳到下一格；
// - 可以把「1990-05-12 08:30:00」整段粘贴进任何一格；
// - 按回车直接排盘。

const DT_PARTS = ["year", "month", "day", "hour", "minute", "second"];
const DT_LEN = {year: 4, month: 2, day: 2, hour: 2, minute: 2, second: 2};   // 秒：整数部分的位数（另可带 3 位小数）
const SECOND_DECIMALS = 3;
const DT_RANGE = {year: [1, 9999], month: [1, 12], hour: [0, 23], minute: [0, 59], second: [0, 59]};
// 第一位数字大于它，就不可能再有第二位，直接补零跳格。
const DT_FIRST_DIGIT_MAX = {month: 1, day: 3, hour: 2, minute: 5, second: 5};
const DT_NAMES = {year: "年", month: "月", day: "日", hour: "时", minute: "分", second: "秒"};
const DT_TEXT_RE = /^\s*(\d{1,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2}(?:\.\d+)?)秒?)?)?\s*$/;

// 秒（可以带小数）→ 「SS」或「SS.sss」：四舍五入到 3 位小数，去掉末尾的 0（05.500 写成 05.5）。
// 进位到 60 时记成 59.999，不往分钟进位：差别不到 1 毫秒。后端（core.py、db.py）用同一个规则。
function formatSecondPart(sec) {
    const totalMs = Math.min(59999, Math.max(0, Math.round(Number(sec) * 1000)));
    const whole = Math.floor(totalMs / 1000);
    const ms = totalMs - whole * 1000;
    return String(whole).padStart(2, "0") + (ms ? `.${String(ms).padStart(3, "0").replace(/0+$/, "")}` : "");
}

// 本地日期时间有两份一模一样的输入框：顶栏一份（#localTime，计算都读它），设置抽屉里一份（#localTimeDrawer）。
// 在哪一份里输入都可以，改完立刻同步到另一份。
function dtInput(part, group = $("localTime")) {
    return group.querySelector(`[data-part='${part}']`);
}

function dtGroups() {
    return [$("localTime"), $("localTimeDrawer")].filter(Boolean);
}

// 把 from 这一份的内容（和标红）抄到另一份。
function mirrorDt(from = $("localTime")) {
    for (const g of dtGroups()) {
        if (g === from) continue;
        for (const p of DT_PARTS) {
            const src = dtInput(p, from), dst = dtInput(p, g);
            if (dst.value !== src.value) dst.value = src.value;
            dst.classList.toggle("invalid", src.classList.contains("invalid"));
        }
    }
}

// 正在输入的是哪一份（焦点在哪一份里）；都不在时是顶栏那份。
function focusedDtGroup() {
    return dtGroups().find((g) => g.contains(document.activeElement)) || $("localTime");
}

function isLeapYear(year, calendar) {
    if (calendar === "j") return year % 4 === 0;
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month, calendar) {
    if (month === 2) return isLeapYear(year, calendar) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function currentCalendar() {
    return $("calendar").value === "j" ? "j" : "g";
}

function readDtParts() {
    const parts = {};
    for (const p of DT_PARTS) {
        const text = dtInput(p).value.trim();
        parts[p] = text === "" ? NaN : Number(text);
    }
    return parts;
}

// 检查整个日期时间；返回 {ok, parts, message}，并给不合法的格子标红。
function validateDateTime({mark = true, source = null} = {}) {
    mirrorDt(source || focusedDtGroup());
    const parts = readDtParts();
    const bad = new Set();
    let message = "";
    for (const p of DT_PARTS) {
        if (Number.isNaN(parts[p])) {
            bad.add(p);
            message = message || `请填写${DT_NAMES[p]}。`;
            continue;
        }
        if (p === "second") {
            if (!(parts.second >= 0 && parts.second < 60)) {
                bad.add(p);
                message = message || "秒应在 0–59.999 之间。";
            }
            continue;
        }
        const range = DT_RANGE[p];
        if (range && (parts[p] < range[0] || parts[p] > range[1])) {
            bad.add(p);
            message = message || `${DT_NAMES[p]}应在 ${range[0]}–${range[1]} 之间。`;
        }
    }
    if (!bad.has("year") && !bad.has("month") && !Number.isNaN(parts.day)) {
        const dim = daysInMonth(parts.year, parts.month, currentCalendar());
        if (parts.day < 1 || parts.day > dim) {
            bad.add("day");
            const cal = currentCalendar() === "j" ? "儒略历" : "格里历";
            message = message || `${cal} ${parts.year} 年 ${parts.month} 月只有 ${dim} 天。`;
        }
    }
    if (mark) {
        for (const g of dtGroups()) {
            for (const p of DT_PARTS) dtInput(p, g).classList.toggle("invalid", bad.has(p) && dtInput(p, g).value !== "");
        }
        const hint = bad.size && DT_PARTS.some((p) => dtInput(p).value !== "") ? message : "";
        $("localTimeHint").textContent = hint;
        if ($("localTimeHintDrawer")) $("localTimeHintDrawer").textContent = hint;
    }
    return {ok: bad.size === 0, parts, message};
}

function formatDtParts(parts) {
    const p2 = (n) => String(n).padStart(2, "0");
    return `${String(parts.year).padStart(4, "0")}-${p2(parts.month)}-${p2(parts.day)} ` +
        `${p2(parts.hour)}:${p2(parts.minute)}:${formatSecondPart(parts.second)}`;
}

// 合法时返回「YYYY-MM-DD HH:MM:SS」（秒可带最多 3 位小数），否则返回空字符串。
function getLocalTime() {
    const {ok, parts} = validateDateTime({mark: false});
    return ok ? formatDtParts(parts) : "";
}

// 写入日期时间。keepStep = true 只在时间步进时使用：保留「相对起点」的偏移显示。
function setLocalTime(text, {keepStep = false} = {}) {
    const match = DT_TEXT_RE.exec(String(text ?? "").replace("T", " "));
    if (!match) return false;
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = match;
    const values = {year: y, month: mo, day: d, hour: h, minute: mi, second: s};
    for (const p of DT_PARTS) {
        dtInput(p).value = p === "year" ? values[p].padStart(4, "0")
            : p === "second" ? formatSecondPart(values[p]) : values[p].padStart(2, "0");
    }
    validateDateTime({source: $("localTime")});
    if (!keepStep) resetStepBase();
    return true;
}

function focusDtPart(index, group = $("localTime")) {
    const input = dtInput(DT_PARTS[Math.max(0, Math.min(DT_PARTS.length - 1, index))], group);
    input.focus();
    input.select();
}

// 离开一格时补零：月日时分秒补到 2 位，年补到 4 位；秒的小数部分整理成最多 3 位（5. 写成 05）。
function padDtPart(part, group = $("localTime")) {
    const input = dtInput(part, group);
    if (input.value === "") return;
    if (part === "second") {
        const value = Number(input.value);
        if (Number.isFinite(value) && value < 60) input.value = formatSecondPart(value);
        return;
    }
    input.value = input.value.padStart(DT_LEN[part], "0");
}

// 秒这一格只留数字和一个小数点：整数部分最多 2 位，小数最多 3 位。
function cleanSecondText(text) {
    const cleaned = String(text).replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    const [whole, frac] = cleaned.split(".");
    return frac === undefined ? whole.slice(0, DT_LEN.second)
        : `${whole.slice(0, DT_LEN.second)}.${frac.slice(0, SECOND_DECIMALS)}`;
}

// 秒这一格已经填满（没有小数时 2 位整数；有小数时 3 位小数）：再敲数字就从头输入。
function secondFull(text) {
    const [whole, frac] = String(text).split(".");
    return frac === undefined ? whole.length >= DT_LEN.second : frac.length >= SECOND_DECIMALS;
}

// ↑ ↓：只改这一格（循环），不进位；日期会限制在当月天数以内。
function nudgeDtPart(part, delta, group = $("localTime")) {
    mirrorDt(group);
    const parts = readDtParts();
    let value = Number.isNaN(parts[part]) ? (DT_RANGE[part]?.[0] ?? 1) : parts[part] + delta;
    let [lo, hi] = DT_RANGE[part] || [1, 31];
    if (part === "day") {
        const y = Number.isNaN(parts.year) ? 2000 : parts.year;
        const m = Number.isNaN(parts.month) ? 1 : Math.min(12, Math.max(1, parts.month));
        hi = daysInMonth(y, m, currentCalendar());
    }
    if (part === "second") {
        // 秒：整数部分加减，保留小数；超出 0–59 循环。
        if (value >= 60) value -= 60;
        if (value < 0) value += 60;
        dtInput(part, group).value = formatSecondPart(value);
        dtInput(part, group).select();
        resetStepBase();
        validateDateTime({source: group});
        return;
    }
    if (value > hi) value = lo;
    if (value < lo) value = hi;
    dtInput(part, group).value = String(value).padStart(DT_LEN[part], "0");
    dtInput(part, group).select();
    resetStepBase();
    validateDateTime({source: group});
}

// ================= 经纬度：十进制 / 度分秒 =================
// 计算永远读 #latitude / #longitude 两个十进制输入框；度分秒是同一个值的另一种填法：
// 改度分秒 → 立刻换算写回十进制；十进制被程序改了（选人、定位、同步档案地点…）→ 度分秒跟着刷新。

const COORDS = {
    latitude: {max: 90, degLen: 2, pos: "北纬", neg: "南纬", posKeys: "nN北", negKeys: "sS南"},
    longitude: {max: 180, degLen: 3, pos: "东经", neg: "西经", posKeys: "eE东", negKeys: "wW西"},
};
const DMS_PARTS = ["d", "m", "s"];

function coordField(name) { return document.querySelector(`.coord-field[data-coord="${name}"]`); }
function dmsInput(name, part) { return coordField(name).querySelector(`[data-dms="${part}"]`); }

// 十进制度 → {neg, d, m, s}（秒保留三位小数，四舍五入后进位）。
// 十进制度保存 7 位小数（约 0.00036″），度分秒的 3 位小数换算过去再换回来不会变。
const COORD_DECIMALS = 7;
const DMS_SECOND_DECIMALS = 3;

function decToDms(value) {
    let abs = Math.abs(value);
    let d = Math.floor(abs);
    let m = Math.floor((abs - d) * 60);
    let sec = Math.round(((abs - d) * 60 - m) * 60 * 1000) / 1000;
    if (sec >= 60) { sec = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return {neg: value < 0, d, m, s: sec};
}

function formatSeconds(sec) {
    const [int, frac] = sec.toFixed(DMS_SECOND_DECIMALS).replace(/\.?0+$/, "").split(".");
    return int.padStart(2, "0") + (frac ? `.${frac}` : "");
}

// 只读显示用：31°13′48.36″ 北纬
function formatCoordDms(value, name) {
    const v = Number(value);
    if (value === "" || value == null || !Number.isFinite(v)) return "?";
    const {neg, d, m, s: sec} = decToDms(v);
    return `${COORDS[name][neg ? "neg" : "pos"]} ${d}°${String(m).padStart(2, "0")}′${formatSeconds(sec)}″`;
}

// 按当前格式显示一个坐标（编辑档案浮窗、档案资料页）：「纬度 31.23」或「北纬 31°13′48″」。
function formatCoord(value, name) {
    const label = name === "latitude" ? "纬度" : "经度";
    if (value === "" || value == null || !Number.isFinite(Number(value))) return `${label} ?`;
    return state.appearance.coord_format === "dms" ? formatCoordDms(value, name) : `${label} ${value}`;
}

// 粘贴的文字：31°13'48.3"N、N 31 13 48、北纬31度13分、-31.23、31.23S 都认。不认识返回 null。
function parseCoordText(text, name) {
    const cfg = COORDS[name];
    const raw = String(text || "").trim();
    if (!raw) return null;
    const nums = raw.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length > 3) return null;
    if ([...raw].some((ch) => /[a-zA-Z\u4e00-\u9fff]/.test(ch) && !(cfg.posKeys + cfg.negKeys + "度分秒").includes(ch))) return null;
    const [d, m = 0, sec = 0] = nums.map(Number);
    if (nums.length > 1 && (!Number.isInteger(d) || m >= 60 || sec >= 60)) return null;
    let value = d + m / 60 + sec / 3600;
    const negative = /^\s*-/.test(raw) || [...cfg.negKeys].some((k) => raw.includes(k));
    if (negative) value = -value;
    if (Math.abs(value) > cfg.max) return null;
    return Number(value.toFixed(COORD_DECIMALS));
}

let coordSyncing = false;

// 十进制 → 度分秒显示
function refreshDms(name) {
    if (coordSyncing) return;
    const field = coordField(name);
    const value = $(name).value;
    const v = Number(value);
    const hemi = field.querySelector(".hemi");
    field.querySelectorAll("[data-dms]").forEach((i) => i.classList.remove("invalid"));
    if (value === "" || !Number.isFinite(v)) {
        DMS_PARTS.forEach((p) => { dmsInput(name, p).value = ""; });
        hemi.dataset.neg = hemi.dataset.neg || "0";
    } else {
        const {neg, d, m, s: sec} = decToDms(v);
        dmsInput(name, "d").value = String(d);
        dmsInput(name, "m").value = String(m).padStart(2, "0");
        dmsInput(name, "s").value = formatSeconds(sec);
        hemi.dataset.neg = neg ? "1" : "0";
    }
    hemi.textContent = COORDS[name][hemi.dataset.neg === "1" ? "neg" : "pos"];
}

// 度分秒 → 十进制（写回隐藏的十进制框）；不合法时标红并清空十进制值，排盘时会提示未填完整。
function commitDms(name) {
    const cfg = COORDS[name];
    const field = coordField(name);
    const [dIn, mIn, sIn] = DMS_PARTS.map((p) => dmsInput(name, p));
    const neg = field.querySelector(".hemi").dataset.neg === "1";
    [dIn, mIn, sIn].forEach((i) => i.classList.remove("invalid"));

    let decimal = "";
    if ([dIn, mIn, sIn].some((i) => i.value.trim() !== "")) {
        const d = Number(dIn.value || 0), m = Number(mIn.value || 0), sec = Number(sIn.value || 0);
        const bad = [];
        if (!/^\d*$/.test(dIn.value) || d > cfg.max) bad.push(dIn);
        if (!/^\d*$/.test(mIn.value) || m >= 60) bad.push(mIn);
        if (!/^\d*(?:\.\d*)?$/.test(sIn.value) || sec >= 60) bad.push(sIn);
        if (!bad.length && d === cfg.max && (m > 0 || sec > 0)) bad.push(mIn, sIn);
        if (bad.length) {
            bad.forEach((i) => i.classList.add("invalid"));
        } else {
            const value = (d + m / 60 + sec / 3600) * (neg ? -1 : 1);
            decimal = String(Number(value.toFixed(COORD_DECIMALS)));
        }
    }
    coordSyncing = true;           // 写回十进制时不要反过来刷新正在输入的度分秒
    $(name).value = decimal;
    $(name).dispatchEvent(new Event("input", {bubbles: true}));
    coordSyncing = false;
}

function applyCoordFormat() {
    const format = state.appearance.coord_format === "dms" ? "dms" : "decimal";
    $("coordBlock").dataset.format = format;
    document.querySelectorAll("input[name='coordFormat']").forEach((r) => { r.checked = r.value === format; });
    Object.keys(COORDS).forEach(refreshDms);
}

function bindCoordInputs() {
    // 程序给十进制框赋值时（选人、定位、同步地点、切换本命 / 过境），度分秒自动跟着变。
    const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    for (const name of Object.keys(COORDS)) {
        const dec = $(name);
        Object.defineProperty(dec, "value", {
            configurable: true,
            get() { return valueProp.get.call(this); },
            set(v) { valueProp.set.call(this, v); refreshDms(name); },
        });
        dec.addEventListener("input", () => refreshDms(name));
        // 十进制框里也可以直接粘贴度分秒，自动换算。
        dec.addEventListener("paste", (event) => {
            const text = event.clipboardData?.getData("text") || "";
            if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(text)) return;
            const value = parseCoordText(text, name);
            if (value === null) return;
            event.preventDefault();
            dec.value = String(value);
        });

        const field = coordField(name);
        const hemi = field.querySelector(".hemi");
        const setHemi = (neg) => {
            hemi.dataset.neg = neg ? "1" : "0";
            hemi.textContent = COORDS[name][neg ? "neg" : "pos"];
            commitDms(name);
        };
        hemi.addEventListener("click", () => setHemi(hemi.dataset.neg !== "1"));

        DMS_PARTS.forEach((part, index) => {
            const input = dmsInput(name, part);
            const maxLen = part === "d" ? COORDS[name].degLen : part === "m" ? 2 : 2 + 1 + DMS_SECOND_DECIMALS;   // 秒：59.999
            const focusPart = (i) => { const next = dmsInput(name, DMS_PARTS[i]); next.focus(); next.select(); };

            let focusedByMouse = false;
            input.addEventListener("mousedown", () => { focusedByMouse = document.activeElement !== input; });
            input.addEventListener("mouseup", (event) => {
                if (!focusedByMouse) return;
                focusedByMouse = false;
                event.preventDefault();
                input.select();
            });
            input.addEventListener("focus", () => input.select());

            input.addEventListener("keydown", (event) => {
                const key = event.key;
                const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
                const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
                if (COORDS[name].posKeys.includes(key) || COORDS[name].negKeys.includes(key)) {
                    event.preventDefault();
                    setHemi(COORDS[name].negKeys.includes(key));
                } else if (key === "-") {
                    event.preventDefault();
                    setHemi(true);
                } else if (key === "+") {
                    event.preventDefault();
                    setHemi(false);
                } else if (key === "Enter") {
                    event.preventDefault();
                    commitDms(name);
                    calculateFull();
                } else if (key === "Backspace" && input.value === "" && index > 0) {
                    event.preventDefault();
                    focusPart(index - 1);
                } else if (key === "ArrowLeft" && atStart && index > 0) {
                    event.preventDefault();
                    focusPart(index - 1);
                } else if (key === "ArrowRight" && atEnd && index < DMS_PARTS.length - 1) {
                    event.preventDefault();
                    focusPart(index + 1);
                } else if (["°", "'", "′", "\"", "″", " ", ":", "：", "/", ","].includes(key) ||
                           (key === "." && part !== "s")) {
                    event.preventDefault();
                    if (input.value !== "" && index < DMS_PARTS.length - 1) focusPart(index + 1);
                } else if (part === "s" && /^\d$/.test(key) && input.selectionStart === input.selectionEnd &&
                           /\.\d{3}$/.test(input.value)) {
                    // 秒的小数已经有 3 位：多敲的数字不要，免得把已经填好的秒清掉。
                    event.preventDefault();
                } else if (/^\d$/.test(key) && !event.ctrlKey && !event.metaKey &&
                           input.selectionStart === input.selectionEnd && input.value.length >= maxLen) {
                    // 这一格已经填满：从头重新输入，而不是被长度卡住。
                    event.preventDefault();
                    input.value = key;
                    input.dispatchEvent(new Event("input", {bubbles: true}));
                }
            });

            input.addEventListener("input", () => {
                const cleaned = part === "s"
                    ? input.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1")
                        .replace(new RegExp(`(\\.\\d{${DMS_SECOND_DECIMALS}})\\d+$`), "$1").slice(0, maxLen)
                    : input.value.replace(/\D/g, "").slice(0, maxLen);
                if (cleaned !== input.value) input.value = cleaned;
                commitDms(name);
                if (index === DMS_PARTS.length - 1) return;
                // 填满就跳到下一格；分的第一位大于 5、经度以 2–9 开头的两位数，也已经不可能再长。
                const full = cleaned.length >= maxLen ||
                    (part === "m" && cleaned.length === 1 && Number(cleaned) > 5) ||
                    (part === "d" && name === "longitude" && cleaned.length === 2 && Number(cleaned[0]) > 1);
                if (full) focusPart(index + 1);
            });

            input.addEventListener("blur", () => {
                if (part === "m" && /^\d$/.test(input.value)) input.value = input.value.padStart(2, "0");
            });

            input.addEventListener("paste", (event) => {
                const text = event.clipboardData?.getData("text") || "";
                if (/^\d+(?:\.\d+)?$/.test(text.trim()) && !text.includes(".")) return;   // 单个整数：照常粘进这一格
                const value = parseCoordText(text, name);
                if (value === null) return;
                event.preventDefault();
                $(name).value = String(value);
                $(name).dispatchEvent(new Event("input", {bubbles: true}));
            });
        });
    }

    document.querySelectorAll("input[name='coordFormat']").forEach((radio) => {
        radio.addEventListener("change", () => {
            saveAppearance({coord_format: radio.value});
            applyCoordFormat();
            if (state.activeProfile) renderProfileView();
        });
    });
    applyCoordFormat();
}

function bindDateTimeInput() {
    dtGroups().forEach(bindDtGroup);
    $("calendar").addEventListener("change", () => {
        resetStepBase();
        validateDateTime();
    });
}

function bindDtGroup(group) {
    DT_PARTS.forEach((part, index) => {
        const input = dtInput(part, group);

        // 点进来就全选：直接敲数字覆盖，不用先删。
        // 用鼠标点进来时，浏览器会在 mouseup 时把全选改回光标，所以在 mouseup 里再选一次。
        let focusedByMouse = false;
        input.addEventListener("mousedown", () => {
            focusedByMouse = document.activeElement !== input;
        });
        input.addEventListener("mouseup", (event) => {
            if (!focusedByMouse) return;
            focusedByMouse = false;
            event.preventDefault();
            input.select();
        });
        input.addEventListener("focus", () => input.select());

        input.addEventListener("keydown", (event) => {
            const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
            const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            const full = part === "second" ? secondFull(input.value) : input.value.length >= DT_LEN[part];
            const noSelection = input.selectionStart === input.selectionEnd;
            if (part === "second" && /^\d$/.test(event.key) && noSelection && full && input.value.includes(".")) {
                // 小数已经有 3 位：多敲的数字不要，免得把已经填好的秒清掉。
                event.preventDefault();
            } else if (part === "second" && event.key === "." && !input.value.includes(".")) {
                // 秒可以带小数：小数点照常输入（空格时补成 0.）。
                if (input.value === "") {
                    event.preventDefault();
                    input.value = "0.";
                }
            } else if (/^\d$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey &&
                input.selectionStart === input.selectionEnd && full) {
                // 这一格已经填满、又没有选中文字：从头重新输入这一格，而不是被长度卡住打不进去。
                event.preventDefault();
                input.value = event.key;
                input.dispatchEvent(new Event("input", {bubbles: true}));
            } else if (event.key === "Enter") {
                event.preventDefault();
                padDtPart(part, group);
                mirrorDt(group);
                calculateFull();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                nudgeDtPart(part, event.key === "ArrowUp" ? 1 : -1, group);
            } else if (event.key === "Backspace" && input.value === "" && index > 0) {
                event.preventDefault();
                focusDtPart(index - 1, group);
            } else if (event.key === "ArrowLeft" && atStart && index > 0) {
                event.preventDefault();
                focusDtPart(index - 1, group);
            } else if (event.key === "ArrowRight" && atEnd && index < DT_PARTS.length - 1) {
                event.preventDefault();
                focusDtPart(index + 1, group);
            } else if (["-", "/", ".", ":", " ", "：", "T", "t"].includes(event.key)) {
                event.preventDefault();
                if (input.value !== "" && index < DT_PARTS.length - 1) {
                    padDtPart(part, group);
                    mirrorDt(group);
                    focusDtPart(index + 1, group);
                }
            }
        });

        input.addEventListener("input", () => {
            const digits = part === "second" ? cleanSecondText(input.value) : input.value.replace(/\D/g, "").slice(0, DT_LEN[part]);
            if (digits !== input.value) input.value = digits;
            resetStepBase();
            input.classList.remove("invalid");
            if (index !== DT_PARTS.length - 1) {
                const full = digits.length >= DT_LEN[part];
                const forced = digits.length === 1 && part in DT_FIRST_DIGIT_MAX && Number(digits) > DT_FIRST_DIGIT_MAX[part];
                if (full || forced) {
                    padDtPart(part, group);
                    focusDtPart(index + 1, group);
                }
            }
            mirrorDt(group);
        });

        input.addEventListener("paste", (event) => {
            const text = (event.clipboardData || window.clipboardData)?.getData("text") || "";
            if (DT_TEXT_RE.test(text.replace("T", " "))) {
                event.preventDefault();
                setLocalTime(text);
            }
        });

        input.addEventListener("blur", () => {
            padDtPart(part, group);
            mirrorDt(group);
            // 焦点还在这组输入框里（只是换了一格）时不报错，等离开整组再检查。
            setTimeout(() => {
                if (!group.contains(document.activeElement)) validateDateTime({source: group});
            }, 0);
        });
    });
}

// ================= 时间步进 =================
// 以当前日期时间为起点，按所选步长往前 / 往后跳，并立即排盘。
// 年 / 月按日历走（1 月 31 日 + 1 个月 = 2 月 28/29 日）；天及以下按固定时长走。
// 计算全在“当地钟表时间”上做，时区不变；儒略历时按儒略历的天数规则算。
// 「相对起点」显示从第一次步进前的那个时间算起累计偏移了多少，可以一键回到起点。

function jdnFromDate(y, m, d, calendar) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    const base = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4);
    return calendar === "j"
        ? base - 32083
        : base - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function dateFromJdn(jdn, calendar) {
    let b = 0, c;
    if (calendar === "j") {
        c = jdn + 32082;
    } else {
        const a = jdn + 32044;
        b = Math.floor((4 * a + 3) / 146097);
        c = a - Math.floor(146097 * b / 4);
    }
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor(1461 * d / 4);
    const m = Math.floor((5 * e + 2) / 153);
    return {
        day: e - Math.floor((153 * m + 2) / 5) + 1,
        month: m + 3 - 12 * Math.floor(m / 10),
        year: 100 * b + d - 4800 + Math.floor(m / 10),
    };
}

// 秒可以带小数（最多 3 位）。总秒数是十几位的数，再加小数会带来浮点尾差，所以换回年月日时分秒时
// 把秒四舍五入到毫秒。
function partsToSeconds(parts, calendar) {
    return jdnFromDate(parts.year, parts.month, parts.day, calendar) * 86400 +
        parts.hour * 3600 + parts.minute * 60 + parts.second;
}

function secondsToParts(total, calendar) {
    const jdn = Math.floor(total / 86400);
    let rest = total - jdn * 86400;
    const date = dateFromJdn(jdn, calendar);
    const hour = Math.floor(rest / 3600);
    rest -= hour * 3600;
    const minute = Math.floor(rest / 60);
    return {...date, hour, minute, second: Math.round((rest - minute * 60) * 1000) / 1000};
}

function shiftDateTime(parts, unit, amount, calendar) {
    if (unit === "y" || unit === "M") {
        const months = parts.year * 12 + (parts.month - 1) + amount * (unit === "y" ? 12 : 1);
        const year = Math.floor(months / 12);
        const month = months - year * 12 + 1;
        return {...parts, year, month, day: Math.min(parts.day, daysInMonth(year, month, calendar))};
    }
    const seconds = amount * (unit === "d" ? 86400 : 1);
    return secondsToParts(partsToSeconds(parts, calendar) + seconds, calendar);
}

function resetStepBase() {
    state.stepBase = null;
    $("stepOffset").textContent = "";
    $("stepResetBtn").classList.add("hidden");
}

function formatOffset(seconds) {
    seconds = Math.round(seconds * 1000) / 1000;      // 去掉浮点尾差（秒最多 3 位小数）
    if (seconds === 0) return "相对起点 ±0";
    const sign = seconds > 0 ? "+" : "−";
    let rest = Math.abs(seconds);
    const d = Math.floor(rest / 86400); rest -= d * 86400;
    const h = Math.floor(rest / 3600); rest -= h * 3600;
    const m = Math.floor(rest / 60);
    const s = Math.round((rest - m * 60) * 1000) / 1000;
    const pieces = [];
    if (d) pieces.push(`${d} 天`);
    if (h) pieces.push(`${h} 小时`);
    if (m) pieces.push(`${m} 分`);
    if (s) pieces.push(`${s} 秒`);
    return `相对起点 ${sign}${pieces.join(" ")}`;
}

function stepTime(direction) {
    const {ok, parts, message} = validateDateTime();
    if (!ok) {
        showError(`日期时间不完整或不合法：${message}`);
        return;
    }
    const calendar = currentCalendar();
    if (!state.stepBase) state.stepBase = {parts, calendar};

    const [unit, amount] = $("stepSize").value.split(":");
    const next = shiftDateTime(parts, unit, Number(amount) * direction, calendar);
    if (next.year < 1 || next.year > 9999) {
        showError("超出可计算的年份范围（1–9999）。");
        return;
    }
    setLocalTime(formatDtParts(next), {keepStep: true});
    showStepOffset();
    calculateFull();
}

function showStepOffset() {
    const {ok, parts} = validateDateTime({mark: false});
    if (!state.stepBase || !ok) {
        $("stepOffset").textContent = "";
        $("stepResetBtn").classList.add("hidden");
        return;
    }
    const offset = Math.round((partsToSeconds(parts, currentCalendar()) -
        partsToSeconds(state.stepBase.parts, state.stepBase.calendar)) * 1000) / 1000;
    $("stepOffset").textContent = formatOffset(offset);
    $("stepResetBtn").classList.toggle("hidden", offset === 0);
}

function bindTimeStep() {
    $("stepBackBtn").addEventListener("click", () => stepTime(-1));
    $("stepFwdBtn").addEventListener("click", () => stepTime(1));
    $("stepResetBtn").addEventListener("click", () => {
        if (!state.stepBase) return;
        setLocalTime(formatDtParts(state.stepBase.parts));
        calculateFull();
    });
}

// ================= 数据来源模式 =================

// ================= 星盘视图：本命 / 过境 / 分盘 =================
// 本命盘只来自人物档案；过境盘就是用另一个时间地点（默认现在）起的一张独立的盘。
// 两张盘各有自己的时刻：切换视图不会改变时刻，只有点「排盘」、时间步进、「更新到现在」、
// 「定位」「同步档案地点」或选择别的档案时，对应的那张盘才会重算。
// 计算设置是共用的：切回某张盘时，如果设置已经改过，就按新设置、用原来的时刻重算。
// 分盘（例如印度占星的 Moon、Bhava 和各个 D 盘）由体系在 SYSTEM.derivedViews 里提供，只从本命盘换算，
// 点到时才算，并缓存到本命盘重算、或这个分盘自己的设置改了为止（见 derivedEntry）。

const BASE_VIEWS = {natal: "本命", transit: "过境"};

function norm360(x) {
    return ((Number(x) % 360) + 360) % 360;
}

// 左侧表单（时间与地点、档案 / 过境面板）和「排盘」按钮对应哪张盘：过境，以及声明 form: "transit" 的分盘
// （如 Gochara）用过境盘；其余用本命盘。
function chartKind(view = state.view) {
    return view === "transit" || SYSTEM.derivedViews[view]?.form === "transit" ? "transit" : "natal";
}

// 右下角结果区显示哪张盘的数据：只有 Transit 显示过境盘，其余（包括 Gochara）都显示本命盘。
function resultsKind(view = state.view) {
    return view === "transit" ? "transit" : "natal";
}

// 分盘的数据：点到这个分盘时才换算（derive），结果按「本命结果 + 分盘自己的设置」缓存。
// derive 返回 Promise 时先显示「计算中…」，算好后如果还停在这个分盘上就重画一次。
// 所以分盘再多，也只有真正点开的那几张会被计算，平时不占任何时间。
function derivedEntry(view, base, transit = undefined) {
    const derived = SYSTEM.derivedViews[view];
    const sig = derived.signature ? String(derived.signature()) : "";
    const cached = state.derived[view];
    // 出错的结果显示过一次后不再沿用：下次点到这张盘时重试（例如网络一时不通）。
    if (cached && cached.source === base && cached.transit === transit && cached.sig === sig &&
        !(cached.error && cached.errorShown)) return cached;

    const entry = {source: base, transit, sig, results: null, error: null};
    state.derived[view] = entry;
    let output;
    try {
        output = derived.derive(base, {payload: state.charts.natal.payload, transit});
    } catch (error) {
        entry.error = error.message || String(error);
        return entry;
    }
    if (output && typeof output.then === "function") {
        output
            .then((results) => { entry.results = results; })
            .catch((error) => { entry.error = error.message || String(error); })
            .finally(() => {
                if (state.derived[view] === entry && state.view === view) {
                    renderChart();
                    SYSTEM.onDerivedReady(view);
                }
            });
    } else {
        entry.results = output;
    }
    return entry;
}

function viewLabel(view) {
    if (view in BASE_VIEWS) return SYSTEM.viewLabels[view] || BASE_VIEWS[view];
    return SYSTEM.derivedViews[view]?.label || view;
}

function renderView() {
    const chart = state.charts[resultsKind()];
    state.results = chart.results || {};
    renderAllResults();
    if (chartKind() === "transit") renderTransitCard();
}

// 星盘上方：常用的几张盘做成按钮条；分盘很多时，其余的放进按钮条右边的下拉菜单（SYSTEM.viewMenu）。
// 按钮和菜单只是 DOM，不触发任何计算。
function renderViewButtons() {
    const box = $("chartViews");
    box.innerHTML = "";
    const bar = [
        ...Object.keys(BASE_VIEWS),
        ...Object.entries(SYSTEM.derivedViews).filter(([, v]) => v.bar !== false)
            .map(([k, v], i) => ({k, order: Number.isFinite(v.order) ? v.order : 1000 + i}))
            .sort((x, y) => x.order - y.order).map((x) => x.k),
    ];
    for (const value of bar) {
        const item = document.createElement("label");
        item.innerHTML = `<input type="radio" name="chartView" value="${escapeHtml(value)}"><span>${escapeHtml(viewLabel(value))}</span>`;
        const radio = item.querySelector("input");
        radio.checked = value === state.view;
        radio.addEventListener("change", () => switchView(value));
        box.appendChild(item);
    }
    renderViewMenu();
}

// 分盘按钮是一个「分体按钮」：左半边直接切到最近用过的那张分盘（默认 SYSTEM.viewMenu.defaultValue，如 D9），
// 右半边 ▾ 打开全部分盘的菜单。菜单挂在 <body> 上、用 fixed 定位，并限制在窗口以内，
// 不会被星盘一栏的边界截断，也不会因为星盘一栏出现滚动条而跟着跑。
const VIEW_MENU_STORE = "quant-astro.viewMenu.last.";

function viewMenuLast() {
    const menu = SYSTEM.viewMenu;
    let last = null;
    try { last = localStorage.getItem(VIEW_MENU_STORE + (state.system?.id || "")); } catch (_) { last = null; }
    const ok = (v) => v && menu.items.some((item) => item.value === v) && SYSTEM.derivedViews[v];
    return ok(last) ? last : (ok(menu.defaultValue) ? menu.defaultValue : null);
}

function rememberViewMenu(view) {
    if (!SYSTEM.derivedViews[view] || SYSTEM.derivedViews[view].bar !== false) return;
    try { localStorage.setItem(VIEW_MENU_STORE + (state.system?.id || ""), view); } catch (_) {}
}

function renderViewMenu() {
    const holder = $("chartViewMenu");
    const menu = SYSTEM.viewMenu;
    if (!holder) return;
    if (!menu || !menu.items?.length) {
        holder.hidden = true;
        holder.innerHTML = "";
        return;
    }
    holder.hidden = false;
    holder.innerHTML = `
        <button type="button" class="view-menu-main"></button>
        <button type="button" class="view-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(menu.label || "更多")}" title="${escapeHtml(menu.label || "更多")}">
            <svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
        </button>`;
    const main = holder.querySelector(".view-menu-main");
    const button = holder.querySelector(".view-menu-btn");
    const pop = document.createElement("div");
    pop.className = "view-menu-pop";
    pop.setAttribute("role", "menu");
    pop.hidden = true;
    pop.innerHTML = menu.items.map((item) => `
        <button type="button" role="menuitemradio" class="view-menu-item" data-view="${escapeHtml(item.value)}"
                title="${escapeHtml(item.title || "")}">
            <span class="view-menu-name">${escapeHtml(item.label)}</span>
            ${item.note ? `<span class="view-menu-note">${escapeHtml(item.note)}</span>` : ""}
            ${item.sub ? `<span class="view-menu-sub">${escapeHtml(item.sub)}</span>` : ""}
        </button>`).join("");
    document.querySelector(".view-menu-pop")?.remove();
    document.body.appendChild(pop);

    const place = () => {
        const r = holder.getBoundingClientRect();
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        pop.style.maxWidth = `${vw - 16}px`;
        const w = pop.offsetWidth, h = pop.offsetHeight;
        pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
        const below = r.bottom + 6;
        pop.style.top = `${below + h > vh - 8 ? Math.max(8, r.top - h - 6) : below}px`;
    };
    const close = (focusButton = false) => {
        if (pop.hidden) return;
        pop.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (focusButton) button.focus();
    };
    main.addEventListener("click", () => {
        const view = main.dataset.view;
        if (view) switchView(view);
    });
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!pop.hidden) {
            close();
            return;
        }
        pop.hidden = false;
        button.setAttribute("aria-expanded", "true");
        place();
        (pop.querySelector("[aria-checked='true']") || pop.querySelector("button"))?.focus();
    });
    pop.addEventListener("click", (event) => {
        const item = event.target.closest("[data-view]");
        if (!item) return;
        close(true);
        switchView(item.dataset.view);
    });
    pop.addEventListener("keydown", (event) => {
        const items = [...pop.querySelectorAll("[data-view]")];
        const index = items.indexOf(document.activeElement);
        const cols = Number(getComputedStyle(pop).getPropertyValue("--cols")) || 4;
        const moves = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols};
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        } else if (event.key in moves && index >= 0) {
            event.preventDefault();
            items[Math.min(items.length - 1, Math.max(0, index + moves[event.key]))].focus();
        } else if (event.key === "Tab") {
            close();
        }
    });
    // 点在菜单和按钮以外的地方才收起（捕获阶段：星盘上的点击会阻止冒泡，也照样能收起）。
    document.addEventListener("pointerdown", (event) => {
        if (!pop.hidden && !pop.contains(event.target) && !holder.contains(event.target)) close();
    }, true);
    window.addEventListener("resize", () => { if (!pop.hidden) place(); });
    updateViewMenu();
}

// 分体按钮：左半边显示当前（或最近用过）的那张分盘；当前看的正是菜单里的盘时高亮。
function updateViewMenu() {
    const holder = $("chartViewMenu");
    const menu = SYSTEM.viewMenu;
    if (!holder || holder.hidden || !menu) return;
    const inBar = [...document.querySelectorAll("input[name='chartView']")].some((r) => r.value === state.view);
    const current = inBar ? null : menu.items.find((item) => item.value === state.view);
    if (current) rememberViewMenu(current.value);
    const target = current?.value || viewMenuLast();
    const label = menu.items.find((item) => item.value === target)?.label || menu.label || "更多";
    const main = holder.querySelector(".view-menu-main");
    main.textContent = label;
    main.dataset.view = target || "";
    main.title = target ? `切到 ${label}` : "";
    holder.classList.toggle("active", Boolean(current));
    document.querySelectorAll(".view-menu-pop [data-view]").forEach((item) => {
        item.setAttribute("aria-checked", String(item.dataset.view === state.view));
    });
}

// 侧栏随视图变化：本命 / 分盘显示「人物档案」面板；过境换成同样大小的「过境」面板。
// 下面的「时间与地点」和计算设置两种视图共用，切换时版面不动，只换内容。
function updateViewUI() {
    const transit = chartKind() === "transit";
    document.querySelectorAll("input[name='chartView']").forEach((r) => { r.checked = r.value === state.view; });
    updateViewMenu();
    $("profilePanel").classList.toggle("hidden", transit);
    $("transitPanel").classList.toggle("hidden", !transit);
    $("timePanel").classList.toggle("hidden", !transit && !state.activeProfile);
    $("timeStrip").hidden = !transit && !state.activeProfile;
    $("nowBtn").classList.toggle("hidden", !transit);
    $("syncProfileLocBtn").disabled = !state.activeProfile;
    updateProfileTab();
    renderTransitCard();
}

// 过境卡片：这一刻的日主星、时主星（时刻、历法、时区、经纬度下面「时间与地点」里都有）。
function renderTransitCard() {
    const r = state.charts.transit.results || {};
    const row = (label, code) => `
        <div class="lord-row">
            <span class="lord-label">${label}</span>
            <span class="lord-name">${code ? escapeHtml(PLANET_NAMES[code] || code) : "—"}</span>
        </div>`;
    $("transitCard").innerHTML = row("日主星", r.day_lord_result?.day_lord) + row("时主星", r.planetary_hour_data?.planetary_hour_lord);
}

// ---------- 表单 ↔ 某张盘的输入 ----------

function readForm() {
    return {
        parts: DT_PARTS.map((p) => dtInput(p).value),
        calendar: $("calendar").value,
        timezone: $("timezone").value,
        latitude: $("latitude").value,
        longitude: $("longitude").value,
        locationInfo: $("locationInfo").textContent,
    };
}

function writeForm(input) {
    DT_PARTS.forEach((p, i) => { dtInput(p).value = input?.parts?.[i] ?? ""; });
    $("calendar").value = input?.calendar === "j" ? "j" : "g";
    $("timezone").value = input?.timezone ?? "";
    $("latitude").value = input?.latitude ?? "";
    $("longitude").value = input?.longitude ?? "";
    $("locationInfo").textContent = input?.locationInfo ?? "";
    validateDateTime({source: $("localTime")});
}

function inputFromProfile(p) {
    const m = DT_TEXT_RE.exec(String(p.birth_time || "").replace("T", " ")) || [];
    const values = [m[1], m[2], m[3], m[4] || "0", m[5] || "0", m[6] || "0"];
    return {
        parts: values.map((v, i) => (v === undefined ? "" : String(v).padStart(i === 0 ? 4 : 2, "0"))),
        calendar: p.calendar === "j" ? "j" : "g",
        timezone: p.timezone_offset || "",
        latitude: String(p.latitude ?? ""),
        longitude: String(p.longitude ?? ""),
        locationInfo: "",
    };
}

// 时间步进的“相对起点”也跟着各自的盘走。
function saveFormTo(kind) {
    state.charts[kind].input = readForm();
    state.charts[kind].stepBase = state.stepBase;
}

function loadFormFrom(kind) {
    writeForm(state.charts[kind].input);
    state.stepBase = state.charts[kind].stepBase;
    showStepOffset();
}

function currentSignature() {
    return JSON.stringify(collectPayload().options);
}

// 切到某张盘时：还没算过、或计算设置改过，就用它自己的时刻（重新）计算；否则直接显示缓存。
async function ensureComputed() {
    const kind = chartKind();
    const chart = state.charts[kind];
    const signature = currentSignature();
    const jobs = [];
    if (!(kind === "natal" && !state.activeProfile) && (!chart.results || chart.signature !== signature)) {
        jobs.push(calculateFull());
    }
    // Gochara：左侧是过境的表单，本命盘按档案在后台补算（或按新的计算设置重算）。
    const natal = state.charts.natal;
    if (kind === "transit" && state.view !== "transit" && state.activeProfile && natal.input &&
        (!natal.results || natal.signature !== signature)) {
        jobs.push(calculateStored("natal"));
    }
    await Promise.all(jobs);
}

async function switchView(view) {
    if (view === state.view) return;
    const fromKind = chartKind(state.view);
    const toKind = chartKind(view);
    if (fromKind !== toKind) saveFormTo(fromKind);
    state.view = view;
    if (fromKind !== toKind) {
        if (toKind === "transit" && !state.charts.transit.input) {
            initTransitInput();
        } else {
            loadFormFrom(toKind);
        }
    }
    updateViewUI();
    showError("");
    renderView();
    await ensureComputed();
}

// ---------- 过境：时间、地点 ----------

// 第一次打开过境盘：现在的时间 + 默认地点，然后在后台定位，定位成功再更新一次。
function initTransitInput() {
    const loc = state.settings.default_location;
    writeForm({
        parts: [], calendar: "g", timezone: timezoneOffsetString(),
        latitude: String(loc.latitude), longitude: String(loc.longitude), locationInfo: "默认地点",
    });
    setLocalTime(localDateTimeString());
    state.charts.transit.input = readForm();
    locateTransit({silentFail: true});
}

function setTransitNow() {
    // 电脑时钟给出的“现在”一定是格里历。
    $("calendar").value = "g";
    setLocalTime(localDateTimeString());
    $("timezone").value = timezoneOffsetString();
    const button = $("nowBtn");
    button.classList.remove("spin");
    void button.offsetWidth;          // 重新触发转圈动画
    button.classList.add("spin");
    calculateFull();
}

// 定位只改过境盘的经纬度；定位期间切走了视图，结果写进过境盘的输入里，等切回来再算。
function locateTransit({silentFail = false} = {}) {
    const apply = (patch, detail = "") => {
        if (chartKind() === "transit") {
            if (patch.latitude !== undefined) $("latitude").value = patch.latitude;
            if (patch.longitude !== undefined) $("longitude").value = patch.longitude;
            $("locationInfo").textContent = patch.locationInfo;
        } else {
            Object.assign(state.charts.transit.input, patch);
            state.charts.transit.signature = "";      // 切回过境时按新地点重算
        }
    };
    const button = $("locateBtn");
    if (!navigator.geolocation) {
        apply({locationInfo: "无法定位"}, "浏览器不支持定位");
        return;
    }
    button.classList.add("busy");
    apply({locationInfo: "定位中…"});
    navigator.geolocation.getCurrentPosition(
        (position) => {
            button.classList.remove("busy");
            const accuracy = Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null;
            const accText = accuracy === null ? "" : accuracy >= 1000 ? ` ±${(accuracy / 1000).toFixed(accuracy >= 10000 ? 0 : 1)} km` : ` ±${accuracy} m`;
            apply({
                latitude: position.coords.latitude.toFixed(6),
                longitude: position.coords.longitude.toFixed(6),
                locationInfo: `已定位${accText}`,
            }, accuracy === null ? "" : `浏览器报告的精度约 ${accuracy} 米`);
            if (chartKind() === "transit") calculateFull();
            renderTransitCard();
        },
        (error) => {
            button.classList.remove("busy");
            const keep = silentFail ? "默认地点" : "定位失败";
            apply({locationInfo: keep}, error.message || "定位被拒绝或超时");
        },
        {enableHighAccuracy: true, timeout: 8000, maximumAge: 0},
    );
}

function syncProfileLocation() {
    const p = state.activeProfile;
    if (!p) return;
    $("latitude").value = p.latitude ?? "";
    $("longitude").value = p.longitude ?? "";
    $("locationInfo").textContent = "档案地点";
    calculateFull();
}

function bindTransitActions() {
    $("nowBtn").addEventListener("click", setTransitNow);
    $("locateBtn").addEventListener("click", () => locateTransit());
    $("syncProfileLocBtn").addEventListener("click", syncProfileLocation);
    // 用过境的时间与地点（比如“现在”）新建档案。
    $("saveAsProfileBtn").addEventListener("click", () => openEditor("new"));
}

// ---------- 本命盘 ↔ 档案 ----------

// 把档案设为本命盘的来源：本命盘的输入换成这份档案的出生数据，旧结果作废。
// 当前正显示本命时立即排盘；正在看过境时不打扰，切回本命再算。
// save = false：只在这一页换人，不写会话、不记「最近打开」
// （打开网页时选回上次的人、或另一个体系已经记过时用）。
async function useProfileForNatal(profile, {calculate = true, save = true} = {}) {
    const changed = (profile?.id ?? null) !== (state.activeProfile?.id ?? null);
    setActiveProfile(profile);
    if (changed) SYSTEM.onProfileChange(profile);
    if (save) saveSession(profile ? profile.id : null);
    const natal = state.charts.natal;
    natal.input = profile ? inputFromProfile(profile) : null;
    natal.results = null;
    natal.payload = null;
    natal.stepBase = null;
    state.derived = {};
    if (chartKind() === "natal") {
        loadFormFrom("natal");
        updateViewUI();
        renderView();
        if (profile && calculate) await calculateFull();
    } else {
        updateViewUI();
        if (state.view !== "transit") {          // Gochara：表单是过境的，本命盘在后台换成这个人
            renderView();
            if (profile && calculate) await ensureComputed();
        }
    }
}

let sessionSaveChain = Promise.resolve();

function saveSession(profileId) {
    sessionSaveChain = sessionSaveChain
        .then(() => api("/api/session", {method: "POST", body: JSON.stringify({last_profile_id: profileId || null})}))
        .catch(() => {});
}

// 打开网页 / 切换档案库时：自动选回这个档案库上一次选中的人（档案已被删除则忽略）。
// 这个人本来就记在会话里，所以不再写一遍，也不算一次「打开」。
async function restoreLastProfile() {
    const id = state.lastProfileId;
    if (!id) {
        await useProfileForNatal(null, {save: false});
        return;
    }
    try {
        const profile = await api(`/api/profiles/${id}`);
        await useProfileForNatal(profile, {save: false});
    } catch (_) {
        await useProfileForNatal(null, {save: false});
    }
}

// ================= 档案库（每套档案一个独立的库：人物、字段、标签互不相干） =================

// 标题处的档案库按钮：显示当前库名；点开是一个悬浮菜单（库列表 + 新建 / 重命名，就地输入，不弹系统对话框）。
function renderLibrarySelect() {
    document.querySelectorAll(".lib-name").forEach((el) => { el.textContent = state.library || ""; });
    if (!$("libraryMenu").hidden) renderLibraryMenu();
}

const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg>';
const ICON_PEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12H4v-2z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg>';

// mode: "list" | "new" | "rename" | "delete"
let libraryMenuMode = "list";

function renderLibraryMenu(error = "") {
    const menu = $("libraryMenu");
    const currentEncrypted = Boolean(state.libraries.find((lib) => lib.name === state.library)?.encrypted);
    const items = state.libraries.map((lib) => {
        const current = lib.name === state.library;
        return `
            <button type="button" class="lm-item${current ? " current" : ""}" role="menuitemradio"
                    aria-checked="${current}" data-name="${escapeHtml(lib.name)}">
                <span class="lm-check">${current ? ICON_CHECK : ""}</span>
                <span class="lm-name">${escapeHtml(lib.name)}</span>
                ${lib.encrypted ? `<span class="lm-lock${lib.locked ? " locked" : ""}">${ICON_LOCK}</span>` : ""}
                <span class="lm-count">${lib.count == null ? "" : lib.count}</span>
            </button>`;
    }).join("");

    let foot;
    if (libraryMenuMode === "list") {
        foot = `
            <button type="button" class="lm-item lm-action" role="menuitem" data-act="new">
                <span class="lm-check">${ICON_PLUS}</span><span class="lm-name">新建档案库</span>
            </button>
            <button type="button" class="lm-item lm-action" role="menuitem" data-act="rename">
                <span class="lm-check">${ICON_PEN}</span><span class="lm-name">重命名当前档案库</span>
            </button>
            <button type="button" class="lm-item lm-action" role="menuitem" data-act="security">
                <span class="lm-check">${ICON_LOCK}</span><span class="lm-name">${currentEncrypted ? "加密设置（取消加密 / 改密码）…" : "加密当前档案库…"}</span>
            </button>
            <button type="button" class="lm-item lm-action lm-danger" role="menuitem" data-act="delete">
                <span class="lm-check">${ICON_TRASH}</span><span class="lm-name">删除档案库…</span>
            </button>`;
    } else if (libraryMenuMode === "delete") {
        // 删除：可以选任何一个档案库（包括锁定的，例如忘了密码），要再输入一次名称确认。
        const options = state.libraries.map((lib) =>
            `<option value="${escapeHtml(lib.name)}"${lib.name === state.library ? " selected" : ""}>${escapeHtml(lib.name)}${lib.count == null ? "" : `（${lib.count} 人）`}</option>`).join("");
        foot = `
            <form class="lm-form lm-delete-form" novalidate>
                <select aria-label="要删除的档案库">${options}</select>
                <input type="text" maxlength="30" autocomplete="off" spellcheck="false" placeholder="再输入一次名称确认">
                <button type="submit" class="danger">删除</button>
            </form>
            <p class="lm-hint">文件会移到 user_data/deleted_libraries/ 文件夹，需要时可以手动找回。</p>`;
    } else {
        const value = libraryMenuMode === "rename" ? state.library : "";
        foot = `
            <form class="lm-form" novalidate>
                <input type="text" maxlength="30" autocomplete="off" spellcheck="false"
                       placeholder="${libraryMenuMode === "rename" ? "新名称" : "新档案库名称"}" value="${escapeHtml(value)}">
                <button type="submit" class="accent-btn">${libraryMenuMode === "rename" ? "改名" : "新建"}</button>
            </form>`;
    }
    menu.innerHTML = `
        <div class="lm-title">档案库<span>人数</span></div>
        <div class="lm-list">${items}</div>
        <div class="lm-sep"></div>
        ${foot}
        ${error ? `<p class="lm-error">${escapeHtml(error)}</p>` : ""}`;

    if (libraryMenuMode !== "list") {
        const input = menu.querySelector(".lm-form input");
        input.focus();
        input.select();
    }
}

function libraryMenuItems() {
    return [...$("libraryMenu").querySelectorAll(".lm-item")];
}

// 档案库菜单只有一个；顶栏和设置抽屉各有一个按钮，点哪个，菜单就挂到哪个按钮下面。
let libraryAnchor = null;

async function openLibraryMenu(button = $("libraryBtn")) {
    const menu = $("libraryMenu");
    libraryAnchor = button;
    button.parentElement.appendChild(menu);
    libraryMenuMode = "list";
    renderLibraryMenu();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => menu.classList.add("open"));
    (menu.querySelector(".lm-item.current") || libraryMenuItems()[0])?.focus();
    try {                                   // 人数可能已经变了：打开时顺手刷新一次
        const fresh = await api("/api/libraries");
        state.libraries = fresh.libraries || state.libraries;
        if (!menu.hidden && libraryMenuMode === "list") {
            const focusedName = document.activeElement?.dataset?.name;
            const focusedAct = document.activeElement?.dataset?.act;
            renderLibraryMenu();
            const again = focusedName != null
                ? menu.querySelector(`.lm-item[data-name="${CSS.escape(focusedName)}"]`)
                : focusedAct ? menu.querySelector(`.lm-item[data-act="${focusedAct}"]`) : null;
            (again || menu.querySelector(".lm-item.current"))?.focus();
        }
    } catch (_) { /* 人数刷新失败不影响使用 */ }
}

function closeLibraryMenu(returnFocus = true) {
    const menu = $("libraryMenu");
    if (menu.hidden) return;
    menu.classList.remove("open");
    menu.hidden = true;
    libraryMenuMode = "list";
    const anchor = libraryAnchor || $("libraryBtn");
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus) anchor.focus();
}

async function submitLibraryForm(name) {
    name = name.trim();
    if (!name) return renderLibraryMenu("名称不能为空");
    try {
        showError("");
        if (libraryMenuMode === "new") {
            await applyLibraryPayload(await api("/api/libraries", {method: "POST", body: JSON.stringify({name})}));
            closeLibraryMenu();
            setStatus(`已新建档案库「${state.library}」`);
        } else {
            if (name === state.library) return closeLibraryMenu();
            const result = await api("/api/libraries/current", {method: "PUT", body: JSON.stringify({name})});
            state.library = result.current;
            state.libraries = result.libraries;
            closeLibraryMenu();
            renderLibrarySelect();
            setStatus(`档案库已改名为「${state.library}」`);
        }
    } catch (error) {
        renderLibraryMenu(error.message);
        const input = $("libraryMenu").querySelector(".lm-form input");
        if (input) { input.value = name; input.select(); }
    }
}

async function deleteLibrary(name, confirmText) {
    if (!name) return;
    if (confirmText.trim() !== name) {
        renderLibraryMenu(`请输入「${name}」确认删除`);
        const form = $("libraryMenu").querySelector(".lm-delete-form");
        if (form) { form.querySelector("select").value = name; form.querySelector("input").focus(); }
        return;
    }
    try {
        showError("");
        const data = await api("/api/libraries/delete", {method: "POST", body: JSON.stringify({name, confirm: confirmText.trim()})});
        closeLibraryMenu();
        await applyLibraryPayload(data);
        setStatus(`已删除档案库「${name}」`);
        showNotice(`档案库「${name}」已删除，文件移到了 user_data/deleted_libraries/${data.moved_to || ""}，需要时可以手动找回。`);
    } catch (error) {
        if (error.locked) { closeLibraryMenu(false); return; }   // 删除后剩下的库是锁定的：解锁窗口已经弹出
        renderLibraryMenu(error.message);
    }
}

async function switchLibrary(name) {
    closeLibraryMenu();
    if (name === state.library) return;
    try {
        showError("");
        await applyLibraryPayload(await api("/api/libraries/switch", {method: "POST", body: JSON.stringify({name})}));
        setStatus(`已切换到档案库「${state.library}」`);
    } catch (error) {
        if (!error.locked) showError(error.message);       // 锁定的库：解锁窗口已经弹出
    }
}

function bindLibraryMenu() {
    const menu = $("libraryMenu");
    document.querySelectorAll("[data-lib-btn]").forEach((button) => {
        button.addEventListener("click", () => {
            if (!menu.hidden && libraryAnchor === button) closeLibraryMenu();
            else {
                if (!menu.hidden) closeLibraryMenu(false);
                openLibraryMenu(button);
            }
        });
        button.addEventListener("keydown", (event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && menu.hidden) {
                event.preventDefault();
                openLibraryMenu(button);
            }
        });
    });
    menu.addEventListener("click", (event) => {
        const item = event.target.closest(".lm-item");
        if (!item) return;
        if (item.dataset.act === "security") {
            closeLibraryMenu(false);
            openSecurityDialog();
        } else if (item.dataset.act) {
            libraryMenuMode = item.dataset.act;
            renderLibraryMenu();
        } else {
            switchLibrary(item.dataset.name);
        }
    });
    menu.addEventListener("submit", (event) => {
        event.preventDefault();
        if (libraryMenuMode === "delete") {
            deleteLibrary(event.target.querySelector("select").value, event.target.querySelector("input").value);
            return;
        }
        submitLibraryForm(event.target.querySelector("input").value);
    });
    menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (libraryMenuMode !== "list") {      // 先退出输入，再按一次关闭菜单
                libraryMenuMode = "list";
                renderLibraryMenu();
                menu.querySelector(".lm-item.current")?.focus();
            } else {
                closeLibraryMenu();
            }
            return;
        }
        if (event.key === "Tab") { closeLibraryMenu(false); return; }
        if (event.target.tagName === "INPUT") return;
        const items = libraryMenuItems();
        const index = items.indexOf(document.activeElement);
        const go = (i) => { event.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
        if (event.key === "ArrowDown") go(index + 1);
        else if (event.key === "ArrowUp") go(index - 1);
        else if (event.key === "Home") go(0);
        else if (event.key === "End") go(items.length - 1);
    });
    document.addEventListener("pointerdown", (event) => {
        if (!menu.hidden && !event.target.closest(".lib-switch")) closeLibraryMenu(false);
    });
}

// 换了档案库：字段、标签、列表、筛选全部换成新库的，本命盘换成新库上次选中的人。
async function applyLibraryPayload(data) {
    state.library = data.library;
    state.libraries = data.libraries || [];
    state.lastProfileId = data.last_profile_id || null;
    state.profileFields = data.profile_fields || [];
    state.tagOptions = data.tags || [];
    state.libraryTotal = null;
    // 筛选和搜索清空；排序换成新库自己保存的排序（后端已按它取好第一页）。
    Object.assign(state.profileQuery, {
        q: "", bornFrom: "", bornTo: "", tags: [], tagMode: "all", fieldFilters: [], page: 1,
    });
    applySortFromPage(data.profiles_page);
    $("profileSearch").value = "";
    for (const id of ["bornFrom", "bornTo", "filterTagInput"]) $(id).value = "";
    renderLibrarySelect();
    renderSortOptions();
    renderFieldFilters();
    renderFilterChips();
    renderTagDatalist();
    applyProfilePage({data: data.profiles, ...data.profiles_page});
    await restoreLastProfile();
}

// ================= 人物档案 =================
// 侧栏只显示「当前人物」卡片和三个按钮，不占地方；
// 找人在「选择人物」浮窗里（分页列表 + 筛选），编辑在「编辑档案」浮窗里；
// 长篇的自定义字段（如“婚姻分析”）完整显示在结果区的「档案资料」标签页。
// 档案库可能有几万人，所以列表永远只向后端要“一页”（50 人）的基础信息。

const PROFILE_PAGE_SIZE = 50;

const CORE_SORT_OPTIONS = [
    {value: "opened", label: "最近打开"},
    {value: "name", label: "名字"},
    {value: "birth", label: "出生时间"},
    {value: "updated", label: "最近修改"},
    {value: "created", label: "最近添加"},
];

// 每种排序依据的默认方向（与后端 SORT_DEFAULT_ORDER 一致）：切换排序依据时自动换成它的默认方向。
// 按数字 / 日期字段（field:<id>）排序默认正序。
const SORT_DEFAULT_ORDER = {opened: "desc", name: "asc", birth: "asc", updated: "desc", created: "desc"};
const DEFAULT_SORT = "opened";

function defaultOrder(sort) {
    if (String(sort).startsWith("field:")) return "asc";
    return SORT_DEFAULT_ORDER[sort] || SORT_DEFAULT_ORDER[DEFAULT_SORT];
}

// 排序方向的文字随排序依据变化，比单纯的“正序 / 倒序”好懂。
function orderLabels(sort) {
    if (["opened", "updated", "created", "birth"].includes(sort)) return {asc: "早的在前", desc: "近的在前"};
    if (String(sort).startsWith("field:")) return {asc: "从小到大", desc: "从大到小"};
    return {asc: "正序 ↑", desc: "倒序 ↓"};
}

// 后端返回的一页（bootstrap、切换档案库）里带着实际使用的排序，照着它设置。
function applySortFromPage(page) {
    const sort = page?.sort || DEFAULT_SORT;
    state.profileQuery.sort = sort;
    state.profileQuery.order = page?.order === "asc" || page?.order === "desc" ? page.order : defaultOrder(sort);
}

// 排序一改就记到当前档案库名下（settings.json → session.profile_sort），下次打开、重启后照样用。
let sortSaveChain = Promise.resolve();

function saveProfileSort() {
    const {sort, order} = state.profileQuery;
    sortSaveChain = sortSaveChain
        .then(() => api("/api/session", {method: "POST", body: JSON.stringify({profile_sort: {sort, order}})}))
        .catch((error) => showError(`排序没能保存：${error.message}`));
}

// 出生日期筛选框允许的写法：1980 / 1980-05 / 1980-05-12。
const BORN_TEXT_RE = /^\d{1,4}(?:[-/.]\d{1,2}){0,2}$/;
// 数值筛选框允许的写法：12、-3.5、1,024、+7
const NUMBER_TEXT_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function splitTags(text) {
    const seen = new Set();
    const result = [];
    for (const piece of String(text ?? "").split(/[,，、;；\n]+/)) {
        const name = piece.trim().replace(/\s+/g, " ");
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(name);
    }
    return result;
}

function formatBirth(text) {
    return String(text || "").slice(0, 16);      // 1985-03-04 05:06
}

function formatDay(isoText) {
    const date = new Date(isoText);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 本机时间的「日期 时:分」；今天的只写「今天 时:分」。
function formatDayTime(isoText) {
    const date = new Date(isoText);
    if (Number.isNaN(date.getTime())) return "";
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return formatDay(isoText) === formatDay(new Date().toISOString()) ? `今天 ${time}` : `${formatDay(isoText)} ${time}`;
}

// ---------- 浮窗 ----------

function openDialog(id) {
    const dialog = $(id);
    if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
    const dialog = $(id);
    if (dialog.open) dialog.close();
}

function bindDialogs() {
    for (const dialog of document.querySelectorAll("dialog.modal")) {
        dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
        // 带 data-guarded 的浮窗（设置浮窗）自己处理关闭：点外面 / Esc 都按“取消”走确认流程。
        if (dialog.hasAttribute("data-guarded")) {
            dialog.addEventListener("close", () => {
                const msg = dialog.querySelector("[data-dialog-msg]");
                if (msg) { msg.textContent = ""; msg.classList.add("hidden"); }
            });
            continue;
        }
        dialog.addEventListener("close", () => {
            const msg = dialog.querySelector("[data-dialog-msg]");
            if (msg) { msg.textContent = ""; msg.classList.add("hidden"); }
        });
        // 点浮窗外的遮罩关闭（点在浮窗本体上不算）。
        dialog.addEventListener("mousedown", (event) => {
            if (event.target !== dialog) return;
            const r = dialog.getBoundingClientRect();
            const outside = event.clientX < r.left || event.clientX > r.right ||
                event.clientY < r.top || event.clientY > r.bottom;
            if (outside) dialog.close();
        });
    }
}

// ---------- 当前人物卡片 + 档案资料页 ----------

function renderActiveProfileCard() {
    const card = $("activeProfileCard");
    const p = state.activeProfile;
    $("editProfileBtn").disabled = !p;
    $("personName").textContent = p ? p.display_name : "选择人物";
    $("personChip").classList.toggle("empty", !p);
    $("personChip").title = p ? `${p.display_name}（点一下换人）` : "选择人物";
    if (!p) {
        card.innerHTML = "<p class='muted profile-card-empty'>未选择人物</p>";
        return;
    }
    // 出生时间、历法、时区、经纬度下面「时间与地点」里都有，这里只放名字。
    card.innerHTML = `<div class="profile-card-name" title="${escapeHtml(p.display_name)}">${escapeHtml(p.display_name)}</div>`;
}

// 「档案资料」标签页：只在本命 / 分盘视图、且选中了人物时出现。
function updateProfileTab() {
    const show = resultsKind() === "natal" && Boolean(state.activeProfile);
    const button = document.querySelector("#resultTabs [data-profile-tab]");
    button.classList.toggle("hidden", !show);
    if (!show && button.classList.contains("active")) {
        activateTab(document.querySelector("#resultTabs [data-tab]:not(.hidden)"));
    }
}

// ---------- 自定义字段树 ----------
// 后端按“深度优先”给出字段列表：上级在前，紧跟着它的全部下级。每个字段带 parent_id、depth、path。

function fieldPathText(field) {
    return (field.path || [field.label]).join(" / ");
}

function fieldChildren(parentId) {
    return state.profileFields.filter((f) => (f.parent_id ?? null) === (parentId ?? null));
}

function renderProfileView() {
    const box = $("profileView");
    const p = state.activeProfile;
    box.innerHTML = "";
    if (!p) return;

    const head = document.createElement("div");
    head.className = "profile-view-head";
    head.innerHTML = `
        <h3>${escapeHtml(p.display_name)}</h3>
        <p class="muted">出生 ${escapeHtml(String(p.birth_time || ""))} · ${CALENDAR_NAMES[p.calendar] || "格里历"} · UTC${escapeHtml(p.timezone_offset || "")} ·
            ${escapeHtml(formatCoord(p.latitude, "latitude"))} · ${escapeHtml(formatCoord(p.longitude, "longitude"))} · 修改于 ${escapeHtml(formatDay(p.updated_at))}</p>
    `;
    if ((p.tags || []).length) {
        const chips = document.createElement("div");
        chips.className = "chips";
        chips.innerHTML = p.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("");
        head.appendChild(chips);
    }
    box.appendChild(head);

    const valueOf = (f) => {
        const v = p.fields?.[f.id];
        return Array.isArray(v) ? v : String(v ?? "").trim();
    };
    // 一个字段（或它的任何一级下级）填了内容，才显示它。
    const filledMemo = new Map();
    const filled = (f) => {
        if (!filledMemo.has(f.id)) {
            filledMemo.set(f.id, (f.kind !== "group" && valueOf(f).length > 0) || fieldChildren(f.id).some(filled));
        }
        return filledMemo.get(f.id);
    };
    const roots = fieldChildren(null).filter(filled);
    if (!roots.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "未填写自定义字段";
        box.appendChild(empty);
        return;
    }

    const draw = (field, parent) => {
        const section = document.createElement("section");
        section.className = "profile-field-view" + (field.depth ? " nested" : "");
        const title = document.createElement("h4");
        title.textContent = field.label;
        section.appendChild(title);

        if (field.kind !== "group" && valueOf(field).length > 0) {
            if (field.kind === "choice" || field.kind === "multi") {
                const chips = document.createElement("div");
                chips.className = "chips";
                const items = Array.isArray(valueOf(field)) ? valueOf(field) : [valueOf(field)];
                chips.innerHTML = items.map((o) => `<span class="chip">${escapeHtml(o)}</span>`).join("");
                section.appendChild(chips);
            } else {
                const body = document.createElement("div");
                body.className = "profile-field-text";
                body.textContent = String(p.fields[field.id]);
                section.appendChild(body);
            }
        }
        const kids = fieldChildren(field.id).filter(filled);
        if (kids.length) {
            const sub = document.createElement("div");
            sub.className = "profile-field-children";
            kids.forEach((k) => draw(k, sub));
            section.appendChild(sub);
        }
        parent.appendChild(section);
    };
    roots.forEach((f) => draw(f, box));
}

function setActiveProfile(profile) {
    state.activeProfile = profile;
    state.activeProfileId = profile ? profile.id : null;
    renderActiveProfileCard();
    renderProfileView();
    updateProfileTab();
    highlightActiveRow();
}

// 选中某个人：取他的完整信息（时区、经纬度、全部自定义字段），作为本命盘并排盘。
async function selectProfile(profileId) {
    if (!profileId) return;
    const token = ++state.selectToken;
    const profile = await api(`/api/profiles/${profileId}`);
    if (token !== state.selectToken) return;     // 期间又点了别的人：只认最后一次点击
    closeDialog("pickerDialog");
    await useProfileForNatal(profile);
}

// ---------- 选择人物浮窗：分页列表 + 筛选 ----------

function activeFieldFilters() {
    return state.profileQuery.fieldFilters
        .filter((f) => fieldById(f.field) && (f.min.trim() || f.max.trim() || f.options.length || f.empty))
        .map((f) => {
            const field = fieldById(f.field);
            const out = {field: Number(f.field)};
            if (field.kind === "number" || field.kind === "date") {
                if (f.min.trim()) out.min = f.min.trim();
                if (f.max.trim()) out.max = f.max.trim();
            } else {
                if (f.options.length) out.options = f.options;
                if (f.empty) out.empty = true;
            }
            return out;
        });
}

function hasActiveFilter() {
    const q = state.profileQuery;
    return Boolean(q.q.trim() || q.bornFrom.trim() || q.bornTo.trim() || q.tags.length || activeFieldFilters().length);
}

function profileListUrl(page) {
    const q = state.profileQuery;
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(PROFILE_PAGE_SIZE));
    if (q.q.trim()) {
        params.set("q", q.q.trim());
        params.set("scope", q.scope);
    }
    if (q.bornFrom.trim()) params.set("born_from", q.bornFrom.trim());
    if (q.bornTo.trim()) params.set("born_to", q.bornTo.trim());
    for (const tag of q.tags) params.append("tag", tag);
    if (q.tags.length > 1) params.set("tag_mode", q.tagMode);
    for (const f of activeFieldFilters()) params.append("ff", JSON.stringify(f));
    params.set("sort", q.sort);
    params.set("order", q.order);
    return `/api/profiles?${params.toString()}`;
}

// payload 的形状和后端 /api/profiles 一致：{data: [...], page, page_size, total, total_pages, has_more}
function applyProfilePage(payload) {
    state.profileList = {
        items: payload.data || [],
        page: payload.page || 1,
        pageSize: payload.page_size || PROFILE_PAGE_SIZE,
        total: payload.total ?? 0,
        totalPages: payload.total_pages ?? 1,
        hasMore: Boolean(payload.has_more),
        sort: payload.sort || state.profileQuery.sort,     // 这一页实际用的排序，用来显示每行的排序依据的值
    };
    state.profileQuery.page = state.profileList.page;
    if (!hasActiveFilter()) state.libraryTotal = state.profileList.total;
    renderProfileList();
}

async function loadProfileList(page = 1) {
    const token = ++state.listToken;     // 连续快速操作时，只认最后一次请求的结果
    try {
        const payload = await apiRaw(profileListUrl(page));
        if (token !== state.listToken) return;

        // 请求的页已经没人了（例如刚删掉这一页的最后一个人）：退回最后一页。
        if (!payload.data.length && page > 1 && payload.total > 0) {
            await loadProfileList(payload.total_pages);
            return;
        }
        applyProfilePage(payload);
    } catch (error) {
        if (token !== state.listToken) return;
        showError(error.message);
    }
}

// 保存 / 删除之后刷新当前这一页（保持当前的筛选和排序不变）。
async function refreshProfiles() {
    await loadProfileList(state.profileQuery.page);
}

function highlightActiveRow() {
    $("profileList").querySelectorAll(".profile-row").forEach((row) => {
        const active = Number(row.dataset.id) === state.activeProfileId;
        row.classList.toggle("active", active);
        row.setAttribute("aria-selected", String(active));
    });
}

function highlightTerm(text, term) {
    const safe = escapeHtml(text);
    if (!term) return safe;
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index < 0) return safe;
    return escapeHtml(text.slice(0, index)) + `<mark>${escapeHtml(text.slice(index, index + term.length))}</mark>` +
        escapeHtml(text.slice(index + term.length));
}

function birthLabel(birthTime, calendar) {
    return formatBirth(birthTime) + (calendar === "j" ? " 儒" : "");
}

// 每行行尾显示「排序依据的值」，让人看得出为什么是这个顺序。按名字、出生时间排序时不需要（名字、出生已经显示）。
function sortValueText(item) {
    if (!("sort_value" in item)) return "";
    const sort = state.profileList.sort;
    const value = item.sort_value;
    if (sort === "opened") return value ? `打开 ${formatDayTime(value)}` : "未打开过";
    if (sort === "updated") return value ? `修改 ${formatDay(value)}` : "";
    if (sort === "created") return value ? `添加 ${formatDay(value)}` : "";
    if (String(sort).startsWith("field:")) {
        const field = fieldById(sort.slice("field:".length));
        const label = field ? field.label : "字段";
        return value === null || value === undefined || value === "" ? `${label} 未填` : `${label} ${value}`;
    }
    return "";
}

function renderProfileList() {
    const box = $("profileList");
    const list = state.profileList;
    box.innerHTML = "";

    if (!list.items.length) {
        const empty = document.createElement("p");
        empty.className = "muted profile-empty";
        empty.textContent = hasActiveFilter() ? "没有符合条件的档案。" : "还没有档案。";
        box.appendChild(empty);
    }

    for (const item of list.items) {
        const row = document.createElement("div");
        row.className = "profile-row";
        row.dataset.id = String(item.id);
        row.tabIndex = 0;
        row.setAttribute("role", "option");

        const tags = (item.tags || [])
            .map((tag) => `<span class="chip small">${escapeHtml(tag)}</span>`)
            .join("");
        row.title = `${item.display_name}\n出生 ${formatBirth(item.birth_time)}${item.calendar === "j" ? "（儒略历）" : ""}` +
            `\n修改于 ${formatDay(item.updated_at)}` +
            ((item.tags || []).length ? `\n标签：${item.tags.join("、")}` : "");
        const sortText = sortValueText(item);
        if (sortText) row.title += `\n${sortText}`;
        const match = item.match
            ? `<div class="profile-row-match"><span class="match-field">${escapeHtml(item.match.field)}</span>${highlightTerm(item.match.text, item.match.term)}</div>`
            : "";
        row.innerHTML = `
            <div class="profile-row-main">
                <span class="profile-row-name">${escapeHtml(item.display_name)}</span>
                <span class="chips">${tags}</span>
                ${sortText ? `<span class="profile-row-sort${item.sort_value == null || item.sort_value === "" ? " empty" : ""}">${escapeHtml(sortText)}</span>` : ""}
                <span class="profile-row-birth">${escapeHtml(birthLabel(item.birth_time, item.calendar))}</span>
                <button type="button" class="profile-row-del" title="删除这份档案" aria-label="删除「${escapeHtml(item.display_name)}」的档案">${ICON_TRASH}</button>
            </div>
            ${match}
        `;
        const del = row.querySelector(".profile-row-del");
        del.addEventListener("click", (event) => {
            event.stopPropagation();          // 不要同时触发「选中这一行」
            deleteProfileFromList(item);
        });
        del.addEventListener("keydown", (event) => event.stopPropagation());

        const open = async () => {
            try {
                await selectProfile(item.id);
            } catch (error) {
                showError(error.message);
            }
        };
        row.addEventListener("click", open);
        row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const sibling = event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
                sibling?.focus();
            }
        });
        box.appendChild(row);
    }

    $("profileTotal").textContent = hasActiveFilter() ? `筛出 ${list.total} 人` : `共 ${list.total} 人`;
    $("profileLibraryCount").textContent = state.libraryTotal != null ? `共 ${state.libraryTotal} 人` : "";
    $("pageJump").value = String(list.page);
    $("pageJump").max = String(Math.max(1, list.totalPages));
    $("pageCount").textContent = String(Math.max(1, list.totalPages));
    $("prevPageBtn").disabled = list.page <= 1;
    $("nextPageBtn").disabled = !list.hasMore;
    highlightActiveRow();
}

function fieldById(id) {
    return state.profileFields.find((f) => String(f.id) === String(id));
}

function sortableFields() {
    return state.profileFields.filter((f) => f.sortable);
}

// 排序下拉框：固定的几项 + 每个“数字 / 日期”类型的自定义字段。
function renderSortOptions() {
    const options = [...CORE_SORT_OPTIONS];
    for (const field of sortableFields()) {
        options.push({value: `field:${field.id}`, label: `${fieldPathText(field)}（${field.kind_label}）`});
    }
    // 正在用来排序的字段被删掉了、或不再可排序：退回默认排序（最近打开），并记住。
    if (!options.some((o) => o.value === state.profileQuery.sort)) {
        state.profileQuery.sort = DEFAULT_SORT;
        state.profileQuery.order = defaultOrder(DEFAULT_SORT);
        saveProfileSort();
    }
    fillSelect($("sortSelect"), options);
    $("sortSelect").value = state.profileQuery.sort;
    renderOrderSelect();
}

function renderOrderSelect() {
    const labels = orderLabels(state.profileQuery.sort);
    fillSelect($("orderSelect"), [{value: "desc", label: labels.desc}, {value: "asc", label: labels.asc}]);
    $("orderSelect").value = state.profileQuery.order;
}

// ---------- 字段条件（数字 / 日期按范围；单选 / 多选按选项，满足任一；多条条件之间是“并且”） ----------

let fieldFilterUid = 0;
const reloadFromFilters = debounce(() => {
    updateFilterBadge();
    loadProfileList(1);
}, 300);

function addFieldFilter() {
    const first = state.profileFields.find((f) => f.filterable);
    state.profileQuery.fieldFilters.push({
        uid: ++fieldFilterUid, field: first ? String(first.id) : "", min: "", max: "", options: [], empty: false,
    });
    renderFieldFilters();
}

// 返回 true 表示有条件因字段被删 / 换类型而失效、被去掉了。
function renderFieldFilters() {
    const box = $("fieldFilters");
    const q = state.profileQuery;
    const before = q.fieldFilters.length;
    q.fieldFilters = q.fieldFilters.filter((f) => fieldById(f.field)?.filterable);
    for (const f of q.fieldFilters) {
        const options = fieldById(f.field).options || [];
        f.options = f.options.filter((o) => options.includes(o));
    }
    box.innerHTML = "";
    const fields = state.profileFields.filter((f) => f.filterable);
    $("addFieldFilterBtn").disabled = !fields.length;
    $("addFieldFilterBtn").title = fields.length ? "" : "还没有数字、日期、单选或多选字段";

    for (const flt of q.fieldFilters) {
        const field = fieldById(flt.field);
        const row = document.createElement("div");
        row.className = "field-filter";

        const select = document.createElement("select");
        fillSelect(select, fields.map((f) => ({value: String(f.id), label: `${fieldPathText(f)}（${f.kind_label}）`})));
        select.value = String(flt.field);
        select.addEventListener("change", () => {
            Object.assign(flt, {field: select.value, min: "", max: "", options: [], empty: false});
            renderFieldFilters();
            reloadFromFilters();
        });
        row.appendChild(select);

        const body = document.createElement("div");
        body.className = "field-filter-body";
        if (field.kind === "number" || field.kind === "date") {
            const re = field.kind === "number" ? NUMBER_TEXT_RE : BORN_TEXT_RE;
            for (const key of ["min", "max"]) {
                const input = document.createElement("input");
                input.type = "text";
                input.value = flt[key];
                input.placeholder = field.kind === "number"
                    ? (key === "min" ? "最小" : "最大")
                    : (key === "min" ? "自 2015" : "至 2020-06");
                input.addEventListener("input", () => {
                    const text = input.value.trim();
                    const valid = text === "" || re.test(text);
                    input.classList.toggle("invalid", !valid);
                    if (!valid) return;
                    flt[key] = text;
                    reloadFromFilters();
                });
                body.appendChild(input);
                if (key === "min") {
                    const sep = document.createElement("span");
                    sep.className = "filter-sep";
                    sep.textContent = "～";
                    body.appendChild(sep);
                }
            }
        } else {
            const choices = [...field.options.map((o) => ({value: o, label: o})), {value: null, label: "（未填写）"}];
            for (const choice of choices) {
                const chip = document.createElement("button");
                chip.type = "button";
                const on = choice.value === null ? flt.empty : flt.options.includes(choice.value);
                chip.className = "chip" + (on ? " selected" : "");
                chip.textContent = choice.label;
                chip.addEventListener("click", () => {
                    if (choice.value === null) flt.empty = !flt.empty;
                    else if (flt.options.includes(choice.value)) flt.options = flt.options.filter((o) => o !== choice.value);
                    else flt.options.push(choice.value);
                    renderFieldFilters();
                    reloadFromFilters();
                });
                body.appendChild(chip);
            }
        }
        row.appendChild(body);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-btn small";
        remove.textContent = "×";
        remove.title = "去掉这个条件";
        remove.addEventListener("click", () => {
            q.fieldFilters = q.fieldFilters.filter((f) => f !== flt);
            renderFieldFilters();
            reloadFromFilters();
        });
        row.appendChild(remove);
        box.appendChild(row);
    }
    return q.fieldFilters.length !== before;
}

// ---------- 标签 ----------

async function refreshTagOptions() {
    try {
        state.tagOptions = await api("/api/tags?limit=500");
    } catch (_) {
        return;
    }
    renderTagDatalist();
    renderTagSuggest();
}

function renderTagDatalist() {
    const list = $("tagDatalist");
    list.innerHTML = "";
    for (const tag of state.tagOptions) {
        const option = document.createElement("option");
        option.value = tag.name;
        option.label = `${tag.profile_count} 人`;
        list.appendChild(option);
    }
}

// 编辑浮窗里的“常用标签”：点一下加上 / 去掉。
function renderTagSuggest() {
    const box = $("profileTagSuggest");
    box.innerHTML = "";
    const current = new Set(splitTags($("profileTags").value).map((t) => t.toLowerCase()));
    for (const tag of state.tagOptions.slice(0, 16)) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (current.has(tag.name.toLowerCase()) ? " selected" : "");
        chip.textContent = tag.name;
        chip.addEventListener("click", () => {
            const tags = splitTags($("profileTags").value);
            const index = tags.findIndex((t) => t.toLowerCase() === tag.name.toLowerCase());
            if (index >= 0) tags.splice(index, 1);
            else tags.push(tag.name);
            $("profileTags").value = tags.join(", ");
            renderTagSuggest();
        });
        box.appendChild(chip);
    }
}

function renderFilterChips() {
    const box = $("filterTagChips");
    box.innerHTML = "";
    for (const tag of state.profileQuery.tags) {
        const chip = document.createElement("span");
        chip.className = "chip selected";
        chip.append(tag);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chip-x";
        remove.textContent = "×";
        remove.title = "取消这个标签筛选";
        remove.addEventListener("click", () => {
            state.profileQuery.tags = state.profileQuery.tags.filter((t) => t !== tag);
            renderFilterChips();
            loadProfileList(1);
        });
        chip.appendChild(remove);
        box.appendChild(chip);
    }
    $("tagModeSelect").classList.toggle("hidden", state.profileQuery.tags.length < 2);
    updateFilterBadge();
}

// 「筛选」按钮上的小数字 = 正在生效的筛选条件个数（不含搜索框，搜索框本身就看得见；
// 也不含排序：排序在搜索框下面一直看得见，而且会被记住，不算筛选条件）。
function updateFilterBadge() {
    const q = state.profileQuery;
    const n = (q.bornFrom.trim() ? 1 : 0) + (q.bornTo.trim() ? 1 : 0) + q.tags.length +
        activeFieldFilters().length;
    $("filterBadge").textContent = String(n);
    $("filterBadge").classList.toggle("hidden", n === 0);
}

// 重置只清筛选和搜索，排序保持不变（排序是记住的浏览习惯，不是一次性的筛选条件）。
function resetProfileFilters() {
    Object.assign(state.profileQuery, {
        q: "", bornFrom: "", bornTo: "", tags: [], tagMode: "all", fieldFilters: [],
    });
    $("profileSearch").value = "";
    for (const id of ["bornFrom", "bornTo"]) {
        $(id).value = "";
        $(id).classList.remove("invalid");
    }
    $("filterTagInput").value = "";
    $("tagModeSelect").value = "all";
    renderFieldFilters();
    renderFilterChips();
    loadProfileList(1);
}

function openPicker() {
    openDialog("pickerDialog");
    loadProfileList(state.profileQuery.page || 1);
    setTimeout(() => $("profileSearch").focus(), 0);
}

function bindProfileBrowser() {
    const reload = debounce(() => {
        updateFilterBadge();
        loadProfileList(1);
    }, 300);

    $("openPickerBtn").addEventListener("click", openPicker);

    $("filterToggle").addEventListener("click", () => {
        const open = $("filterBox").classList.toggle("hidden") === false;
        $("filterToggle").setAttribute("aria-expanded", String(open));
    });

    $("profileSearch").addEventListener("input", () => {
        state.profileQuery.q = $("profileSearch").value;
        reload();
    });
    // 搜索框里按 ↓ 直接跳到列表第一个人，回车选中。
    $("profileSearch").addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "Enter") {
            const first = $("profileList").querySelector(".profile-row");
            if (!first) return;
            event.preventDefault();
            if (event.key === "Enter" && state.profileList.items.length === 1) first.click();
            else first.focus();
        }
    });

    const bindValidated = (id, re, key) => {
        $(id).addEventListener("input", () => {
            const text = $(id).value.trim();
            const valid = text === "" || re.test(text);
            $(id).classList.toggle("invalid", !valid);
            if (!valid) return;              // 还没敲完（如 “1980-”）：先不查询，免得弹出报错
            state.profileQuery[key] = text;
            reload();
        });
    };
    bindValidated("bornFrom", BORN_TEXT_RE, "bornFrom");
    bindValidated("bornTo", BORN_TEXT_RE, "bornTo");
    $("addFieldFilterBtn").addEventListener("click", addFieldFilter);

    $("searchScope").addEventListener("change", () => {
        state.profileQuery.scope = $("searchScope").value;
        $("profileSearch").placeholder = state.profileQuery.scope === "all"
            ? "全文检索：名字、标签、所有字段内容（空格分隔多个词）"
            : "搜索名字";
        if (state.profileQuery.q.trim()) reload();
    });

    $("importCsvInput").addEventListener("change", importCsv);

    $("filterTagInput").addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const added = splitTags($("filterTagInput").value);
        $("filterTagInput").value = "";
        let changed = false;
        for (const name of added) {
            if (!state.profileQuery.tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
                state.profileQuery.tags.push(name);
                changed = true;
            }
        }
        if (changed) {
            renderFilterChips();
            loadProfileList(1);
        }
    });

    $("tagModeSelect").addEventListener("change", () => {
        state.profileQuery.tagMode = $("tagModeSelect").value;
        loadProfileList(1);
    });
    // 换排序依据时方向换成它的默认方向（最近打开 / 修改 / 添加默认近的在前，名字默认正序）。
    $("sortSelect").addEventListener("change", () => {
        state.profileQuery.sort = $("sortSelect").value;
        state.profileQuery.order = defaultOrder(state.profileQuery.sort);
        renderOrderSelect();
        saveProfileSort();
        loadProfileList(1);
    });
    $("orderSelect").addEventListener("change", () => {
        state.profileQuery.order = $("orderSelect").value;
        saveProfileSort();
        loadProfileList(1);
    });
    $("resetFiltersBtn").addEventListener("click", resetProfileFilters);

    $("prevPageBtn").addEventListener("click", () => loadProfileList(state.profileList.page - 1));
    $("nextPageBtn").addEventListener("click", () => loadProfileList(state.profileList.page + 1));
    $("pageJump").addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const wanted = Math.floor(Number($("pageJump").value));
        if (!wanted) return;
        const page = Math.max(1, Math.min(wanted, state.profileList.totalPages));
        loadProfileList(page);
    });
    // 输入框里留着“当前页码”；改了没回车就离开，恢复成当前页码。
    $("pageJump").addEventListener("blur", () => {
        $("pageJump").value = String(state.profileList.page);
    });
}

// ---------- 编辑档案浮窗 ----------

// 多行文本框随内容自动变高（到浮窗高度的一半为止，再多就在框内滚动）。
function autoGrow(textarea) {
    textarea.style.height = "auto";
    const max = Math.max(160, window.innerHeight * 0.5);
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, max)}px`;
    textarea.style.overflowY = textarea.scrollHeight + 2 > max ? "auto" : "hidden";
}

// 一个字段的输入框（分组没有输入框，返回 null）。
function buildFieldInput(field, value) {
    let input;
    if (field.kind === "group") return null;
    if (field.kind === "text") {
        // 文本字段可以很长（例如上千字的分析）：多行、自动变高。
        input = document.createElement("textarea");
        input.rows = 2;
        input.addEventListener("input", () => autoGrow(input));
        requestAnimationFrame(() => autoGrow(input));
        input.value = String(value ?? "");
    } else if (field.kind === "choice") {
        input = document.createElement("select");
        fillSelect(input, [{value: "", label: "—"}, ...field.options.map((o) => ({value: o, label: o}))]);
        input.value = field.options.includes(value) ? value : "";
    } else if (field.kind === "multi") {
        // 多选：一排可以点选的选项。
        input = document.createElement("div");
        input.className = "chips multi-input";
        const selected = new Set(Array.isArray(value) ? value : String(value ?? "").split(/[、;；,，]/).map((v) => v.trim()).filter(Boolean));
        for (const option of field.options) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip" + (selected.has(option) ? " selected" : "");
            chip.textContent = option;
            chip.dataset.option = option;
            chip.addEventListener("click", () => chip.classList.toggle("selected"));
            input.appendChild(chip);
        }
        if (!field.options.length) input.innerHTML = "<span class='muted'>还没有选项</span>";
    } else {
        input = document.createElement("input");
        input.type = "text";
        if (field.kind === "number") {
            input.inputMode = "decimal";
            input.placeholder = "12、-3.5";
        } else {
            input.placeholder = "2020-05-12、2020-05 或 2020";
        }
        input.value = String(value ?? "");
    }
    input.dataset.fieldId = String(field.id);
    input.dataset.kind = field.kind;
    return input;
}

// preserved：{字段id: 值}，用于重画输入框时保留已填内容。
// 字段按树形排列：下级字段缩进放在上级下面；分组只是一个标题。
function renderProfileCustomFields(preserved = null) {
    const box = $("profileCustomFields");
    box.innerHTML = "";

    const draw = (field, parent) => {
        const kids = fieldChildren(field.id);
        const wrap = document.createElement("div");
        wrap.className = "custom-field" + (field.kind === "group" ? " group" : "");
        const title = document.createElement("span");
        title.className = "custom-field-title";
        title.textContent = field.kind === "text" || field.kind === "group" ? field.label : `${field.label}（${field.kind_label}）`;
        wrap.appendChild(title);
        const input = buildFieldInput(field, preserved?.[field.id]);
        if (field.kind === "text") {
            const counter = document.createElement("span");
            counter.className = "char-count";
            const update = () => { counter.textContent = input.value ? `${input.value.length} 字` : ""; };
            input.addEventListener("input", update);
            update();
            title.appendChild(counter);
        }
        if (input) {
            const label = document.createElement("label");
            label.className = "custom-field-input";
            label.appendChild(input);
            wrap.appendChild(label);
        }
        if (kids.length) {
            const sub = document.createElement("div");
            sub.className = "custom-field-children";
            kids.forEach((k) => draw(k, sub));
            wrap.appendChild(sub);
        }
        parent.appendChild(wrap);
    };
    fieldChildren(null).forEach((f) => draw(f, box));
    if (!state.profileFields.length) {
        box.innerHTML = "<p class='muted'>还没有自定义字段。</p>";
    }
}

function collectProfileFields() {
    const values = {};
    $("profileCustomFields").querySelectorAll("[data-field-id]").forEach((el) => {
        if (el.dataset.kind === "multi") {
            values[el.dataset.fieldId] = Array.from(el.querySelectorAll(".chip.selected")).map((c) => c.dataset.option);
        } else {
            values[el.dataset.fieldId] = el.value;
        }
    });
    return values;
}

const CALENDAR_NAMES = {g: "格里历", j: "儒略历"};

function birthSummary() {
    const time = getLocalTime() || "（日期时间未填完整）";
    return `出生数据：${time} · ${CALENDAR_NAMES[currentCalendar()]} · UTC${$("timezone").value.trim() || "?"} · ` +
        `${formatCoord($("latitude").value, "latitude")} · ${formatCoord($("longitude").value, "longitude")}`;
}

// mode: "edit"（编辑当前人物）或 "new"（新建）
function openEditor(mode) {
    state.editorMode = mode;
    const p = mode === "edit" ? state.activeProfile : null;
    $("editorTitle").textContent = p ? `编辑档案：${p.display_name}` : "新建档案";
    $("profileName").value = p?.display_name || "";
    $("profileTags").value = (p?.tags || []).join(", ");
    renderProfileCustomFields(p?.fields || {});
    renderTagSuggest();
    renderFieldManager();
    renderTagManager();
    $("editorBirthInfo").textContent = birthSummary();
    $("deleteProfileBtn").classList.toggle("hidden", !p);
    $("saveAsNewBtn").classList.toggle("hidden", !p);
    $("saveProfileBtn").textContent = p ? "保存修改" : "创建档案";
    openDialog("editorDialog");
    setTimeout(() => $("profileName").focus(), 0);
}

function profilePayload() {
    return {
        display_name: $("profileName").value.trim(),
        birth_time: getLocalTime(),
        calendar: currentCalendar(),
        timezone_offset: $("timezone").value.trim(),
        latitude: Number($("latitude").value),
        longitude: Number($("longitude").value),
        tags: splitTags($("profileTags").value),
        fields: collectProfileFields(),
    };
}

function checkProfileForm() {
    if (!formComplete()) {
        showError("请先在左侧「时间与地点」里填写完整、合法的本地时间、时区、纬度、经度。");
        return null;
    }
    const payload = profilePayload();
    if (!payload.display_name) {
        showError("人物名称不能为空。");
        $("profileName").focus();
        return null;
    }
    return payload;
}

// 保存 / 新建成功后：把服务器整理过的结果设为当前人物，并刷新列表和标签。
// 新建（包括在过境里「存为档案」）时，新档案成为本命盘；编辑保存时本命盘的时刻就是表单里的，不必重算。
async function afterProfileSaved(saved, {isNew = false} = {}) {
    const full = await api(`/api/profiles/${saved.id}`);
    closeDialog("editorDialog");
    if (isNew) {
        await useProfileForNatal(full);
    } else {
        setActiveProfile(full);
        updateViewUI();
    }
    await Promise.all([refreshProfiles(), refreshTagOptions()]);
}

async function createProfile() {
    const payload = checkProfileForm();
    if (!payload) return;
    try {
        showError("");
        // 列表不是全量加载的，同名检查交给后端。
        const check = await api(`/api/profiles/check-name?name=${encodeURIComponent(payload.display_name)}`);
        if (check.count > 0 && !confirm(`已经有 ${check.count} 份叫「${payload.display_name}」的档案了，仍要再新建一份吗？`)) {
            return;
        }
        const saved = await api("/api/profiles", {method: "POST", body: JSON.stringify(payload)});
        await afterProfileSaved(saved, {isNew: true});
        setStatus(`已新建档案「${saved.display_name}」`);
    } catch (error) {
        showError(error.message);
    }
}

async function saveActiveProfile() {
    if (state.editorMode !== "edit" || !state.activeProfileId) {
        await createProfile();
        return;
    }
    const payload = checkProfileForm();
    if (!payload) return;
    try {
        showError("");
        const saved = await api(`/api/profiles/${state.activeProfileId}`, {
            method: "PUT",
            body: JSON.stringify(payload),
        });
        await afterProfileSaved(saved);
        setStatus(`已保存「${saved.display_name}」`);
    } catch (error) {
        showError(error.message);
    }
}

// 在「选择人物」列表里直接删除某一份档案（不必先选中、再打开编辑窗口）。
async function deleteProfileFromList(item) {
    if (!confirm(`确定删除「${item.display_name}」的档案？删除后无法恢复。`)) return;
    try {
        showError("");
        await api(`/api/profiles/${item.id}`, {method: "DELETE"});
        if (item.id === state.activeProfileId) await useProfileForNatal(null);
        await Promise.all([refreshProfiles(), refreshTagOptions()]);
        setStatus(`已删除「${item.display_name}」`);
    } catch (error) {
        showError(error.message);
    }
}

async function deleteActiveProfile() {
    if (!state.activeProfileId) return;
    if (!confirm(`确定删除「${state.activeProfile?.display_name || ""}」的档案？删除后无法恢复。`)) return;
    try {
        await api(`/api/profiles/${state.activeProfileId}`, {method: "DELETE"});
        closeDialog("editorDialog");
        await useProfileForNatal(null);
        await Promise.all([refreshProfiles(), refreshTagOptions()]);
        setStatus("档案已删除");
    } catch (error) {
        showError(error.message);
    }
}

function bindProfileActions() {
    bindProfileBrowser();

    $("editProfileBtn").addEventListener("click", () => openEditor("edit"));
    $("newProfileBtn").addEventListener("click", () => openEditor("new"));
    $("saveProfileBtn").addEventListener("click", saveActiveProfile);
    $("saveAsNewBtn").addEventListener("click", createProfile);
    $("deleteProfileBtn").addEventListener("click", deleteActiveProfile);
    $("profileTags").addEventListener("input", renderTagSuggest);
    // 浮窗里按 Ctrl/⌘ + 回车保存
    $("editorDialog").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            saveActiveProfile();
        }
    });

    bindFieldManager();
}

// ---------- 标签管理（改名 / 合并 / 删除） ----------

async function renderTagManager() {
    const box = $("tagManagerList");
    let tags = [];
    try {
        tags = await api("/api/tags?limit=5000");
    } catch (error) {
        showError(error.message);
        return;
    }
    $("tagManagerCount").textContent = tags.length ? `${tags.length} 个` : "";
    box.innerHTML = "";
    if (!tags.length) {
        box.innerHTML = "<p class='muted'>还没有标签。</p>";
        return;
    }
    for (const tag of tags) {
        const row = document.createElement("div");
        row.className = "tag-row";
        const name = document.createElement("input");
        name.type = "text";
        name.value = tag.name;
        name.maxLength = 30;
        name.title = "改完按回车或点别处即保存；改成已有标签的名字会把两个标签合并";
        name.addEventListener("change", async () => {
            const target = name.value.trim();
            if (!target || target === tag.name) {
                name.value = tag.name;
                return;
            }
            const existing = tags.find((t) => t.id !== tag.id && t.name.toLowerCase() === target.toLowerCase());
            if (existing && !confirm(`已经有标签「${existing.name}」，要把「${tag.name}」合并进去吗？`)) {
                name.value = tag.name;
                return;
            }
            await tagChanged(api(`/api/tags/${tag.id}`, {method: "PUT", body: JSON.stringify({name: target})}));
        });
        const count = document.createElement("span");
        count.className = "muted tag-count";
        count.textContent = `${tag.profile_count} 人`;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
            if (!confirm(`从所有档案（${tag.profile_count} 份）中去掉标签「${tag.name}」？`)) return;
            await tagChanged(api(`/api/tags/${tag.id}`, {method: "DELETE"}));
        });
        row.append(name, count, del);
        box.appendChild(row);
    }
}

async function tagChanged(request) {
    try {
        showError("");
        await request;
        await Promise.all([renderTagManager(), refreshTagOptions(), refreshProfiles()]);
        if (state.activeProfileId) {
            const fresh = await api(`/api/profiles/${state.activeProfileId}`);
            setActiveProfile(fresh);
            $("profileTags").value = (fresh.tags || []).join(", ");
            renderTagSuggest();
        }
        // 正在筛选的标签被改名 / 删除：从筛选里去掉旧名字。
        const known = new Set(state.tagOptions.map((t) => t.name.toLowerCase()));
        const before = state.profileQuery.tags.length;
        state.profileQuery.tags = state.profileQuery.tags.filter((t) => known.has(t.toLowerCase()));
        if (state.profileQuery.tags.length !== before) {
            renderFilterChips();
            loadProfileList(1);
        }
    } catch (error) {
        showError(error.message);
    }
}

// ---------- CSV 导入 ----------

async function importCsv() {
    const input = $("importCsvInput");
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!confirm(`导入「${file.name}」？\n\n· id 与现有档案相同的行会覆盖那份档案\n· 其余行新建档案\n· 任何一行有错，整个导入都不会生效`)) return;
    const form = new FormData();
    form.append("file", file);
    try {
        showError("");
        const response = await fetch("/api/profiles/import", {method: "POST", body: form});
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || `导入失败：HTTP ${response.status}`);
        const r = payload.data;
        state.profileFields = await api("/api/profile-fields");
        renderSortOptions();
        renderFieldFilters();
        renderProfileCustomFields();
        renderFieldManager();
        await Promise.all([refreshTagOptions(), loadProfileList(1)]);
        if (state.activeProfileId) setActiveProfile(await api(`/api/profiles/${state.activeProfileId}`));
        const extra = [];
        if (r.new_fields.length) extra.push(`新建字段：${r.new_fields.join("、")}`);
        for (const [label, options] of Object.entries(r.new_options || {})) extra.push(`「${label}」新增选项：${options.join("、")}`);
        showNotice(`导入完成：新建 ${r.created} 份，更新 ${r.updated} 份。` + (extra.length ? "\n" + extra.join("\n") : ""));
    } catch (error) {
        showError(error.message);
    }
}

// ---------- 自定义字段：管理（增 / 改名 / 改类型 / 选项 / 删） ----------

async function reloadProfileFields() {
    const preserved = collectProfileFields();   // 保住已经敲进去、还没保存的内容
    state.profileFields = await api("/api/profile-fields");
    renderProfileCustomFields(preserved);
    renderFieldManager();
    renderProfileView();

    const sortBefore = state.profileQuery.sort;
    renderSortOptions();
    const filtersCleared = renderFieldFilters();
    if (sortBefore !== state.profileQuery.sort || filtersCleared) {
        updateFilterBadge();
        await loadProfileList(1);               // 排序 / 筛选用的字段没了，列表已退回默认
    }
}

// 可以作为上级的字段：不能是自己或自己的下级；放进去之后总层数不能超过上限。
const MAX_FIELD_DEPTH = 5;

function fieldSubtreeIds(id) {
    const ids = new Set([id]);
    for (const f of state.profileFields) {          // 列表是深度优先的，上级总在下级前面
        if (f.parent_id != null && ids.has(f.parent_id)) ids.add(f.id);
    }
    return ids;
}

function fieldSubtreeHeight(id) {
    const base = fieldById(id)?.depth ?? 0;
    let max = 0;
    for (const sub of fieldSubtreeIds(id)) max = Math.max(max, (fieldById(sub)?.depth ?? 0) - base);
    return max;
}

function parentOptions(field = null) {
    const blocked = field ? fieldSubtreeIds(field.id) : new Set();
    const height = field ? fieldSubtreeHeight(field.id) : 0;
    const options = [{value: "", label: "顶层"}];
    for (const f of state.profileFields) {
        if (blocked.has(f.id) || f.depth + 1 + height >= MAX_FIELD_DEPTH) continue;
        options.push({value: String(f.id), label: fieldPathText(f)});
    }
    return options;
}

function renderFieldManager() {
    const box = $("fieldManagerList");
    box.innerHTML = "";
    fillSelect($("newFieldParent"), parentOptions());

    if (!state.profileFields.length) {
        box.innerHTML = "<p class='muted'>还没有自定义字段。</p>";
        return;
    }

    const draw = (field, list) => {
        const wrap = document.createElement("div");
        wrap.className = "field-item";
        wrap.dataset.fieldId = field.id;
        const row = document.createElement("div");
        row.className = "field-row";

        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "drag-handle";
        handle.textContent = "⠿";
        handle.setAttribute("aria-label", `调整「${field.label}」在同级里的顺序：拖动，或按上下方向键`);
        bindFieldDrag(handle, wrap);

        const name = document.createElement("input");
        name.type = "text";
        name.value = field.label;
        name.maxLength = 40;
        name.addEventListener("change", async () => {
            try {
                showError("");
                await api(`/api/profile-fields/${field.id}`, {method: "PUT", body: JSON.stringify({label: name.value})});
                await reloadProfileFields();
            } catch (error) {
                showError(error.message);
                name.value = field.label;
            }
        });

        const kind = document.createElement("select");
        fillSelect(kind, state.fieldKinds);
        kind.value = field.kind;
        kind.setAttribute("aria-label", "字段类型");
        kind.addEventListener("change", () => changeFieldKind(field, kind));

        const parent = document.createElement("select");
        fillSelect(parent, parentOptions(field));
        parent.value = field.parent_id == null ? "" : String(field.parent_id);
        parent.setAttribute("aria-label", "上级字段");
        parent.className = "field-parent";
        parent.addEventListener("change", async () => {
            try {
                showError("");
                await api(`/api/profile-fields/${field.id}`, {
                    method: "PUT", body: JSON.stringify({parent_id: parent.value ? Number(parent.value) : null}),
                });
                await reloadProfileFields();
            } catch (error) {
                showError(error.message);
                parent.value = field.parent_id == null ? "" : String(field.parent_id);
            }
        });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "删除";
        del.addEventListener("click", () => deleteField(field));

        row.append(handle, name, kind, parent, del);
        wrap.appendChild(row);
        if (field.kind === "choice" || field.kind === "multi") wrap.appendChild(buildOptionEditor(field));
        const kids = fieldChildren(field.id);
        if (kids.length) {
            const sub = document.createElement("div");
            sub.className = "field-children";
            kids.forEach((k) => draw(k, sub));
            wrap.appendChild(sub);
        }
        list.appendChild(wrap);
    };
    fieldChildren(null).forEach((f) => draw(f, box));
}

// ---------- 字段顺序：拖动把手，或选中把手后按上下方向键 ----------

// 按显示顺序（深度优先）列出全部字段 id；后端据此排好每一级里的先后。
function fieldOrderFromDom() {
    return [...$("fieldManagerList").querySelectorAll(".field-item")].map((el) => Number(el.dataset.fieldId));
}

let fieldOrderSaving = Promise.resolve();

function saveFieldOrder() {
    const ids = fieldOrderFromDom();
    if (ids.join() === state.profileFields.map((f) => f.id).join()) return;
    const run = async () => {
        try {
            showError("");
            state.profileFields = await api("/api/profile-fields/order", {method: "PUT", body: JSON.stringify({ids})});
            const preserved = collectProfileFields();
            renderProfileCustomFields(preserved);
            renderProfileView();
            renderSortOptions();
            renderFieldFilters();
        } catch (error) {
            showError(error.message);
            renderFieldManager();
        }
    };
    fieldOrderSaving = fieldOrderSaving.then(run);   // 连续调整时按先后依次保存
}

function bindFieldDrag(handle, item) {
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.focus({preventScroll: true});
        // 监听挂在 document 上：拖动中条目会在 DOM 里移位，挂在把手上的指针捕获会因此丢失。
        const list = item.parentElement;
        item.classList.add("dragging");
        const move = (e) => {
            const others = [...list.querySelectorAll(":scope > .field-item:not(.dragging)")];   // 只在同级之间移动
            const before = others.find((el) => {
                const r = el.getBoundingClientRect();
                return e.clientY < r.top + r.height / 2;
            });
            if (before) {
                if (item.nextElementSibling !== before) list.insertBefore(item, before);
            } else if (list.lastElementChild !== item) {
                list.appendChild(item);
            }
        };
        const end = () => {
            item.classList.remove("dragging");
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", end);
            document.removeEventListener("pointercancel", end);
            handle.focus({preventScroll: true});
            saveFieldOrder();
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", end);
        document.addEventListener("pointercancel", end);
    });
    handle.addEventListener("keydown", (event) => {
        const list = item.parentElement;
        if (event.key === "ArrowUp" && item.previousElementSibling) {
            list.insertBefore(item, item.previousElementSibling);
        } else if (event.key === "ArrowDown" && item.nextElementSibling) {
            list.insertBefore(item.nextElementSibling, item);
        } else {
            return;
        }
        event.preventDefault();
        handle.focus({preventScroll: true});
        item.scrollIntoView({block: "nearest"});
        saveFieldOrder();
    });
}

async function changeFieldKind(field, select) {
    const target = select.value;
    const toChoice = target === "choice" || target === "multi";
    const fromChoice = field.kind === "choice" || field.kind === "multi";
    let message = "";
    if (target === "group") {
        const usage = await api(`/api/profile-fields/${field.id}/usage`);
        const own = usage.own_profiles ?? 0;
        message = `把「${field.label}」改成分组？\n\n分组自己不存内容，只用来收纳下级字段。` +
            (own ? `这个字段已有 ${own} 份档案填了内容，改完会被清掉（下级字段不受影响）。` : "");
    } else if (toChoice && !fromChoice) {
        message = `把「${field.label}」改成${target === "choice" ? "单选" : "多选"}字段？\n\n现有的不同取值会自动变成选项` +
            (target === "multi" ? "（按顿号、逗号、分号拆开）" : "") + "。";
    } else if (fromChoice && !toChoice) {
        message = `把「${field.label}」改成${select.selectedOptions[0].textContent}字段？\n\n已选的内容保留为文字，选项列表会被去掉。`;
    }
    if (message && !confirm(message)) {
        select.value = field.kind;
        return;
    }
    try {
        showError("");
        const saved = await api(`/api/profile-fields/${field.id}`, {
            method: "PUT",
            body: JSON.stringify({kind: target}),
        });
        await reloadProfileFields();
        setStatus(`字段「${saved.label}」已改为${saved.kind_label}类型`);
        if (saved.unparsed_count) {
            showError(
                `字段「${saved.label}」已改为${saved.kind_label}类型，但有 ${saved.unparsed_count} 份档案里这一项的内容无法识别：` +
                `原文都还在，只是不参与排序和筛选；之后保存这些档案时，需要先把这一项改成合法写法或清空。`
            );
        }
    } catch (error) {
        showError(error.message);
        select.value = field.kind;
    }
}

// 单选 / 多选字段的选项：改名（已选的人跟着改）、删除（已选的人这一项被清掉）、添加。
function buildOptionEditor(field) {
    const box = document.createElement("div");
    box.className = "option-editor";

    const save = async (options, renames = {}) => {
        try {
            showError("");
            await api(`/api/profile-fields/${field.id}`, {
                method: "PUT",
                body: JSON.stringify({options, renames}),
            });
            await reloadProfileFields();
            if (state.activeProfileId) setActiveProfile(await api(`/api/profiles/${state.activeProfileId}`));
        } catch (error) {
            showError(error.message);
            renderFieldManager();
        }
    };

    field.options.forEach((option, index) => {
        const item = document.createElement("span");
        item.className = "option-item";
        const input = document.createElement("input");
        input.type = "text";
        input.value = option;
        input.maxLength = 30;
        input.title = "改完按回车或点别处即保存；已选这个选项的档案会跟着改名";
        input.size = Math.max(2, option.length + 1);
        input.addEventListener("change", () => {
            const name = input.value.trim();
            if (!name || name === option) {
                input.value = option;
                return;
            }
            const options = field.options.slice();
            options[index] = name;
            save(options, {[option]: name});
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chip-x";
        remove.textContent = "×";
        remove.title = "删除这个选项";
        remove.addEventListener("click", async () => {
            const usage = (await api(`/api/profile-fields/${field.id}/option-usage`))[option] || 0;
            if (usage && !confirm(`删除选项「${option}」？\n\n有 ${usage} 份档案选了它，这些档案里的这一项会被清掉。`)) return;
            save(field.options.filter((o) => o !== option));
        });
        item.append(input, remove);
        box.appendChild(item);
    });

    const add = document.createElement("input");
    add.type = "text";
    add.placeholder = "＋ 新选项，回车添加";
    add.maxLength = 30;
    add.className = "option-add";
    add.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const name = add.value.trim();
        if (name) save([...field.options, name]);
    });
    box.appendChild(add);
    return box;
}

async function addField() {
    const input = $("newFieldLabel");
    const label = input.value.trim();
    if (!label) return;
    const kind = $("newFieldKind").value;
    const parentId = $("newFieldParent").value ? Number($("newFieldParent").value) : null;
    let options = [];
    if (kind === "choice" || kind === "multi") {
        const text = prompt(`「${label}」的选项（用逗号或顿号分隔，以后也可以再改）：`, "");
        if (text === null) return;
        options = text.split(/[,，、;；]/).map((o) => o.trim()).filter(Boolean);
    }

    try {
        showError("");
        await api("/api/profile-fields", {
            method: "POST",
            body: JSON.stringify({label, kind, options, parent_id: parentId}),
        });
        input.value = "";
        await reloadProfileFields();
        setStatus(`已为所有档案添加字段「${label}」`);
    } catch (error) {
        showError(error.message);
    }
}

async function deleteField(field) {
    try {
        showError("");
        // 先取最新的“有多少份档案填了内容”，让确认框里的数字是准的（含全部下级字段）。
        const usage = await api(`/api/profile-fields/${field.id}/usage`);
        const parts = [];
        if (usage.descendants) parts.push(`它的 ${usage.descendants} 个下级字段会一起删除。`);
        if (usage.profiles) parts.push(`所有档案中的这些内容都会被一并删除（目前有 ${usage.profiles} 份档案填了内容），且无法恢复。`);
        if (!confirm(`确定删除字段「${fieldPathText(field)}」吗？` + (parts.length ? "\n\n" + parts.join("\n") : ""))) return;

        await api(`/api/profile-fields/${field.id}`, {method: "DELETE"});
        await reloadProfileFields();
        if (state.activeProfileId) {
            setActiveProfile(await api(`/api/profiles/${state.activeProfileId}`));
        }
        await refreshProfiles();
        setStatus(`已删除字段「${fieldPathText(field)}」`);
    } catch (error) {
        showError(error.message);
    }
}

function bindFieldManager() {
    $("addFieldBtn").addEventListener("click", addField);
    $("newFieldLabel").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addField();
        }
    });
}

// ================= 档案库加密（SQLCipher，按库单独设置） =================
// 加密后，档案库文件在磁盘上是密文；每次打开程序（或点「立即锁定」后）要输入密码才能看到这个库。
// 忘记密码，数据无法找回。

// info = 423 响应：{library: 被锁定的库, libraries: [{name, encrypted, locked}...]}
let unlockTarget = null;

function openUnlockDialog(info = {}) {
    // 隐藏着的体系不弹窗（不抢当前体系的焦点），等被切换到时再弹。
    if (!frameActive()) {
        pendingUnlockInfo = info;
        return;
    }
    const dialog = $("unlockDialog");
    unlockTarget = info.library || state.library || null;
    $("unlockTitle").textContent = unlockTarget ? `档案库「${unlockTarget}」已加密` : "档案库已加密";
    const others = (info.libraries || state.libraries || []).filter((lib) => lib.name !== unlockTarget);
    const select = $("unlockSwitchSelect");
    select.innerHTML = others.map((lib) =>
        `<option value="${escapeHtml(lib.name)}">${escapeHtml(lib.name)}${lib.locked ? "（已锁定）" : ""}</option>`).join("");
    $("unlockSwitch").classList.toggle("hidden", !others.length);
    if (dialog.open) return;
    $("unlockPassword").value = "";
    $("unlockMsg").textContent = "";
    $("unlockMsg").classList.add("hidden");
    dialog.showModal();
    setTimeout(() => $("unlockPassword").focus(), 0);
}

function showUnlockMessage(text) {
    $("unlockMsg").textContent = text;
    $("unlockMsg").classList.remove("hidden");
}

function bindUnlockDialog() {
    const dialog = $("unlockDialog");
    if (dialog.dataset.bound) return;
    dialog.dataset.bound = "1";
    dialog.addEventListener("cancel", (event) => event.preventDefault());   // 不解锁（或不换库）就不能关
    $("unlockForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = $("unlockBtn");
        button.disabled = true;
        try {
            // 这里只解锁。取消加密在档案库菜单的「加密设置（取消加密 / 改密码）…」里。
            await api("/api/security/unlock", {method: "POST",
                body: JSON.stringify({library: unlockTarget, password: $("unlockPassword").value})});
            location.reload();
        } catch (error) {
            showUnlockMessage(error.message);
            $("unlockPassword").select();
        } finally {
            button.disabled = false;
        }
    });
    $("unlockSwitchBtn").addEventListener("click", async () => {
        const name = $("unlockSwitchSelect").value;
        if (!name) return;
        try {
            await apiRaw("/api/libraries/switch", {method: "POST", body: JSON.stringify({name})});
            location.reload();
        } catch (error) {
            if (error.locked) {
                openUnlockDialog(error.payload);
                $("unlockPassword").value = "";
                $("unlockMsg").classList.add("hidden");
                $("unlockPassword").focus();
            } else {
                showUnlockMessage(error.message);
            }
        }
    });
}

async function openSecurityDialog() {
    try {
        state.security = await api(`/api/security?library=${encodeURIComponent(state.library || "")}`);
    } catch (error) {
        showError(error.message);
        return;
    }
    renderSecurityDialog();
    openDialog("securityDialog");
}

function securityField(id, label, autocomplete = "new-password") {
    return `<label>${label}<input id="${id}" type="password" autocomplete="${autocomplete}" spellcheck="false"></label>`;
}

function renderSecurityDialog() {
    const s = state.security || {};
    const body = $("securityBody");
    const name = escapeHtml(s.library || state.library || "");
    if (!s.available) {
        body.innerHTML = `
            <p class="security-state off">「${name}」未加密</p>
            <p>加密功能需要 SQLCipher：请先在命令行运行 <code>pip install sqlcipher3-wheels</code>，然后重新启动程序。</p>`;
        return;
    }
    if (!s.enabled) {
        body.innerHTML = `
            <p class="security-state off">「${name}」未加密</p>
            <p>只加密这一个档案库，其他档案库不受影响。每个加密的档案库有自己的密码。</p>
            <p class="security-warn">密码不保存在任何地方。<b>忘记密码，这个档案库无法找回</b>，请务必记牢，并定期备份
               <code>user_data</code> 文件夹。</p>
            <form id="securityEnableForm" class="stack" novalidate>
                ${securityField("secNew", "设置密码（至少 6 个字符）")}
                ${securityField("secNew2", "再输入一次")}
                <div class="button-row"><button type="submit" class="accent-btn">加密</button></div>
            </form>`;
        $("securityEnableForm").addEventListener("submit", (event) => {
            event.preventDefault();
            if ($("secNew").value !== $("secNew2").value) return showError("两次输入的密码不一样。");
            securityAction("/api/security/enable", {password: $("secNew").value}, "已加密。");
        });
        return;
    }
    // 「取消加密」直接展开放在最前面：使用者最常来这里就是为了不想每次输密码。
    body.innerHTML = `
        <p class="security-state on">「${name}」已加密 · ${s.unlocked ? "已解锁" : "已锁定"}</p>
        <section class="security-section">
            <h3>取消加密</h3>
            <p class="muted">取消后，打开这个档案库不再需要密码，文件以普通 SQLite 格式保存在磁盘上。档案内容不变。</p>
            <form id="securityDisableForm" class="stack" novalidate>
                ${securityField("secOff", "当前密码", "current-password")}
                <div class="button-row"><button type="submit" class="danger">取消加密</button></div>
            </form>
        </section>
        <div class="button-row"><button id="secLockBtn" type="button">立即锁定</button></div>
        <details class="fold nested">
            <summary>更改密码</summary>
            <form id="securityChangeForm" class="stack fold-body" novalidate>
                ${securityField("secOld", "当前密码", "current-password")}
                ${securityField("secNew", "新密码（至少 6 个字符）")}
                ${securityField("secNew2", "再输入一次新密码")}
                <div class="button-row"><button type="submit" class="accent-btn">更改密码</button></div>
            </form>
        </details>`;
    $("secLockBtn").addEventListener("click", async () => {
        try {
            await api("/api/security/lock", {method: "POST", body: JSON.stringify({library: s.library})});
            location.reload();
        } catch (error) {
            showError(error.message);
        }
    });
    $("securityChangeForm").addEventListener("submit", (event) => {
        event.preventDefault();
        if ($("secNew").value !== $("secNew2").value) return showError("两次输入的新密码不一样。");
        securityAction("/api/security/password", {old_password: $("secOld").value, new_password: $("secNew").value}, "密码已更改。");
    });
    $("securityDisableForm").addEventListener("submit", (event) => {
        event.preventDefault();
        if (!confirm(`取消加密后，「${s.library}」会以明文保存在磁盘上。确定？`)) return;
        securityAction("/api/security/disable", {password: $("secOff").value}, "已取消加密。");
    });
}

async function securityAction(url, payload, message) {
    try {
        showError("");
        state.security = await api(url, {method: "POST", body: JSON.stringify({library: state.security?.library || state.library, ...payload})});
        renderSecurityDialog();
        showNotice(message);
        refreshProfiles();
    } catch (error) {
        showError(error.message);
    }
}

// ================= 启动 =================

async function init() {
    bindEmbedding();
    try {
        setStatus("初始化中");
        const systemId = document.body.dataset.system;
        let bootstrap;
        try {
            bootstrap = await api(`/api/bootstrap?system=${encodeURIComponent(systemId)}`);
        } catch (error) {
            if (error.locked) {
                bindUnlockDialog();
                setStatus("档案库已锁定");
                openUnlockDialog(error.payload);
                return;
            }
            throw error;
        }

        state.system = bootstrap.system;
        state.security = bootstrap.security;
        state.settings = bootstrap.settings;
        state.optionsMeta = bootstrap.options;
        state.profileFields = bootstrap.profile_fields || [];
        state.library = bootstrap.library;
        state.libraries = bootstrap.libraries || [];
        state.lastProfileId = bootstrap.last_profile_id || null;
        state.fieldKinds = bootstrap.field_kinds || [{value: "text", label: "文本"}, {value: "number", label: "数字"}];
        state.tagOptions = bootstrap.tags || [];
        Object.assign(state.appearance, state.settings.appearance || {});
        SYSTEM.init(bootstrap);
        for (const [tab, label] of Object.entries(SYSTEM.tabLabels || {})) {
            const button = document.querySelector(`#resultTabs [data-tab="${tab}"]`);
            if (button) button.textContent = label;
        }

        fillSelect($("houseSystem"), state.optionsMeta.house_systems);
        fillSelect($("ayanamshaMode"), state.optionsMeta.ayanamsha_modes);

        setFormFromDefaults();
        $("eclipticMode").addEventListener("change", updateAyanamshaState);
        bindCalcDefaults();
        fillSelect($("newFieldKind"), state.fieldKinds);
        renderLibrarySelect();
        bindLibraryMenu();
        applySortFromPage(bootstrap.profiles_page);     // 后端已按这个档案库保存的排序取好第一页
        renderSortOptions();
        renderFieldFilters();
        renderFilterChips();
        renderTagDatalist();
        // 启动时后端只给第一页（50 人）的基础信息，不会把整个档案库读进来。
        applyProfilePage({data: bootstrap.profiles, ...bootstrap.profiles_page});
        renderActiveProfileCard();

        bindCalcButton();
        bindDateTimeInput();
        bindCoordInputs();
        bindTimeStep();
        bindFolds();
        bindResultTabs();
        bindDrawer();
        bindTabOrderDialog();
        bindRawDialog();
    bindSettingsTransfer();
        bindDialogs();
        bindUnlockDialog();
        SYSTEM.bind();
        updateTabVisibility();
        bindProfileActions();
        bindTransitActions();
        renderViewButtons();
        updateViewUI();
        renderView();

        state.initialized = true;
        // 打开网页时显示本命盘，并自动选回上一次选中的档案。
        await restoreLastProfile();
        if (!state.activeProfile) setStatus("未选择人物");
    } catch (error) {
        showError(error.message);
        setStatus("初始化失败");
    } finally {
        resolveInitDone();
    }
}

// ================= 设置抽屉 =================
// 左上角的按钮打开 / 收起；点抽屉外面、按 Esc 也收起。抽屉里的改动和以前一样立即生效。

function drawerOpen() {
    return $("drawer").classList.contains("open");
}

function setDrawerOpen(open) {
    $("drawer").classList.toggle("open", open);
    $("drawer").setAttribute("aria-hidden", String(!open));
    $("drawerScrim").hidden = !open;
    $("drawerBtn").setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => $("drawer").querySelector("button, input, select")?.focus({preventScroll: true}), 0);
}

function bindDrawer() {
    $("drawerBtn").addEventListener("click", () => setDrawerOpen(!drawerOpen()));
    $("drawerScrim").addEventListener("click", () => setDrawerOpen(false));
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !drawerOpen() || document.querySelector("dialog[open]")) return;
        if (!$("libraryMenu").hidden) return;           // 先收起档案库菜单
        setDrawerOpen(false);
        $("drawerBtn").focus();
    });
    $("personChip").addEventListener("click", () => openPicker());
}

window.addEventListener("DOMContentLoaded", init);
