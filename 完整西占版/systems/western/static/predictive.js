"use strict";
/*
 * 西方占星的推运盘：日返、月返、次限、三限、日弧、小限、法达。
 *
 * - 七张盘都是「分盘」（SYSTEM.derivedViews），放在星盘上方「推运 ▾」的下拉菜单里。
 *   左侧的时间与地点用过境盘的（form: "transit"）：顶栏的时间就是推运的目标时刻，
 *   时间步进（± 1 天等）可以直接往前往后推。
 * - 日返、月返、次限、三限、日弧：后端算出一张完整的盘，右边的行星、相位、宫位……都显示这张盘（ownResults）。
 * - 小限、法达：星盘是本命盘，外面加几圈（年、月、日小限 / 法达主限、子限），走到哪里高亮哪里；
 *   右边另有「小限」「法达」两个标签页列出完整的时间表。
 * - 设置在计算设置的「推运」一组，每张盘一个浮窗。浮窗的内容按后端给的 predictive_spec 生成
 *   （字段、范围、默认值都写在 systems/western/predictive_settings.py）。
 */

const PREDICTIVE_VIEWS = [
    {kind: "solar_return", label: "日返", note: "Solar Return"},
    {kind: "lunar_return", label: "月返", note: "Lunar Return"},
    {kind: "secondary", label: "次限", note: "Secondary"},
    {kind: "tertiary", label: "三限", note: "Tertiary"},
    {kind: "solar_arc", label: "日弧", note: "Solar Arc"},
    {kind: "profection", label: "小限", note: "Profection"},
    {kind: "firdaria", label: "法达", note: "Firdaria"},
];
const TIMELORD_KINDS = ["profection", "firdaria"];
const PV_PLANET_NAMES = {
    Su: "太阳", Mo: "月亮", Me: "水星", Ve: "金星", Ma: "火星", Ju: "木星", Sa: "土星",
    Ur: "天王星", Ne: "海王星", Pl: "冥王星", Ra: "北交点", Ke: "南交点",
};
const PV_SIGN_NAMES = ["白羊", "金牛", "双子", "巨蟹", "狮子", "处女", "天秤", "天蝎", "射手", "摩羯", "水瓶", "双鱼"];

state.predictive = null;        // 推运盘设置（settings.json → systems.western.predictive）

function pvSymbol(code) {
    return state.optionsMeta.planet_symbols[code] || code;
}

function pvColor(code) {
    return state.points?.planet_colors?.[code];
}

function pvName(code) {
    return PV_PLANET_NAMES[code] || code;
}

// 本命盘的请求：出生时间地点用本命盘排盘时的，计算设置用当前的（刚改过星体配置也立刻生效）。
function pvNatalPayload(natalPayload) {
    return {birth: natalPayload.birth, options: collectPayload().options};
}

// ================= 分盘 =================

function predictiveDerive(kind) {
    return async (natal, {payload}) => {
        const target = state.charts.transit.payload?.birth;
        if (!payload || !target) throw new Error("需要本命盘和顶栏时间。");
        if (TIMELORD_KINDS.includes(kind)) {
            const data = await fetchTimelords(payload, target);
            return timelordChart(kind, natal, data);
        }
        return api(systemApi("/predictive"), {
            method: "POST",
            body: JSON.stringify({kind, natal: pvNatalPayload(payload), target, settings: state.predictive}),
        });
    };
}

function buildPredictiveViews() {
    const views = {};
    PREDICTIVE_VIEWS.forEach(({kind, label}, i) => {
        const timelord = TIMELORD_KINDS.includes(kind);
        views[kind] = {
            label,
            derive: predictiveDerive(kind),
            signature: () => JSON.stringify([state.predictive?.[kind], collectPayload().options]),
            form: "transit",
            bar: false,
            ownResults: !timelord,
            order: 100 + i,
        };
    });
    return views;
}

function buildPredictiveMenu() {
    return {
        label: "推运",
        defaultValue: "solar_return",
        items: PREDICTIVE_VIEWS.map((v) => ({value: v.kind, label: v.label, note: v.note})),
    };
}

// ---------- 小限、法达的数据（星盘外圈和两个标签页共用，同样的输入只算一次） ----------

let timelordCache = {key: "", promise: null};

function fetchTimelords(natalPayload, target) {
    const body = {
        kind: "timelords", natal: pvNatalPayload(natalPayload), target,
        settings: state.predictive,
    };
    const key = JSON.stringify(body);
    if (timelordCache.key !== key) {
        const promise = api(systemApi("/predictive"), {method: "POST", body: JSON.stringify(body)});
        timelordCache = {key, promise, data: null};
        promise.then((data) => { if (timelordCache.promise === promise) timelordCache.data = data; }).catch(() => {});
    }
    return timelordCache.promise;
}

