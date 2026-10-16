export const CHARACTER_SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digit: "0123456789",
  symbol: "!@#$%^&*_-+=?",
};

// —— 密码短语词表（内置，英文短词，便于记忆与输入）——
export const PASSPHRASE_WORDLIST = [
  "able", "about", "above", "accept", "acid", "acorn", "acres", "action", "active", "actor",
  "adapt", "admit", "adopt", "adult", "after", "again", "agent", "agile", "agreed", "ahead",
  "album", "alert", "alien", "alike", "alive", "allow", "alloy", "alone", "along", "alpha",
  "amber", "among", "ample", "anchor", "angle", "animal", "ankle", "apart", "apple", "april",
  "arcade", "arctic", "argue", "armor", "around", "arrow", "artist", "aspect", "aspen", "asset",
  "atlas", "atomic", "attach", "aurora", "author", "autumn", "avail", "awake", "award", "axiom",
  "bacon", "badge", "bagel", "baker", "balance", "bamboo", "banjo", "barrel", "basic", "basin",
  "batch", "beach", "beacon", "beard", "beast", "bedrock", "before", "begin", "being", "below",
  "bench", "berry", "beside", "better", "beyond", "bicycle", "binary", "birch", "bishop", "bison",
  "blade", "blank", "blast", "blaze", "blend", "blimp", "block", "bloom", "blossom", "board",
  "boast", "bobcat", "bolts", "bonus", "boost", "border", "borrow", "botany", "bottle", "boulder",
  "bounce", "brave", "bread", "breeze", "brick", "bridge", "bright", "bring", "brook", "brush",
  "bubble", "bucket", "buffalo", "builder", "bundle", "bunker", "burden", "burst", "butter", "button",
  "cabin", "cable", "cactus", "camera", "campus", "candle", "canvas", "canyon", "carbon", "cargo",
  "carpet", "carrot", "castle", "casual", "cattle", "caviar", "cedar", "cello", "cement", "center",
  "cereal", "chalk", "charm", "chart", "cheese", "cherry", "chess", "chief", "chili", "chimney",
  "chorus", "cinema", "circle", "citrus", "civic", "civil", "clamp", "clarity", "classic", "clever",
  "cliff", "climb", "clinic", "cloak", "clock", "closet", "cloud", "clover", "cluster", "coach",
  "coastal", "cobalt", "cocoa", "coffee", "column", "comet", "comfort", "command", "compass", "concert",
  "condor", "copper", "coral", "corner", "cosmic", "cotton", "county", "couple", "courage", "cousin",
  "cover", "cradle", "crane", "crater", "crayon", "cream", "credit", "cricket", "crimson", "crisp",
  "critter", "crown", "crumbs", "crystal", "cubed", "cumin", "cunning", "cupcake", "curious", "curly",
  "curtain", "custom", "cyborg", "cymbal", "dagger", "dahlia", "dairy", "daisy", "damage", "dancer",
  "dapper", "daring", "darken", "dawn", "deacon", "debate", "decade", "decent", "decide", "declare",
  "deeply", "defend", "degree", "delta", "denim", "dental", "depart", "depend", "deposit", "desktop",
  "detail", "detect", "device", "diagram", "dialog", "diesel", "digest", "dilemma", "dinner", "direct",
  "disco", "dispute", "distant", "divide", "diving", "dizzy", "doctor", "dolphin", "domain", "donate",
  "donkey", "double", "dough", "dozen", "draft", "dragon", "drama", "drawer", "dream", "dress",
  "drift", "drill", "drink", "drive", "droplet", "duckling", "dungeon", "duplex", "during", "dusty",
  "dwarf", "dynamic", "eagle", "early", "earth", "easel", "eastern", "eclipse", "edible", "editor",
  "effect", "effort", "eight", "either", "elastic", "elbow", "elder", "electric", "elegant", "element",
  "elephant", "eleven", "elite", "ember", "emerald", "emotion", "empire", "employ", "empty", "enable",
  "enamel", "encode", "endless", "engine", "enough", "ensure", "entire", "envelope", "equal", "equator",
  "error", "essay", "estate", "etched", "ethics", "evening", "event", "evolve", "exact", "example",
  "exceed", "exhale", "exotic", "expand", "expert", "explore", "export", "expose", "extra", "fabric",
  "factory", "falcon", "family", "famous", "fancy", "fable", "gadget", "galaxy", "gallery", "gamble",
  "garlic", "gather", "gazelle", "gemini", "general", "gentle", "genuine", "gesture", "geyser", "ginger",
  "giraffe", "given", "glacier", "glance", "glass", "glide", "global", "glossy", "glove", "golden",
  "gopher", "gospel", "govern", "grace", "grain", "grand", "granite", "grape", "graph", "grasp",
  "gravel", "gravy", "green", "greet", "grid", "griffin", "grille", "groove", "ground", "group",
  "guava", "guard", "guess", "guide", "guitar", "gumbo", "gutter", "gypsum", "habit", "haircut",
  "halibut", "hamlet", "hammer", "hammock", "handle", "hanger", "harbor", "harmony", "harvest", "hazel",
  "header", "health", "hearth", "heaven", "hedge", "helium", "helmet", "herald", "herbal", "heron",
  "hidden", "highly", "hiker", "hilltop", "hinge", "history", "hobby", "hockey", "holiday", "hollow",
  "honest", "honey", "hoodie", "hoping", "horizon", "hornet", "horse", "hospital", "hostel", "hotel",
  "hourly", "house", "hover", "human", "humble", "humid", "hunter", "hurdle", "hurry", "husky",
  "hybrid", "hydro", "iceberg", "iconic", "ideal", "igloo", "ignite", "ignore", "iguana", "image",
  "impact", "import", "impress", "improve", "impulse", "inches", "income", "indeed", "index", "indigo",
  "indoor", "infant", "inform", "inject", "inland", "inner", "input", "insect", "inside", "insight",
  "inspire", "install", "instant", "intense", "invest", "invite", "iodine", "iron", "island", "italic",
  "ivory", "jacket", "jaguar", "jargon", "jasmine", "jelly", "jersey", "jewel", "jockey", "jolly",
  "journal", "joyful", "judge", "juggle", "juice", "jumbo", "jungle", "junior", "juniper", "jupiter",
  "justice", "kayak", "kernel", "kettle", "keyboard", "kidney", "kindly", "kingdom", "kitchen", "kitten",
  "knight", "knowledge", "koala", "ladder", "lagoon", "lantern", "laptop", "large", "laser", "latch",
  "latex", "laugh", "launch", "laundry", "lavender", "lawyer", "layer", "leader", "league", "ledger",
  "legacy", "legend", "lemon", "length", "lentil", "leopard", "lesson", "letter", "level", "liberty",
  "library", "license", "lifecycle", "lighthouse", "lilac", "limit", "linear", "lintel", "lion", "liquid",
  "listen", "little", "lively", "lizard", "lobby", "lobster", "local", "locker", "lodge", "logic",
  "lonely", "longer", "lookup", "loop", "lotus", "loudly", "lounge", "lovely", "lower", "loyal",
  "lucid", "lucky", "lumber", "lunar", "lunch", "luxury", "lyric", "machine", "madam", "magenta",
  "magic", "magnet", "mailbox", "major", "mammoth", "manage", "mandate", "mango", "mantis", "manual",
  "maple", "marble", "margin", "marina", "market", "martial", "marvel", "mascot", "mask", "mason",
  "matrix", "matter", "mature", "meadow", "measure", "medal", "median", "melody", "melon", "member",
  "memoir", "mentor", "menu", "mercury", "mercy", "merge", "merit", "mesh", "message", "metal",
  "meteor", "method", "metric", "middle", "midst", "might", "mild", "mimic", "mineral", "mingle",
  "minor", "mint", "minute", "miracle", "mirror", "misty", "mixture", "moat", "mobile", "model",
  "modern", "modest", "modify", "module", "moment", "monarch", "mondo", "monkey", "monsoon", "month",
  "moral", "morning", "mortal", "mosaic", "mother", "motion", "motor", "mountain", "mouse", "movie",
  "muffin", "mumble", "muscle", "museum", "music", "mustard", "mutual", "myrtle", "mystery", "napkin",
  "narrow", "nation", "native", "natural", "nature", "nebula", "nectar", "needle", "neighbor", "nerve",
  "nested", "network", "neutral", "never", "newest", "nickel", "nimble", "ninja", "nitrogen", "noble",
  "nominal", "normal", "north", "notable", "notch", "notebook", "novel", "nozzle", "nuance", "nuclear",
  "nugget", "number", "nurse", "nutmeg", "oasis", "object", "oblige", "observe", "obtain", "occur",
  "ocean", "octagon", "october", "octopus", "office", "offset", "olive", "olympic", "onion", "onward",
  "opal", "opera", "opinion", "oppose", "optical", "orange", "orbit", "orchard", "orchid", "order",
  "organ", "origin", "ornate", "orphan", "osprey", "ostrich", "otter", "ounce", "outdoor", "outer",
  "output", "outside", "oval", "overlap", "owner", "oxide", "oxygen", "oyster", "ozone", "pacific",
  "packet", "pagoda", "painter", "palace", "pallet", "palm", "pancake", "panda", "panel", "panic",
  "panther", "papaya", "paper", "parade", "parcel", "pardon", "parent", "parish", "parka", "parlor",
  "parrot", "parsley", "partner", "party", "passage", "passion", "pasta", "pastel", "pastry", "patch",
  "patient", "patio", "patrol", "pattern", "pavement", "payment", "peace", "peach", "peanut", "pearl",
  "pebble", "pedal", "pelican", "pencil", "pendant", "penguin", "pension", "people", "pepper", "perch",
  "perfect", "perform", "perfume", "period", "permit", "person", "petal", "petition", "phantom", "phase",
  "phoenix", "phone", "photo", "phrase", "physics", "piano", "picnic", "picture", "pigeon", "pilgrim",
  "pillar", "pillow", "pilot", "pine", "pint", "pioneer", "pipeline", "piston", "pitcher", "pivot",
  "pixel", "pizza", "placid", "plank", "plant", "plasma", "plate", "plateau", "player", "please",
  "pledge", "plenty", "plover", "plum", "plunge", "pocket", "podium", "poetry", "point", "polar",
  "police", "polish", "pollen", "pomelo", "poncho", "pontoon", "poplar", "poppy", "popular", "porch",
  "portal", "portion", "portrait", "possible", "postage", "posture", "potato", "potent", "pottery", "pouch",
  "powder", "power", "praise", "prairie", "pray", "precise", "predict", "prefer", "premium", "present",
  "preside", "pretty", "prevent", "preview", "pride", "primary", "prime", "prince", "print", "prior",
  "prism", "prison", "private", "prize", "problem", "process", "profile", "profit", "program", "project",
  "promise", "prompt", "proof", "proper", "propose", "protect", "proud", "prove", "provide", "public",
  "pudding", "puffin", "puller", "pulpit", "pulsar", "pumpkin", "punch", "puppet", "purple", "purpose",
  "puzzle", "pyramid", "python", "rabbit", "raccoon", "racing", "radar", "radiant", "radio", "radish",
  "rafter", "ragtime", "railway", "rainbow", "raisin", "rally", "ramble", "random", "ranger", "rapid",
  "rather", "ravine", "reactor", "reader", "realm", "reason", "rebel", "recall", "receipt", "recipe",
  "record", "recover", "recruit", "recycle", "reduce", "reef", "refer", "reflect", "reform", "refract",
  "regal", "region", "regular", "relax", "release", "relief", "remain", "remedy", "remind", "remote",
  "render", "renewal", "rental", "repair", "repeat", "replay", "report", "rescue", "research", "resident",
  "resin", "resolve", "resort", "respect", "restore", "result", "retail", "retain", "retina", "retreat",
  "reunion", "reuse", "reveal", "review", "revise", "reward", "rhythm", "ribbon", "rider", "ridge",
  "rifle", "right", "rigid", "rincon", "ripples", "ritual", "river", "roast", "robin", "robot",
  "rocket", "rodeo", "rogue", "roller", "roman", "roof", "rookie", "roster", "rotate",
  "rough", "round", "router", "royal", "rubber", "rubric", "ruby", "rugged", "rumble", "runner",
  "runway", "rural", "russet", "rustic", "sacred", "saddle", "safari", "safety", "saffron", "sailor",
  "salad", "salmon", "saloon", "salute", "sample", "sander", "sapphire", "satchel", "satin", "sauce",
  "savage", "saving", "scale", "scandal", "scarf", "scenic", "schedule", "scheme", "scholar", "school",
  "science", "scissor", "scooter", "scope", "score", "scout", "scramble", "screen", "script", "scroll",
  "sculpt", "seagull", "season", "second", "secret", "sector", "secure", "sediment", "segment", "seldom",
  "select", "senate", "senator", "senior", "sensor", "sentry", "sequel", "serial", "series", "sermon",
  "serpent", "servant", "service", "session", "settle", "seven", "shadow", "shallow", "shampoo", "shape",
  "share", "shark", "sharp", "shell", "shelter", "sherbet", "shield", "shift", "shine", "shirt",
  "shiver", "shock", "shore", "short", "shoulder", "shovel", "shower", "shrimp", "shrine", "shuffle",
  "shutter", "sibling", "sierra", "siesta", "sieve", "signal", "silent", "silicon", "silk", "silver",
  "similar", "simple", "sincere", "single", "siren", "sister", "sixteen", "skate", "sketch", "skiing",
  "skill", "skirt", "skyline", "slalom", "sleep", "slice", "slide", "slogan", "slope", "small",
  "smart", "smile", "smoke", "smooth", "snake", "snapshot", "sneaker", "snowfall", "social", "socket",
  "sodium", "soften", "solar", "soldier", "solid", "solution", "sonata", "sonic", "soothe", "sorbet",
  "sorrow", "sound", "source", "south", "space", "spade", "spanner", "sparkle", "sparrow", "spatial",
  "speaker", "special", "species", "sphere", "spice", "spider", "spinach", "spiral", "spirit", "splash",
  "spoken", "sponge", "spoon", "sport", "spotlight", "spread", "spring", "sprout", "square", "squash",
  "squid", "stable", "stadium", "staff", "stage", "stairs", "stamp", "stand", "staple", "starch",
  "starling", "startup", "statue", "status", "stay", "steady", "steam", "steel", "stellar", "stencil",
  "stereo", "sterling", "stew", "sticker", "stifle", "stitch", "stock", "stone", "stool", "storied",
  "stork", "story", "stove", "straight", "strange", "stream", "street", "stretch", "strike", "string",
  "strip", "strong", "studio", "study", "stumble", "sturdy", "style", "subject", "submit", "subtle",
  "suburb", "subway", "sudden", "suffer", "sugar", "suggest", "suite", "sulfur", "summer", "summit",
  "sunday", "sunflower", "sunrise", "sunset", "super", "supply", "support", "supreme", "surface", "surfer",
  "surge", "survey", "survive", "suspend", "sustain", "swallow", "swamp", "sweater", "swift", "swimmer",
  "switch", "sword", "symbol", "syntax", "system", "table", "tablet", "tackle", "tactic", "tailor",
  "talent", "tandem", "tangent", "tanker", "tapestry", "target", "tavern", "teacher", "teapot", "technical",
  "tempo", "tenant", "tender", "tennis", "tension", "terrace", "texture", "thank", "theater", "theme",
  "theory", "thermal", "thicket", "thimble", "thirty", "thistle", "thorough", "thought", "thread", "thrive",
  "throne", "thumb", "thunder", "ticket", "tidal", "timber", "timely", "tinder", "tissue", "toast",
  "tobacco", "toffee", "toggle", "token", "tomato", "tonight", "tool", "topaz", "topic", "torch",
  "tornado", "torrent", "total", "toucan", "touch", "tourist", "toward", "tower", "trace", "track",
  "trade", "traffic", "trail", "trainer", "transit", "travel", "tray", "treaty", "treble", "treasure",
  "tremble", "trend", "trial", "tribe", "trick", "trident", "trio", "triple", "triumph",
  "trolley", "trophy", "tropic", "trouble", "trout", "truck", "truffle", "trumpet", "trunk", "trust",
  "truth", "tulip", "tumble", "tundra", "tungsten", "tunnel", "turbine", "turquoise", "turtle", "tutor",
  "twilight", "twist", "ultra", "umbrella", "unable", "uncle", "under", "unfold", "uniform", "unify",
  "union", "unique", "unite", "unity", "universe", "unlock", "until", "unusual", "update", "upgrade",
  "uphill", "upload", "upper", "upright", "upset", "urban", "urgent", "usable", "useful", "usual",
  "utility", "vacation", "vaccine", "vacuum", "valid", "valley", "value", "valve", "vanilla", "vantage",
  "vapor", "variant", "various", "vault", "vector", "velvet", "vendor", "venture", "venue", "verse",
  "vermont", "veranda", "verbose", "verify", "vessel", "veteran", "viable", "vibrant", "victory", "video",
  "viewer", "vigor", "village", "vintage", "vinyl", "violet", "violin", "virtue", "vision", "visit",
  "visual", "vital", "vivid", "vocal", "voltage", "volume", "voyage", "waffle", "wagtail", "wagon",
  "walnut", "walrus", "wander", "warden", "warmth", "warrior", "washer", "waste", "watch", "water",
  "wattle", "waver", "wave", "wax", "weasel", "weather", "weaver", "wedge", "weekly", "weight",
  "welcome", "welfare", "western", "whale", "wheat", "wheel", "whisker", "whisper", "whistle", "white",
  "wholly", "widget", "wildlife", "willow", "window", "winner", "winter", "wisdom", "wisely", "wish",
  "wonder", "wooden", "worker", "world", "worthy", "wrench", "wrinkle", "wrist", "writer", "yacht",
  "yarrow", "yearly", "yellow", "yield", "yodel", "yogurt", "young", "zealous", "zebra", "zenith",
  "zephyr", "zigzag", "zinc", "zipper", "zodiac", "zoom",
];

