import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
assert.ok(tag?.startsWith("v"), "Usage: node .github/scripts/release-notes.mjs v<version>");

const version = tag.slice(1);
assert.match(
	version,
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
	`Unsupported release version: ${version}`,
);

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(manifest.version, version, `package.json version ${manifest.version} does not match tag ${tag}`);

const changelog = readFileSync("CHANGELOG.md", "utf8");
const sections = changelog
	.split(/^## /m)
	.slice(1)
	.filter((section) => section.split("\n", 1)[0].startsWith(`${version} - `));
assert.equal(sections.length, 1, `CHANGELOG.md must contain exactly one "## ${version} - YYYY-MM-DD" section`);

const [heading, ...body] = sections[0].split("\n");
assert.match(heading, /^\S+ - \d{4}-\d{2}-\d{2}$/, `CHANGELOG.md heading must be dated: ${heading}`);
const notes = body.join("\n").trim();
assert.ok(notes.length > 0, `CHANGELOG.md section for ${version} is empty`);

process.stdout.write(`${notes}\n`);