function pvSignCell(sign) {
    return `${SIGN_GLYPHS[sign]} ${PV_SIGN_NAMES[sign]}`;
}

function pvLevelTitle(name, level) {
    const lon = level.lon === null || level.lon === undefined ? "" : ` ${pvDegText(level.lon)}`;
    return `${name} · ${PV_SIGN_NAMES[level.sign]}${lon} · 主星 ${pvName(level.lord)} · 第 ${level.house} 宫\n${level.start} 至 ${level.end}`;
}

function pvDegText(lon) {
    const x = ((Number(lon) % 360) + 360) % 360;
    const sign = Math.floor(x / 30);
    const total = Math.round((x - sign * 30) * 60);
    return `${PV_SIGN_NAMES[sign]} ${Math.floor(total / 60)}°${String(total % 60).padStart(2, "0")}′`;
}

// 小限：三圈从里往外是 年、月、日；每圈 12 格就是 12 个星座，格子里是星座的主星。
function profectionRings(p) {
    const levels = [["年小限", p.year], ["月小限", p.month], ["日小限", p.day]];
    return levels.map(([name, level]) => ({
        type: "zodiac",
        highlight: level.sign,
        marker: level.lon === null || level.lon === undefined ? null : level.lon,
        cells: p.lords.map((lord, sign) => ({
            symbol: pvSymbol(lord), color: pvColor(lord),
            title: sign === level.sign ? pvLevelTitle(name, level) : `${name} · ${PV_SIGN_NAMES[sign]} · 主星 ${pvName(lord)}`,
        })),
    }));
}

// 法达：里圈是当前主限的子限，外圈是一整轮主限。
function firdariaRings(f) {
    const cycleStart = f.cycle * f.total;
    const major = f.periods[f.current.major];
    const stateOf = (a, b, age) => (age >= b ? "past" : age >= a ? "current" : "future");
    const majors = f.periods.map((p) => ({
        start: (p.start.age - cycleStart) / f.total,
        end: (p.end.age - cycleStart) / f.total,
        symbol: pvSymbol(p.lord), color: pvColor(p.lord),
        state: stateOf(p.start.age, p.end.age, f.age),
        title: `${pvName(p.lord)}主限（${p.years} 年）\n${p.start.text} 至 ${p.end.text}`,
    }));
    const span = major.end.age - major.start.age;
    const subs = major.subs.length ? major.subs.map((s) => ({
        start: (s.start.age - major.start.age) / span,
        end: (s.end.age - major.start.age) / span,
        symbol: pvSymbol(s.lord), color: pvColor(s.lord),
        state: stateOf(s.start.age, s.end.age, f.age),
        title: `${pvName(major.lord)}主限 · ${pvName(s.lord)}子限\n${s.start.text} 至 ${s.end.text}`,
    })) : [{start: 0, end: 1, symbol: pvSymbol(major.lord), color: pvColor(major.lord), state: "current",
        title: `${pvName(major.lord)}主限（不分子限）\n${major.start.text} 至 ${major.end.text}`}];
    return [
        {type: "time", segments: subs, marker: (f.age - major.start.age) / span},
        {type: "time", segments: majors, marker: f.cycle_age / f.total},
    ];
}

function timelordChart(kind, natal, data) {
    const error = data.errors?.[kind];
    if (error) throw new Error(error);
    if (kind === "profection") {
        const p = data.profection;
        const part = (name, level) => `${name} ${PV_SIGN_NAMES[level.sign]}（${pvName(level.lord)}）`;
        return {
            ...natal,
            outer_rings: profectionRings(p),
            chart_caption: `小限 · 起点 ${p.start_label} · ${part("年", p.year)} · ${part("月", p.month)} · ${part("日", p.day)}`
                + ` · ${data.target.text} ${data.target.tz}`,
        };
    }
    const f = data.firdaria;
    const major = f.periods[f.current.major];
    const sub = f.current.sub === null ? null : major.subs[f.current.sub];
    return {
        ...natal,
        outer_rings: firdariaRings(f),
        chart_caption: `法达（${f.is_day ? "日生" : "夜生"}）· ${pvName(major.lord)}主限 ${major.start.text.slice(0, 10)} 至 ${major.end.text.slice(0, 10)}`
            + (sub ? ` · ${pvName(sub.lord)}子限 ${sub.start.text.slice(0, 10)} 至 ${sub.end.text.slice(0, 10)}` : "")
            + ` · ${data.target.text} ${data.target.tz}`,
    };
}

