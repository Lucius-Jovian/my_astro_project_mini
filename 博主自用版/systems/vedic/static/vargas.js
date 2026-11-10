"use strict";
/*
 * 分盘（Varga）注册表：每一张 D 盘是什么、有哪几种算法、每种算法怎样把黄经换算成分盘黄经。
 *
 * 只在这一个文件里登记，页面上的分盘菜单、计算设置里的「分盘算法」浮窗、星盘上方的说明文字
 * 全部从这里自动生成。以后要：
 *   - 给某张分盘加一种别的典籍的算法：在它的 methods 里加一项（见下面「怎样加一种算法」）；
 *   - 加一张新的分盘（例如 D5、D6、D8、D11、D81、D108、D144）：在 VARGAS 里加一项。
 * 不需要改 vedic.js、common.js 或后端；后端只按格式检查保存的算法名称。
 *
 * 性能：这里只有数据和几十行换算函数。分盘不会预先计算，只有在星盘上方点到那一张时才换算
 * （每张盘十来个点，一次不到 1 毫秒），换算结果缓存到本命盘重算或算法改变为止。
 * 所以分盘再多，也只多了菜单里的几个按钮，浏览器的负担不变。
 *
 * ─────────────────────────── 约定 ───────────────────────────
 * 黄经 lon：0–360°。星座序号 s：0 白羊 … 11 双鱼。sign 内度数 d：0–30°。
 * 一种算法 = {label, source, note?, toLon(lon) → 分盘黄经}。
 * 分盘黄经 = 分盘星座 × 30 + 这一份里走过的比例 × 30。
 * 这样分盘里显示的度数是“在这一份里的进度”，与常见软件的写法一致；对循环法（Parivritti）来说
 * 它恰好等于 原黄经 × n 取 360 的余数。
 *
 * ─────────────────────────── 怎样加一种算法 ───────────────────────────
 *   在某张分盘的 methods 里加：
 *     my_method: {
 *         label: "显示在下拉框里的名字",
 *         source: "出处，如 Jataka Parijata",
 *         note: "（可选）一句话说明",
 *         toLon: equalParts(9, (s) => s),           // 等分，每份从哪一个星座数起（连续往后数）
 *         // 或 toLon: mappedParts(3, (s) => [s, s + 4, s + 8]),   // 等分，每份直接指定星座
 *         // 或 toLon: unequalParts((s) => [[5, 0], [10, 10], ...]), // 不等分：[这一份的终点度数, 星座]
 *         // 或 toLon: cyclic(9),                   // 循环法：从白羊起连续数下去
 *         // 或 toLon: (lon) => 自己写的换算，返回 0–360 的分盘黄经
 *     },
 *   方法的键（my_method）只能用小写字母、数字、_ 和 -，它会写进 settings.json。
 */
