"use strict";

const state = {
    settings: null,
    optionsMeta: null,
    results: {},
    profileFields: [],
    fieldKinds: [],
    tagOptions: [],
    profileList: {items: [], page: 1, pageSize: 50, total: 0, totalPages: 1, hasMore: false},
    profileQuery: {q: "", bornFrom: "", bornTo: "", tags: [], tagMode: "all", sort: "name", order: "asc", page: 1},
    listToken: 0,
    selectToken: 0,
    activeProfileId: null,
    sourceMode: "current",
    initialized: false,
    requestToken: 0,
};

const $ = (id) => document.getElementById(id);

function setStatus(text) {
    $("statusBadge").textContent = text;
}

function showError(message) {
    const box = $("errorBox");
    if (!message) {
        box.textContent = "";
        box.classList.add("hidden");
        return;
    }
    box.textContent = String(message);
    box.classList.remove("hidden");
}

// 返回完整的响应体（除了 data，还有分页列表用的 total / page / has_more 等）。
async function apiRaw(url, options = {}) {
    const response = await fetch(url, {
        headers: {"Content-Type": "application/json"},
        ...options,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
    }
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
        "T", pad2(date.getHours()), ":", pad2(date.getMinutes()), ":", pad2(date.getSeconds()),
    ].join("");
}

function timezoneOffsetString(date = new Date()) {
    const totalMinutes = -date.getTimezoneOffset();
    const sign = totalMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(totalMinutes);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// ---------- 勾选组：主行星 / 小行星 / 恒星 共用同一套交互 ----------
// 每一项都是独立的复选框：点一下勾上，再点一下取消，互不影响；
// 每组都有「全选 / 全不选」和「已选 n/m」。恒星组另有「添加」输入框。

const PLANET_NAMES = {
    Su: "太阳", Mo: "月亮", Me: "水星", Ve: "金星", Ma: "火星", Ju: "木星", Sa: "土星",
    Ur: "天王星", Ne: "海王星", Pl: "冥王星", Ra: "罗睺", Ke: "计都",
    Ch: "凯龙", Ph: "福斯", Ce: "谷神", Pa: "智神", Jn: "婚神", Vs: "灶神",
};

function planetLabel(code) {
    return PLANET_NAMES[code] ? `${code} ${PLANET_NAMES[code]}` : code;
}

function starLabel(value) {
    const [name, designation] = String(value).split(",").map((s) => s.trim());
    return designation ? `${name} · ${designation}` : name;
}

function checkGroupBoxes(rootId) {
    return Array.from($(rootId).querySelectorAll(".check-grid input[type='checkbox']"));
}

function updateCheckCount(rootId) {
    const boxes = checkGroupBoxes(rootId);
    const checked = boxes.filter((b) => b.checked).length;
    $(rootId).querySelector(".check-count").textContent = `已选 ${checked}/${boxes.length}`;
}

function addCheckItem(rootId, value, label, checked, title = "") {
    const item = document.createElement("label");
    item.className = "check-item";
    if (title) item.title = title;

    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = value;
    box.checked = checked;
    box.addEventListener("change", () => updateCheckCount(rootId));

    const text = document.createElement("span");
    text.textContent = label;

    item.append(box, text);
    $(rootId).querySelector(".check-grid").appendChild(item);
}

function getChecked(rootId) {
    return checkGroupBoxes(rootId).filter((b) => b.checked).map((b) => b.value);
}

function setChecked(rootId, values) {
    const wanted = new Set(values || []);
    checkGroupBoxes(rootId).forEach((b) => { b.checked = wanted.has(b.value); });
    updateCheckCount(rootId);
}

function mountCheckGroup(rootId, title, items, checkedValues, options = {}) {
    const root = $(rootId);
    root.className = "check-group";
    root.innerHTML = `
        <div class="check-group-head">
            <span class="check-group-title">${escapeHtml(title)} <span class="check-count muted"></span></span>
            <span class="check-group-actions">
                <button type="button" data-act="all">全选</button>
                <button type="button" data-act="none">全不选</button>
            </span>
        </div>
        <div class="check-grid"></div>
        ${options.addable ? `
        <div class="check-add">
            <input type="text" placeholder="${escapeHtml(options.addPlaceholder || "")}">
            <button type="button" data-act="add">添加</button>
        </div>` : ""}
    `;

    const wanted = new Set(checkedValues || []);
    for (const item of items) {
        addCheckItem(rootId, item.value, item.label, wanted.has(item.value), item.title || "");
    }
    updateCheckCount(rootId);

    root.querySelector("[data-act='all']").addEventListener("click", () => {
        checkGroupBoxes(rootId).forEach((b) => { b.checked = true; });
        updateCheckCount(rootId);
    });
    root.querySelector("[data-act='none']").addEventListener("click", () => {
        checkGroupBoxes(rootId).forEach((b) => { b.checked = false; });
        updateCheckCount(rootId);
    });

    if (options.addable) {
        const input = root.querySelector(".check-add input");
        const commit = () => {
            const value = input.value.split(",").map((s) => s.trim()).filter(Boolean).join(",");
            if (!value) return;
            const existing = checkGroupBoxes(rootId).find(
                (b) => b.value.toLowerCase() === value.toLowerCase()
            );
            if (existing) existing.checked = true;
            else addCheckItem(rootId, value, starLabel(value), true, value);
            input.value = "";
            updateCheckCount(rootId);
        };
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                commit();
            }
        });
        root.querySelector("[data-act='add']").addEventListener("click", commit);
    }
}

