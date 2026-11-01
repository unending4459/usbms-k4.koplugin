const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const plugin = path.join(__dirname, "..", "usbms.koplugin");
const direct = fs.readFileSync(path.join(plugin, "usbms_direct.sh"), "utf8");
const framework = fs.readFileSync(path.join(plugin, "usbms_framework.sh"), "utf8");

function runShell(script, shell = "bash", args = ["-s"]) {
    const result = spawnSync(
        process.platform === "win32" ? "wsl.exe" : shell,
        process.platform === "win32" ? ["--exec", shell, ...args] : args,
        { input: script, encoding: "utf8", timeout: 30000 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
}

function shellFunction(source, name) {
    const single = source.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\}$`, "m"));
    const multiple = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
    assert.ok(single || multiple, `Missing function: ${name}`);
    return (single || multiple)[0];
}

const recovery = ["lun_empty", "release_lun", "restore_userstore", "finish"]
    .map(name => shellFunction(direct, name)).join("\n");

const mocks = `
exec 3>&1
EXPORT_ATTEMPTED=0; NEEDS_FSCK=0; RECOVERY_BLOCKED=0; RECOVERY_RESULT=fail
HAL_PID=; LOG=/dev/null; RESULT=/dev/null; LUN=/dev/null
LOCK=/unused; PIDFILE=/unused; KOSH_PID=999999; mounted=no
log() { printf 'LOG %s\\n' "$*"; }
screen() { echo RECOVERY_SCREEN; }
sync() { :; }
sleep() { :; }
rm() { :; }
kill() { echo RESUMED; }
lipc-set-prop() { :; }
base_mounted() { [ "$mounted" = yes ]; }
reader_accessible() { return 0; }
mntus() { printf 'MOUNT %s\\n' "$*" >&3; mounted=yes; }
`;

function recover(setup, command = "finish") {
    return runShell(`${mocks}\n${recovery}\n${setup}\n${command}\n`);
}

for (const [connected, charging, expected] of [
    ["1", "1", 0],
    ["1", "0", 1],
    ["0", "1", 1],
    ["0", "0", 1],
    ["1", "", 1],
    ["", "1", 1],
]) {
    test(`host requires gadget=${connected} and cable power=${charging}`, () => {
        const result = runShell(`
CONNECTED=/mock/connected
cat() { printf '%s' '${connected}'; }
lipc-get-prop() { printf '%s' '${charging}'; }
${shellFunction(direct, "host_connected")}
host_connected
`);
        assert.equal(result.status, expected);
    });
}

test("waiting screen remains until cable power and gadget connection are present", () => {
    const waiting = direct.slice(direct.indexOf("if ! host_connected; then"), direct.indexOf('log "computer connected"'));
    const result = runShell(`
CONNECTED=/mock/connected; HOST_TIMEOUT=3; RESULT=/dev/null; charging=0
cat() { printf 1; }
lipc-get-prop() { printf '%s' "$charging"; }
screen() { echo "$1"; }
msg() { echo "$1"; }
log() { echo "$*"; }
sleep() { echo CABLE_INSERTED; charging=1; }
${shellFunction(direct, "host_connected")}
${waiting}
echo HOST_READY
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "usb-waiting\nCABLE_INSERTED\nHOST_READY");
});

