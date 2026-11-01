"use strict";
/*
 * 只靠黄经就能算的印度占星判断（纯函数，不碰页面）：
 *   尊贵（极旺、旺、根三方、庙、陷、落、极落）、Chara Karaka、Baladi / Jagradadi Avastha、
 *   特殊度数（Mrityu Bhaga、Pushkara Bhaga、Pushkara Navamsa、Gandanta）、
 *   天然 / 临时 / 五重友敌、Ashtakavarga、分盘汇总（Vimsopaka、Vaiseshikamsa）、Arudha、Jaimini 星座互看。
 * 需要星历或精确时刻的（Vishesha Lagna、Upagraha、行星战、Shadbala、历法）在后端 astro/jyotish.py、astro/bala.py。
 *
 * 黄经都是当前黄道体系下的黄经；星座 0 白羊 … 11 双鱼。
 */
(function () {
    const norm360 = (x) => ((Number(x) % 360) + 360) % 360;
    const mod12 = (x) => ((x % 12) + 12) % 12;
    const signOf = (lon) => Math.floor(norm360(lon) / 30 + 1e-9) % 12;
    const degIn = (lon) => {
        const x = norm360(lon);
        const d = x - signOf(x) * 30;
        return d >= 0 && d < 30 ? d : 0;
    };

    const P7 = ["Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa"];
    const P9 = [...P7, "Ra", "Ke"];
    const SIGN_LORD = ["Ma", "Ve", "Me", "Mo", "Su", "Me", "Ve", "Ma", "Ju", "Sa", "Sa", "Ju"];
    const OWN = {Su: [4], Mo: [3], Ma: [0, 7], Me: [2, 5], Ju: [8, 11], Ve: [1, 6], Sa: [9, 10], Ra: [], Ke: []};
    const EXALT = {Su: 0, Mo: 1, Ma: 9, Me: 5, Ju: 3, Ve: 11, Sa: 6};
    const NODE_EXALT = {taurus: {Ra: 1, Ke: 7}, gemini: {Ra: 2, Ke: 8}};
    // 根三方（Moolatrikona）：[星座, 起, 止]（BPHS 第 3 章，与 Yoga 引擎一致）
    const MT = {Su: [4, 0, 20], Mo: [1, 4, 30], Ma: [0, 0, 12], Me: [5, 16, 20], Ju: [8, 0, 10], Ve: [6, 0, 15], Sa: [10, 0, 20]};

    // 天然友敌（BPHS 第 3 章）。罗计参与时按常见的说法：友 Me Ve Sa，敌 Su Mo Ma，木星中性。
    const FRIENDS = {
        Su: ["Mo", "Ma", "Ju"], Mo: ["Su", "Me"], Ma: ["Su", "Mo", "Ju"], Me: ["Su", "Ve"],
        Ju: ["Su", "Mo", "Ma"], Ve: ["Me", "Sa"], Sa: ["Me", "Ve"], Ra: ["Me", "Ve", "Sa"], Ke: ["Me", "Ve", "Sa"],
    };
    const ENEMIES = {
        Su: ["Ve", "Sa"], Mo: [], Ma: ["Me"], Me: ["Mo"], Ju: ["Me", "Ve"], Ve: ["Su", "Mo"], Sa: ["Su", "Mo", "Ma"],
        Ra: ["Su", "Mo", "Ma"], Ke: ["Su", "Mo", "Ma"],
    };

    function naturalRel(a, b) {
        if (FRIENDS[a]?.includes(b)) return 1;
        if (ENEMIES[a]?.includes(b)) return -1;
        return 0;
    }

    function temporalRel(signs, a, b) {
        return [1, 2, 3, 9, 10, 11].includes(mod12(signs[b] - signs[a])) ? 1 : -1;
    }

    // ---------------------------------------------------------------- 尊贵

    function exaltSign(code, cfg) {
        if (code in EXALT) return EXALT[code];
        return (NODE_EXALT[cfg?.nodes] || NODE_EXALT.taurus)[code];
    }

    /*
     * 行星表「尊贵」一栏：只给一个最重要的标签。优先次序：极旺、旺、极落、落、根三方、庙、陷。
     * 水星在处女、月亮在金牛按度数分段（擢升段 → 根三方段 → 庙）。罗计只看旺、落。
     */
    function dignity(code, lon, cfg = {}) {
        const s = signOf(lon), d = degIn(lon);
        const ex = exaltSign(code, cfg);
        const deep = Number(cfg.deep?.[code]);
        const orb = Number(cfg.orb ?? 1);
        const mt = MT[code];
        const inMt = mt && s === mt[0] && d >= mt[1] && d < mt[2];
        if (ex === s) {
            const exaltPart = code === "Me" ? d < 15 : code === "Mo" ? d < 4 : true;
            if (exaltPart) {
                if (Number.isFinite(deep) && code in EXALT && Math.abs(d - deep) <= orb) return {key: "deep", text: "极旺", cls: "good"};
                return {key: "exalt", text: "旺", cls: "good"};
            }
        }
        if (ex !== undefined && mod12(ex + 6) === s) {
            if (Number.isFinite(deep) && code in EXALT && Math.abs(d - deep) <= orb) return {key: "deepdeb", text: "极落", cls: "bad"};
            return {key: "debil", text: "落", cls: "bad"};
        }
        if (inMt) return {key: "mt", text: "根三方", cls: "good"};
        if (OWN[code]?.includes(s)) return {key: "own", text: "庙", cls: ""};
        if (cfg.detriment !== false && OWN[code]?.some((o) => mod12(o + 6) === s)) return {key: "det", text: "陷", cls: "dim"};
        return null;
    }

    // 尊贵是否属于「自己的星座」一类（分盘汇总、Jagradadi 用）：庙、旺、根三方星座（按星座，不看度数）
    function dignifiedSign(code, sign, cfg) {
        return OWN[code]?.includes(sign) || exaltSign(code, cfg) === sign || MT[code]?.[0] === sign;
    }

    // ---------------------------------------------------------------- Chara Karaka

    const KARAKA_8 = ["AK", "AmK", "BK", "MK", "PiK", "PK", "GK", "DK"];
    const KARAKA_7 = ["AK", "AmK", "BK", "MK", "PK", "GK", "DK"];

    // 按星座内度数从大到小排；八 Karaka 时罗睺参与，度数取 30 − 星座内度数。
    function charaKarakas(pos, scheme = "8") {
        const list = [...P7, ...(String(scheme) === "8" ? ["Ra"] : [])]
            .filter((p) => pos[p])
            .map((p) => ({p, d: p === "Ra" ? 30 - degIn(pos[p].lon) : degIn(pos[p].lon)}))
            .sort((a, b) => b.d - a.d);
        const names = String(scheme) === "8" ? KARAKA_8 : KARAKA_7;
        return Object.fromEntries(list.map((x, i) => [x.p, names[i]]));
    }

    // ---------------------------------------------------------------- Avastha

    const BALADI = ["婴", "少", "壮", "老", "死"];

    // Baladi：每 6° 一段；奇数星座 婴 少 壮 老 死，偶数星座反过来。
    function baladi(lon) {
        const k = Math.min(4, Math.floor(degIn(lon) / 6));
        return BALADI[signOf(lon) % 2 === 0 ? k : 4 - k];
    }

    // Jagradadi：庙、旺、根三方星座为醒，友或中性的星座为梦，敌的星座或落为眠（按天然友敌）。罗计不算。
    function jagradadi(code, lon, cfg) {
        if (!P7.includes(code)) return null;
        const s = signOf(lon);
        if (dignifiedSign(code, s, cfg)) return "醒";
        if (mod12(exaltSign(code, cfg) + 6) === s) return "眠";
        return naturalRel(code, SIGN_LORD[s]) < 0 ? "眠" : "梦";
    }

    // ---------------------------------------------------------------- 特殊度数

    // Mrityu Bhaga（死度）：每个星座一个度数（第 n 度）。两种出处只有月亮一行不同。
    const MRITYU = {
        Su: [20, 9, 12, 6, 8, 24, 16, 17, 22, 2, 3, 23],
        Ma: [19, 28, 25, 23, 29, 28, 14, 21, 2, 15, 11, 6],
        Me: [15, 14, 13, 12, 8, 18, 20, 10, 21, 22, 7, 5],
        Ju: [19, 29, 12, 27, 6, 4, 13, 10, 17, 11, 15, 28],
        Ve: [28, 15, 11, 17, 10, 13, 4, 6, 27, 12, 29, 19],
        Sa: [10, 4, 7, 9, 12, 16, 3, 18, 28, 14, 13, 15],
        Ra: [14, 13, 12, 11, 24, 23, 22, 21, 10, 20, 18, 8],
        Ke: [8, 18, 20, 10, 21, 22, 23, 24, 11, 12, 13, 14],
    };
    const MRITYU_MOON = {
        phaladeepika: [26, 12, 13, 25, 24, 11, 26, 14, 13, 25, 5, 12],
        jataka_parijata: [8, 25, 22, 22, 21, 1, 4, 23, 18, 20, 20, 10],
    };
    // Pushkara Bhaga（吉度）：每个星座一个度数
    const PUSHKARA_BHAGA = [21, 14, 18, 8, 19, 9, 24, 11, 23, 14, 19, 9];
    // Pushkara Navamsa（吉分）：火象第 7、9 份，土象第 3、5 份，风象第 6、8 份，水象第 1、3 份
    const PUSHKARA_NAVAMSA = [[7, 9], [3, 5], [6, 8], [1, 3]];

    // 第 n 度：span = degree 时为 [n−1, n)；half 时为 n ± 0.5°
    function onDegree(d, n, span) {
        return span === "half" ? Math.abs(d - n) <= 0.5 : d >= n - 1 && d < n;
    }

    function specialDegrees(code, lon, cfg = {}) {
        const s = signOf(lon), d = degIn(lon);
        const tags = [];
        if (cfg.mrityu !== false) {
            const row = code === "Mo" ? MRITYU_MOON[cfg.mrityu_source] || MRITYU_MOON.phaladeepika : MRITYU[code];
            if (row && onDegree(d, row[s], cfg.span)) tags.push({text: "死度", cls: "bad"});
        }
        if (cfg.pushkara_bhaga !== false && onDegree(d, PUSHKARA_BHAGA[s], cfg.span)) tags.push({text: "吉度", cls: "good"});
        if (cfg.pushkara_navamsa !== false && PUSHKARA_NAVAMSA[s % 4].includes(Math.min(8, Math.floor(d / (10 / 3))) + 1)) {
            tags.push({text: "吉分", cls: "good"});
        }
        if (cfg.gandanta !== false) {
            const orb = Number(cfg.gandanta_orb ?? 10 / 3);
            if (([3, 7, 11].includes(s) && d > 30 - orb) || ([4, 8, 0].includes(s) && d < orb)) tags.push({text: "甘丹塔", cls: "bad"});
        }
        return tags;
    }

    // ---------------------------------------------------------------- 友敌

    const REL_TEXT = {2: "大友", 1: "友", 0: "中", "-1": "敌", "-2": "大敌"};

    function friendship(pos, includeNodes) {
        const list = (includeNodes ? P9 : P7).filter((p) => pos[p]);
        const signs = Object.fromEntries(list.map((p) => [p, signOf(pos[p].lon)]));
        const natural = {}, temporal = {}, compound = {};
        for (const a of list) {
            natural[a] = {}; temporal[a] = {}; compound[a] = {};
            for (const b of list) {
                if (a === b) continue;
                const n = naturalRel(a, b), t = temporalRel(signs, a, b);
                natural[a][b] = n; temporal[a][b] = t; compound[a][b] = n + t;
            }
        }
        return {list, natural, temporal, compound};
    }

    // ---------------------------------------------------------------- Ashtakavarga

    // 每颗行星的 BAV：从各贡献者（七曜和上升）数起，哪些星座得一分（BPHS 第 66 章）
    const AV = {
        Su: {Su: [1, 2, 4, 7, 8, 9, 10, 11], Mo: [3, 6, 10, 11], Ma: [1, 2, 4, 7, 8, 9, 10, 11], Me: [3, 5, 6, 9, 10, 11, 12],
             Ju: [5, 6, 9, 11], Ve: [6, 7, 12], Sa: [1, 2, 4, 7, 8, 9, 10, 11], La: [3, 4, 6, 10, 11, 12]},
        Mo: {Su: [3, 6, 7, 8, 10, 11], Mo: [1, 3, 6, 7, 10, 11], Ma: [2, 3, 5, 6, 9, 10, 11], Me: [1, 3, 4, 5, 7, 8, 10, 11],
             Ju: [1, 4, 7, 8, 10, 11, 12], Ve: [3, 4, 5, 7, 9, 10, 11], Sa: [3, 5, 6, 11], La: [3, 6, 10, 11]},
        Ma: {Su: [3, 5, 6, 10, 11], Mo: [3, 6, 11], Ma: [1, 2, 4, 7, 8, 10, 11], Me: [3, 5, 6, 11],
             Ju: [6, 10, 11, 12], Ve: [6, 8, 11, 12], Sa: [1, 4, 7, 8, 9, 10, 11], La: [1, 3, 6, 10, 11]},
        Me: {Su: [5, 6, 9, 11, 12], Mo: [2, 4, 6, 8, 10, 11], Ma: [1, 2, 4, 7, 8, 9, 10, 11], Me: [1, 3, 5, 6, 9, 10, 11, 12],
             Ju: [6, 8, 11, 12], Ve: [1, 2, 3, 4, 5, 8, 9, 11], Sa: [1, 2, 4, 7, 8, 9, 10, 11], La: [1, 2, 4, 6, 8, 10, 11]},
        Ju: {Su: [1, 2, 3, 4, 7, 8, 9, 10, 11], Mo: [2, 5, 7, 9, 11], Ma: [1, 2, 4, 7, 8, 10, 11], Me: [1, 2, 4, 5, 6, 9, 10, 11],
             Ju: [1, 2, 3, 4, 7, 8, 10, 11], Ve: [2, 5, 6, 9, 10, 11], Sa: [3, 5, 6, 12], La: [1, 2, 4, 5, 6, 7, 9, 10, 11]},
        Ve: {Su: [8, 11, 12], Mo: [1, 2, 3, 4, 5, 8, 9, 11, 12], Ma: [3, 5, 6, 9, 11, 12], Me: [3, 5, 6, 9, 11],
             Ju: [5, 8, 9, 10, 11], Ve: [1, 2, 3, 4, 5, 8, 9, 10, 11], Sa: [3, 4, 5, 8, 9, 10, 11], La: [1, 2, 3, 4, 5, 8, 9, 11]},
        Sa: {Su: [1, 2, 4, 7, 8, 10, 11], Mo: [3, 6, 11], Ma: [3, 5, 6, 10, 11, 12], Me: [6, 8, 9, 10, 11, 12],
             Ju: [5, 6, 11, 12], Ve: [6, 11, 12], Sa: [3, 5, 6, 11], La: [1, 3, 4, 6, 10, 11]},
    };

    // 返回 {bav: {行星: [12 个星座的分数]}, sav: [12]}，下标是星座（0 白羊）
    function ashtakavarga(pos, ascLon) {
        const from = {...Object.fromEntries(P7.map((p) => [p, signOf(pos[p].lon)])), La: signOf(ascLon)};
        const bav = {};
        const sav = Array(12).fill(0);
        for (const p of P7) {
            const row = Array(12).fill(0);
            for (const [giver, places] of Object.entries(AV[p])) {
                for (const n of places) row[mod12(from[giver] + n - 1)] += 1;
            }
            bav[p] = row;
            row.forEach((v, i) => { sav[i] += v; });
        }
        return {bav, sav};
    }

    // ---------------------------------------------------------------- 分盘汇总

    const GROUPS = {
        shad: {label: "Shadvarga", weights: {D1: 6, D2: 2, D3: 4, D9: 5, D12: 2, D30: 1},
               names: {2: "Kimshuka", 3: "Vyanjana", 4: "Chamara", 5: "Chatra", 6: "Kundala"}},
        sapta: {label: "Saptavarga", weights: {D1: 5, D2: 2, D3: 3, D7: 2.5, D9: 4.5, D12: 2, D30: 1},
                names: {2: "Kimshuka", 3: "Vyanjana", 4: "Chamara", 5: "Chatra", 6: "Kundala", 7: "Mukuta"}},
        dasha: {label: "Dashavarga", weights: {D1: 3, D2: 1.5, D3: 1.5, D7: 1.5, D9: 1.5, D10: 1.5, D12: 1.5, D16: 1.5, D30: 1.5, D60: 5},
                names: {2: "Parijata", 3: "Uttama", 4: "Gopura", 5: "Simhasana", 6: "Paravata", 7: "Devaloka", 8: "Brahmaloka",
                        9: "Airavata", 10: "Sridhama"}},
        shodasha: {label: "Shodashavarga",
                   weights: {D1: 3.5, D2: 1, D3: 1, D4: 0.5, D7: 0.5, D9: 3, D10: 0.5, D12: 0.5, D16: 2, D20: 0.5, D24: 0.5,
                             D27: 0.5, D30: 1, D40: 0.5, D45: 0.5, D60: 4},
                   names: {2: "Bhedaka", 3: "Kusuma", 4: "Nagapushpa", 5: "Kanduka", 6: "Kerala", 7: "Kalpavriksha",
                           8: "Chandanavana", 9: "Purnachandra", 10: "Uchchaisrava", 11: "Dhanvantari", 12: "Suryakanta",
                           13: "Vidruma", 14: "Sakra Simhasana", 15: "Goloka", 16: "Sri Vallabha"}},
    };
    const VIMSOPAKA_POINTS = {2: 18, 1: 15, 0: 10, "-1": 7, "-2": 5};

    /*
     * signsByVarga: {D1: {代号: 星座}, D2: {...}, ...}（用当前的分盘算法换算好）
     * 每颗星：在每张分盘里，庙、旺、根三方星座得 20 分，否则按它与那个星座主星的五重关系（以 D1 判断临时友敌）
     * 大友 18、友 15、中 10、敌 7、大敌 5；再按所选分盘组的权重折算成 20 分制。
     * Vaiseshikamsa：所选分盘组里有几张落在庙、旺、根三方星座（2 张起有名称）。
     */
    function vargaSummary(signsByVarga, codes, cfg, groups = {vimsopaka: "shodasha", vaiseshikamsa: "dasha"}, includeNodes = false) {
        const d1 = signsByVarga.D1 || {};
        const rel = (a, b) => naturalRel(a, b) + temporalRel(d1, a, b);
        const vg = GROUPS[groups.vimsopaka] || GROUPS.shodasha;
        const vs = GROUPS[groups.vaiseshikamsa] || GROUPS.dasha;
        const out = {};
        for (const code of codes) {
            if (!P7.includes(code) && !(includeNodes && (code === "Ra" || code === "Ke"))) {
                out[code] = {vimsopaka: null, count: null, name: ""};
                continue;
            }
            let score = 0;
            for (const [id, w] of Object.entries(vg.weights)) {
                const s = signsByVarga[id]?.[code];
                if (s === undefined) continue;
                const lord = SIGN_LORD[s];
                const pts = dignifiedSign(code, s, cfg) || lord === code ? 20 : VIMSOPAKA_POINTS[rel(code, lord)];
                score += (w * pts) / 20;
            }
            const count = Object.keys(vs.weights).filter((id) => {
                const s = signsByVarga[id]?.[code];
                return s !== undefined && dignifiedSign(code, s, cfg);
            }).length;
            out[code] = {vimsopaka: score, count, name: vs.names[count] || ""};
        }
        return out;
    }

    // ---------------------------------------------------------------- Arudha

    const ARUDHA_CODES = ["AL", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "UL"];

    // 天蝎（火星 / 计都）、水瓶（土星 / 罗睺）两个主星里取较强者（Jaimini 的简化规则）：
    // 一个在本星座、另一个不在 → 取不在的；都在或都不在 → 同宫行星多的；再相同 → 星座内度数大的。
    function strongerLord(sign, a, b, signs, degs) {
        const inA = signs[a] === sign, inB = signs[b] === sign;
        if (inA !== inB) return inA ? b : a;
        const company = (p) => P9.filter((q) => q !== p && signs[q] === signs[p]).length;
        if (company(a) !== company(b)) return company(a) > company(b) ? a : b;
        return (degs[a] ?? 0) >= (degs[b] ?? 0) ? a : b;
    }

    // signs/degs：{代号: 星座 / 星座内度数}，lagna：第一宫的星座。返回 {AL: 星座, A2: …, UL: …}
    function arudhas(signs, degs, lagna, cfg = {}) {
        const out = {};
        for (let h = 0; h < 12; h++) {
            const sign = mod12(lagna + h);
            let lord = SIGN_LORD[sign];
            if (cfg.dual_lord !== "primary" && (sign === 7 || sign === 10) && signs.Ke !== undefined) {
                lord = sign === 7 ? strongerLord(sign, "Ma", "Ke", signs, degs) : strongerLord(sign, "Sa", "Ra", signs, degs);
            }
            const ls = signs[lord];
            if (ls === undefined) continue;
            const n = mod12(ls - sign);                    // 从本宫数到主星：第 n+1 个
            let pada = mod12(ls + n);
            if (cfg.arudha_exception !== false && (pada === sign || pada === mod12(sign + 6))) pada = mod12(pada + 9);
            out[ARUDHA_CODES[h]] = pada;
        }
        return out;
    }

    // ---------------------------------------------------------------- Jaimini 星座互看

    // 动星座看定星座（相邻的除外），定星座看动星座（相邻的除外），变星座互看。
    function rasiAspects(sign) {
        const out = [];
        for (let t = 0; t < 12; t++) {
            if (t === sign) continue;
            const ms = sign % 3, mt = t % 3;
            const adjacent = mod12(t - sign) === 1 || mod12(sign - t) === 1;
            if ((ms === 0 && mt === 1 && !adjacent) || (ms === 1 && mt === 0 && !adjacent) || (ms === 2 && mt === 2)) out.push(t);
        }
        return out;
    }

    window.Jyotish = {
        P7, P9, SIGN_LORD, REL_TEXT, GROUPS, ARUDHA_CODES,
        signOf, degIn, naturalRel,
        dignity, dignifiedSign, charaKarakas, baladi, jagradadi, specialDegrees,
        friendship, ashtakavarga, vargaSummary, arudhas, rasiAspects, exaltSign,
    };
})();