/** 排除易混淆字符时密码短语的词表快筛也遵循（词内含易混淆字母的词不剔除，仅用于展示一致性；词表词都是清晰短词） */
const AMBIGUOUS_IN_WORDS = "";

export function randomBelow(max, rng = crypto) {
  if (!Number.isInteger(max) || max < 1 || max > 0xffffffff)
    throw new Error("随机范围无效");
  const limit = Math.floor(0x100000000 / max) * max,
    bytes = new Uint32Array(1);
  do {
    rng.getRandomValues(bytes);
  } while (bytes[0] >= limit);
  return bytes[0] % max;
}

export function passwordPools({
  sets = Object.keys(CHARACTER_SETS),
  exclude = "",
  avoidAmbiguous = false,
} = {}) {
  const excluded = new Set(exclude + (avoidAmbiguous ? "O0oIl1|" : ""));
  if (!sets.length) throw new Error("至少选择一种字符集");
  const pools = sets.map((name) => {
    if (!CHARACTER_SETS[name]) throw new Error("未知字符集");
    const pool = [...CHARACTER_SETS[name]].filter((c) => !excluded.has(c));
    if (!pool.length) throw new Error("排除字符后「" + name + "」为空");
    return pool;
  });
  return pools;
}

export function generatePassword(options = {}, rng = crypto) {
  const pools = passwordPools(options),
    length = Number(options.length ?? 16);
  if (!Number.isInteger(length) || length < 6 || length > 128)
    throw new Error("长度应为 6–128 的整数");
  const all = pools.flat(),
    output = pools.map((pool) => pool[randomBelow(pool.length, rng)]);
  while (output.length < length) output.push(all[randomBelow(all.length, rng)]);
  for (let i = output.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1, rng);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output.join("");
}

