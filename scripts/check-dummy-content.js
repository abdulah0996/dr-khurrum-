import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGETS = [
  "README.md",
  "MONGODB_SETUP_GUIDE.md",
  ".env.example",
  "package.json",
  "index.html",
  "Dockerfile",
  "docker-compose.yml",
  "ecosystem.config.cjs",
  "deploy",
  "docs",
  "scripts",
  "locales",
  "src",
  "server",
  "test",
  "dist",
  ".github"
];

const DENYLIST = [
  "Dr. Mujeeb",
  "Dr Mujeeb",
  "Mujeeb Ur Rehman",
  "Dr. Majee",
  "Dr Majee",
  "0300-8585508",
  "Al Habib General Hospital",
  "Muhammad Medical Complex",
  "Mayar Jandol",
  "RIRS",
  "PKR 170,000",
  "PKR 280,000",
  "demo123",
  "clinic.demo",
  "sample patient",
  "test patient",
  "seeded patient",
  "seeded appointment",
  "mock data",
  "memory fallback",
  "WhatsApp Demo",
  "local demo mode",
  "fake reports",
  "fake charts",
  "fake message sent",
  "old doctor data",
  "old clinic data",
  "placeholder patient",
  "placeholder appointment",
  "placeholder clinic",
  "Dr. Poram",
  "Dr Poram",
  "Lorem Ipsum",
  "doctor@example.com",
  "0300-0000000",
  "sample appointment",
  "dummy appointment",
  "example clinic"
];

const CASE_INSENSITIVE = ["demo", "dummy", "fake", "mujeeb", "majee", "poram", "rirs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "backups"]);
const SKIP_FILES = new Set(["scripts/check-dummy-content.js"]);
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".json", ".md", ".css", ".html", ".yml", ".yaml", ".cjs", ".example", ".txt", ".conf", ""]);

function walk(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll("\\", "/");
  if (SKIP_FILES.has(relative)) return [];
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(filePath))) return [];
    return fs.readdirSync(filePath).flatMap((item) => walk(path.join(filePath, item)));
  }
  if (!TEXT_EXTENSIONS.has(path.extname(filePath))) return [];
  return [filePath];
}

const files = TARGETS.map((target) => path.join(ROOT, target)).filter(fs.existsSync).flatMap(walk);
const findings = [];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const file of files) {
  const text = fs.readFileSync(file, "utf8")
    .replaceAll("check:dummy-content", "check-content-command")
    .replaceAll("dummy-content", "content-audit");
  const relative = path.relative(ROOT, file).replaceAll("\\", "/");
  for (const term of DENYLIST) {
    if (text.includes(term)) findings.push(`${relative}: contains "${term}"`);
  }
  const lower = text.toLowerCase();
  for (const term of CASE_INSENSITIVE) {
    if (new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(lower)) findings.push(`${relative}: contains "${term}"`);
  }
}

const patientFacingFiles = [
  "server/routes/public.js",
  "server/services/messageTemplates.js",
  "locales"
]
  .map((target) => path.join(ROOT, target))
  .filter(fs.existsSync)
  .flatMap(walk);

for (const file of patientFacingFiles) {
  const text = fs.readFileSync(file, "utf8");
  const relative = path.relative(ROOT, file).replaceAll("\\", "/");
  for (const qualification of ["FCPS", "FCOS"]) {
    if (text.includes(qualification)) findings.push(`${relative}: exposes unverified patient-facing qualification "${qualification}"`);
  }
}

if (findings.length) {
  console.error("Content scan failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log(`Content scan passed across ${files.length} files.`);
