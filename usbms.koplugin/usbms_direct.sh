#!/bin/sh
# usbms.koplugin direct helper: exports the userstore without the Amazon framework.
#
# Does what volumd does on this firmware (traced on a PW2, FW 5.12.2.2, 2026-10-15): g_file_storage is
# loaded at boot with removable=y, so exporting is writing /dev/mmcblk0p4 to the LUN after
# unmounting the vfat on /mnt/base-us. The fuse proxy on /mnt/us stays mounted throughout.
#
# main.lua copies this to /var/tmp, starts it detached, waits for the ready file and quits KOReader
# with 85. We SIGSTOP koreader.sh first, so it cannot restart KOReader while the drive is exported,
# and SIGCONT it after safe recovery: its loop restarts KOReader, with the framework still down.
#
# Safety rules, in order of importance:
#   - No module, upstart job or rootfs file is changed. Host writes and filesystem repair can
#     change user data; a reboot does not undo those changes.
#   - Nothing changes until every pre-flight check passes: a mismatch means "not the firmware this
#     was written for", and we hand control back untouched.
#   - The vfat is never unmounted lazily. If anything still uses it, we give up.
#   - Export requires the supported mount layout; remount requires confirmed gadget release.
#
# Usage: usbms_direct.sh READER_PID KOSH_PID TOKEN HOST_TIMEOUT FSCK(auto|always)

READER_PID=$1
KOSH_PID=$2
TOKEN=$3
HOST_TIMEOUT=${4:-30}
FSCK_MODE=${5:-auto}

WORK=/var/tmp/usbms-koplugin
# /var/local is persistent (ext3), so the log survives the reboot that a stuck session needs.
LOG=/var/local/usbms-koplugin.log
LOCK="$WORK/lock"
PIDFILE="$WORK/helper.pid"
READY="$WORK/ready"
RESULT="$WORK/result"
FBINK="$WORK/fbink"
FONT="$WORK/NotoSans-Regular.ttf"
# Screen texts in KOReader's language, written by main.lua (key=value lines).
SCREEN_TEXTS="$WORK/screen.txt"
HAL_EVENTS="$WORK/hal.events"

UDC=/sys/devices/platform/fsl-usb2-udc/gadget
LUN="$UDC/gadget-lun0/file"
CONNECTED="$UDC/connected"
# FW 4 (K4) has no connected file; the LUN's online flag is 1 only while a computer is attached
# (0 with no cable and on a charge-only port).
[ -e "$CONNECTED" ] || CONNECTED="$UDC/gadget-lun0/online"
USERSTORE_DEV=/dev/mmcblk0p4
LOOP_DEV=/dev/loop/0
BASE_MP=/mnt/base-us

# Every command BusyBox has comes from the plugin's own copy: the firmware's BusyBox (1.7.2 on the
# K4) lacks options this helper relies on, such as grep -E. mount and umount stay the firmware's
# util-linux ones, and Amazon's mntus script gets the firmware PATH back.
SYSTEM_PATH=$PATH
use_own_busybox() {
    rm -rf "$WORK/bin" && mkdir "$WORK/bin" && "$WORK/busybox" --install -s "$WORK/bin" || return 1
    rm -f "$WORK/bin/mount" "$WORK/bin/umount"
    PATH="$WORK/bin:$PATH"
}

cd / || exit 1
trap '' HUP

# Drop every descriptor inherited from KOReader, so none of them pins a file on the userstore.
for fd in $(ls /proc/$$/fd 2>/dev/null); do
    [ "$fd" -gt 2 ] 2>/dev/null && eval "exec $fd>&-" 2>/dev/null
done

log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

host_connected() {
    [ "$(cat "$CONNECTED" 2>/dev/null)" = "1" ] &&
        [ "$(lipc-get-prop com.lab126.powerd isCharging 2>/dev/null)" = "1" ]
}