// ================= 右边的「小限」「法达」标签页 =================

// 目标时刻：过境盘算过就用顶栏（过境）的时间；还没打开过过境时用「现在」。
// 「现在」对同一张本命盘只取一次，避免每次重画都换一个时间、重复计算。
let timelordNow = {natal: null, birth: null};

function timelordTarget() {
    const birth = state.charts.transit.payload?.birth;
    if (birth) return birth;
    const natal = state.charts.natal.results;
    if (timelordNow.natal !== natal) timelordNow = {natal, birth: birthFromInput(nowTransitInput())};
    return timelordNow.birth;
}

function renderTimelordTabs() {
    const boxes = {profection: $("profectionResult"), firdaria: $("firdariaResult")};
    if (!boxes.profection || !boxes.firdaria) return;
    const payload = state.charts.natal.payload;
    if (!state.activeProfile || !payload || !state.charts.natal.results) {
        Object.values(boxes).forEach((b) => { b.innerHTML = "<p class='muted'>选择人物后显示</p>"; });
        return;
    }
    const promise = fetchTimelords(payload, timelordTarget());
    if (timelordCache.data && timelordCache.promise === promise) {
        drawTimelordTabs(timelordCache.data);
        return;
    }
    Object.values(boxes).forEach((b) => { if (!b.dataset.ready) b.innerHTML = "<p class='muted'>计算中…</p>"; });
    promise.then((data) => {
        if (timelordCache.promise === promise) drawTimelordTabs(data);
    }).catch((error) => {
        if (timelordCache.promise !== promise) return;
        Object.values(boxes).forEach((b) => { b.innerHTML = `<p class='point-error'>${escapeHtml(error.message)}</p>`; });
    });
}

function drawTimelordTabs(data) {
    const prof = $("profectionResult");
    const fird = $("firdariaResult");
    prof.dataset.ready = fird.dataset.ready = "1";
    const when = `<p class="pv-when">${escapeHtml(data.target.text)} ${escapeHtml(data.target.tz)}</p>`;
    prof.innerHTML = data.errors?.profection
        ? `<p class="point-error">${escapeHtml(data.errors.profection)}</p>` : when + profectionHtml(data.profection);
    fird.innerHTML = data.errors?.firdaria
        ? `<p class="point-error">${escapeHtml(data.errors.firdaria)}</p>` : when + firdariaHtml(data.firdaria);
    scrollTimelordTabs();
}

// 当前那一行滚到看得见的地方：年表在自己的小滚动框里；法达表在标签页里，滚到当前主限那一行。
// 标签页没显示时量不出位置，所以切到这两个标签页时再滚一次。
function scrollTimelordTabs() {
    $("profectionResult")?.querySelectorAll(".pv-scroll").forEach((wrap) => {
        const row = wrap.querySelector("tr.current");
        if (row) wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2);
    });
    const major = $("firdariaResult")?.querySelector("tr.pv-major.current");
    const panels = major?.closest(".tab-panels");
    if (major && panels && major.offsetParent) {
        const top = major.getBoundingClientRect().top - panels.getBoundingClientRect().top + panels.scrollTop;
        panels.scrollTop = Math.max(0, top - 80);
    }
}