/** PIN：纯数字，默认 6–12 位；可排除重复与顺子由调用方做视觉提示（不强校验） */
export function generatePin(length = 6, rng = crypto) {
  const n = Number(length);
  if (!Number.isInteger(n) || n < 4 || n > 16)
    throw new Error("PIN 长度应为 4–16 的整数");
  return Array.from({ length: n }, () => randomBelow(10, rng)).join("");
}

/**
 * 密码短语：count 个词 + 分隔符 + 数字 + 可选大写。
 * 熵 = count × log2(词表大小) + 数字附加（写入提示）。
 */
export function generatePassphrase(
  {
    words = 4,
    separator = "-",
    capitalize = false,
    appendNumber = true,
  } = {},
  rng = crypto,
) {
  const n = Number(words);
  if (!Number.isInteger(n) || n < 2 || n > 12)
    throw new Error("单词数应为 2–12 的整数");
  const list = PASSPHRASE_WORDLIST;
  const picked = Array.from({ length: n }, () => list[randomBelow(list.length, rng)]);
  const parts = picked.map((word) =>
    capitalize ? word[0].toUpperCase() + word.slice(1) : word,
  );
  const phrase = parts.join(separator || "");
  if (!appendNumber) return phrase;
  const num = randomBelow(100, rng);
  return `${phrase}${separator || ""}${String(num).padStart(2, "0")}`;
}