(function () {
    const norm360 = (x) => ((Number(x) % 360) + 360) % 360;
    const mod12 = (x) => ((x % 12) + 12) % 12;

    // 星座分类（s 从 0 起）：白羊、巨蟹、天秤、摩羯为动（Chara）；金牛、狮子、天蝎、水瓶为定（Sthira）；其余为变（Dvisvabhava）。
    const isMovable = (s) => s % 3 === 0;
    const isFixed = (s) => s % 3 === 1;
    // 奇数星座（白羊、双子……）= 阳性；偶数星座（金牛、巨蟹……）= 阴性。
    const isOdd = (s) => s % 2 === 0;
    const byModality = (movable, fixed, dual) => (s) => (isMovable(s) ? movable : isFixed(s) ? fixed : dual);

    // 把黄经拆成：星座、星座内度数。
    function split(lon) {
        const x = norm360(lon);
        const s = Math.min(11, Math.floor(x / 30));
        return {s, d: x - s * 30};
    }

    // 第 k 份（共 n 份等分）与这一份里走过的比例。浮点误差不让它越过最后一份。
    function partOf(d, n) {
        const pos = (d * n) / 30;
        const k = Math.min(n - 1, Math.floor(pos));
        return {k, frac: Math.min(1, Math.max(0, pos - k))};
    }

    // 等分 n 份，第 1 份落在 start(s)，以后每份往后数一个星座。
    function equalParts(n, start) {
        return (lon) => {
            const {s, d} = split(lon);
            const {k, frac} = partOf(d, n);
            return mod12(start(s) + k) * 30 + frac * 30;
        };
    }

    // 等分 n 份，每一份落在哪个星座直接给出（signs(s) 返回长度为 n 的数组）。
    function mappedParts(n, signs) {
        return (lon) => {
            const {s, d} = split(lon);
            const {k, frac} = partOf(d, n);
            return mod12(signs(s)[k]) * 30 + frac * 30;
        };
    }

    // 不等分：segments(s) 返回 [[这一份的终点度数, 星座], ...]，终点度数递增，最后一份到 30。
    function unequalParts(segments) {
        return (lon) => {
            const {s, d} = split(lon);
            let from = 0;
            for (const [to, sign] of segments(s)) {
                if (d < to || to >= 30) {
                    const frac = Math.min(1, Math.max(0, (d - from) / (to - from)));
                    return mod12(sign) * 30 + frac * 30;
                }
                from = to;
            }
            return 0;
        };
    }

    // 循环法（Parivritti）：从白羊起连续数下去，分盘黄经 = 原黄经 × n。
    function cyclic(n) {
        return (lon) => (norm360(lon) * n) % 360;
    }

    const BPHS = "BPHS 第 6 章";
    const PARIVRITTI = {
        label: "Parivritti 循环法",
        source: "Parivritti（循环）",
        note: "从白羊起连续数下去，不分奇偶和动定变",
    };
    const parivritti = (n) => ({...PARIVRITTI, toLon: cyclic(n)});

    // 星座：0 白羊 1 金牛 2 双子 3 巨蟹 4 狮子 5 处女 6 天秤 7 天蝎 8 射手 9 摩羯 10 水瓶 11 双鱼
    const ARI = 0, TAU = 1, GEM = 2, CAN = 3, LEO = 4, VIR = 5, LIB = 6, SCO = 7, SAG = 8, CAP = 9, AQU = 10, PIS = 11;

    /*
     * 分盘清单（顺序 = 菜单里的顺序）。
     *   id       网址、设置里用的名字；也是星盘上方按钮显示的名字
     *   n        一个星座分成几份（只作说明，换算以 toLon 为准）
     *   name     梵文名
     *   topic    主要看什么（BPHS 第 6 章的说法，简写）
     *   view     对应的星盘视图键；D1 就是 Rashi 本身（natal），其余默认等于 id
     *   methods  可选的算法；第一个是默认算法
     */
    const VARGAS = [
        {
            id: "D1", n: 1, name: "Rashi", topic: "本命", view: "natal",
            methods: {bphs: {label: "Parashara（BPHS）", source: BPHS, toLon: (lon) => norm360(lon)}},
        },
        {
            id: "D2", n: 2, name: "Hora", topic: "财富",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "奇数星座前 15° 太阳 Hora（狮子）、后 15° 月亮 Hora（巨蟹）；偶数星座相反",
                    toLon: mappedParts(2, (s) => (isOdd(s) ? [LEO, CAN] : [CAN, LEO])),
                },
                parivritti: parivritti(2),
            },
        },
        {
            id: "D3", n: 3, name: "Drekkana", topic: "兄弟姐妹",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "0–10° 本星座，10–20° 第 5 个星座，20–30° 第 9 个星座",
                    toLon: mappedParts(3, (s) => [s, s + 4, s + 8]),
                },
                parivritti: parivritti(3),
            },
        },
        {
            id: "D4", n: 4, name: "Chaturthamsa", topic: "福运 · 产业",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "四份依次落在本星座、第 4、第 7、第 10 个星座",
                    toLon: mappedParts(4, (s) => [s, s + 3, s + 6, s + 9]),
                },
                parivritti: parivritti(4),
            },
        },
        {
            id: "D7", n: 7, name: "Saptamsa", topic: "子女",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "奇数星座从本星座数起，偶数星座从第 7 个星座数起",
                    toLon: equalParts(7, (s) => (isOdd(s) ? s : s + 6)),
                },
                parivritti: parivritti(7),
            },
        },
        {
            id: "D9", n: 9, name: "Navamsa", topic: "配偶 · 品质",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "动星座从本星座、定星座从第 9 个、变星座从第 5 个星座数起（与循环法结果相同）",
                    toLon: equalParts(9, (s) => s + byModality(0, 8, 4)(s)),
                },
            },
        },
        {
            id: "D10", n: 10, name: "Dasamsa", topic: "事业 · 地位",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "奇数星座从本星座数起，偶数星座从第 9 个星座数起",
                    toLon: equalParts(10, (s) => (isOdd(s) ? s : s + 8)),
                },
                parivritti: parivritti(10),
            },
        },
        {
            id: "D12", n: 12, name: "Dwadasamsa", topic: "父母",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "从本星座数起",
                    toLon: equalParts(12, (s) => s),
                },
                parivritti: parivritti(12),
            },
        },
        {
            id: "D16", n: 16, name: "Shodasamsa", topic: "车乘 · 享受",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "动星座从白羊、定星座从狮子、变星座从射手数起（与循环法结果相同）",
                    toLon: equalParts(16, byModality(ARI, LEO, SAG)),
                },
            },
        },
        {
            id: "D20", n: 20, name: "Vimsamsa", topic: "修行 · 信仰",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "动星座从白羊、定星座从射手、变星座从狮子数起（与循环法结果相同）",
                    toLon: equalParts(20, byModality(ARI, SAG, LEO)),
                },
            },
        },
        {
            id: "D24", n: 24, name: "Chaturvimsamsa", topic: "学业",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "奇数星座从狮子数起，偶数星座从巨蟹数起",
                    toLon: equalParts(24, (s) => (isOdd(s) ? LEO : CAN)),
                },
                parivritti: parivritti(24),
            },
        },
        {
            id: "D27", n: 27, name: "Saptavimsamsa", topic: "强弱",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "火象从白羊、土象从巨蟹、风象从天秤、水象从摩羯数起（与循环法结果相同）",
                    toLon: equalParts(27, (s) => [ARI, CAN, LIB, CAP][s % 4]),
                },
            },
        },
        {
            id: "D30", n: 30, name: "Trimsamsa", topic: "灾厄",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "不等分。奇数星座：火 5°、土 5°、木 8°、水 7°、金 5°；偶数星座顺序相反",
                    toLon: unequalParts((s) => (isOdd(s)
                        ? [[5, ARI], [10, AQU], [18, SAG], [25, GEM], [30, LIB]]
                        : [[5, TAU], [12, VIR], [20, PIS], [25, CAP], [30, SCO]])),
                },
                parivritti: parivritti(30),
            },
        },
        {
            id: "D40", n: 40, name: "Khavedamsa", topic: "吉凶",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "奇数星座从白羊数起，偶数星座从天秤数起",
                    toLon: equalParts(40, (s) => (isOdd(s) ? ARI : LIB)),
                },
                parivritti: parivritti(40),
            },
        },
        {
            id: "D45", n: 45, name: "Akshavedamsa", topic: "品性",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "动星座从白羊、定星座从狮子、变星座从射手数起",
                    toLon: equalParts(45, byModality(ARI, LEO, SAG)),
                },
                parivritti: parivritti(45),
            },
        },
        {
            id: "D60", n: 60, name: "Shashtiamsa", topic: "总体",
            methods: {
                bphs: {
                    label: "Parashara（BPHS）", source: BPHS,
                    note: "从本星座数起，每 0°30′ 一份",
                    toLon: equalParts(60, (s) => s),
                },
                parivritti: parivritti(60),
            },
        },
    ];

    const METHOD_KEY_RE = /^[a-z0-9_-]{1,40}$/;
    const byId = new Map();

    function check(varga) {
        if (!/^D\d{1,3}$/.test(varga.id)) throw new Error(`分盘 id 必须写成 D 加数字：${varga.id}`);
        const keys = Object.keys(varga.methods || {});
        if (!keys.length) throw new Error(`分盘 ${varga.id} 至少要有一种算法`);
        for (const key of keys) {
            if (!METHOD_KEY_RE.test(key)) throw new Error(`分盘 ${varga.id} 的算法名称不合法：${key}`);
            if (typeof varga.methods[key].toLon !== "function") throw new Error(`分盘 ${varga.id} 的算法 ${key} 缺少 toLon`);
        }
    }

    // 登记一张分盘；id 已存在时整张替换。
    function register(varga) {
        check(varga);
        const entry = {view: varga.id, ...varga};
        if (byId.has(entry.id)) VARGAS.splice(VARGAS.findIndex((v) => v.id === entry.id), 1, entry);
        else VARGAS.push(entry);
        byId.set(entry.id, entry);
        return entry;
    }

    // 给已有的分盘加一种算法（别的文件也可以调用，不必改上面的清单）。
    function addMethod(id, key, method) {
        const varga = byId.get(id);
        if (!varga) throw new Error(`没有分盘 ${id}`);
        varga.methods[key] = method;
        check(varga);
    }

    VARGAS.splice(0, VARGAS.length, ...VARGAS.map((v) => {
        check(v);
        return {view: v.id, ...v};
    }));
    VARGAS.forEach((v) => byId.set(v.id, v));

    function defaultMethod(id) {
        return Object.keys(byId.get(id)?.methods || {})[0] || null;
    }

    // 实际要用的算法：设置里选的那种；设置里写的算法不存在（例如删掉了）就用默认算法。
    function resolveMethod(id, chosen) {
        const varga = byId.get(id);
        if (!varga) return null;
        return chosen && varga.methods[chosen] ? chosen : defaultMethod(id);
    }

    window.VedicVargas = {
        list: () => VARGAS.slice(),
        get: (id) => byId.get(id) || null,
        defaultMethod,
        resolveMethod,
        register,
        addMethod,
        // 供别的文件写新算法时复用
        helpers: {equalParts, mappedParts, unequalParts, cyclic, isOdd, isMovable, isFixed, byModality, norm360},
    };
})();
