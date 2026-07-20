import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const textExtensions = new Set([
  ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ps1", ".sh", ".txt", ".yaml", ".yml"
]);
const secretAssignment = /^(MONGODB_URI|JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|COOKIE_SECRET|ADMIN_BOOTSTRAP_TOKEN|WHATSAPP_ACCESS_TOKEN|WHATSAPP_VERIFY_TOKEN|META_APP_SECRET)=(.*)$/gm;
const placeholder = /^(?:|<[^>]+>|replace(?:-me)?|change-me|your[-_].*)$/i;
const signatures = [
  { name: "MongoDB URI with embedded credentials", pattern: /mongodb(?:\+srv)?:\/\/[^\s/:@]+:[^\s@]+@/gi },
  { name: "Meta-style access token", pattern: /\bEAA[A-Za-z0-9]{30,}\b/g },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
}

function isTextFile(file) {
  const extension = path.extname(file).toLowerCase();
  return textExtensions.has(extension) || path.basename(file).startsWith(".env");
}

const findings = [];
for (const file of repositoryFiles()) {
  if (!isTextFile(file) || !fs.existsSync(file) || fs.statSync(file).size > 2_000_000) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const signature of signatures) {
    signature.pattern.lastIndex = 0;
    for (const match of content.matchAll(signature.pattern)) {
      if (signature.name === "MongoDB URI with embedded credentials" && /<|replace|change-me|your[-_]|username|password/i.test(match[0])) continue;
      findings.push(`${file}: ${signature.name}`);
      break;
    }
  }
  secretAssignment.lastIndex = 0;
  for (const match of content.matchAll(secretAssignment)) {
    const value = match[2].trim();
    if (!placeholder.test(value)) findings.push(`${file}: populated ${match[1]}`);
  }
}

// Scan every reachable Git revision without ever printing a matched value. CI
// checks out full history so a credential removed from the current tree still
// blocks a release until it has been rotated and the history is remediated.
try {
  const history = execFileSync("git", ["log", "--all", "-p", "--no-color", "--", "."], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  for (const signature of signatures) {
    signature.pattern.lastIndex = 0;
    for (const match of history.matchAll(signature.pattern)) {
      if (signature.name === "MongoDB URI with embedded credentials" && /<|replace|change-me|your[-_]|username|password/i.test(match[0])) continue;
      findings.push(`Git history: ${signature.name}`);
      break;
    }
  }
  const historyAssignment = /^[+-]?(MONGODB_URI|JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|COOKIE_SECRET|ADMIN_BOOTSTRAP_TOKEN|WHATSAPP_ACCESS_TOKEN|WHATSAPP_VERIFY_TOKEN|META_APP_SECRET)=(.*)$/gm;
  for (const match of history.matchAll(historyAssignment)) {
    const value = match[2].trim();
    if (!placeholder.test(value)) findings.push(`Git history: populated ${match[1]}`);
  }
} catch (error) {
  findings.push(`Git history scan could not complete (${error.status || "git error"})`);
}

if (findings.length) {
  console.error("Secret scan failed. Values are not printed:");
  [...new Set(findings)].forEach((finding) => console.error(`- ${finding}`));
  process.exitCode = 1;
} else {
  console.log("Secret scan passed: no populated credentials detected.");
}