function mountSelectionGroups() {
    const calc = state.settings.calculation_defaults;
    const meta = state.optionsMeta;

    mountCheckGroup(
        "selectedPlanets", "主行星",
        meta.main_planets.map((code) => ({value: code, label: planetLabel(code)})),
        calc.selected_planets
    );
    mountCheckGroup(
        "selectedMinorPlanets", "小行星",
        meta.minor_planets.map((code) => ({value: code, label: planetLabel(code)})),
        calc.selected_minor_planets
    );

    const stars = Array.from(new Set(calc.selected_stars || []));
    mountCheckGroup(
        "selectedStars", "恒星",
        stars.map((value) => ({value, label: starLabel(value), title: value})),
        stars,
        {addable: true, addPlaceholder: "添加恒星，如 Betelgeuse,alOri"}
    );
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

    $("elevation").value = birth.elevation;
    $("atpress").value = birth.atpress;
    $("attemp").value = birth.attemp;
    $("calendar").value = birth.calendar;

    $("eclipticMode").value = calc.ecliptic_mode;
    setSelectValue($("ayanamshaMode"), calc.ayanamsha_mode);
    $("nodeMode").value = calc.node_mode;
    $("houseSystem").value = calc.house_system;
    $("heliocentric").checked = Boolean(calc.heliocentric);
    $("strictEphe").checked = Boolean(calc.strict_ephe);
}

function formComplete() {
    return Boolean(
        $("localTime").value &&
        $("timezone").value.trim() &&
        $("latitude").value !== "" &&
        $("longitude").value !== ""
    );
}