export function uuidV4(
  { uppercase = false, hyphens = true } = {},
  rng = crypto,
) {
  const bytes = new Uint8Array(16);
  rng.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let value = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  if (hyphens)
    value = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return uppercase ? value.toUpperCase() : value;
}

/** 字符池估计熵（现有逻辑保留：长度 × log2(池)） */
export function entropyEstimate(options) {
  const pools = passwordPools(options);
  return Math.floor(
    Number(options.length || 16) * Math.log2(pools.flat().length),
  );
}

/** 密码短语熵：词数 × log2(词表大小) + 附加两位数字的 log2(100) */
export function passphraseEntropy({ words = 4, appendNumber = true } = {}) {
  const n = Math.max(2, Math.min(12, Number(words) || 4));
  let bits = n * Math.log2(PASSPHRASE_WORDLIST.length);
  if (appendNumber !== false) bits += Math.log2(100);
  return Math.floor(bits);
}

/** PIN 熵：10^length 均匀空间 */
export function pinEntropy(length = 6) {
  return Math.floor((Math.max(4, Math.min(16, Number(length) || 6))) * Math.log2(10));
}

/**
 * 真实密码（非生成结果）的估算熵：字符类别池混合估计。
 * 检查器使用：对用户输入的密码做池估计，不做字典攻击，只做即时本地启发式。
 */