# Full-screen status, text only. The text goes through KOReader's fbink with KOReader's Noto Sans
# (OpenType is in its build), placed and sized from the real screen height so it fits the K4's
# 600x800 as well as the Paperwhite's 758x1024. Each piece falls back to something plainer when its
# file is missing. The first argument names the screen (it used to pick an image) and is unused.
screen() {
    shift
    view_height=
    if [ -x "$FBINK" ]; then
        view_height=$("$FBINK" -e 2>/dev/null | sed -n 's/.*viewHeight=\([0-9]*\);.*/\1/p')
        "$FBINK" -q -c -f
    else
        eips -c
    fi
    case "$view_height" in ''|*[!0-9]*|0) view_height=800 ;; esac
    # Upper middle of the screen; the fallbacks count rows of 16 px (fbink -S 2) instead of pixels.
    top=$((view_height * 2 / 5))
    row=$((top / 16))
    px=$((view_height * 44 / 1024))
    for line in "$@"; do
        if [ -x "$FBINK" ] && [ -f "$FONT" ] && "$FBINK" -q -O -m -t "regular=$FONT,px=$px,top=$top,left=30,right=30" -- "$line" > /dev/null 2>&1; then
            top=$((top + px + 12))
        elif [ -x "$FBINK" ]; then
            "$FBINK" -q -m -S 2 -y "$row" -- "$line" > /dev/null 2>&1
            row=$((row + 3))
        else
            eips 2 "$row" "$line" > /dev/null 2>&1
            row=$((row + 2))
        fi
        px=$((view_height * 32 / 1024))
    done
}

# Screen texts: main.lua's translation when there is one, English otherwise.
msg() {
    v=$(sed -n "s/^$1=//p" "$SCREEN_TEXTS" 2>/dev/null | head -n 1)
    if [ -n "$v" ]; then echo "$v"; return; fi
    case "$1" in
        waiting_title)   echo "USB mode" ;;
        waiting_text)    echo "Connect the cable to a computer." ;;
        active_title)    echo "USB storage active" ;;
        active_text)     echo "Eject the Kindle on the computer to return to KOReader." ;;
        returning_title) echo "USB mode" ;;
        returning_text)  echo "Returning to KOReader..." ;;
        recovery_title)  echo "USB recovery required" ;;
        recovery_text)   echo "Unplug USB and hold power for 40 s." ;;
    esac
}

base_mounted() { grep -q " $BASE_MP " /proc/mounts; }
userstore_mounted_anywhere() {
    mount_table=$(cat /proc/mounts) || return 0
    printf '%s\n' "$mount_table" | grep -q -E "^($LOOP_DEV|$USERSTORE_DEV) |^[^ ]+ [^ ]+ vfat "
}

reader_accessible() { [ -r /mnt/us/koreader/reader.lua ]; }

lun_empty() {
    lun_value=$(cat "$LUN" 2>/dev/null) || return 1
    [ -z "$lun_value" ]
}

release_lun() {
    printf '\n' > "$LUN" || return 1
    lun_empty
}

EXPORT_ATTEMPTED=0
NEEDS_FSCK=0
RECOVERY_BLOCKED=0
RECOVERY_RESULT=fail

restore_userstore() {
    if [ "$EXPORT_ATTEMPTED" = 1 ]; then
        release_lun || { log "cannot confirm LUN release"; return 1; }
        EXPORT_ATTEMPTED=0
    fi
    [ "$RECOVERY_BLOCKED" = 0 ] || return 1
    RECOVERY_BLOCKED=1
    sync
    if [ "$NEEDS_FSCK" = 1 ]; then
        RECOVERY_RESULT=fsckfail
        PATH="$SYSTEM_PATH" mntus --fsck mount >> "$LOG" 2>&1 || return 1
        NEEDS_FSCK=0
        RECOVERY_RESULT=fail
    fi
    mount_attempt=0
    while ! base_mounted && [ "$mount_attempt" -lt 3 ]; do
        if ! PATH="$SYSTEM_PATH" mntus mount >> "$LOG" 2>&1; then
            base_mounted && return 1
        fi
        mount_attempt=$((mount_attempt + 1))
        base_mounted || sleep 2
    done
    base_mounted && reader_accessible || return 1
    RECOVERY_BLOCKED=0
}