function collectPayload() {
    return {
        birth: {
            local_time_str: $("localTime").value.replace("T", " "),
            timezone_str: $("timezone").value.trim(),
            latitude: Number($("latitude").value),
            longitude: Number($("longitude").value),
            elevation: Number($("elevation").value || 0),
            atpress: Number($("atpress").value || 1013.25),
            attemp: Number($("attemp").value || 20),
            calendar: $("calendar").value,
        },
        options: {
            ecliptic_mode: $("eclipticMode").value,
            ayanamsha_mode: $("ayanamshaMode").value,
            node_mode: $("nodeMode").value,
            house_system: $("houseSystem").value,
            heliocentric: $("heliocentric").checked,
            strict_ephe: $("strictEphe").checked,
            selected_planets: getChecked("selectedPlanets"),
            selected_minor_planets: getChecked("selectedMinorPlanets"),
            selected_stars: getChecked("selectedStars"),
            sunrise_rsmi: state.settings.calculation_defaults.sunrise_rsmi,
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

function renderKeyValue(target, obj) {
    const container = $(target);
    if (!obj || Object.keys(obj).length === 0) {
        container.innerHTML = "<p class='muted'>无数据</p>";
        return;
    }

    let html = "<div class='table-wrap'><table><tbody>";
    for (const [key, value] of Object.entries(obj)) {
        html += `<tr><th>${escapeHtml(key)}</th><td>${formatValue(value)}</td></tr>`;
    }
    html += "</tbody></table></div>";
    container.innerHTML = html;
}

// 表格里这几列固定排在最前面、按这个顺序；其余的列排在后面，彼此保持原有顺序。
const COLUMN_ORDER = ["dms", "lon", "lat", "ra", "dec", "speed"];

function orderColumns(columns) {
    const rank = (name) => {
        const index = COLUMN_ORDER.indexOf(name);
        return index === -1 ? COLUMN_ORDER.length : index;
    };
    return [...columns].sort((a, b) => rank(a) - rank(b));
}

function renderObjectMap(target, obj) {
    const container = $(target);
    if (!obj || Object.keys(obj).length === 0) {
        container.innerHTML = "<p class='muted'>无数据</p>";
        return;
    }

    const first = Object.values(obj)[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
        renderKeyValue(target, obj);
        return;
    }

    const columns = new Set();
    Object.values(obj).forEach((row) => {
        Object.keys(row || {}).forEach((key) => columns.add(key));
    });

    const cols = orderColumns(Array.from(columns));
    let html = "<div class='table-wrap'><table><thead><tr><th>项目</th>";
    html += cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    html += "</tr></thead><tbody>";

    for (const [name, row] of Object.entries(obj)) {
        html += `<tr><th>${escapeHtml(name)}</th>`;
        for (const col of cols) {
            html += `<td>${formatValue(row?.[col])}</td>`;
        }
        html += "</tr>";
    }

    html += "</tbody></table></div>";
    container.innerHTML = html;
}

function renderAllResults() {
    renderKeyValue("contextResult", state.results.context || {});
    renderObjectMap("planetResult", state.results.planet_pos || {});
    renderObjectMap("minorPlanetResult", state.results.minor_planet_pos || {});
    renderObjectMap("fixedStarResult", state.results.fixed_star_pos || {});

    const house = state.results.house_result || {};
    $("houseResult").innerHTML = `
        <h3>十二宫宫头</h3><div id="houseCuspsInner"></div>
        <h3>四轴</h3><div id="houseAxesInner"></div>
        <h3>辅助轴点</h3><div id="houseAuxInner"></div>
    `;
    renderObjectMap("houseCuspsInner", house.houses || {});
    renderObjectMap("houseAxesInner", house.axes || {});
    renderObjectMap("houseAuxInner", house.auxiliary_points || {});

    $("sunResult").innerHTML = `
        <h3>日出日落</h3><div id="sun1"></div>
        <h3>值日星</h3><div id="sun2"></div>
        <h3>行星时</h3><div id="sun3"></div>
    `;
    renderKeyValue("sun1", state.results.sun_events || {});
    renderKeyValue("sun2", state.results.day_lord_result || {});
    renderKeyValue("sun3", state.results.planetary_hour_data || {});
}

async function calculateFull() {
    if (!formComplete()) {
        showError("请先填写完整的本地时间、时区、纬度、经度。");
        setStatus("参数不完整");
        return;
    }

    const token = ++state.requestToken;
    showError("");
    setStatus("计算中");

    try {
        const result = await api("/api/chart/full", {
            method: "POST",
            body: JSON.stringify(collectPayload()),
        });

        if (token !== state.requestToken) return;

        state.results = result;
        renderAllResults();
        setStatus("已更新");
    } catch (error) {
        if (token !== state.requestToken) return;
        showError(error.message);
        setStatus("计算失败");
    }
}

async function calculatePartial(changedFields) {
    if (!formComplete()) return;

    if (!Object.keys(state.results).length) {
        await calculateFull();
        return;
    }

    const token = ++state.requestToken;
    showError("");
    setStatus("局部更新中");

    try {
        const payload = collectPayload();
        payload.changed_fields = Array.from(changedFields);
        payload.current_results = state.results;

        const updates = await api("/api/chart/partial", {
            method: "POST",
            body: JSON.stringify(payload),
        });

        if (token !== state.requestToken) return;

        Object.assign(state.results, updates);
        renderAllResults();
        setStatus("已更新");
    } catch (error) {
        if (token !== state.requestToken) return;
        showError(error.message);
        setStatus("计算失败");
    }
}

// 不再逐字段自动排盘：当前时间/位置、手动输入这两种模式下，
// 改完参数需要点这个按钮才会重新计算；calculatePartial() 保留在上面，
// 只是暂时没有自动触发它的地方了，以后想恢复自动增量计算随时能接回来。
function bindCalcButton() {
    $("calcBtn").addEventListener("click", () => {
        calculateFull();
    });
}

function updateModeUI() {
    $("profilePanel").classList.toggle("hidden", state.sourceMode !== "profile");
    document.querySelectorAll("input[name='sourceMode']").forEach((radio) => {
        radio.checked = radio.value === state.sourceMode;
    });
}

async function initializeCurrentMode() {
    state.sourceMode = "current";
    updateModeUI();

    $("localTime").value = localDateTimeString();
    $("timezone").value = timezoneOffsetString();

    const defaultLocation = state.settings.default_location;
    $("latitude").value = defaultLocation.latitude;
    $("longitude").value = defaultLocation.longitude;

    let permissionText = "权限状态未知";
    try {
        if (navigator.permissions?.query) {
            const status = await navigator.permissions.query({name: "geolocation"});
            permissionText = `权限：${status.state}`;
        }
    } catch (_) {}

    if (!navigator.geolocation) {
        $("locationInfo").textContent =
            `浏览器不支持 Geolocation API，已使用默认地点：${defaultLocation.label}。` +
            `点击右上角「排盘」计算。`;
        return;
    }

    $("locationInfo").textContent =
        `正在通过浏览器 Geolocation API 请求位置。${permissionText}。` +
        `网页无法判断底层实际来自 GPS、Wi‑Fi、基站还是系统融合定位。`;

    await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                $("latitude").value = position.coords.latitude.toFixed(6);
                $("longitude").value = position.coords.longitude.toFixed(6);

                const accuracy = Number.isFinite(position.coords.accuracy)
                    ? `${Math.round(position.coords.accuracy)} 米`
                    : "未知";

                $("locationInfo").textContent =
                    `定位方式：浏览器 Geolocation API；底层定位提供方不会暴露给网页。` +
                    `报告精度：${accuracy}；${permissionText}。点击右上角「排盘」计算。`;
                resolve();
            },
            (error) => {
                $("locationInfo").textContent =
                    `定位未获得，已使用默认地点：${defaultLocation.label}。` +
                    `原因：${error.message || "用户拒绝、系统定位不可用或定位超时"}。` +
                    `点击右上角「排盘」计算。`;
                resolve();
            },
            {
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 0,
            }
        );
    });
}

