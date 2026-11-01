const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
// The locales in the order their ASTs arrive; the file walk below proves l10n/ holds exactly these.
const locales = process.argv.slice(3);
assert.ok(locales.length > 0, "No locales given");
for (const name of locales) assert.match(name, /^[a-z]{2,3}(?:_[A-Z]{2})?$/, `Locale name: ${name}`);
const luaFiles = ["main.lua", "_meta.lua", "usbms_l10n.lua", ...locales.map(name => `l10n/${name}.lua`)];
const expected = [...luaFiles, "usbms_direct.sh", "usbms_framework.sh", "busybox", "LICENSE"].sort();
const asts = fs.readFileSync(0, "utf8").trim().split(/\r?\n/).map(JSON.parse);
assert.equal(asts.length, luaFiles.length, "Unexpected Lua AST count");

function literal(node) {
    if (node.type === "StringLiteral") return JSON.parse(node.raw);
    if (node.type === "BooleanLiteral" || node.type === "NumericLiteral") return node.value;
    assert.equal(node.type, "TableConstructorExpression", "Data must contain literal values only");
    const result = Object.create(null);
    for (const field of node.fields) {
        assert.equal(field.type, "TableKeyString");
        const key = field.key.name;
        assert.ok(!(key in result), `Duplicate key: ${key}`);
        result[key] = literal(field.value);
    }
    return result;
}

function checkLocale(actual, reference, label) {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(reference).sort(), `${label}: keys`);
    for (const key of Object.keys(reference)) {
        const value = actual[key];
        assert.equal(typeof value, typeof reference[key], `${label}.${key}: type`);
        if (typeof value === "object") checkLocale(value, reference[key], `${label}.${key}`);
        if (typeof value === "string") {
            assert.ok(value.trim(), `${label}.${key}: empty string`);
            const placeholders = text => (text.match(/%\d+/g) || []).sort();
            assert.deepEqual(placeholders(value), placeholders(reference[key]), `${label}.${key}: placeholders`);
            if (label.endsWith(".screen")) assert.doesNotMatch(value, /[\r\n]/, `${label}.${key}: multiline screen`);
        }
    }
}

const english = literal(asts[2].body.find(node => node.type === "LocalStatement" && node.variables[0].name === "en").init[0]);
for (let index = 0; index < locales.length; index++) {
    const locale = literal(asts[index + 3].body.find(node => node.type === "ReturnStatement").arguments[0]);
    checkLocale(locale, english, locales[index]);
    if (["ar", "fa", "he", "hi", "ja", "ka", "ko_KR", "zh_CN", "zh_TW"].includes(locales[index])) {
        assert.equal(locale.screen_font_ok, false, `${locales[index]}: unsupported font script`);
    }
}
const metadata = asts[1].body.find(node => node.type === "ReturnStatement").arguments[0];
const versionField = metadata.fields.find(field => field.key.name === "version");
const version = literal(versionField.value);
assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);

function walk(directory, prefix = "") {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        assert.ok(!entry.isSymbolicLink(), `Symlink not allowed: ${entry.name}`);
        const relative = prefix + entry.name;
        return entry.isDirectory() ? walk(path.join(directory, entry.name), relative + "/") : [relative];
    });
}
assert.deepEqual(walk(root).sort(), expected, "Unexpected or missing release files");
const files = expected.map(name => {
    const bytes = fs.readFileSync(path.join(root, name));
    assert.ok(bytes.length > 0, `Empty file: ${name}`);
    if (name.endsWith(".lua") || name.endsWith(".sh")) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        assert.doesNotMatch(text, /\r/, `CR line endings: ${name}`);
        assert.ok(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), `BOM: ${name}`);
    }
    return { path: name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
});
process.stdout.write(JSON.stringify({ version, locales: locales.length, files }));