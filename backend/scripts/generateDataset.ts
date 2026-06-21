// Dataset generator.
//
// The assignment needs >= 100,000 queries, each with a count/frequency. Rather
// than ship a huge file or require a network download, we synthesise a realistic
// corpus: vocabulary (brands, products, modifiers, tech terms, actions, ...) is
// combined through templates to produce 100k+ DISTINCT queries that share
// prefixes the way real traffic does ("iphone", "iphone 15", ...). Counts follow
// a ZIPF distribution (a few head queries searched millions of times, a long
// low-count tail) — which is what makes head-prefix caching so effective.
//
// Output: data/queries.json  — [{ "query": "...", "count": 123 }, ...]
//
// Swap in a real dataset instead: write any array of { query, count } objects to
// data/queries.json (e.g. Wikipedia titles, an AOL query log, product names —
// aggregate to counts if needed). Everything downstream is source-agnostic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../data/queries.json');
const TARGET = Number(process.env.DATASET_SIZE || 120_000);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Deterministic PRNG (mulberry32) so the dataset is reproducible across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(12345);

const HEAD = [
  'iphone', 'amazon', 'youtube', 'facebook', 'google', 'gmail', 'weather', 'netflix',
  'whatsapp web', 'instagram', 'translate', 'maps', 'chatgpt', 'java', 'python',
  'javascript', 'react', 'nodejs', 'iphone 15', 'samsung galaxy', 'airpods', 'macbook',
  'ps5', 'xbox', 'nike shoes', 'adidas', 'flights', 'hotels near me', 'pizza near me',
  'how to screenshot', 'covid symptoms', 'bitcoin price', 'stock market', 'nba scores',
  'premier league', 'cricket score', 'spotify', 'linkedin', 'twitter', 'reddit',
  'wikipedia', 'amazon prime', 'flipkart', 'best laptops', 'iphone charger',
  'wireless earbuds', 'air fryer', 'running shoes', 'coffee maker', 'office chair',
];

const BRANDS = [
  'apple', 'samsung', 'sony', 'lg', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'nike',
  'adidas', 'puma', 'bosch', 'philips', 'canon', 'nikon', 'logitech', 'jbl', 'boat',
  'oneplus', 'xiaomi', 'realme', 'oppo', 'vivo', 'google', 'microsoft', 'intel', 'amd',
  'nvidia', 'corsair', 'razer', 'anker', 'whirlpool', 'panasonic', 'toshiba', 'huawei',
  'motorola', 'nokia', 'fitbit', 'garmin',
];
const PRODUCTS = [
  'phone', 'laptop', 'tablet', 'headphones', 'earbuds', 'monitor', 'keyboard', 'mouse',
  'charger', 'cable', 'speaker', 'smartwatch', 'camera', 'tv', 'router', 'printer',
  'hard drive', 'ssd', 'graphics card', 'processor', 'shoes', 'backpack', 'jacket',
  'watch', 'sunglasses', 'water bottle', 'blender', 'microwave', 'refrigerator',
  'washing machine', 'air conditioner', 'fan', 'vacuum cleaner', 'desk', 'chair',
  'mattress', 'pillow', 'cookware', 'kettle', 'toaster',
];
const MODIFIERS = [
  'price', 'review', 'reviews', 'specs', 'deals', 'offers', 'near me', 'under 500',
  'under 1000', 'best', 'cheap', 'pro', 'max', 'mini', 'plus', '2024', '2025', 'used',
  'refurbished', 'wireless', 'bluetooth', 'gaming', 'portable', 'replacement', 'manual',
  'warranty', 'comparison', 'vs', 'for students', 'for work', 'black', 'white', 'discount',
];
const TECH = [
  'react', 'angular', 'vue', 'svelte', 'node', 'express', 'django', 'flask', 'spring',
  'kubernetes', 'docker', 'terraform', 'aws', 'gcp', 'azure', 'redis', 'kafka', 'postgres',
  'mongodb', 'mysql', 'graphql', 'rest api', 'typescript', 'rust', 'golang', 'kotlin',
  'swift', 'tensorflow', 'pytorch', 'pandas', 'numpy', 'sql', 'git', 'linux', 'nginx',
];
const TECH_SUFFIX = ['tutorial', 'example', 'docs', 'interview questions', 'cheat sheet',
  'best practices', 'vs', 'setup', 'install', 'crash course', 'roadmap', 'project ideas'];
const ACTIONS = [
  'tie a tie', 'cook rice', 'lose weight', 'learn python', 'invest money', 'make coffee',
  'screenshot on mac', 'reset router', 'speed up laptop', 'write a resume', 'start a business',
  'meditate', 'run faster', 'save money', 'learn guitar', 'bake bread', 'fix wifi',
  'remove background', 'compress pdf', 'convert video', 'unclog a drain', 'change a tire',
];

function* generators(): Generator<string> {
  for (const b of BRANDS) for (const p of PRODUCTS) yield `${b} ${p}`;
  for (const b of BRANDS) yield b;
  for (const p of PRODUCTS) { yield `best ${p}`; yield `cheap ${p} online`; }
  for (const t of TECH) for (const s of TECH_SUFFIX) yield `${t} ${s}`;
  for (const t of TECH) for (const t2 of TECH) if (t !== t2) yield `${t} vs ${t2}`;
  for (const a of ACTIONS) { yield `how to ${a}`; yield `how do i ${a}`; yield `best way to ${a}`; }
  for (const p of PRODUCTS) for (const m of MODIFIERS) { yield `${m} ${p}`; yield `${p} ${m}`; }
  for (const b of BRANDS) for (const p of PRODUCTS) for (const m of MODIFIERS) yield `${b} ${p} ${m}`;
  // Deep tail: two-modifier combinations fill up to TARGET.
  for (const b of BRANDS)
    for (const p of PRODUCTS)
      for (const m of MODIFIERS)
        for (const m2 of MODIFIERS)
          if (m !== m2) yield `${b} ${p} ${m} ${m2}`;
}

console.log(`Generating up to ${TARGET.toLocaleString()} distinct queries...`);

const set = new Set<string>();
for (const h of HEAD) set.add(normalize(h));
for (const q of generators()) {
  const n = normalize(q);
  if (n) set.add(n);
  if (set.size >= TARGET) break;
}

const headNorm = HEAD.map(normalize);
const headSet = new Set(headNorm);
const body = [...set].filter((q) => !headSet.has(q));
for (let i = body.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [body[i], body[j]] = [body[j], body[i]];
}
const ordered = [...headNorm, ...body];

// Zipf counts: count(rank) = round(BASE / rank^S * jitter), floored at 1.
const BASE = 3_000_000;
const S = 0.92;
let maxCount = 0;
const rows = ordered.map((query, idx) => {
  const rank = idx + 1;
  const jitter = 0.7 + rand() * 0.6;
  const count = Math.max(1, Math.round((BASE / Math.pow(rank, S)) * jitter));
  if (count > maxCount) maxCount = count;
  return { query, count };
});

fs.writeFileSync(OUT, JSON.stringify(rows));
console.log(`✓ Wrote ${rows.length.toLocaleString()} queries to ${path.relative(process.cwd(), OUT)}`);
console.log(`  Top count: ${maxCount.toLocaleString()} (Zipf head)`);
console.log(`  The server seeds the primary store from this file on first start.`);