function switchToManualMode() {
    state.sourceMode = "manual";
    updateModeUI();
    $("locationInfo").textContent =
        "手动输入模式：填好时间、时区、经纬度后，点击右上角「排盘」计算。";
}

// ================= 人物档案：分页列表 =================
// 档案库可能有几万人，所以列表永远只向后端要“一页”（50 人）的基础信息：
// 名字、出生时间、修改时间、标签。点开某个人时，才去取他的时区、经纬度和全部自定义字段。

const PROFILE_PAGE_SIZE = 50;

const CORE_SORT_OPTIONS = [
    {value: "name", label: "名字"},
    {value: "birth", label: "出生时间"},
    {value: "updated", label: "最近修改"},
    {value: "created", label: "创建先后"},
    {value: "latitude", label: "纬度"},
    {value: "longitude", label: "经度"},
];

// 出生日期筛选框允许的写法：1980 / 1980-05 / 1980-05-12。
const BORN_TEXT_RE = /^\d{1,4}(?:[-/.]\d{1,2}){0,2}$/;

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

function singleLine(value) {
    return String(value ?? "").replace(/\s*[\r\n]+\s*/g, " ");
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

function hasActiveFilter() {
    const q = state.profileQuery;
    return Boolean(q.q.trim() || q.bornFrom.trim() || q.bornTo.trim() || q.tags.length);
}

function profileListUrl(page) {
    const q = state.profileQuery;
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", String(PROFILE_PAGE_SIZE));
    if (q.q.trim()) params.set("q", q.q.trim());
    if (q.bornFrom.trim()) params.set("born_from", q.bornFrom.trim());
    if (q.bornTo.trim()) params.set("born_to", q.bornTo.trim());
    for (const tag of q.tags) params.append("tag", tag);
    if (q.tags.length > 1) params.set("tag_mode", q.tagMode);
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
    };
    state.profileQuery.page = state.profileList.page;
    renderProfileList();
}