// Kindle 4 (600x800), Paperwhite 2 (758x1024), and an fbink that reports no height.
for (const [height, title, text] of [
    ["800", "px=34,top=320", "px=25,top=366"],
    ["1024", "px=44,top=409", "px=32,top=465"],
    ["", "px=34,top=320", "px=25,top=366"],
]) {
    test(`status text fits a screen of height ${height || "unknown"}`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usbms-fbink-"));
        try {
            const fbink = path.join(dir, "fbink");
            const state = height ? `viewWidth=600;viewHeight=${height};screenWidth=600;` : "";
            // screen() silences the text calls, so the mock reports on fd 3.
            fs.writeFileSync(fbink, `#!/bin/sh\n[ "$1" = -e ] && { printf '%s' '${state}'; exit 0; }\necho "$*" >&3\n`,
                { mode: 0o755 });
            const result = runShell(`
exec 3>&1
FBINK='${fbink}'; FONT='${fbink}'
${shellFunction(direct, "screen")}
screen usb-waiting Title Text
`);
            assert.equal(result.status, 0, result.stderr);
            const lines = result.stdout.trim().split("\n");
            assert.equal(lines.length, 3, result.stdout);
            assert.equal(lines[0], "-q -c -f");
            assert.ok(lines[1].includes(`,${title},`) && lines[1].endsWith("-- Title"), lines[1]);
            assert.ok(lines[2].includes(`,${text},`) && lines[2].endsWith("-- Text"), lines[2]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

// FW 5 asks upstart; FW 4 has no status command and only a cvm that is gone counts as stopped.
for (const [label, mocks, expected] of [
    ["upstart job stopped", "status() { echo 'lab126_gui stop/waiting'; }", 0],
    ["upstart job running", "status() { echo 'lab126_gui start/running'; }", 1],
    ["sysv without cvm", "pidof() { return 1; }", 0],
    ["sysv with cvm", "pidof() { echo 1234; }", 1],
]) {
    test(`framework check: ${label}`, () => {
        const result = runShell(`
${mocks}
${shellFunction(direct, "framework_stopped")}
framework_stopped
`);
        assert.equal(result.status, expected, result.stderr);
    });
}

for (const [name, source] of [["direct", direct], ["framework", framework]]) {
    test(`${name} helper has valid POSIX shell syntax`, () => {
        const result = runShell(source, "sh", ["-n"]);
        assert.equal(result.status, 0, result.stderr);
    });
}

test("failed LUN close prevents mount, fsck and resume", () => {
    const result = recover("EXPORT_ATTEMPTED=1; NEEDS_FSCK=1; LUN=/dev/full");
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /MOUNT|RESUMED/);
    assert.match(result.stdout, /RECOVERY_SCREEN/);
});

test("successful write with unreadable LUN still prevents recovery", () => {
    const result = recover("EXPORT_ATTEMPTED=1; cat() { return 1; }");
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /MOUNT|RESUMED/);
});

test("LUN read error is not an empty medium", () => {
    const result = recover("cat() { return 1; }", "lun_empty");
    assert.equal(result.status, 1);
});

test("failed mounts never resume and are retried at most three times", () => {
    const result = recover("mntus() { echo MOUNT_FAILURE >&3; return 1; }");
    assert.equal(result.status, 1);
    assert.equal((result.stdout.match(/MOUNT_FAILURE/g) || []).length, 3);
    assert.doesNotMatch(result.stdout, /RESUMED/);
});

test("fsck failure is terminal even if mntus mounted the partition", () => {
    const result = recover(
        "NEEDS_FSCK=1; mntus() { echo FSCK_FAILURE >&3; mounted=yes; return 1; }",
        "finish; finish",
    );
    assert.equal(result.status, 1);
    assert.equal((result.stdout.match(/FSCK_FAILURE/g) || []).length, 1);
    assert.doesNotMatch(result.stdout, /RESUMED/);
});

test("mount error cannot be hidden by an apparently mounted base", () => {
    const result = recover("mntus() { mounted=yes; return 1; }");
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /RESUMED/);
});

test("exit recovery cannot retry an exhausted explicit recovery", () => {
    const result = recover(
        "attempts=0; mntus() { attempts=$((attempts + 1)); echo MOUNT_ATTEMPT >&3; [ \"$attempts\" -ge 4 ] && mounted=yes; }",
        "restore_userstore; finish",
    );
    assert.equal(result.status, 1);
    assert.equal((result.stdout.match(/MOUNT_ATTEMPT/g) || []).length, 3);
    assert.doesNotMatch(result.stdout, /RESUMED/);
});

test("missing FUSE access prevents resume despite a mounted base", () => {
    const result = recover("mounted=yes; reader_accessible() { return 1; }");
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /RESUMED/);
});

test("normal recovery mounts and resumes", () => {
    const result = recover("");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOUNT mount/);
    assert.match(result.stdout, /RESUMED/);
});

test("unclean recovery checks before resuming", () => {
    const result = recover("EXPORT_ATTEMPTED=1; NEEDS_FSCK=1");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOUNT --fsck mount/);
    assert.match(result.stdout, /RESUMED/);
});

test("already mounted storage is not remounted", () => {
    const result = recover("mounted=yes");
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /MOUNT/);
    assert.match(result.stdout, /RESUMED/);
});

