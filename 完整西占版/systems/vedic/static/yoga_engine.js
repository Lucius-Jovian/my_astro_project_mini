"use strict";
/*
 * Yoga 引擎：把一条用文字写的条件（公式）编译成函数，在一张盘上判断是否成立。
 *
 * 默认 Yoga 和使用者自定义的 Yoga 用同一套公式、同一个引擎，所以两者在性能上没有区别。
 * 公式只在载入或修改时编译一次（编译成普通的 JS 闭包），之后每张盘只做查表和比较。
 * 一张盘先算好一份「盘面」（每个点在哪个星座、第几宫、谁是宫主……，几十个数），所有 Yoga 共用。
 *
 * ─────────────────────────── 公式写法 ───────────────────────────
 *   house(Ju, Mo) in KENDRA and (own(Ju) or exalted(Ju))
 *   assoc(lord(9), lord(10))
 *   all_in(P7, run(1, 7))
 *
 * 值：数字；行星 Su Mo Ma Me Ju Ve Sa Ra Ke；上升点 Asc；Lagna（这张盘的第一宫，Moon 盘里就是月亮所在星座）；
 *     列表 [1, 4, 7, 10]；常数（KENDRA、P7 等，见 CONSTANTS）。
 * 运算：and or not（也可以写 且 或 非、&& || !）；== != < <= > >=；in、not in；
 *       + -（数字加减；列表合并、去掉）；括号。中文全角的括号和逗号也认。
 * 函数：见 FUNCTIONS（每个都有中文说明，管理 Yoga 的浮窗里可以查看）。
 * 宫位一律从 1 数起；星座 1 = 白羊 … 12 = 双鱼。
 *
 * 关于“格子”：一般的盘每个格子是一个星座；Bhava 盘每个格子是一个宫位。house、conj、aspect、in_house 等
 * 按格子算（所以在 Bhava 盘里按宫位算）；own、exalted 等尊贵按点真实所在的星座算。
 */