async function loadProfileList(page = 1) {
    const token = ++state.listToken;     // 连续快速操作时，只认最后一次请求的结果
    $("pagerInfo").textContent = "加载中…";
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
        $("pagerInfo").textContent = "加载失败";
    }
}

// 保存 / 删除之后刷新当前这一页（保持当前的筛选和排序不变）。
async function refreshProfiles() {
    await loadProfileList(state.profileQuery.page);
}

function highlightActiveRow() {
    $("profileList").querySelectorAll(".profile-row").forEach((row) => {
        row.classList.toggle("active", Number(row.dataset.id) === state.activeProfileId);
    });
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
        row.innerHTML = `
            <div class="profile-row-name">${escapeHtml(item.display_name)}</div>
            <div class="profile-row-meta">出生 ${escapeHtml(formatBirth(item.birth_time))} · 修改 ${escapeHtml(formatDay(item.updated_at))}</div>
            ${tags ? `<div class="chips">${tags}</div>` : ""}
        `;

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
            }
        });
        box.appendChild(row);
    }

    $("pagerInfo").textContent = `第 ${list.page} / ${list.totalPages} 页 · 共 ${list.total} 人`;
    $("prevPageBtn").disabled = list.page <= 1;
    $("nextPageBtn").disabled = !list.hasMore;
    highlightActiveRow();
}