// 表格：rows = [{cells: [html...], cls}]
function pvTable(headers, rows, {scroll = false} = {}) {
    if (!rows.length) return "<p class='muted'>无数据</p>";
    const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
    const body = rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    return `<div class="table-wrap${scroll ? " pv-scroll" : ""}"><table class="info-table pv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function pvSignHtml(sign) {
    return `${glyphHtml(SIGN_GLYPHS[sign], state.points?.sign_colors?.[sign])} ${escapeHtml(PV_SIGN_NAMES[sign])}`;
}

function pvLordHtml(code) {
    return `${planetGlyph(code)} ${escapeHtml(pvName(code))}`;
}

function pvPlanetsHtml(codes) {
    return codes?.length ? codes.map((c) => planetGlyph(c)).join(" ") : "<span class='muted'>—</span>";
}

function pvLevelCells(level) {
    const sign = level.lon === null || level.lon === undefined ? pvSignHtml(level.sign)
        : `${pvSignHtml(level.sign)} <span class="muted">${escapeHtml(pvDegText(level.lon).split(" ")[1])}</span>`;
    return [sign, pvLordHtml(level.lord), `${level.house}`, pvPlanetsHtml(level.planets)];
}

function profectionHtml(p) {
    const current = [["年", p.year], ["月", p.month], ["日", p.day]].map(([name, level]) => ({
        cells: [escapeHtml(name), ...pvLevelCells(level), escapeHtml(level.start), escapeHtml(level.end)],
        cls: "",
    }));
    const listRows = (list, active) => list.map((level) => ({
        cells: [String(level.index + 1), ...pvLevelCells(level), escapeHtml(level.start), escapeHtml(level.end)],
        cls: level.index === active ? "current" : "",
    }));
    const years = p.years.map((level) => ({
        cells: [String(level.age), ...pvLevelCells(level), escapeHtml(level.start)],
        cls: level.age === p.year.index ? "current" : "",
    }));
    return `
        <div class="pv-section-title">当前 · 起点 ${escapeHtml(p.start_label)}</div>
        ${pvTable(["", "星座", "主星", "宫", "本命星体", "起", "止"], current)}
        <div class="pv-section-title">本年各月</div>
        ${pvTable(["月", "星座", "主星", "宫", "本命星体", "起", "止"], listRows(p.months, p.month.index))}
        <div class="pv-section-title">本月各段</div>
        ${pvTable(["段", "星座", "主星", "宫", "本命星体", "起", "止"], listRows(p.days, p.day.index))}
        <div class="pv-section-title">年表</div>
        ${pvTable(["岁", "星座", "主星", "宫", "本命星体", "起"], years, {scroll: true})}`;
}

function firdariaHtml(f) {
    const ageText = (a) => (Math.round(a * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
    const rows = [];
    for (const p of f.periods) {
        rows.push({
            cells: [pvLordHtml(p.lord), "", escapeHtml(p.start.text), escapeHtml(p.end.text), ageText(p.start.age), ageText(p.years)],
            cls: `pv-major${p.current ? " current" : ""}`,
        });
        for (const s of p.subs) {
            rows.push({
                cells: ["", pvLordHtml(s.lord), escapeHtml(s.start.text), escapeHtml(s.end.text), ageText(s.start.age),
                    ageText(s.end.age - s.start.age)],
                cls: `pv-sub${s.current ? " current" : ""}`,
            });
        }
    }
    const order = f.sequence.map((c) => planetGlyph(c)).join(" ");
    return `
        <div class="pv-section-title">${f.is_day ? "日生" : "夜生"} · 一轮 ${ageText(f.total)} 年${f.cycle ? ` · 第 ${f.cycle + 1} 轮` : ""} · ${order}</div>
        ${pvTable(["主限", "子限", "起", "止", "起始年龄", "年数"], rows)}`;
}

// ================= 设置浮窗（计算设置 →「推运」） =================

function pvFieldVisible(field, cfg) {
    return Object.entries(field.when || {}).every(([key, values]) => values.includes(cfg[key]));
}

function pvRow(body, label) {
    const row = el("div", {class: "pv-row"});
    row.appendChild(el("span", {class: "pv-label"}, label));
    const ctl = el("div", {class: "pv-ctl"});
    row.appendChild(ctl);
    body.appendChild(row);
    return ctl;
}

function pvNumberInput(ctl, field, value, onChange) {
    const isInt = field.type === "int";
    const input = el("input", {type: "number", step: isInt ? 1 : "any", min: field.lo, max: field.hi, value,
        class: "orb-input pv-number"});
    const commit = () => {
        const n = Number(input.value);
        const ok = input.value !== "" && Number.isFinite(n) && n >= field.lo && n <= field.hi && (!isInt || Number.isInteger(n));
        input.classList.toggle("invalid", !ok);
        if (ok) {
            showError("");
            onChange(n);
        } else {
            showError(`${field.label}：请填 ${field.lo} 到 ${field.hi} 之间的${isInt ? "整数" : "数字"}。`);
        }
    };
    input.addEventListener("change", commit);
    ctl.appendChild(input);
    if (field.unit) ctl.appendChild(el("span", {class: "orb-unit"}, field.unit));
    for (const preset of field.presets || []) {
        const chip = el("button", {type: "button", class: "pv-chip"}, preset.label);
        if (Number(preset.value) === Number(value)) chip.classList.add("on");
        chip.addEventListener("click", () => {
            input.value = preset.value;
            commit();
            renderSettingsDialog();
        });
        ctl.appendChild(chip);
    }
}

function pvPointChoices() {
    const base = [{value: "Asc", label: "上升"}, {value: "MC", label: "中天"},
        ...["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa"].map((c) => ({value: c, label: pvName(c)}))];
    const lots = (state.points?.lots?.items || []).map((l) => ({value: `lot:${l.code}`, label: `${l.label}（Lot）`}));
    return [...base, ...lots];
}

function pvSequenceInput(ctl, field, value, onChange) {
    const input = el("input", {type: "text", value: value.join(" "), class: "pv-seq-input", spellcheck: "false"});
    const preview = el("span", {class: "pv-seq-preview"});
    preview.innerHTML = value.map((c) => planetGlyph(c)).join(" ");
    input.addEventListener("change", () => {
        const codes = input.value.trim().split(/[\s,，、]+/).filter(Boolean)
            .map((c) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase());
        const allowed = ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke"];
        const ok = codes.length > 0 && codes.every((c) => allowed.includes(c)) && new Set(codes).size === codes.length;
        input.classList.toggle("invalid", !ok);
        if (!ok) return showError(`${field.label}：只能填 ${allowed.join(" ")}，用空格分开，不能重复。`);
        showError("");
        onChange(codes);
        renderSettingsDialog();
    });
    ctl.append(input, preview);
    for (const preset of field.presets || []) {
        const chip = el("button", {type: "button", class: "pv-chip"}, preset.label);
        if (preset.value.join(" ") === value.join(" ")) chip.classList.add("on");
        chip.addEventListener("click", () => { onChange([...preset.value]); renderSettingsDialog(); });
        ctl.appendChild(chip);
    }
}

function renderPredictiveDialog(body) {
    const kind = settingsDialog.category;
    const spec = state.optionsMeta.predictive_spec[kind];
    const cfg = draft()[kind];
    const set = (key, value, rerender = false) => updateDraft((d) => { d[kind][key] = value; }, {rerender});
    let section = null;
    const form = () => {
        if (!section) {
            section = el("div", {class: "pv-form"});
            body.appendChild(section);
        }
        return section;
    };
    for (const field of spec.fields) {
        if (field.section) {
            sectionTitle(body, field.section);
            section = null;
            continue;
        }
        if (!pvFieldVisible(field, cfg)) continue;
        const ctl = pvRow(form(), field.label);
        const value = cfg[field.key];
        if (field.type === "choice") {
            const short = field.choices.length <= 3 && field.choices.every((c) => c.label.length <= 8);
            if (short) {
                const seg = el("div", {class: "segmented compact pv-seg", role: "radiogroup"});
                for (const choice of field.choices) {
                    const item = el("label");
                    const radio = el("input", {type: "radio", name: `pv-${kind}-${field.key}`, value: choice.value});
                    radio.checked = value === choice.value;
                    radio.addEventListener("change", () => set(field.key, choice.value, true));
                    item.append(radio, el("span", {}, choice.label));
                    seg.appendChild(item);
                }
                ctl.appendChild(seg);
            } else {
                const select = el("select", {class: "pv-select"});
                fillSelect(select, field.choices);
                select.value = value;
                select.addEventListener("change", () => set(field.key, select.value, true));
                ctl.appendChild(select);
            }
        } else if (field.type === "number" || field.type === "int") {
            pvNumberInput(ctl, field, value, (n) => set(field.key, n));
        } else if (field.type === "bool") {
            const label = el("label", {class: "pv-check"});
            label.append(checkbox(value, (on) => set(field.key, on)), el("span", {}, "是"));
            ctl.appendChild(label);
        } else if (field.type === "house") {
            const select = el("select", {class: "pv-select"});
            fillSelect(select, [{value: "", label: "跟随计算设置"}, ...state.optionsMeta.house_systems.map((h) => ({value: h, label: h}))]);
            select.value = value;
            select.addEventListener("change", () => set(field.key, select.value));
            ctl.appendChild(select);
        } else if (field.type === "point") {
            const select = el("select", {class: "pv-select"});
            const choices = pvPointChoices();
            if (!choices.some((c) => c.value === value)) choices.push({value, label: `${value}（已不存在）`});
            fillSelect(select, choices);
            select.value = value;
            select.addEventListener("change", () => set(field.key, select.value));
            ctl.appendChild(select);
        } else if (field.type === "planet_years") {
            const grid = el("div", {class: "pv-years"});
            for (const code of ["Su", "Mo", "Me", "Ve", "Ma", "Ju", "Sa", "Ra", "Ke"]) {
                const cell = el("label", {class: "pv-year"});
                const name = el("span", {class: "sect-name"});
                name.innerHTML = planetGlyph(code);
                cell.appendChild(name);
                pvNumberInput(cell, {...field, label: `${field.label} · ${pvName(code)}`, unit: "", presets: []}, value[code],
                    (n) => updateDraft((d) => { d[kind].years[code] = n; }, {rerender: false}));
                grid.appendChild(cell);
            }
            ctl.appendChild(grid);
        } else if (field.type === "sequence") {
            pvSequenceInput(ctl, field, value, (codes) => updateDraft((d) => { d[kind][field.key] = codes; }, {rerender: false}));
        }
    }
}

const PV_DIALOG_CATEGORIES = {
    ...Object.fromEntries(PREDICTIVE_VIEWS.map(({kind, label}) => [
        kind, {title: `推运 · ${label}`, render: renderPredictiveDialog, bulk: []},
    ])),
    biwheel: {title: "相位 · 双盘容许度", render: renderPredictiveDialog, bulk: []},
};

// 设置面板里每一项右边的摘要
function predictiveSummary(kind) {
    const c = state.predictive?.[kind];
    if (!c) return "";
    const spec = state.optionsMeta.predictive_spec[kind];
    const choice = (key) => spec.fields.find((f) => f.key === key)?.choices?.find((x) => x.value === c[key])?.label || "";
    const preset = (key) => {
        const field = spec.fields.find((f) => f.key === key);
        return field?.presets?.find((p) => Number(p.value) === Number(c[key]))?.label || `${c[key]} 日`;
    };
    const place = {natal: "出生地", target: "顶栏地点", custom: "自定义地点"}[c.location] || "";
    if (kind === "solar_return" || kind === "lunar_return") {
        return [Number(c.offset) ? `+${c.offset}°` : "", {before: "之前一次", after: "之后一次", nearest: "最近一次"}[c.pick], place]
            .filter(Boolean).join(" · ");
    }
    if (kind === "secondary" || kind === "tertiary") {
        return `${c.eph_days === 1 ? "1 日" : `${c.eph_days} 日`} = ${preset("life_days")}${c.direction === "converse" ? " · 逆推" : ""}`;
    }
    if (kind === "solar_arc") return `${choice("arc")}${c.direction === "converse" ? " · 逆推" : ""}`;
    if (kind === "profection") {
        const start = pvPointChoices().find((p) => p.value === c.start)?.label || c.start;
        return `${start} · ${choice("mode")}`;
    }
    if (kind === "biwheel") {
        const one = (view, label) => (c[`${view}_mode`] === "fixed" ? `${label} ${c[`${view}_orb`]}°` : `${label} ×${c[`${view}_scale`]}`);
        return [one("transit", "过境"), one("secondary", "次限")].join(" · ");
    }
    if (kind === "firdaria") {
        const night = spec.fields.find((f) => f.key === "night_order").presets
            .find((p) => p.value.join(" ") === c.night_order.join(" "))?.label || "自定义";
        return `夜生 ${night}`;
    }
    return "";
}

function renderPredictiveEntries() {
    document.querySelectorAll("[data-predictive-dialog]").forEach((button) => {
        button.querySelector(".point-count").textContent = predictiveSummary(button.dataset.predictiveDialog);
    });
}

function bindTimelordTabs() {
    document.querySelectorAll("[data-tab='tabProfection'], [data-tab='tabFirdaria']").forEach((button) => {
        button.addEventListener("click", () => requestAnimationFrame(scrollTimelordTabs));
    });
}

function bindPredictiveDialogs() {
    bindTimelordTabs();
    document.querySelectorAll("[data-predictive-dialog]").forEach((button) => {
        button.addEventListener("click", () => openSettingsDialog("predictive", button.dataset.predictiveDialog));
    });
}

// ================= 单盘 / 双盘 =================
// 过境和五张推运盘（日返、月返、次限、三限、日弧）可以切成双盘：内圈本命，外圈这张盘。
// 每张盘各自记住单盘还是双盘（只记在本机浏览器里）。双盘时：
//   - 结果区上方多一条「外圈的盘 / 本命」切换，决定行星、宫位、相位……这些标签页显示哪张盘的数据；
//   - 相位标签页多一个「双盘相位」视图（外圈对内圈），双盘时默认就显示它；
//   - 星盘上点一个元素，高亮与它构成双盘相位的元素。

const BI_VIEWS = ["transit", "solar_return", "lunar_return", "secondary", "tertiary", "solar_arc"];
state.biSide = "outer";         // 双盘时结果区显示哪张盘：outer 外圈的盘 / natal 本命

function biWanted(view) {
    try { return localStorage.getItem(`western.biwheel.${view}`) === "1"; } catch (_) { return false; }
}

function setBiWanted(view, on) {
    try { localStorage.setItem(`western.biwheel.${view}`, on ? "1" : "0"); } catch (_) { /* 只在这一页有效 */ }
}

function biActive(view = state.view) {
    return BI_VIEWS.includes(view) && biWanted(view) && Boolean(state.activeProfile);
}

// 外圈那张盘的结果：过境盘，或这张推运盘（还没算好时为 null）
function biOuterResults(view = state.view) {
    if (view === "transit") return state.charts.transit.results || null;
    return state.derived[view]?.results || null;
}

// 结果区的数据（common.js 的 adjustResults 挂接点）：双盘且选了「本命」时换成本命盘。
function biAdjustResults(results, view) {
    if (biActive(view) && state.biSide === "natal") return state.charts.natal.results || {};
    return results;
}

// 双盘要用本命盘：还没算、或计算设置改过时，在后台按档案补算。
let biNatalPending = false;

function ensureNatalForBi() {
    const natal = state.charts.natal;
    if (biNatalPending || !natal.input || !state.activeProfile) return;
    if (natal.results && natal.signature === currentSignature()) return;
    biNatalPending = true;
    calculateStored("natal").finally(() => { biNatalPending = false; });
}

// ---------- 双盘相位（后端 /cross-aspects，每张盘各自缓存） ----------

const crossCache = {};

function crossChartPoints(results) {
    return {planet_pos: results.planet_pos, house_result: {axes: results.house_result?.axes || {}}, asteroids: results.asteroids || {}};
}

function crossFor(view, natal, outer) {
    const options = collectPayload().options;
    const sig = JSON.stringify([state.predictive?.biwheel, options.points, options.aspects]);
    const cached = crossCache[view];
    if (cached && cached.natal === natal && cached.outer === outer && cached.sig === sig) return cached;
    const entry = {natal, outer, sig, data: null, error: null};
    crossCache[view] = entry;
    api(systemApi("/cross-aspects"), {
        method: "POST",
        body: JSON.stringify({view, options: {points: options.points, aspects: options.aspects},
            outer: crossChartPoints(outer), inner: crossChartPoints(natal), settings: state.predictive}),
    }).then((data) => { entry.data = data; })
        .catch((error) => { entry.error = error.message || String(error); })
        .finally(() => {
            if (crossCache[view] !== entry || state.view !== view) return;
            renderMainChart();
            renderAspects();
        });
    return entry;
}

function biCaption(view, outer) {
    const label = viewLabel(view);
    const text = outer.predictive?.caption
        || (outer.context?.local_dt ? `${label} ${localTimeText(outer.context.local_dt)}` : label);
    return `外圈 ${text} · 内圈 本命`;
}

// 星盘：单盘照旧；双盘时内圈画本命，外圈画这张盘。返回给 AstroChart.render 的 [结果, 附加选项]。
function biChartArgs(results, view, mini) {
    if (mini || !results || !biActive(view)) return [results, {}];
    const natal = state.charts.natal.results;
    if (!natal || state.charts.natal.signature !== currentSignature()) ensureNatalForBi();
    if (!natal) return [results, {}];
    const cross = crossFor(view, natal, results);
    return [natal, {outer: results, cross: cross.data, caption: biCaption(view, results)}];
}

// ---------- 控件 ----------

function updateWheelUI() {
    const view = state.view;
    const supported = BI_VIEWS.includes(view);
    const active = biActive(view);
    const wheel = $("wheelSwitch");
    if (wheel) {
        wheel.hidden = !supported;
        wheel.querySelectorAll("input").forEach((r) => { r.checked = r.value === (biWanted(view) ? "bi" : "single"); });
    }
    const bar = $("biSideBar");
    if (bar) {
        bar.hidden = !active;
        const outerLabel = bar.querySelector("[data-side='outer'] span");
        if (outerLabel) outerLabel.textContent = viewLabel(view);
        bar.querySelectorAll("input").forEach((r) => { r.checked = r.value === state.biSide; });
    }
    const cross = $("aspectCrossOption");
    if (cross) cross.classList.toggle("hidden", !active);
    if (!active && state.aspectView === "cross") state.aspectView = "main";
}

function bindWheelSwitch() {
    document.querySelectorAll("#wheelSwitch input").forEach((radio) => {
        radio.addEventListener("change", () => {
            if (!radio.checked) return;
            const on = radio.value === "bi";
            setBiWanted(state.view, on);
            state.biSide = "outer";
            state.aspectView = on ? "cross" : (state.aspectView === "cross" ? "main" : state.aspectView);
            AstroChart.clearSelection();
            renderView();
        });
    });
    // 结果区上方的「外圈的盘 / 本命」：放在标签页按钮下面，所有标签页共用
    const panels = document.querySelector("#resultPanel .tab-panels");
    if (panels && !$("biSideBar")) {
        const bar = el("div", {id: "biSideBar", class: "segmented compact bi-side-bar", role: "radiogroup", "aria-label": "结果区显示哪张盘"});
        bar.hidden = true;
        for (const [value, label] of [["outer", "外圈"], ["natal", "本命"]]) {
            const item = el("label", {"data-side": value});
            const radio = el("input", {type: "radio", name: "biSide", value});
            radio.addEventListener("change", () => {
                if (!radio.checked) return;
                state.biSide = value;
                renderView();
            });
            item.append(radio, el("span", {}, label));
            bar.appendChild(item);
        }
        panels.parentElement.insertBefore(bar, panels);
    }
}

// ---------- 相位标签页：双盘相位 ----------

function renderCrossAspects(box) {
    const view = state.view;
    const natal = state.charts.natal.results;
    const outer = biOuterResults(view);
    if (!natal || !outer) {
        box.innerHTML = "<p class='muted'>计算中…</p>";
        return;
    }
    const entry = crossFor(view, natal, outer);
    if (entry.error) {
        box.innerHTML = `<p class="point-error">${escapeHtml(entry.error)}</p>`;
        return;
    }
    const data = entry.data;
    if (!data) {
        box.innerHTML = "<p class='muted'>计算中…</p>";
        return;
    }
    const rows = data.outer || [];
    const cols = data.inner || [];
    if (!rows.length || !cols.length) {
        box.innerHTML = "<p class='muted'>参与相位的点不足。请在「计算设置 → 相位 → 行星选用」里勾选。</p>";
        return;
    }
    const cells = new Map();
    for (const hit of data.aspects || []) {
        const key = `${hit.a}|${hit.b}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(hit);
    }
    let html = `<p class="pv-when">外圈 ${escapeHtml(viewLabel(view))} · 内圈 本命 · 容许度 ${escapeHtml(data.orb)} · ${(data.aspects || []).length} 个相位</p>`;
    html += "<div class='table-wrap aspect-matrix-wrap'><table class='aspect-matrix cross-matrix'><thead><tr>";
    html += "<th class='am-corner'><span>外</span><span>内</span></th>";
    html += cols.map((p) => `<th class='am-head'>${symbolHtml(p, "am-sym")}</th>`).join("");
    html += "</tr></thead><tbody>";
    for (const r of rows) {
        html += `<tr><th class='am-label'>${symbolHtml(r, "am-sym")}</th>`;
        for (const c of cols) {
            const hits = cells.get(`${r.id}|${c.id}`) || [];
            html += `<td class='am-cell'>${hits.map(aspectHitHtml).join("")}</td>`;
        }
        html += "</tr>";
    }
    html += "</tbody></table></div>";
    // 按偏差从小到大的列表
    const info = Object.fromEntries([...rows, ...cols].map((p) => [p.id, p]));
    const list = [...(data.aspects || [])].sort((x, y) => x.deviation - y.deviation);
    if (list.length) {
        html += "<div class='pv-section-title'>按偏差排列</div>";
        html += "<div class='table-wrap'><table class='aspect-list cross-list'><thead><tr><th>外圈</th><th>相位</th><th>内圈</th><th>偏差</th></tr></thead><tbody>";
        for (const hit of list) {
            const a = info[hit.a] || {label: hit.a, symbol: hit.a};
            const b = info[hit.b] || {label: hit.b, symbol: hit.b};
            const motion = hit.motion || "";
            html += "<tr>"
                + `<td>${symbolHtml(a)} ${escapeHtml(a.label)}</td>`
                + `<td><span class='asp-sym'>${escapeHtml(symText(hit.symbol))}</span> ${escapeHtml(hit.name)}</td>`
                + `<td>${symbolHtml(b)} ${escapeHtml(b.label)}</td>`
                + `<td><span class='asp-dev ${motion ? `motion-${motion}` : "motion-none"}'>${escapeHtml(formatDeviation(hit.deviation) + motion)}</span></td>`
                + "</tr>";
        }
        html += "</tbody></table></div>";
    }
    box.innerHTML = html;
}