export function guessEntropy(password) {
  const text = String(password ?? "");
  if (!text) return 0;
  const hasLower = /[a-z]/.test(text);
  const hasUpper = /[A-Z]/.test(text);
  const hasDigit = /[0-9]/.test(text);
  const hasSymbol = /[^a-zA-Z0-9]/.test(text);
  let pool = 0;
  if (hasLower) pool += 26;
  if (hasUpper) pool += 26;
  if (hasDigit) pool += 10;
  if (hasSymbol) pool += 33;
  let bits = text.length * Math.log2(Math.max(pool, 2));
  // 常见模式降权：纯数字 / 重复 / 顺序
  if (/^\d+$/.test(text)) bits *= 0.55;
  if (/^(.)\1+$/.test(text)) bits = Math.min(bits, 6);
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/i.test(text)) bits *= 0.6;
  return Math.max(0, Math.round(bits));
}

/** 熵 → 离线慢哈希场景破解时间估算（10^11 次猜测/秒，bcrypt 级防护下的对手） */
export function crackTimeEstimate(bits) {
  const guessesPerSecond = 1e11; // 离线 + 昂贵 KDF 假设
  const seconds = Math.pow(2, bits - 1) / guessesPerSecond;
  if (seconds < 1) return { value: "瞬间", seconds };
  const units = [
    ["秒", 60],
    ["分钟", 60],
    ["小时", 24],
    ["天", 365],
    ["年", Infinity],
  ];
  let value = seconds;
  for (const [label, size] of units) {
    if (value < size || size === Infinity)
      return {
        value: value < 10 ? value.toFixed(1) + " " + label : Math.round(value).toLocaleString("zh-CN") + " " + label,
        seconds,
      };
    value /= size;
  }
  return { value: String(Math.round(value)), seconds };
}

/** 通用强度规则提示（用于检查器，中文输出） */
export function strengthIssues(password) {
  const text = String(password ?? "");
  const issues = [];
  if (!text) return issues;
  if (text.length < 12) issues.push("长度不足 12 位，加长是性价比最高的强化");
  if (!/[a-z]/.test(text)) issues.push("未包含小写字母");
  if (!/[A-Z]/.test(text)) issues.push("未包含大写字母");
  if (!/[0-9]/.test(text)) issues.push("未包含数字");
  if (!/[^a-zA-Z0-9]/.test(text)) issues.push("未包含符号");
  if (/^(?:\d+)\1*$/.test(text) && text.length > 3) issues.push("重复片段明显");
  if (/^(.)\1+$/.test(text)) issues.push("整串都是同一字符");
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/i.test(text))
    issues.push("包含键盘顺序或常见序列");
  if (/^(?:password|passw0rd|admin|root|letmein|iloveyou|qwerty)/i.test(text))
    issues.push("以极常见的密码词开头");
  if (/^\d{4}$/.test(text) || /^(?:19|20)\d{2}$/.test(text.slice(0, 4)))
    issues.push("开头像年份，易被字典命中");
  return issues;
}