(function () {
    const P9 = ["Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa", "Ra", "Ke"];
    const POINTS = new Set([...P9, "Asc", "Lagna"]);
    const NAMES = {
        Su: "太阳", Mo: "月亮", Ma: "火星", Me: "水星", Ju: "木星", Ve: "金星", Sa: "土星",
        Ra: "罗睺", Ke: "计都", Asc: "上升点", Lagna: "第一宫",
    };

    // 星座（0 白羊 … 11 双鱼）的主星
    const SIGN_LORD = ["Ma", "Ve", "Me", "Mo", "Su", "Me", "Ve", "Ma", "Ju", "Sa", "Sa", "Ju"];
    // 擢升星座（BPHS 第 3 章；罗睺金牛、计都天蝎取常见说法）；入弱 = 对面的星座
    const EXALT = {Su: 0, Mo: 1, Ma: 9, Me: 5, Ju: 3, Ve: 11, Sa: 6, Ra: 1, Ke: 7};
    const OWN = {Su: [4], Mo: [3], Ma: [0, 7], Me: [2, 5], Ju: [8, 11], Ve: [1, 6], Sa: [9, 10], Ra: [], Ke: []};
    // 原三方（Moolatrikona）：[星座, 起始度数, 结束度数]（BPHS 第 3 章）
    const MT = {Su: [4, 0, 20], Mo: [1, 4, 30], Ma: [0, 0, 12], Me: [5, 16, 20], Ju: [8, 0, 10], Ve: [6, 0, 15], Sa: [10, 0, 20]};
    // 天然友敌（BPHS 第 3 章）。没列出的是中性。
    const FRIENDS = {
        Su: ["Mo", "Ma", "Ju"], Mo: ["Su", "Me"], Ma: ["Su", "Mo", "Ju"], Me: ["Su", "Ve"],
        Ju: ["Su", "Mo", "Ma"], Ve: ["Me", "Sa"], Sa: ["Me", "Ve"],
    };
    const ENEMIES = {
        Su: ["Ve", "Sa"], Mo: [], Ma: ["Me"], Me: ["Mo"], Ju: ["Me", "Ve"], Ve: ["Su", "Mo"], Sa: ["Su", "Mo", "Ma"],
    };
    // 燃烧（Combust）的默认度数（BPHS 常用值）；Me_r、Ve_r 是水星、金星逆行时的度数。
    // 实际用的度数由 makeChart({combust}) 传入（计算设置 → 燃烧）。
    const COMBUST = {Mo: 12, Ma: 17, Me: 14, Me_r: 12, Ju: 11, Ve: 10, Ve_r: 8, Sa: 15};

    const CONSTANTS = {
        KENDRA: {value: [1, 4, 7, 10], doc: "角宫 1、4、7、10"},
        TRIKONA: {value: [1, 5, 9], doc: "三方宫 1、5、9"},
        DUSTHANA: {value: [6, 8, 12], doc: "凶宫 6、8、12"},
        UPACHAYA: {value: [3, 6, 10, 11], doc: "增长宫 3、6、10、11"},
        PANAPHARA: {value: [2, 5, 8, 11], doc: "续宫 2、5、8、11"},
        APOKLIMA: {value: [3, 6, 9, 12], doc: "果宫 3、6、9、12"},
        MOVABLE: {value: [1, 4, 7, 10], doc: "动星座（白羊、巨蟹、天秤、摩羯），配合 all_in_signs 使用"},
        FIXED: {value: [2, 5, 8, 11], doc: "定星座（金牛、狮子、天蝎、水瓶）"},
        DUAL: {value: [3, 6, 9, 12], doc: "变星座（双子、处女、射手、双鱼）"},
        P9: {value: P9, doc: "九曜：Su Mo Ma Me Ju Ve Sa Ra Ke"},
        P7: {value: P9.slice(0, 7), doc: "七曜（不含罗睺、计都）"},
        P5: {value: ["Ma", "Me", "Ju", "Ve", "Sa"], doc: "五星（不含日、月、罗睺、计都），月亮 / 太阳类 Yoga 常用"},
        NB: {value: ["Mo", "Me", "Ju", "Ve"], doc: "天然吉星（固定写法，Nabhasa 用）"},
        NM: {value: ["Su", "Ma", "Sa"], doc: "天然凶星（固定写法，Nabhasa 用）"},
    };

    const mod12 = (x) => ((x % 12) + 12) % 12;
    const norm360 = (x) => ((Number(x) % 360) + 360) % 360;

    // ================================================================ 词法、语法

    class RuleError extends Error {
        constructor(message, pos = null) {
            super(message);
            this.pos = pos;
        }
    }

    const ALIASES = {"且": "and", "&&": "and", "或": "or", "||": "or", "非": "not", "!": "not"};

    function tokenize(src) {
        const text = String(src || "")
            .replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",")
            .replace(/【/g, "[").replace(/】/g, "]").replace(/＝/g, "=");
        const tokens = [];
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            if (/\s/.test(ch)) { i++; continue; }
            const two = text.slice(i, i + 2);
            if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
                tokens.push({t: "op", v: ALIASES[two] || two, pos: i});
                i += 2;
                continue;
            }
            if ("()[],<>+-!".includes(ch)) {
                tokens.push({t: ch === "!" ? "op" : "op", v: ALIASES[ch] || ch, pos: i});
                i++;
                continue;
            }
            if (ALIASES[ch]) {
                tokens.push({t: "op", v: ALIASES[ch], pos: i});
                i++;
                continue;
            }
            if (/[0-9.]/.test(ch)) {
                const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(text.slice(i));
                if (!m) throw new RuleError(`无法识别的数字`, i);
                tokens.push({t: "num", v: Number(m[0]), pos: i});
                i += m[0].length;
                continue;
            }
            if (/[A-Za-z_]/.test(ch)) {
                const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
                const word = m[0];
                const lower = word.toLowerCase();
                if (["and", "or", "not", "in"].includes(lower)) tokens.push({t: "op", v: lower, pos: i});
                else if (lower === "true" || lower === "false") tokens.push({t: "bool", v: lower === "true", pos: i});
                else tokens.push({t: "id", v: word, pos: i});
                i += word.length;
                continue;
            }
            if (ch === "=") throw new RuleError("比较相等请写 ==", i);
            throw new RuleError(`无法识别的字符「${ch}」`, i);
        }
        tokens.push({t: "end", v: "", pos: text.length});
        return tokens;
    }

    function parse(src) {
        const tokens = tokenize(src);
        let k = 0;
        const peek = () => tokens[k];
        const isOp = (v) => tokens[k].t === "op" && tokens[k].v === v;
        const expectOp = (v, what) => {
            if (!isOp(v)) throw new RuleError(`这里应该是「${v}」${what ? `（${what}）` : ""}`, peek().pos);
            k++;
        };

        function orExpr() {
            let left = andExpr();
            while (isOp("or")) { const pos = peek().pos; k++; left = {t: "or", a: left, b: andExpr(), pos}; }
            return left;
        }
        function andExpr() {
            let left = notExpr();
            while (isOp("and")) { const pos = peek().pos; k++; left = {t: "and", a: left, b: notExpr(), pos}; }
            return left;
        }
        function notExpr() {
            if (isOp("not")) { const pos = peek().pos; k++; return {t: "not", a: notExpr(), pos}; }
            return compare();
        }
        function compare() {
            const left = additive();
            const tok = peek();
            if (tok.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(tok.v)) {
                k++;
                return {t: "cmp", op: tok.v, a: left, b: additive(), pos: tok.pos};
            }
            if (isOp("in")) { k++; return {t: "in", a: left, b: additive(), pos: tok.pos}; }
            if (isOp("not") && tokens[k + 1]?.t === "op" && tokens[k + 1].v === "in") {
                k += 2;
                return {t: "not", a: {t: "in", a: left, b: additive(), pos: tok.pos}, pos: tok.pos};
            }
            return left;
        }
        function additive() {
            let left = unary();
            while (isOp("+") || isOp("-")) {
                const tok = peek(); k++;
                left = {t: "arith", op: tok.v, a: left, b: unary(), pos: tok.pos};
            }
            return left;
        }
        function unary() {
            if (isOp("-")) {
                const pos = peek().pos; k++;
                return {t: "arith", op: "-", a: {t: "num", v: 0, pos}, b: unary(), pos};
            }
            return primary();
        }
        function primary() {
            const tok = peek();
            if (tok.t === "num") { k++; return {t: "num", v: tok.v, pos: tok.pos}; }
            if (tok.t === "bool") { k++; return {t: "bool", v: tok.v, pos: tok.pos}; }
            if (isOp("(")) {
                k++;
                const inner = orExpr();
                expectOp(")", "括号没有配对");
                return inner;
            }
            if (isOp("[")) {
                k++;
                const items = [];
                if (!isOp("]")) {
                    items.push(orExpr());
                    while (isOp(",")) { k++; items.push(orExpr()); }
                }
                expectOp("]", "列表没有结束");
                return {t: "list", items, pos: tok.pos};
            }
            if (tok.t === "id") {
                k++;
                if (isOp("(")) {
                    k++;
                    const args = [];
                    if (!isOp(")")) {
                        args.push(orExpr());
                        while (isOp(",")) { k++; args.push(orExpr()); }
                    }
                    expectOp(")", `${tok.v}(...) 的括号没有配对`);
                    return {t: "call", name: tok.v, args, pos: tok.pos};
                }
                return {t: "id", name: tok.v, pos: tok.pos};
            }
            if (tok.t === "end") throw new RuleError("公式不完整", tok.pos);
            throw new RuleError(`这里不应该出现「${tok.v}」`, tok.pos);
        }

        if (peek().t === "end") throw new RuleError("公式是空的", 0);
        const ast = orExpr();
        if (peek().t !== "end") throw new RuleError(`多出了「${peek().v}」`, peek().pos);
        return ast;
    }

    // ================================================================ 盘面

    /*
     * 盘面：一张盘上所有 Yoga 共用的数据，算一次。
     *   points   {代号: {lon}}：这张盘（可能是分盘）上的黄经，含 Asc
     *   cells    {代号: 格子 0–11}：可省略（= 黄经所在星座）；Bhava 盘按宫位
     *   lagna    第一宫所在的格子（Moon 盘 = 月亮的星座）；省略时 = Asc 的格子
     *   phys     {代号: {lon, speed}}：D1 的真实黄经和速度（逆行、燃烧、日夜、上弦下弦都按它算）
     *   aspects  {行星: [第几个星座, ...]}：相位表（含罗睺 / 计都的开关）
     *   dsign    (代号, n) → 1–12：这个点在 Dn 的星座（由 vedic.js 用当前分盘算法提供）
     */
    function makeChart(input) {
        const sign = {}, cell = {}, deg = {}, lon = {};
        for (const code of [...P9, "Asc"]) {
            const p = input.points?.[code];
            if (!p || !Number.isFinite(Number(p.lon))) continue;
            const L = norm360(p.lon);
            lon[code] = L;
            sign[code] = Math.floor(L / 30) % 12;
            deg[code] = L - sign[code] * 30;
            const c = input.cells?.[code];
            cell[code] = Number.isInteger(c) ? c : sign[code];
        }
        const lagna = Number.isInteger(input.lagna) ? input.lagna : cell.Asc;
        cell.Lagna = lagna;
        sign.Lagna = lagna;
        deg.Lagna = 0;
        const phys = input.phys || input.points || {};
        const chart = {sign, cell, deg, lon, lagna, phys, aspects: input.aspects || {}, combust: {...COMBUST, ...(input.combust || {})},
            dsignFn: input.dsign, memo: new Map()};
        return chart;
    }

    // ================================================================ 函数

    function needPoint(v, fn) {
        if (typeof v !== "string" || !POINTS.has(v)) throw new RuleError(`${fn}() 需要一个行星或 Asc / Lagna，收到的是 ${show(v)}`);
        return v;
    }
    function needPlanet(v, fn) {
        if (typeof v !== "string" || !P9.includes(v)) throw new RuleError(`${fn}() 需要一个行星，收到的是 ${show(v)}`);
        return v;
    }
    function needList(v, fn) {
        if (!Array.isArray(v)) throw new RuleError(`${fn}() 需要一个列表，收到的是 ${show(v)}`);
        return v;
    }
    function needHouse(v, fn) {
        if (!Number.isInteger(v) || v < 1 || v > 12) throw new RuleError(`${fn}() 的宫位要是 1–12 的整数，收到的是 ${show(v)}`);
        return v;
    }
    function show(v) {
        if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
        if (typeof v === "boolean") return v ? "成立" : "不成立";
        return String(v);
    }
    function has(chart, p) {
        return chart.cell[p] !== undefined;
    }

    const H = {
        house(chart, p, from = "Lagna") {
            needPoint(p, "house");
            needPoint(from, "house");
            if (!has(chart, p) || !has(chart, from)) return 0;
            return mod12(chart.cell[p] - chart.cell[from]) + 1;
        },
        lord(chart, n, from = "Lagna") {
            needHouse(n, "lord");
            needPoint(from, "lord");
            return SIGN_LORD[mod12(chart.cell[from] + n - 1)];
        },
        inHouse(chart, n, from = "Lagna") {
            const key = `ih:${n}:${from}`;
            let v = chart.memo.get(key);
            if (!v) {
                v = P9.filter((p) => has(chart, p) && H.house(chart, p, from) === n);
                chart.memo.set(key, v);
            }
            return v;
        },
        aspect(chart, a, b) {
            needPlanet(a, "aspect");
            needPoint(b, "aspect");
            if (!has(chart, a) || !has(chart, b)) return false;
            const d = mod12(chart.cell[b] - chart.cell[a]) + 1;
            return d !== 1 && (chart.aspects[a] || []).includes(d);
        },
        conj(chart, a, b) {
            return has(chart, a) && has(chart, b) && chart.cell[a] === chart.cell[b];
        },
        exchange(chart, a, b) {
            needPlanet(a, "exchange");
            needPlanet(b, "exchange");
            return a !== b && SIGN_LORD[chart.sign[a]] === b && SIGN_LORD[chart.sign[b]] === a;
        },
        waxing(chart) {
            const mo = chart.phys.Mo, su = chart.phys.Su;
            return mo && su ? norm360(mo.lon - su.lon) < 180 : true;
        },
        benefic(chart, p) {
            if (p === "Ju" || p === "Ve") return true;
            if (p === "Mo") return H.waxing(chart);
            if (p === "Me") {
                // 水星与凶星同格时算凶（BPHS）
                return !["Su", "Ma", "Sa", "Ra", "Ke"].some((m) => H.conj(chart, "Me", m)) &&
                    !(H.conj(chart, "Me", "Mo") && !H.waxing(chart));
            }
            return false;
        },
    };

    // 每个函数：fn(chart, ...参数)；min / max 参数个数；sig 写法；doc 中文说明。
    const FUNCTIONS = {
        house: {min: 1, max: 2, sig: "house(P[, 从])", doc: "P 在第几宫（1–12），默认从 Lagna 数；house(Ju, Mo) 是从月亮数", fn: H.house},
        sign: {min: 1, max: 1, sig: "sign(P)", doc: "P 所在星座（1 白羊 … 12 双鱼）",
            fn: (c, p) => { needPoint(p, "sign"); return has(c, p) ? c.sign[p] + 1 : 0; }},
        deg: {min: 1, max: 1, sig: "deg(P)", doc: "P 在星座内的度数（0–30；分盘里是这一份里的进度）",
            fn: (c, p) => { needPoint(p, "deg"); return c.deg[p] ?? 0; }},
        lon: {min: 1, max: 1, sig: "lon(P)", doc: "P 的黄经（0–360）", fn: (c, p) => { needPoint(p, "lon"); return c.lon[p] ?? 0; }},
        lord: {min: 1, max: 2, sig: "lord(n[, 从])", doc: "第 n 宫的宫主星；lord(9, Mo) 是从月亮数的第 9 宫宫主", fn: H.lord},
        lords_of: {min: 1, max: 1, sig: "lords_of(P)", doc: "P 主管的宫位列表（从 Lagna 数）",
            fn: (c, p) => { needPlanet(p, "lords_of"); return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((n) => H.lord(c, n) === p); }},
        signlord: {min: 1, max: 1, sig: "signlord(P)", doc: "P 所在星座的主星（定位星 Dispositor）",
            fn: (c, p) => { needPoint(p, "signlord"); return SIGN_LORD[c.sign[p]]; }},
        in_house: {min: 1, max: 2, sig: "in_house(n[, 从])", doc: "落在第 n 宫的行星列表（九曜）",
            fn: (c, n, from = "Lagna") => { needHouse(n, "in_house"); needPoint(from, "in_house"); return H.inHouse(c, n, from); }},
        houses_of: {min: 1, max: 2, sig: "houses_of(列表[, 从])", doc: "列表里每个行星所在的宫位",
            fn: (c, list, from = "Lagna") => needList(list, "houses_of").filter((p) => has(c, p)).map((p) => H.house(c, p, from))},
        all_in: {min: 2, max: 3, sig: "all_in(列表, 宫位列表[, 从])", doc: "列表里的行星全部落在这些宫位",
            fn: (c, list, hs, from = "Lagna") => needList(list, "all_in").every((p) => !has(c, p) || needList(hs, "all_in").includes(H.house(c, p, from)))},
        any_in: {min: 2, max: 3, sig: "any_in(列表, 宫位列表[, 从])", doc: "列表里至少有一个行星落在这些宫位",
            fn: (c, list, hs, from = "Lagna") => needList(list, "any_in").some((p) => has(c, p) && needList(hs, "any_in").includes(H.house(c, p, from)))},
        count_in: {min: 2, max: 3, sig: "count_in(列表, 宫位列表[, 从])", doc: "列表里落在这些宫位的行星个数",
            fn: (c, list, hs, from = "Lagna") => needList(list, "count_in").filter((p) => has(c, p) && needList(hs, "count_in").includes(H.house(c, p, from))).length},
        all_in_signs: {min: 2, max: 2, sig: "all_in_signs(列表, 星座列表)", doc: "列表里的行星全部落在这些星座（1–12）",
            fn: (c, list, signs) => needList(list, "all_in_signs").every((p) => !has(c, p) || needList(signs, "all_in_signs").includes(c.sign[p] + 1))},
        signs_occupied: {min: 1, max: 1, sig: "signs_occupied(列表)", doc: "列表里的行星一共占了几个格子（星座）",
            fn: (c, list) => new Set(needList(list, "signs_occupied").filter((p) => has(c, p)).map((p) => c.cell[p])).size},
        run: {min: 2, max: 2, sig: "run(起, 个数)", doc: "从第「起」宫开始连续若干个宫位，如 run(10, 7) = [10, 11, 12, 1, 2, 3, 4]",
            fn: (c, start, len) => { needHouse(start, "run"); return Array.from({length: Math.max(0, Math.min(12, len))}, (_, i) => mod12(start - 1 + i) + 1); }},
        conj: {min: 2, max: 9, sig: "conj(A, B, ...)", doc: "这些点在同一个格子（同一星座；Bhava 盘为同一宫）",
            fn: (c, ...ps) => { ps.forEach((p) => needPoint(p, "conj")); return ps.every((p) => H.conj(c, ps[0], p)); }},
        aspect: {min: 2, max: 2, sig: "aspect(A, B)", doc: "A 对 B 所在的格子投射相位（Parashari 星座相位，罗睺 / 计都按设置）", fn: H.aspect},
        aspect_house: {min: 2, max: 2, sig: "aspect_house(A, n)", doc: "A 对第 n 宫投射相位",
            fn: (c, a, n) => { needPlanet(a, "aspect_house"); needHouse(n, "aspect_house"); const d = mod12(c.lagna + n - 1 - c.cell[a]) + 1; return d !== 1 && (c.aspects[a] || []).includes(d); }},
        aspected_by: {min: 1, max: 1, sig: "aspected_by(P)", doc: "对 P 投射相位的行星列表",
            fn: (c, p) => { needPoint(p, "aspected_by"); return P9.filter((a) => a !== p && H.aspect(c, a, p)); }},
        exchange: {min: 2, max: 2, sig: "exchange(A, B)", doc: "A、B 互在对方的星座（星座互换）", fn: H.exchange},
        assoc: {min: 2, max: 2, sig: "assoc(A, B)", doc: "A、B 有关联：同格、星座互换或互相投射相位（A、B 是同一颗行星时不算）",
            fn: (c, a, b) => { needPlanet(a, "assoc"); needPlanet(b, "assoc"); return a !== b && (H.conj(c, a, b) || H.exchange(c, a, b) || (H.aspect(c, a, b) && H.aspect(c, b, a))); }},
        parivartana: {min: 2, max: 2, sig: "parivartana(宫位列表A, 宫位列表B)", doc: "A 中某宫与 B 中另一宫的宫主互相落在对方的宫里（宫主互换）",
            fn: (c, A, B) => {
                for (const a of needList(A, "parivartana")) for (const b of needList(B, "parivartana")) {
                    if (a === b) continue;
                    const la = H.lord(c, a), lb = H.lord(c, b);
                    if (la !== lb && H.house(c, la) === b && H.house(c, lb) === a) return true;
                }
                return false;
            }},
        own: {min: 1, max: 1, sig: "own(P)", doc: "P 在自己主管的星座（入庙）", fn: (c, p) => { needPlanet(p, "own"); return OWN[p].includes(c.sign[p]); }},
        exalted: {min: 1, max: 1, sig: "exalted(P)", doc: "P 在擢升星座", fn: (c, p) => { needPlanet(p, "exalted"); return EXALT[p] === c.sign[p]; }},
        debilitated: {min: 1, max: 1, sig: "debilitated(P)", doc: "P 在入弱星座", fn: (c, p) => { needPlanet(p, "debilitated"); return mod12(EXALT[p] + 6) === c.sign[p]; }},
        mt: {min: 1, max: 1, sig: "mt(P)", doc: "P 在原三方（Moolatrikona）的度数范围内",
            fn: (c, p) => { needPlanet(p, "mt"); const m = MT[p]; return Boolean(m) && c.sign[p] === m[0] && c.deg[p] >= m[1] && c.deg[p] < m[2]; }},
        strong: {min: 1, max: 1, sig: "strong(P)", doc: "P 擢升、在原三方或入庙",
            fn: (c, p) => { needPlanet(p, "strong"); const m = MT[p]; return EXALT[p] === c.sign[p] || OWN[p].includes(c.sign[p]) || (Boolean(m) && c.sign[p] === m[0] && c.deg[p] >= m[1] && c.deg[p] < m[2]); }},
        exsign: {min: 1, max: 1, sig: "exsign(P)", doc: "P 的擢升星座（1–12）", fn: (c, p) => { needPlanet(p, "exsign"); return EXALT[p] + 1; }},
        exlord: {min: 1, max: 1, sig: "exlord(P)", doc: "P 擢升星座的主星", fn: (c, p) => { needPlanet(p, "exlord"); return SIGN_LORD[EXALT[p]]; }},
        deblord: {min: 1, max: 1, sig: "deblord(P)", doc: "P 入弱星座的主星", fn: (c, p) => { needPlanet(p, "deblord"); return SIGN_LORD[mod12(EXALT[p] + 6)]; }},
        friend: {min: 2, max: 2, sig: "friend(A, B)", doc: "B 是 A 的天然朋友",
            fn: (c, a, b) => { needPlanet(a, "friend"); needPlanet(b, "friend"); return (FRIENDS[a] || []).includes(b); }},
        enemy: {min: 2, max: 2, sig: "enemy(A, B)", doc: "B 是 A 的天然敌人",
            fn: (c, a, b) => { needPlanet(a, "enemy"); needPlanet(b, "enemy"); return (ENEMIES[a] || []).includes(b); }},
        friend_sign: {min: 1, max: 1, sig: "friend_sign(P)", doc: "P 所在星座的主星是 P 的天然朋友",
            fn: (c, p) => { needPlanet(p, "friend_sign"); return (FRIENDS[p] || []).includes(SIGN_LORD[c.sign[p]]); }},
        enemy_sign: {min: 1, max: 1, sig: "enemy_sign(P)", doc: "P 所在星座的主星是 P 的天然敌人",
            fn: (c, p) => { needPlanet(p, "enemy_sign"); return (ENEMIES[p] || []).includes(SIGN_LORD[c.sign[p]]); }},
        retro: {min: 1, max: 1, sig: "retro(P)", doc: "P 逆行（按本命盘的真实速度）",
            fn: (c, p) => { needPlanet(p, "retro"); return Number(c.phys[p]?.speed) < 0; }},
        combust: {min: 1, max: 1, sig: "combust(P)", doc: "P 燃烧：离太阳在设置的度数以内（计算设置 → 燃烧），按本命盘真实黄经",
            fn: (c, p) => {
                needPlanet(p, "combust");
                const orb = (Number(c.phys[p]?.speed) < 0 && c.combust[`${p}_r`]) || c.combust[p];
                if (!orb || !c.phys[p] || !c.phys.Su) return false;
                const d = Math.abs(((c.phys[p].lon - c.phys.Su.lon) % 360 + 540) % 360 - 180);
                return d < orb;
            }},
        waxing: {min: 0, max: 0, sig: "waxing()", doc: "月亮在上弦（离太阳 0°–180°）", fn: (c) => H.waxing(c)},
        day: {min: 0, max: 0, sig: "day()", doc: "日间出生（太阳在地平线上，按本命盘真实黄经估算）",
            fn: (c) => { const su = c.phys.Su, asc = c.phys.Asc; return su && asc ? norm360(asc.lon - su.lon) < 180 : true; }},
        benefic: {min: 1, max: 1, sig: "benefic(P)", doc: "P 是吉星：木、金；上弦的月亮；不与凶星同格的水星",
            fn: (c, p) => { needPlanet(p, "benefic"); return H.benefic(c, p); }},
        malefic: {min: 1, max: 1, sig: "malefic(P)", doc: "P 是凶星（九曜中不是吉星的）", fn: (c, p) => { needPlanet(p, "malefic"); return !H.benefic(c, p); }},
        benefics: {min: 0, max: 0, sig: "benefics()", doc: "这张盘上的吉星列表", fn: (c) => P9.filter((p) => H.benefic(c, p))},
        malefics: {min: 0, max: 0, sig: "malefics()", doc: "这张盘上的凶星列表", fn: (c) => P9.filter((p) => !H.benefic(c, p))},
        yogakaraka: {min: 1, max: 1, sig: "yogakaraka(P)", doc: "P 同时主管一个角宫（4、7、10）和一个三方宫（5、9）",
            fn: (c, p) => { needPlanet(p, "yogakaraka"); const ls = FUNCTIONS.lords_of.fn(c, p); return ls.some((n) => [4, 7, 10].includes(n)) && ls.some((n) => [5, 9].includes(n)); }},
        all_between: {min: 3, max: 3, sig: "all_between(列表, A, B)", doc: "列表里的行星都在从 A 顺黄道到 B 的弧段之内（不含两端）",
            fn: (c, list, a, b) => {
                needPoint(a, "all_between"); needPoint(b, "all_between");
                const arc = norm360(c.lon[b] - c.lon[a]);
                return needList(list, "all_between").every((p) => { const d = norm360(c.lon[p] - c.lon[a]); return d > 0 && d < arc; });
            }},
        dsign: {min: 2, max: 2, sig: "dsign(P, n)", doc: "P 在 Dn 分盘的星座（1–12），按当前分盘算法；如 dsign(Su, 9)",
            fn: (c, p, n) => { needPoint(p, "dsign"); if (!c.dsignFn) throw new RuleError("这张盘不能换算分盘"); return c.dsignFn(p === "Lagna" ? "Asc" : p, n); }},
        count: {min: 1, max: 1, sig: "count(列表)", doc: "列表里有几项", fn: (c, list) => needList(list, "count").length},
        unique: {min: 1, max: 1, sig: "unique(列表)", doc: "去掉重复的项", fn: (c, list) => [...new Set(needList(list, "unique"))]},
        inter: {min: 2, max: 2, sig: "inter(A, B)", doc: "两个列表共有的项（不重复）",
            fn: (c, a, b) => [...new Set(needList(a, "inter"))].filter((x) => needList(b, "inter").includes(x))},
        subset: {min: 2, max: 2, sig: "subset(A, B)", doc: "A 的每一项都在 B 里", fn: (c, a, b) => needList(a, "subset").every((x) => needList(b, "subset").includes(x))},
    };

    // ================================================================ 编译

    function truthy(v, pos) {
        if (typeof v !== "boolean") throw new RuleError(`这里需要「成立 / 不成立」，得到的是 ${show(v)}`, pos);
        return v;
    }

    function equal(a, b) {
        if (Array.isArray(a) && Array.isArray(b)) {
            const sa = [...new Set(a)].map(String).sort(), sb = [...new Set(b)].map(String).sort();
            return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
        }
        return a === b;
    }

    function compileNode(n) {
        switch (n.t) {
            case "num": { const v = n.v; return () => v; }
            case "bool": { const v = n.v; return () => v; }
            case "id": {
                if (POINTS.has(n.name)) { const v = n.name; return () => v; }
                const c = CONSTANTS[n.name];
                if (c) { const v = Object.freeze(c.value.slice()); return () => v; }
                const fix = Object.keys(CONSTANTS).find((k) => k.toLowerCase() === n.name.toLowerCase()) ||
                    [...POINTS].find((k) => k.toLowerCase() === n.name.toLowerCase());
                throw new RuleError(`不认识的名称「${n.name}」${fix ? `，是不是 ${fix}？` : ""}`, n.pos);
            }
            case "list": {
                const fs = n.items.map(compileNode);
                return (c) => fs.map((f) => f(c));
            }
            case "call": {
                const spec = FUNCTIONS[n.name] || FUNCTIONS[n.name.toLowerCase()];
                if (!spec) throw new RuleError(`不认识的函数「${n.name}」`, n.pos);
                if (n.args.length < spec.min || n.args.length > spec.max) {
                    const range = spec.min === spec.max ? `${spec.min}` : `${spec.min}–${spec.max}`;
                    throw new RuleError(`${spec.sig} 需要 ${range} 个参数，这里给了 ${n.args.length} 个`, n.pos);
                }
                const fs = n.args.map(compileNode);
                const fn = spec.fn;
                const pos = n.pos;
                const wrap = (call) => (c) => {
                    try {
                        return call(c);
                    } catch (error) {
                        if (error instanceof RuleError && error.pos === null) error.pos = pos;
                        throw error;
                    }
                };
                switch (fs.length) {
                    case 0: return wrap((c) => fn(c));
                    case 1: { const [a] = fs; return wrap((c) => fn(c, a(c))); }
                    case 2: { const [a, b] = fs; return wrap((c) => fn(c, a(c), b(c))); }
                    case 3: { const [a, b, d] = fs; return wrap((c) => fn(c, a(c), b(c), d(c))); }
                    default: return wrap((c) => fn(c, ...fs.map((f) => f(c))));
                }
            }
            case "and": { const a = compileNode(n.a), b = compileNode(n.b), pos = n.pos; return (c) => truthy(a(c), pos) && truthy(b(c), pos); }
            case "or": { const a = compileNode(n.a), b = compileNode(n.b), pos = n.pos; return (c) => truthy(a(c), pos) || truthy(b(c), pos); }
            case "not": { const a = compileNode(n.a), pos = n.pos; return (c) => !truthy(a(c), pos); }
            case "in": {
                const a = compileNode(n.a), b = compileNode(n.b), pos = n.pos;
                return (c) => {
                    const list = b(c);
                    if (!Array.isArray(list)) throw new RuleError(`in 的右边要是列表，得到的是 ${show(list)}`, pos);
                    return list.includes(a(c));
                };
            }
            case "cmp": {
                const a = compileNode(n.a), b = compileNode(n.b), op = n.op, pos = n.pos;
                if (op === "==") return (c) => equal(a(c), b(c));
                if (op === "!=") return (c) => !equal(a(c), b(c));
                return (c) => {
                    const x = a(c), y = b(c);
                    if (typeof x !== "number" || typeof y !== "number") throw new RuleError(`${op} 只能比较数字`, pos);
                    return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
                };
            }
            case "arith": {
                const a = compileNode(n.a), b = compileNode(n.b), op = n.op, pos = n.pos;
                return (c) => {
                    const x = a(c), y = b(c);
                    if (typeof x === "number" && typeof y === "number") return op === "+" ? x + y : x - y;
                    if (Array.isArray(x)) {
                        const ys = Array.isArray(y) ? y : [y];
                        return op === "+" ? [...x, ...ys] : x.filter((v) => !ys.includes(v));
                    }
                    throw new RuleError(`${op} 两边要是数字，或左边是列表`, pos);
                };
            }
            default:
                throw new RuleError("无法编译的公式", n.pos);
        }
    }

    // 编译一条公式：{ok: true, fn} 或 {ok: false, error, pos}
    function compile(rule) {
        try {
            const fn = compileNode(parse(rule));
            return {ok: true, fn};
        } catch (error) {
            if (error instanceof RuleError) return {ok: false, error: error.message, pos: error.pos};
            return {ok: false, error: String(error.message || error), pos: null};
        }
    }

    // 在一张盘上判断一条已编译的公式：{value: true/false} 或 {error, pos}
    function run(compiled, chart) {
        if (!compiled.ok) return {error: compiled.error, pos: compiled.pos};
        try {
            const v = compiled.fn(chart);
            if (typeof v !== "boolean") return {error: `公式的结果要是「成立 / 不成立」，得到的是 ${show(v)}`, pos: 0};
            return {value: v};
        } catch (error) {
            if (error instanceof RuleError) return {error: error.message, pos: error.pos};
            return {error: String(error.message || error), pos: null};
        }
    }

    window.YogaEngine = {
        compile, run, makeChart, parse,
        FUNCTIONS, CONSTANTS, NAMES, P9,
        tables: {SIGN_LORD, EXALT, OWN, MT, FRIENDS, ENEMIES, COMBUST},
    };
})();