const mountCheck = shellFunction(direct, "userstore_mounted_anywhere");
for (const [name, mounts, expected] of [
    ["raw partition alias", "/dev/block/179:4 /chroot/books vfat rw 0 0", 0],
    ["another loop", "/dev/loop1 /chroot/books vfat rw 0 0", 0],
    ["no FAT mounts", "/dev/root / ext3 ro 0 0", 1],
]) {
    test(`mount guard handles ${name}`, () => {
        const result = runShell(`
LOOP_DEV=/dev/loop/0; USERSTORE_DEV=/dev/mmcblk0p4
cat() { printf '%s\\n' '${mounts}'; }
${mountCheck}
userstore_mounted_anywhere
`);
        assert.equal(result.status, expected, result.stderr);
    });
}

test("unreadable mount table blocks export", () => {
    const result = runShell(`cat() { return 1; }\n${mountCheck}\nuserstore_mounted_anywhere`);
    assert.equal(result.status, 0);
});

test("AUTO_RETURN=0 ends supervision without relaunch", () => {
    const tail = framework.slice(framework.indexOf('log "USB drive mode started'));
    const result = runShell(`
AUTO_RETURN=0; n=0
log() { :; }
launch_koreader() { echo UNEXPECTED_LAUNCH; }
${tail}
`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_LAUNCH/);
});

const launchGuard = ["usb_state", "safe_to_launch"].map(name => shellFunction(framework, name)).join("\n");
for (const [name, file, mounted, connected, available, expected] of [
    ["ready storage", "/", 0, "0", "1", 0],
    ["connected host", "/", 0, "1", "1", 1],
    ["unknown connection", "/", 0, "", "1", 1],
    ["unmounted storage", "/", 1, "0", "1", 1],
    ["unavailable storage", "/", 0, "0", "0", 1],
    ["Kindle without UDC file", "/missing-udc", 0, "1", "1", 0],
    ["Kindle without UDC file and unavailable storage", "/missing-udc", 0, "1", "0", 1],
]) {
    test(`framework launch guard handles ${name}`, () => {
        const result = runShell(`
CONNECTED=${file}
userstore_mounted() { return ${mounted}; }
cat() { printf '%s' '${connected}'; }
lipc-get-prop() { printf '%s' '${available}'; }
${launchGuard}
safe_to_launch
`);
        assert.equal(result.status, expected, result.stderr);
    });
}

const koreaderRunning = shellFunction(framework, "koreader_running");
for (const [name, pids, expected] of [
    ["no KOReader", "", 1],
    ["only the exiting KOReader", "123", 1],
    ["a new KOReader", "456", 0],
    ["the exiting and a new KOReader", "123 456", 0],
]) {
    test(`framework detects ${name}`, () => {
        const result = runShell(`
READER_PID=123
pidof() { [ -n '${pids}' ] && echo '${pids}'; }
${koreaderRunning}
koreader_running
`);
        assert.equal(result.status, expected, result.stderr);
    });
}

test("framework never launches a second KOReader", () => {
    const result = runShell(`
log() { echo "$*"; }
koreader_running() { return 0; }
safe_to_launch() { echo UNEXPECTED_CHECK; return 0; }
env() { echo UNEXPECTED_LAUNCH; }
${shellFunction(framework, "launch_koreader")}
launch_koreader
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already running/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED/);
});

const frameworkTail = framework.slice(framework.indexOf('log "USB drive mode started'));
for (const [name, setup, pattern] of [
    ["a Kindle without UDC file", "usb_state() { echo none; }; userstore_mounted() { return 1; }", /does not report/],
    ["KOReader started while exported", "usb_state() { echo 1; }; userstore_mounted() { return 1; }; koreader_running() { return 0; }", /started meanwhile/],
    ["KOReader started before unplug", "usb_state() { echo 1; }; userstore_mounted() { return 0; }; koreader_running() { return 0; }", /started meanwhile/],
]) {
    test(`framework session ends without relaunch on ${name}`, () => {
        const result = runShell(`
AUTO_RETURN=1; n=0; READER_PID=123
log() { echo "$*"; }
sleep() { :; }
koreader_running() { return 1; }
launch_koreader() { echo UNEXPECTED_LAUNCH; }
${shellFunction(framework, "superseded")}
${setup}
${frameworkTail}
`);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, pattern);
        assert.doesNotMatch(result.stdout, /UNEXPECTED_LAUNCH/);
    });
}

for (const [name, cancelled, expected] of [
    ["reports a failure", "return 1", "precheck"],
    ["drops the result after a cancel", "return 0", "REMOVED"],
]) {
    test(`direct fail ${name}`, () => {
        const result = runShell(`
RESULT=$(mktemp)
log() { :; }
cancelled() { ${cancelled}; }
rm() { echo REMOVED; }
${shellFunction(direct, "fail")}
( fail precheck "message" )
status=$?
command cat "$RESULT"; command rm -f "$RESULT"
exit $status
`);
        assert.equal(result.status, 1);
        assert.equal(result.stdout.trim(), expected);
    });
}

test("direct recovery screen has English fallbacks", () => {
    const result = runShell(`
SCREEN_TEXTS=/missing
${shellFunction(direct, "msg")}
msg recovery_title; msg recovery_text
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "USB recovery required\nUnplug USB and hold power for 40 s.\n");
});

