"use strict";
/*
 * 默认 Yoga 清单。每一条都只是「名称 + 公式 + 说明」，与使用者自己新建的 Yoga 完全一样，
 * 由 yoga_engine.js 编译、计算。使用者可以停用、修改、删除任何一条（改动存在 settings.json，
 * 不会改这个文件）；删掉或改坏了，在「管理 Yoga」里点「恢复默认」即可。
 *
 * 字段：
 *   id      唯一编号（只用字母、数字、_ . -），会写进 settings.json；以后改名字不要改 id
 *   name    梵文名；cn 中文名
 *   cat     分类（见 CATEGORIES）
 *   rule    条件公式（写法见 yoga_engine.js 开头）
 *   desc    条件的中文说明；effect 主要含义（简述）；src 出处
 *
 * 出处缩写：BPHS = Brihat Parashara Hora Shastra；PD = Phaladeepika；SA = Saravali；
 *           现代 = 近现代常用、古籍里没有统一定义的说法。
 * 同一个 Yoga 各家定义常有出入，这里取较常见、可以明确判断的一种；需要别的定义时直接改公式。
 */
(function () {
    const CATEGORIES = [
        {id: "mahapurusha", label: "五大人物 Pancha Mahapurusha"},
        {id: "lunar", label: "月亮 Chandra"},
        {id: "solar", label: "太阳 Surya"},
        {id: "raja", label: "王者 Raja"},
        {id: "dhana", label: "财富 Dhana"},
        {id: "neecha", label: "入弱解除 Neecha Bhanga"},
        {id: "viparita", label: "逆转 Viparita"},
        {id: "parivartana", label: "宫主互换 Parivartana"},
        {id: "named", label: "其他名 Yoga"},
        {id: "nabhasa", label: "那跋娑 Nabhasa"},
        {id: "dosha", label: "凶象 Dosha"},
        {id: "vargottama", label: "同宫 Vargottama"},
        {id: "custom", label: "自定义"},
    ];

    const Y = [];
    const add = (id, name, cn, cat, rule, desc, effect = "", src = "") => Y.push({id, name, cn, cat, rule, desc, effect, src});
    const PNAME = {Su: "太阳", Mo: "月亮", Ma: "火星", Me: "水星", Ju: "木星", Ve: "金星", Sa: "土星", Ra: "罗睺", Ke: "计都"};

    // ---------------------------------------------------------------- 五大人物
    [
        ["ruchaka", "Ruchaka", "火星", "Ma", "勇武、领导、军警"],
        ["bhadra", "Bhadra", "水星", "Me", "聪慧、口才、学识"],
        ["hamsa", "Hamsa", "木星", "Ju", "正直、受人尊敬、学识"],
        ["malavya", "Malavya", "金星", "Ve", "富足、享受、艺术"],
        ["sasa", "Sasa", "土星", "Sa", "权势、掌管众人"],
    ].forEach(([id, name, cnp, p, effect]) => add(
        `mp.${id}`, name, cnp, "mahapurusha",
        `house(${p}) in KENDRA and (own(${p}) or exalted(${p}))`,
        `${cnp}在自己的星座或擢升星座，并落在角宫`, effect, "BPHS 75",
    ));

    // ---------------------------------------------------------------- 月亮
    add("moon.sunapha", "Sunapha", "月前", "lunar", "any_in(P5, [2], Mo)",
        "月亮之后的第 2 宫有行星（不算太阳、罗睺、计都）", "自力致富、有名声", "BPHS 37 / PD 6");
    add("moon.anapha", "Anapha", "月后", "lunar", "any_in(P5, [12], Mo)",
        "月亮之前的第 12 宫有行星（不算太阳、罗睺、计都）", "健康、品格好、有威望", "BPHS 37 / PD 6");
    add("moon.durudhara", "Durudhara", "月夹", "lunar", "any_in(P5, [2], Mo) and any_in(P5, [12], Mo)",
        "月亮前后（第 2、12 宫）都有行星（不算太阳、罗睺、计都）", "富裕、慷慨、享受", "BPHS 37 / PD 6");
    add("moon.kemadruma", "Kemadruma", "月孤", "lunar", "not any_in(P5, [2, 12], Mo)",
        "月亮前后（第 2、12 宫）都没有行星（不算太阳、罗睺、计都）", "孤立、困顿（看是否解除）", "BPHS 37 / PD 6");
    add("moon.kemadruma_bhanga", "Kemadruma Bhanga", "月孤解除", "lunar",
        "not any_in(P5, [2, 12], Mo) and (any_in(P7 - [Mo], KENDRA) or any_in(P7 - [Mo], KENDRA, Mo))",
        "有 Kemadruma，但有行星落在 Lagna 或月亮的角宫，凶象解除", "Kemadruma 的不利大为减轻", "PD 6 / SA");
    add("moon.adhi", "Chandra Adhi", "月亮 Adhi", "lunar", "all_in([Me, Ju, Ve], [6, 7, 8], Mo)",
        "水星、木星、金星都落在月亮起的第 6、7、8 宫", "领导、高位、富足", "BPHS 37 / PD 6");
    add("moon.gajakesari", "Gaja Kesari", "象狮", "lunar", "house(Ju, Mo) in KENDRA",
        "木星在月亮起的角宫", "名声、智慧、长久的财富", "BPHS 36 / PD 6");
    add("moon.chandra_mangala", "Chandra Mangala", "月火", "lunar", "conj(Mo, Ma) or (aspect(Mo, Ma) and aspect(Ma, Mo))",
        "月亮与火星同格，或互相投射相位", "善于赚钱、经商", "PD 6");
    add("moon.shakata", "Shakata", "车轮", "lunar", "house(Mo, Ju) in [6, 8, 12] and not house(Mo) in KENDRA",
        "月亮在木星起的第 6、8、12 宫，而且不在 Lagna 的角宫", "起落不定", "BPHS 36 / PD 6");
    add("moon.vasumati", "Vasumati", "富有", "lunar", "all_in([Me, Ju, Ve], UPACHAYA, Mo) or all_in([Me, Ju, Ve], UPACHAYA)",
        "水星、木星、金星都在月亮或 Lagna 起的增长宫（3、6、10、11）", "钱财充裕", "PD 6");

    // ---------------------------------------------------------------- 太阳
    add("sun.vesi", "Vesi", "日前", "solar", "any_in(P5, [2], Su)",
        "太阳之后的第 2 宫有行星（不算月亮、罗睺、计都）", "平稳、诚实", "BPHS 38 / PD 6");
    add("sun.vosi", "Vosi", "日后", "solar", "any_in(P5, [12], Su)",
        "太阳之前的第 12 宫有行星（不算月亮、罗睺、计都）", "能干、慷慨", "BPHS 38 / PD 6");
    add("sun.ubhayachari", "Ubhayachari", "日夹", "solar", "any_in(P5, [2], Su) and any_in(P5, [12], Su)",
        "太阳前后（第 2、12 宫）都有行星（不算月亮、罗睺、计都）", "地位高、口才好", "BPHS 38 / PD 6");
    add("sun.budhaditya", "Budha Aditya", "日水", "solar", "conj(Su, Me)",
        "太阳与水星同格", "聪明、有技巧、受人称赞", "PD 6");

    // ---------------------------------------------------------------- 王者：角宫主与三方宫主的关联
    const RAJA_PAIRS = [[1, 5], [1, 9], [4, 1], [4, 5], [4, 9], [7, 1], [7, 5], [7, 9], [10, 1], [10, 5]];
    RAJA_PAIRS.forEach(([k, t]) => add(
        `raja.${k}_${t}`, "Raja", `王者（${k}、${t} 宫主）`, "raja",
        `assoc(lord(${k}), lord(${t}))`,
        `第 ${k} 宫主与第 ${t} 宫主有关联（同格、星座互换或互相投射相位）`, "地位、权力、成就", "BPHS 41",
    ));
    add("raja.dharma_karma", "Dharma Karmadhipati", "法业王者（9、10 宫主）", "raja", "assoc(lord(9), lord(10))",
        "第 9 宫主与第 10 宫主有关联（同格、星座互换或互相投射相位）", "事业有成、名利兼得", "BPHS 41");
    add("raja.yogakaraka_kendra", "Yogakaraka", "成就星在角宫三方", "raja",
        "(yogakaraka(Ma) and house(Ma) in [1, 4, 5, 7, 9, 10]) or (yogakaraka(Ve) and house(Ve) in [1, 4, 5, 7, 9, 10]) or (yogakaraka(Sa) and house(Sa) in [1, 4, 5, 7, 9, 10])",
        "同时主管角宫和三方宫的行星（Yogakaraka）落在角宫或三方宫", "这颗行星的大运带来上升", "BPHS 34");
    add("raja.lakshmi", "Lakshmi", "吉祥天女", "raja",
        "strong(lord(1)) and (own(lord(9)) or exalted(lord(9))) and house(lord(9)) in [1, 4, 5, 7, 9, 10]",
        "命主星有力（擢升、原三方或入庙），第 9 宫主入庙或擢升并落在角宫、三方宫", "富贵、有德", "BPHS 36 / PD 6");

    // ---------------------------------------------------------------- 财富
    const DHANA_PAIRS = [[1, 2], [1, 5], [1, 9], [1, 11], [2, 5], [2, 9], [2, 11], [5, 9], [5, 11], [9, 11]];
    DHANA_PAIRS.forEach(([a, b]) => add(
        `dhana.${a}_${b}`, "Dhana", `财富（${a}、${b} 宫主）`, "dhana",
        `assoc(lord(${a}), lord(${b}))`,
        `第 ${a} 宫主与第 ${b} 宫主有关联（同格、星座互换或互相投射相位）`, "钱财", "BPHS 42",
    ));
    add("dhana.kalanidhi", "Kalanidhi", "宝藏", "dhana",
        "house(Ju) in [2, 5] and (conj(Ju, Me) or aspect(Me, Ju)) and (conj(Ju, Ve) or aspect(Ve, Ju))",
        "木星在第 2 或第 5 宫，并与水星、金星同格或受它们的相位", "富有、有学问", "PD 6");
    add("dhana.khadga", "Khadga", "宝剑", "dhana",
        "house(lord(2)) == 9 and house(lord(9)) == 2 and house(lord(1)) in [1, 4, 5, 7, 9, 10]",
        "第 2 宫主在第 9 宫、第 9 宫主在第 2 宫，命主星在角宫或三方宫", "富有、幸运", "BPHS 36");

    // ---------------------------------------------------------------- 入弱解除
    ["Su", "Mo", "Ma", "Me", "Ju", "Ve", "Sa"].forEach((p) => add(
        `neecha.${p}`, "Neecha Bhanga", `入弱解除（${PNAME[p]}）`, "neecha",
        `debilitated(${p}) and (house(deblord(${p})) in KENDRA or house(deblord(${p}), Mo) in KENDRA or ` +
        `house(exlord(${p})) in KENDRA or house(exlord(${p}), Mo) in KENDRA or aspect(deblord(${p}), ${p}) or ` +
        `dsign(${p}, 9) == exsign(${p}))`,
        `${PNAME[p]}入弱，但入弱星座的主星或擢升星座的主星在 Lagna 或月亮的角宫，或入弱星座主星对它投射相位，或它在 D9 擢升`,
        "先抑后扬", "BPHS 28 / PD 7",
    ));

    // ---------------------------------------------------------------- 逆转
    add("viparita.harsha", "Harsha", "逆转·喜", "viparita", "house(lord(6)) in DUSTHANA",
        "第 6 宫主落在第 6、8、12 宫", "健康、胜过对手", "BPHS 36");
    add("viparita.sarala", "Sarala", "逆转·直", "viparita", "house(lord(8)) in DUSTHANA",
        "第 8 宫主落在第 6、8、12 宫", "长寿、无畏", "BPHS 36");
    add("viparita.vimala", "Vimala", "逆转·净", "viparita", "house(lord(12)) in DUSTHANA",
        "第 12 宫主落在第 6、8、12 宫", "节俭、独立、品行好", "BPHS 36");

    // ---------------------------------------------------------------- 宫主互换
    const GOOD = "[1, 2, 4, 5, 7, 9, 10, 11]";
    add("pari.maha", "Maha Parivartana", "大互换", "parivartana", `parivartana(${GOOD}, ${GOOD})`,
        "第 1、2、4、5、7、9、10、11 宫中两个宫的宫主互相落在对方的宫里", "大吉，相关两宫的事情兴旺", "PD 6");
    add("pari.khala", "Khala Parivartana", "互换（涉及 3 宫）", "parivartana", `parivartana([3], ${GOOD})`,
        "第 3 宫主与第 1、2、4、5、7、9、10、11 宫之一的宫主互换", "起伏、时好时坏", "PD 6");
    add("pari.dainya", "Dainya Parivartana", "互换（涉及凶宫）", "parivartana",
        "parivartana(DUSTHANA, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])",
        "第 6、8、12 宫之一的宫主与另一宫的宫主互换", "困扰、损耗", "PD 6");

    // ---------------------------------------------------------------- 其他名 Yoga
    add("named.shubha_kartari", "Shubha Kartari", "吉夹", "named",
        "any_in(benefics(), [2]) and any_in(benefics(), [12]) and not any_in(malefics(), [2, 12])",
        "第 2、12 宫都有吉星，而且没有凶星（Lagna 被吉星夹住）", "顺利、受保护", "BPHS");
    add("named.papa_kartari", "Papa Kartari", "凶夹", "named",
        "any_in(malefics(), [2]) and any_in(malefics(), [12])",
        "第 2、12 宫都有凶星（Lagna 被凶星夹住）", "受压制、阻碍多", "BPHS");
    add("named.lagnadhi", "Lagna Adhi", "命宫 Adhi", "named", "all_in([Me, Ju, Ve], [6, 7, 8])",
        "水星、木星、金星都落在 Lagna 起的第 6、7、8 宫", "有学问、地位高", "PD 6");
    add("named.amala", "Amala", "无瑕", "named",
        "(count(in_house(10)) > 0 and subset(in_house(10), benefics())) or (count(in_house(10, Mo)) > 0 and subset(in_house(10, Mo), benefics()))",
        "Lagna 或月亮起的第 10 宫只有吉星", "名誉好、品行端正", "PD 6");
    add("named.saraswati", "Saraswati", "辩才天女", "named",
        "all_in([Ju, Ve, Me], [1, 2, 4, 5, 7, 9, 10]) and (own(Ju) or exalted(Ju) or friend_sign(Ju))",
        "木星、金星、水星都在角宫、三方宫或第 2 宫，木星入庙、擢升或在朋友的星座", "学识、文采、口才", "PD 6");
    add("named.parvata", "Parvata", "山", "named",
        "(any_in(benefics(), KENDRA) and not any_in(malefics(), KENDRA) and not any_in(malefics(), [6, 8])) or house(lord(12), lord(1)) in KENDRA",
        "角宫有吉星而无凶星，第 6、8 宫没有凶星；或命主星与第 12 宫主互在角宫", "富裕、受尊敬", "BPHS 36");
    add("named.kahala", "Kahala", "鼓", "named", "lord(4) != lord(9) and house(lord(4), lord(9)) in KENDRA and strong(lord(1))",
        "第 4 宫主与第 9 宫主互在角宫，命主星有力", "勇敢、有权势", "BPHS 36");
    add("named.chamara", "Chamara", "拂尘", "named",
        "(exalted(lord(1)) and house(lord(1)) in KENDRA and aspect(Ju, lord(1))) or count_in(benefics(), [1]) >= 2 or count_in(benefics(), [7]) >= 2 or count_in(benefics(), [9]) >= 2 or count_in(benefics(), [10]) >= 2",
        "命主星擢升在角宫并受木星相位；或第 1、7、9、10 宫之一有两颗吉星", "受王者器重、长寿、博学", "BPHS 36");
    add("named.shankha", "Shankha", "海螺", "named", "lord(5) != lord(6) and house(lord(5), lord(6)) in KENDRA and strong(lord(1))",
        "第 5 宫主与第 6 宫主互在角宫，命主星有力", "仁慈、长寿、有福", "BPHS 36");
    add("named.bheri", "Bheri", "战鼓", "named", "all_in([Ve, Ju, lord(1)], KENDRA) and strong(lord(9))",
        "金星、木星和命主星都在角宫，第 9 宫主有力", "富有、名声、长寿", "BPHS 36");
    add("named.sreenatha", "Sreenatha", "吉祥主", "named",
        "exalted(lord(7)) and house(lord(7)) == 10 and conj(lord(10), lord(9))",
        "第 7 宫主擢升在第 10 宫，第 10 宫主与第 9 宫主同格", "富贵", "BPHS 36");
    add("named.chatussagara", "Chatussagara", "四海", "named", "subset(KENDRA, houses_of(P9))",
        "四个角宫都有行星", "名声远播", "PD 6");
    add("named.guru_mangala", "Guru Mangala", "木火", "named", "conj(Ju, Ma) or (aspect(Ju, Ma) and aspect(Ma, Ju))",
        "木星与火星同格，或互相投射相位", "有魄力、有成就", "现代");
    add("named.duryoga", "Duryoga", "事业不顺", "named", "house(lord(10)) in DUSTHANA",
        "第 10 宫主落在第 6、8、12 宫", "事业辛劳、难得赏识", "PD 6");
    add("named.daridra", "Daridra", "贫乏", "named", "house(lord(11)) in DUSTHANA",
        "第 11 宫主落在第 6、8、12 宫", "收入不稳", "PD 6");

    // ---------------------------------------------------------------- Nabhasa（只看七曜）
    // 依托 Ashraya
    add("nabhasa.rajju", "Rajju", "绳", "nabhasa", "all_in_signs(P7, MOVABLE)", "七曜都在动星座", "好远游", "BPHS 12");
    add("nabhasa.musala", "Musala", "杵", "nabhasa", "all_in_signs(P7, FIXED)", "七曜都在定星座", "有地位、固执", "BPHS 12");
    add("nabhasa.nala", "Nala", "苇", "nabhasa", "all_in_signs(P7, DUAL)", "七曜都在变星座", "能干、多变", "BPHS 12");
    // 群 Dala
    add("nabhasa.mala", "Mala（Srik）", "花环", "nabhasa", "count(inter(houses_of(NB), KENDRA)) >= 3",
        "天然吉星（月、水、木、金）占了三个角宫", "享受、幸福", "BPHS 12");
    add("nabhasa.sarpa", "Sarpa", "蛇", "nabhasa", "count(inter(houses_of(NM), KENDRA)) >= 3",
        "天然凶星（日、火、土）占了三个角宫", "辛苦、受困", "BPHS 12");
    // 形 Akriti
    const two = (a, b) => `all_in(P7, [${a}, ${b}]) and count(unique(houses_of(P7))) == 2`;
    add("nabhasa.gada", "Gada", "杖", "nabhasa",
        `(${two(1, 4)}) or (${two(4, 7)}) or (${two(7, 10)}) or (${two(10, 1)})`, "七曜全在相邻的两个角宫", "勤奋、富有", "BPHS 12");
    add("nabhasa.sakata", "Sakata", "车", "nabhasa", two(1, 7), "七曜全在第 1、7 宫", "奔波", "BPHS 12");
    add("nabhasa.vihaga", "Vihaga", "鸟", "nabhasa", two(4, 10), "七曜全在第 4、10 宫", "游走、传信", "BPHS 12");
    add("nabhasa.sringataka", "Sringataka", "角", "nabhasa", "all_in(P7, [1, 5, 9])", "七曜全在第 1、5、9 宫", "好争、晚年好", "BPHS 12");
    add("nabhasa.hala", "Hala", "犁", "nabhasa", "all_in(P7, [2, 6, 10]) or all_in(P7, [3, 7, 11]) or all_in(P7, [4, 8, 12])",
        "七曜全在 Lagna 以外的一组三方（2、6、10 / 3、7、11 / 4、8、12）", "务农、勤劳", "BPHS 12");
    add("nabhasa.vajra", "Vajra", "金刚杵", "nabhasa", "all_in(NB, [1, 7]) and all_in(NM, [4, 10])",
        "吉星在第 1、7 宫，凶星在第 4、10 宫", "早晚年好、中年辛苦", "BPHS 12");
    add("nabhasa.yava", "Yava", "麦", "nabhasa", "all_in(NM, [1, 7]) and all_in(NB, [4, 10])",
        "凶星在第 1、7 宫，吉星在第 4、10 宫", "中年最好", "BPHS 12");
    add("nabhasa.kamala", "Kamala（Padma）", "莲", "nabhasa", "all_in(P7, KENDRA) and subset(KENDRA, houses_of(P7))",
        "七曜全在角宫，四个角宫都有行星", "名声、德行", "BPHS 12");
    add("nabhasa.vapi", "Vapi", "池", "nabhasa", "all_in(P7, PANAPHARA) or all_in(P7, APOKLIMA)",
        "七曜全在续宫（2、5、8、11）或全在果宫（3、6、9、12）", "积蓄", "BPHS 12");
    [
        ["yupa", "Yupa", "祭柱", 1, 4, "好祭祀、慷慨"],
        ["ishu", "Ishu（Shara）", "箭", 4, 4, "制箭、狩猎"],
        ["shakti", "Shakti", "矛", 7, 4, "勇敢、辛劳"],
        ["danda", "Danda", "杖", 10, 4, "受人差遣"],
        ["nauka", "Nauka", "舟", 1, 7, "靠水为业、名声"],
        ["kuta", "Kuta", "峰", 4, 7, "管理牢狱、山野"],
        ["chatra", "Chatra", "伞", 7, 7, "护佑他人、晚年好"],
        ["chapa", "Chapa（Dhanus）", "弓", 10, 7, "勇武、首尾享福"],
    ].forEach(([id, name, cn, start, len, effect]) => add(
        `nabhasa.${id}`, name, cn, "nabhasa", `all_in(P7, run(${start}, ${len}))`,
        `七曜全在从第 ${start} 宫起的连续 ${len} 个宫`, effect, "BPHS 12",
    ));
    add("nabhasa.ardhachandra", "Ardhachandra", "半月", "nabhasa",
        [2, 3, 5, 6, 8, 9, 11, 12].map((s) => `all_in(P7, run(${s}, 7))`).join(" or "),
        "七曜全在从一个非角宫开始的连续 7 个宫", "统领、俊美", "BPHS 12");
    add("nabhasa.chakra", "Chakra", "轮", "nabhasa", "all_in(P7, [1, 3, 5, 7, 9, 11])", "七曜全在奇数宫", "统领者", "BPHS 12");
    add("nabhasa.samudra", "Samudra", "海", "nabhasa", "all_in(P7, [2, 4, 6, 8, 10, 12])", "七曜全在偶数宫", "富有、享受", "BPHS 12");
    // 数 Sankhya
    [
        ["vallaki", "Vallaki（Veena）", "琴", 7, "多才多艺"],
        ["damini", "Damini", "缰绳", 6, "乐于助人"],
        ["pasha", "Pasha", "索", 5, "交际广、受牵连"],
        ["kedara", "Kedara", "田", 4, "务农、有用"],
        ["shula", "Shula", "叉", 3, "勇猛、好斗"],
        ["yuga", "Yuga", "轭", 2, "贫乏、离群"],
        ["gola", "Gola", "球", 1, "辛苦、少学"],
    ].forEach(([id, name, cn, n, effect]) => add(
        `nabhasa.${id}`, name, cn, "nabhasa", `signs_occupied(P7) == ${n}`,
        `七曜一共占了 ${n} 个星座`, effect, "BPHS 12",
    ));

    // ---------------------------------------------------------------- 凶象
    add("dosha.kuja", "Kuja Dosha", "火星凶象（Lagna）", "dosha", "house(Ma) in [1, 2, 4, 7, 8, 12]",
        "火星在 Lagna 起的第 1、2、4、7、8、12 宫（Manglik）", "婚姻方面需注意", "现代");
    add("dosha.kuja_moon", "Kuja Dosha", "火星凶象（月亮）", "dosha", "house(Ma, Mo) in [1, 2, 4, 7, 8, 12]",
        "火星在月亮起的第 1、2、4、7、8、12 宫", "婚姻方面需注意", "现代");
    add("dosha.kalasarpa", "Kala Sarpa", "时蛇", "dosha", "all_between(P7, Ra, Ke) or all_between(P7, Ke, Ra)",
        "七曜全在罗睺、计都轴的同一侧", "起伏较大", "现代");
    add("dosha.surya_grahana", "Surya Grahana", "日食凶象", "dosha", "conj(Su, Ra) or conj(Su, Ke)",
        "太阳与罗睺或计都同格", "与父亲、权威相关的困扰", "现代");
    add("dosha.chandra_grahana", "Chandra Grahana", "月食凶象", "dosha", "conj(Mo, Ra) or conj(Mo, Ke)",
        "月亮与罗睺或计都同格", "情绪、母亲方面的困扰", "现代");
    add("dosha.guru_chandala", "Guru Chandala", "木星染污", "dosha", "conj(Ju, Ra) or conj(Ju, Ke)",
        "木星与罗睺或计都同格", "信仰、师长方面的偏差", "现代");
    add("dosha.angaraka", "Angaraka", "火罗", "dosha", "conj(Ma, Ra) or conj(Ma, Ke)",
        "火星与罗睺或计都同格", "冲动、意外", "现代");
    add("dosha.visha", "Visha", "毒", "dosha", "conj(Sa, Mo)",
        "土星与月亮同格", "忧郁、压力", "现代");
    add("dosha.shrapit", "Shrapit", "诅咒", "dosha", "conj(Sa, Ra)",
        "土星与罗睺同格", "延迟、阻碍", "现代");

    // ---------------------------------------------------------------- Vargottama（D1 与 D9 同一星座）
    [...Object.keys(PNAME), "Asc"].forEach((p) => add(
        `vargottama.${p}`, "Vargottama", `同宫（${PNAME[p] || "上升点"}）`, "vargottama",
        `dsign(${p}, 1) == dsign(${p}, 9)`,
        `${PNAME[p] || "上升点"}在 D1 与 D9 落在同一个星座`, "这颗行星（上升点）力量增强", "BPHS",
    ));

    window.VedicYogaDefaults = {CATEGORIES, YOGAS: Y};
})();