// 排序下拉框：固定的几项 + 每个“数字”类型的自定义字段。
function renderSortOptions() {
    const options = [...CORE_SORT_OPTIONS];
    for (const field of state.profileFields) {
        if (field.kind === "number") {
            options.push({value: `field:${field.id}`, label: `${field.label}（数字）`});
        }
    }
    // 正在用来排序的字段被删掉了、或不再是数字类型：退回按名字排序。
    if (!options.some((o) => o.value === state.profileQuery.sort)) {
        state.profileQuery.sort = "name";
    }
    fillSelect($("sortSelect"), options);
    $("sortSelect").value = state.profileQuery.sort;
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

// 编辑区下方的“常用标签”：点一下加上 / 去掉。
function renderTagSuggest() {
    const box = $("profileTagSuggest");
    box.innerHTML = "";
    const current = new Set(splitTags($("profileTags").value).map((t) => t.toLowerCase()));
    for (const tag of state.tagOptions.slice(0, 12)) {
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
}

function resetProfileFilters() {
    Object.assign(state.profileQuery, {
        q: "", bornFrom: "", bornTo: "", tags: [], tagMode: "all", sort: "name", order: "asc",
    });
    $("profileSearch").value = "";
    $("bornFrom").value = "";
    $("bornTo").value = "";
    $("filterTagInput").value = "";
    $("tagModeSelect").value = "all";
    $("orderSelect").value = "asc";
    $("bornFrom").classList.remove("invalid");
    $("bornTo").classList.remove("invalid");
    renderSortOptions();
    renderFilterChips();
    loadProfileList(1);
}

function bindProfileBrowser() {
    const reload = debounce(() => loadProfileList(1), 300);

    $("profileSearch").addEventListener("input", () => {
        state.profileQuery.q = $("profileSearch").value;
        reload();
    });

    for (const [id, key] of [["bornFrom", "bornFrom"], ["bornTo", "bornTo"]]) {
        $(id).addEventListener("input", () => {
            const text = $(id).value.trim();
            const valid = text === "" || BORN_TEXT_RE.test(text);
            $(id).classList.toggle("invalid", !valid);
            if (!valid) return;              // 还没敲完（如 “1980-”）：先不查询，免得弹出报错
            state.profileQuery[key] = text;
            reload();
        });
    }

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
    $("sortSelect").addEventListener("change", () => {
        state.profileQuery.sort = $("sortSelect").value;
        loadProfileList(1);
    });
    $("orderSelect").addEventListener("change", () => {
        state.profileQuery.order = $("orderSelect").value;
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
        $("pageJump").value = "";
        loadProfileList(page);
    });

    // 编辑区的标签输入框手动改了，常用标签的高亮要跟着变。
    $("profileTags").addEventListener("input", renderTagSuggest);
}

// ---------- 自定义字段：表单里的输入框 ----------

// preserved：{字段id: 值}，用于重画输入框时保留已填内容。
function renderProfileCustomFields(preserved = null) {
    const box = $("profileCustomFields");
    box.innerHTML = "";

    for (const field of state.profileFields) {
        const isNumber = field.kind === "number";

        const label = document.createElement("label");
        label.textContent = isNumber ? `${field.label}（数字）` : field.label;

        const input = document.createElement("input");
        input.type = "text";
        if (isNumber) {
            input.inputMode = "decimal";
            input.placeholder = "数字，如 12、-3.5";
        }
        input.dataset.fieldId = String(field.id);
        input.value = singleLine(preserved?.[field.id]);     // 字段都是单行的，旧数据里的换行显示成空格

        label.appendChild(input);
        box.appendChild(label);
    }
}

function collectProfileFields() {
    const values = {};
    $("profileCustomFields").querySelectorAll("[data-field-id]").forEach((el) => {
        values[el.dataset.fieldId] = el.value;
    });
    return values;
}

function loadProfileIntoForm(profile) {
    $("profileName").value = profile.display_name || "";
    $("profileTags").value = (profile.tags || []).join(", ");
    renderProfileCustomFields(profile.fields || {});
    renderTagSuggest();
    $("localTime").value = String(profile.birth_time || "").replace(" ", "T");
    $("timezone").value = profile.timezone_offset || "";
    $("latitude").value = profile.latitude ?? "";
    $("longitude").value = profile.longitude ?? "";
}

// 点开某个人：这时才去取他的完整信息（时区、经纬度、全部自定义字段）。
async function selectProfile(profileId) {
    if (!profileId) return;
    const token = ++state.selectToken;
    const profile = await api(`/api/profiles/${profileId}`);
    if (token !== state.selectToken) return;     // 期间又点了别的人：只认最后一次点击
    state.activeProfileId = profile.id;
    loadProfileIntoForm(profile);
    highlightActiveRow();
    await calculateFull();
}

function profilePayload() {
    return {
        display_name: $("profileName").value.trim(),
        birth_time: $("localTime").value.replace("T", " "),
        timezone_offset: $("timezone").value.trim(),
        latitude: Number($("latitude").value),
        longitude: Number($("longitude").value),
        tags: splitTags($("profileTags").value),
        fields: collectProfileFields(),
    };
}

function clearProfileForm() {
    state.activeProfileId = null;
    $("profileName").value = "";
    $("profileTags").value = "";
    renderProfileCustomFields(null);
    renderTagSuggest();
    highlightActiveRow();
}

// 保存 / 新建成功后：把服务器整理过的结果（标签去重等）写回表单，并刷新列表和标签。
async function afterProfileSaved(saved) {
    state.activeProfileId = saved.id;
    $("profileTags").value = (saved.tags || []).join(", ");
    await Promise.all([refreshProfiles(), refreshTagOptions()]);
    highlightActiveRow();
}

// 「新建」：把当前表单里的内容存成一份全新的档案，并切换到这份新档案。
async function createProfileFromForm() {
    if (!formComplete()) {
        showError("请先填写完整的本地时间、时区、纬度、经度。");
        return;
    }
    const payload = profilePayload();
    if (!payload.display_name) {
        showError("人物名称不能为空。");
        return;
    }

    try {
        showError("");
        // 列表已经不是全量加载的了，同名检查交给后端。
        const check = await api(
            `/api/profiles/check-name?name=${encodeURIComponent(payload.display_name)}`
        );
        if (check.count > 0 && !confirm(`已经有 ${check.count} 份叫「${payload.display_name}」的档案了，仍要再新建一份吗？`)) {
            return;
        }

        const saved = await api("/api/profiles", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        await afterProfileSaved(saved);
        setStatus(`已新建档案「${saved.display_name}」`);
    } catch (error) {
        showError(error.message);
    }
}

// 「保存」：用当前表单内容直接覆盖当前选中的那份档案。
async function saveActiveProfile() {
    if (!state.activeProfileId) {
        showError("当前没有选中的档案，无法覆盖保存。请先在上方列表里点选一份档案，或点击「新建」把当前内容存成新档案。");
        return;
    }
    if (!formComplete()) {
        showError("请先填写完整的本地时间、时区、纬度、经度。");
        return;
    }

    try {
        showError("");
        const saved = await api(`/api/profiles/${state.activeProfileId}`, {
            method: "PUT",
            body: JSON.stringify(profilePayload()),
        });
        await afterProfileSaved(saved);
        setStatus(`已覆盖保存「${saved.display_name}」`);
    } catch (error) {
        showError(error.message);
    }
}

function bindProfileActions() {
    bindProfileBrowser();

    $("newProfileBtn").addEventListener("click", createProfileFromForm);
    $("saveProfileBtn").addEventListener("click", saveActiveProfile);
    $("clearProfileBtn").addEventListener("click", clearProfileForm);

    $("deleteProfileBtn").addEventListener("click", async () => {
        if (!state.activeProfileId) return;
        if (!confirm("确定删除当前人物档案？")) return;

        try {
            await api(`/api/profiles/${state.activeProfileId}`, {
                method: "DELETE",
            });
            clearProfileForm();
            await Promise.all([refreshProfiles(), refreshTagOptions()]);
            setStatus("档案已删除");
        } catch (error) {
            showError(error.message);
        }
    });

    bindFieldManager();
}

// ---------- 自定义字段：管理（增 / 改名 / 改类型 / 删） ----------

async function reloadProfileFields() {
    const preserved = collectProfileFields();   // 保住已经敲进去、还没保存的内容
    state.profileFields = await api("/api/profile-fields");
    renderProfileCustomFields(preserved);
    renderFieldManager();

    const sortBefore = state.profileQuery.sort;
    renderSortOptions();
    if (sortBefore !== state.profileQuery.sort) {
        await loadProfileList(1);               // 排序用的字段没了，列表已退回按名字排序
    }
}

function renderFieldManager() {
    const box = $("fieldManagerList");
    box.innerHTML = "";

    if (!state.profileFields.length) {
        box.innerHTML = "<p class='muted'>还没有自定义字段。</p>";
        return;
    }

    for (const field of state.profileFields) {
        const row = document.createElement("div");
        row.className = "field-row";

        const name = document.createElement("input");
        name.type = "text";
        name.value = field.label;
        name.maxLength = 40;
        name.title = "改完按回车，或点一下别处即保存";
        name.addEventListener("change", async () => {
            try {
                showError("");
                await api(`/api/profile-fields/${field.id}`, {
                    method: "PUT",
                    body: JSON.stringify({label: name.value}),
                });
                await reloadProfileFields();
            } catch (error) {
                showError(error.message);
                name.value = field.label;
            }
        });

        const kind = document.createElement("select");
        fillSelect(kind, state.fieldKinds);
        kind.value = field.kind;
        kind.title = "字段类型";
        kind.addEventListener("change", async () => {
            try {
                showError("");
                const saved = await api(`/api/profile-fields/${field.id}`, {
                    method: "PUT",
                    body: JSON.stringify({kind: kind.value}),
                });
                await reloadProfileFields();
                setStatus(`字段「${saved.label}」已改为${saved.kind_label}类型`);
                if (saved.unparsed_count) {
                    showError(
                        `字段「${saved.label}」已改为数字类型，但有 ${saved.unparsed_count} 份档案里这一项的内容无法识别为数字：` +
                        `原文都还在，只是不参与排序；之后保存这些档案时，需要先把这一项改成数字或清空。`
                    );
                }
            } catch (error) {
                showError(error.message);
                kind.value = field.kind;
            }
        });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "删除";
        del.addEventListener("click", () => deleteField(field));

        row.append(name, kind, del);
        box.appendChild(row);
    }
}

async function addField() {
    const input = $("newFieldLabel");
    const label = input.value.trim();
    if (!label) return;

    try {
        showError("");
        await api("/api/profile-fields", {
            method: "POST",
            body: JSON.stringify({label, kind: $("newFieldKind").value}),
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
        // 先取最新的"有多少份档案填了这一项"，让确认框里的数字是准的。
        const latest = (await api("/api/profile-fields")).find((f) => f.id === field.id);
        if (!latest) {
            await reloadProfileFields();
            return;
        }

        const message = latest.used_count > 0
            ? `确定删除字段「${latest.label}」吗？\n\n所有档案中的这一项都会被一并删除（目前有 ${latest.used_count} 份档案填了内容），且无法恢复。`
            : `确定删除字段「${latest.label}」吗？`;
        if (!confirm(message)) return;

        await api(`/api/profile-fields/${field.id}`, {method: "DELETE"});
        await reloadProfileFields();
        await refreshProfiles();
        setStatus(`已从所有档案中删除字段「${latest.label}」`);
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

function bindModeSwitching() {
    document.querySelectorAll("input[name='sourceMode']").forEach((radio) => {
        radio.addEventListener("change", async () => {
            const mode = radio.value;
            if (mode === "current") {
                await initializeCurrentMode();
            } else if (mode === "manual") {
                switchToManualMode();
            } else if (mode === "profile") {
                state.sourceMode = "profile";
                updateModeUI();
                $("locationInfo").textContent =
                    "人物档案模式：在档案列表里点选一个人后立即排盘；之后如果修改了数值，需要重新点击「排盘」才会用新数值计算。";
            }
        });
    });
}

async function init() {
    try {
        setStatus("初始化中");
        const bootstrap = await api("/api/bootstrap");

        state.settings = bootstrap.settings;
        state.optionsMeta = bootstrap.options;
        state.profileFields = bootstrap.profile_fields || [];
        state.fieldKinds = bootstrap.field_kinds || [{value: "text", label: "文本"}, {value: "number", label: "数字"}];
        state.tagOptions = bootstrap.tags || [];

        fillSelect($("houseSystem"), state.optionsMeta.house_systems);
        fillSelect($("ayanamshaMode"), state.optionsMeta.ayanamsha_modes);
        mountSelectionGroups();

        setFormFromDefaults();
        fillSelect($("newFieldKind"), state.fieldKinds);
        renderSortOptions();
        renderFilterChips();
        renderTagDatalist();
        renderTagSuggest();
        // 启动时后端只给第一页（50 人）的基础信息，不会把整个档案库读进来。
        applyProfilePage({data: bootstrap.profiles, ...bootstrap.profiles_page});
        renderProfileCustomFields();
        renderFieldManager();

        bindCalcButton();
        bindModeSwitching();
        bindProfileActions();

        state.initialized = true;
        await initializeCurrentMode();
    } catch (error) {
        showError(error.message);
        setStatus("初始化失败");
    }
}

window.addEventListener("DOMContentLoaded", init);