# "pid starttime" for every process under PID, from /proc/*/stat in one pass. comm can hold
# spaces, so fields are counted from the last ") ". starttime lets us tell a reused pid apart.
descendants() {
    cat /proc/[0-9]*/stat 2>/dev/null | awk -v root="$1" '
        { s = $0; sub(/.*\) /, "", s); split(s, f, " "); parent[$1] = f[2]; start[$1] = f[20] }
        END {
            for (p in parent) {
                q = parent[p]
                while (q != "" && q != 0 && q != 1) {
                    if (q == root) { print p, start[p]; break }
                    q = parent[q]
                }
            }
        }'
}

starttime() {
    s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
    s=${s##*) }
    echo "$s" | cut -d' ' -f20
}

holders() {
    for p in /proc/[0-9]*; do
        n=$(ls -l "$p/cwd" "$p/fd" 2>/dev/null | grep -c -E '/mnt/(us|base-us)')
        m=$(grep -c -E '/mnt/(us|base-us)' "$p/maps" 2>/dev/null)
        [ "${n:-0}" -gt 0 ] || [ "${m:-0}" -gt 0 ] || continue
        echo "${p#/proc/} $(tr '\0' ' ' < "$p/cmdline" | cut -c1-80) [fd/cwd:$n maps:$m]"
    done
}

fail() {
    # $1 result code for main.lua, rest: log message. Only used before anything changed, or after
    # finish() can undo it.
    code=$1; shift
    log "$*"
    # After a cancel, main.lua has already told the user; a result would come up again later.
    if cancelled; then rm -f "$RESULT"; else echo "$code" > "$RESULT"; fi
    exit 1
}

cancelled() {
    [ "$(cat "$LOCK/token" 2>/dev/null)" != "$TOKEN" ] || [ -f "$LOCK/cancel" ]
}

[ -n "$TOKEN" ] && [ "$(cat "$LOCK/token" 2>/dev/null)" = "$TOKEN" ] || exit 1
[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$READER_PID" ] || exit 1
trap 'rm -rf "$LOCK"; rm -f "$PIDFILE"' EXIT
cancelled && exit 1
echo $$ > "$LOCK/pid" || exit 1
echo $$ > "$PIDFILE" || exit 1
: > "$LOG"
log "direct: reader=$READER_PID koreader.sh=$KOSH_PID host_timeout=${HOST_TIMEOUT}s fsck=$FSCK_MODE"
echo "fail" > "$RESULT"
use_own_busybox || fail precheck "precheck failed: cannot link BusyBox commands into $WORK/bin"

# ---- Pre-flight: nothing has changed yet. Any surprise means hands off.
check() { # $1 message, rest: command
    m=$1; shift
    "$@" > /dev/null 2>&1 || fail precheck "precheck failed: $m"
}
kdb_is() { [ "$(kdb get "$1" 2>/dev/null)" = "$2" ]; }

check "parent $KOSH_PID is not koreader.sh" sh -c "tr '\0' ' ' < /proc/$KOSH_PID/cmdline | grep -q koreader.sh"
check "reader $READER_PID is not a child of $KOSH_PID" sh -c "[ \"\$(awk '/^PPid/{print \$2}' /proc/$READER_PID/status)\" = $KOSH_PID ]"
framework_stopped() {
    # FW 5 (upstart) has a job for it. FW 4 (sysvinit, K4) has none: koreader.sh --framework_stop
    # stops the framework through /etc/init.d/framework, which ends cvm; with the framework up,
    # koreader.sh only SIGSTOPs cvm, so a paused cvm still counts as running.
    if command -v status > /dev/null 2>&1; then
        status lab126_gui | grep -q 'stop/waiting'
    else
        ! pidof cvm > /dev/null
    fi
}
check "the Amazon framework is running" framework_stopped
# koreader.sh SIGSTOPs volumd; a running volumd would react to the same USB events we do.
VOLUMD_PID=$(pidof volumd)
check "volumd is not stopped (state $(grep '^State' "/proc/$VOLUMD_PID/status" 2>/dev/null))" \
    sh -c "[ -z '$VOLUMD_PID' ] || grep -q '^State:.*T' /proc/$VOLUMD_PID/status"
check "kdb says the userstore is not $USERSTORE_DEV" kdb_is system/daemon/volumd/MOUNTED_VOLUME_NAME "$USERSTORE_DEV"
check "kdb says the LUN is not $LUN" kdb_is system/daemon/volumd/SYS_MOUNT_FILE_NAME "$LUN"
check "no LUN file at $LUN" test -w "$LUN"
check "no connected file at $CONNECTED" test -r "$CONNECTED"
check "the LUN is unreadable or already exports a device" lun_empty
check "g_file_storage is not removable" sh -c "grep -q Y /sys/module/g_file_storage/parameters/removable"
check "$BASE_MP is not a vfat on $LOOP_DEV" grep -q "^$LOOP_DEV $BASE_MP vfat " /proc/mounts
check "$LOOP_DEV is not backed by $USERSTORE_DEV" sh -c "losetup $LOOP_DEV | grep -q $USERSTORE_DEV"
check "$USERSTORE_DEV is mounted directly" sh -c "! grep -q '^$USERSTORE_DEV ' /proc/mounts"
check "no mntus" test -x /usr/sbin/mntus
check "no dosfsck" test -x /sbin/dosfsck
log "pre-flight ok"

# ---- Resume koreader.sh only after storage has been recovered.
finish() {
    [ -n "$HAL_PID" ] && kill "$HAL_PID" 2>/dev/null
    if ! restore_userstore; then
        echo "$RECOVERY_RESULT" > "$RESULT"
        log "RECOVERY STOPPED: unplug USB and reboot the Kindle (hold power 40 s)"
        screen usb-returning "$(msg recovery_title)" "$(msg recovery_text)"
        rm -rf "$LOCK"
        rm -f "$PIDFILE"
        return 1
    fi
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
    log "resuming koreader.sh"
    kill -CONT "$KOSH_PID" 2>/dev/null
    rm -rf "$LOCK"
    rm -f "$PIDFILE"
}
trap finish EXIT
trap 'exit 1' INT TERM

cancelled && fail fail "startup cancelled"
kill -STOP "$KOSH_PID" || fail fail "could not stop koreader.sh"
# Snapshot KOReader's children now: some (lipc-wait-event, subprocesses) outlive it.
OLD_TREE=$(descendants "$READER_PID")
# Tell main.lua it may quit now: koreader.sh cannot restart KOReader any more.
echo "$TOKEN" > "$READY" || fail fail "could not acknowledge startup"

# 1. Wait for KOReader to exit (zombie counts: its parent is stopped and cannot reap it yet).
n=0
while [ -d "/proc/$READER_PID" ] && ! grep -q '^State:.*Z' "/proc/$READER_PID/status" 2>/dev/null; do
    cancelled && fail fail "startup cancelled"
    [ "$n" -ge 120 ] && fail fail "KOReader did not exit within 60 s"
    usleep 500000
    n=$((n + 1))
done
log "KOReader exited"
# No suspend while the drive is exported: the host would see the Kindle vanish mid-write.
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || fail fail "preventScreenSaver not set"

# 2. Stop what KOReader left behind, as long as each pid is still the process we saw.
echo "$OLD_TREE" | while read -r p st; do
    [ -n "$p" ] && [ "$p" != "$$" ] && [ "$(starttime "$p")" = "$st" ] && echo "$p $st"
done > "$WORK/leftovers"
leftovers=$(awk '{print $1}' "$WORK/leftovers" | tr '\n' ' ')
if [ -n "$leftovers" ]; then
    log "stopping leftovers: $leftovers"
    kill -TERM $leftovers 2>/dev/null
    sleep 2
    while read -r p st; do
        [ -n "$p" ] && [ "$(starttime "$p")" = "$st" ] && kill -KILL "$p" 2>/dev/null
    done < "$WORK/leftovers"
fi

# The waiting screen only makes sense when no computer is there yet; with the cable already in
# (the usual case, since the prompt appears on plug) it would be a pointless full-screen flash.
if ! host_connected; then
    screen usb-waiting "$(msg waiting_title)" "$(msg waiting_text)"
fi

# 3. Wait for a computer: the UDC reports a host once the cable carries data.
n=0
until host_connected; do
    if [ "$n" -ge "$HOST_TIMEOUT" ]; then
        log "no computer after ${HOST_TIMEOUT} s"
        echo "nohost" > "$RESULT"
        exit 0
    fi
    sleep 1
    n=$((n + 1))
done
log "computer connected"
lun_empty || fail fail "LUN is unreadable or no longer empty, refusing"

# 4. Unmount the vfat. Never lazily: if anything still holds it, give up and go back.
sync
if ! umount "$BASE_MP" 2>> "$LOG"; then
    log "userstore busy:"
    holders >> "$LOG"
    fail busy "unmount refused, nothing exported"
fi
# Belt and braces: the partition must not be reachable through any other mount before the host
# gets it. finish() remounts if we bail out here.
userstore_mounted_anywhere && fail busy "userstore still mounted elsewhere: $(grep -E "^($LOOP_DEV|$USERSTORE_DEV) " /proc/mounts | tr '\n' ';')"
log "userstore unmounted"

# 5. Export.
rm -f "$HAL_EVENTS"
lipc-wait-event -m com.lab126.hal usbPlugOut,usbUnconfigured > "$HAL_EVENTS" 2>/dev/null &
HAL_PID=$!
EXPORT_ATTEMPTED=1
NEEDS_FSCK=1
if ! echo "$USERSTORE_DEV" > "$LUN" || [ "$(cat "$LUN")" != "$USERSTORE_DEV" ]; then
    fail fail "could not export $USERSTORE_DEV"
fi
log "exported $USERSTORE_DEV"
screen usb-active "$(msg active_title)" "$(msg active_text)"

# 6. Wait for the end of the session. Only two things end it:
#    - the gadget closes the LUN: the host ejected (START STOP UNIT, or Lab126's idle-after-sync
#      heuristic for Windows "safely remove");
#    - the cable goes away: connected reads 0 twice in a row, or udev reports usbPlugOut.
#    usbUnconfigured alone is only logged: the gadget also sends it on bus suspend, when the host
#    may still hold the drive. A host that re-enumerates after an eject finds no medium, because
#    nothing exports it again.
reason=""
gone=0
noted=""
while [ -z "$reason" ]; do
    sleep 1
    connected_value=$(cat "$CONNECTED" 2>/dev/null) || fail fail "cannot read USB connection state"
    case "$connected_value" in
        1) gone=0 ;;
        0) gone=$((gone + 1)) ;;
        *) fail fail "invalid USB connection state" ;;
    esac
    lun_value=$(cat "$LUN" 2>/dev/null) || fail fail "cannot read LUN state"
    if [ "$gone" -ge 2 ] || grep -q 'usbPlugOut' "$HAL_EVENTS" 2>/dev/null; then
        reason=unplug
    elif [ -z "$lun_value" ] && [ "$connected_value" = "1" ]; then
        reason=eject
    elif [ -z "$noted" ] && grep -q 'usbUnconfigured' "$HAL_EVENTS" 2>/dev/null; then
        noted=1
        log "usbUnconfigured seen while the LUN is still exported, waiting on"
    fi
done
log "session ended: $reason ($(tr '\n' ' ' < "$HAL_EVENTS" 2>/dev/null))"

# 7. Take the medium away from the host before touching the filesystem again. Closing the backing
#    file makes the gadget fsync it.
release_lun || fail fail "could not release the USB medium"
EXPORT_ATTEMPTED=0
screen usb-returning "$(msg returning_title)" "$(msg returning_text)"
sync
echo 3 > /proc/sys/vm/drop_caches

# 8. Check (after an unclean end, or always if asked) and mount, as /usr/sbin/mntus does.
if [ "$reason" = "eject" ] && [ "$FSCK_MODE" != "always" ]; then NEEDS_FSCK=0; fi
restore_userstore || fail "$RECOVERY_RESULT" "could not safely recover the userstore"
log "userstore mounted"
echo "$reason" > "$RESULT"
exit 0