for (const [name, source] of [["direct", direct], ["framework", framework]]) {
    test(`${name} helper rejects an obsolete session token`, () => {
        const result = runShell(`
LOCK=/unused; TOKEN=current
cat() { echo obsolete; }
${shellFunction(source, "cancelled")}
cancelled
`);
        assert.equal(result.status, 0);
    });
    test(`${name} helper rejects startup without Lua's reservation`, () => {
        const start = source.indexOf('[ -n "$TOKEN" ] && [ "$(cat "$LOCK/token"');
        const end = source.indexOf('echo $$ > "$LOCK/pid" || exit 1', start);
        assert.ok(start >= 0 && end > start);
        const result = runShell(`
LOCK=/unused; TOKEN=current; READER_PID=123
cancelled() { return 1; }
rm() { :; }
cat() { case "$1" in */token) echo current ;; *) echo 999 ;; esac; }
${source.slice(start, end)}
echo UNEXPECTED_CLAIM
`);
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout, /UNEXPECTED_CLAIM/);
    });
    test(`${name} late helper cleans its cancelled reservation`, () => {
        const start = source.indexOf('[ -n "$TOKEN" ] && [ "$(cat "$LOCK/token"');
        const end = source.indexOf('echo $$ > "$LOCK/pid" || exit 1', start);
        const result = runShell(`
LOCK=/unused; PIDFILE=/unused; TOKEN=current; READER_PID=123
cancelled() { return 0; }
rm() { echo CLEANED; }
cat() { case "$1" in */token) echo current ;; *) echo 123 ;; esac; }
${source.slice(start, end)}
echo UNEXPECTED_CLAIM
`);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /CLEANED/);
        assert.doesNotMatch(result.stdout, /UNEXPECTED_CLAIM/);
    });
}

const sessionStart = direct.indexOf('reason=""');
const sessionEnd = direct.indexOf('log "session ended:', sessionStart);
const sessionLoop = direct.slice(sessionStart, sessionEnd);
assert.ok(sessionStart >= 0 && sessionEnd > sessionStart);

for (const [name, connection, lun, events, expected, reason] of [
    ["connection read error", "return 1", "echo medium", ":", 24, ""],
    ["LUN read error", "echo 1", "return 1", ":", 24, ""],
    ["invalid connection", "echo invalid", "echo medium", ":", 24, ""],
    ["eject", "echo 1", ":", ":", 0, "eject"],
    ["unplug", "echo 0", "echo medium", ":", 0, "unplug"],
    ["unplug with empty LUN", "echo 0", ":", ":", 0, "unplug"],
    ["plug out event with empty LUN", "echo 1", ":", "echo usbPlugOut", 0, "unplug"],
]) {
    test(`direct session handles ${name}`, () => {
        const result = runShell(`
CONNECTED=/connection; LUN=/lun; HAL_EVENTS=/events
sleep() { :; }
cat() { case "$1" in /connection) ${connection} ;; /lun) ${lun} ;; esac; }
grep() {
    if [ "$2" = "usbPlugOut" ]; then
        [ "$(${events})" = "usbPlugOut" ]
    else
        return 1
    fi
}
fail() { exit 24; }
${sessionLoop}
printf '%s' "$reason"
`);
        assert.equal(result.status, expected, result.stderr);
        assert.equal(result.stdout, reason);
    });
}