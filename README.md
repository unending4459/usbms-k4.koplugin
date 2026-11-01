# USB storage for KOReader on Kindle

`usbms.koplugin` brings USB mass storage to [KOReader](https://koreader.rocks) on jailbroken Kindles. Tap **Start USB storage** (or accept the prompt when you plug in a computer) to share the Kindle's storage without manually leaving KOReader. With the direct method, KOReader restarts after eject or unplug once storage recovery succeeds. The alternative Amazon UI method can return to KOReader after the cable is unplugged, if automatic return is enabled.

Without it, KOReader on Kindle blocks USB storage on purpose (it lives on the partition that would be exported), so copying books means leaving KOReader and going through the Amazon UI.

## Compatibility

| | |
| :-- | :-- |
| Tested on | Kindle Paperwhite 2 (6th gen, 2013), firmware 5.12.2.2, KOReader 2026.07.2 started with `koreader.sh --framework_stop` |
| Other Kindles | Untested. The direct method checks the expected storage layout and services before export (see [Safety](#safety)) and refuses if a check fails. Passing those checks does not establish compatibility with an untested device. The Amazon UI method uses Amazon's USB handling, but is also untested elsewhere. Kindles without the `fsl-usb2-udc` USB controller cannot tell a computer from a charger: the plugin asks on any cable, and the Amazon UI method stays in the Amazon UI after a USB session instead of guessing when the cable is out |
| Status screens | Text only, placed and sized from the screen height reported by KOReader's `fbink` |
| Shell | Both helpers run under the plugin's own static BusyBox `ash` (`usbms.koplugin/busybox`, ARMv7). Older Kindle shells, such as the Kindle 4's on firmware 4.x, cannot close file descriptors above 9 and would exit before the helper starts. The plugin refuses to start without it |
| Other platforms | Unsupported. The plugin disables itself on anything but a Kindle |

## Install

You need a jailbroken Kindle with KOReader already installed. Back up your books and other userstore data before trying the plugin on an untested setup.

1. Download `usbms.koplugin-vX.Y.Z.zip` from [Releases](../../releases).
2. Connect the Kindle (leave KOReader first) and unzip into `koreader/plugins/`, so you get `koreader/plugins/usbms.koplugin/main.lua`.
3. Eject, start KOReader, and check *Tools → More tools → Plugin management → USB mode (Kindle)* is enabled.

You can also [build the package from source](#build-a-release). The development tools are not required to install or run a packaged release.

## Use

- **Plug in a computer** while KOReader is open: it asks whether to share storage. Tap **Share**. If you decline, it does not ask again until the cable is unplugged. While a computer is connected, the Kindle does not go to sleep, with or without this plugin; unplug the cable to put it to sleep.
- Or **Main menu → Start USB storage**, or the **Start USB storage** gesture action.
- Copy your files, then **eject** the Kindle on the computer. With the direct method, KOReader restarts after storage recovery succeeds. With the Amazon UI method, also unplug the cable; KOReader restarts only if automatic return is enabled and storage is available.
- **Always eject before unplugging.** After an accidental unplug, the direct method attempts a filesystem check before restarting KOReader. This cannot guarantee recovery or prevent data loss, especially if writes were in progress.
- Settings are under **Settings → Device → USB mass storage**: the prompt on connect, the method, an always-check option for direct mode, automatic return and a connection timeout for Amazon UI mode, and the log of the last session.

## How it works

**Direct method** (default when KOReader runs without the Amazon framework). It does what Amazon's `volumd` does, without the framework:

1. The plugin copies a shell helper, its BusyBox, KOReader's `fbink` and a font to `/var/tmp` (RAM), starts the helper under that BusyBox's `ash`, and waits until the helper confirms it has paused `koreader.sh`. Only then does KOReader quit.
2. The helper waits for KOReader to exit, stops what KOReader left running, and waits for both `gadget/connected` and `powerd isCharging` to report `1`. It then unmounts `/mnt/base-us` and writes `/dev/mmcblk0p4` to the USB gadget's LUN. `g_file_storage` is already loaded by the firmware; no module is loaded or unloaded.
3. When the computer ejects the drive (the gadget empties the LUN) or the cable goes away, the helper confirms the LUN is released, checks unclean sessions through Amazon's `mntus --fsck mount`, and remounts the storage. It resumes `koreader.sh` only after the base mount and access to KOReader are confirmed; the launcher's loop then restarts KOReader.

**Amazon UI method** (slower alternative). KOReader quits normally, `koreader.sh` brings the Amazon framework back, and Amazon handles exporting the drive. If automatic return is enabled, the helper starts KOReader again after the cable is unplugged and storage availability is confirmed. Otherwise, you stay in the Amazon UI. If you start KOReader yourself in the meantime (from KUAL, for example), the helper steps aside and never starts a second copy. This method is used when you enable it in the settings, and always when KOReader runs on top of the Amazon framework.

## Safety

The plugin does not modify `/etc`, upstart jobs, kernel modules or the read-only root file system. Its session files live in RAM and its log is stored in `/var/local/usbms-koplugin.log`. However, USB writes and filesystem repair modify persistent user data. Keep a backup: a reboot can recover from some stuck sessions, but cannot undo corruption or restore lost files.

Unplugging during writes, hardware failures and interrupted repairs can damage the userstore. The direct method uses these safeguards on the tested device and firmware:

1. **Pre-flight checks, before anything changes.** `koreader.sh` is KOReader's parent; the Amazon framework is stopped and `volumd` paused; the firmware's own database (`kdb`) names `/dev/mmcblk0p4` as the userstore and the expected LUN file; the LUN is empty; `/mnt/base-us` is a vfat on `/dev/loop/0` backed by `mmcblk0p4`; `g_file_storage` is removable; `mntus` and `dosfsck` exist. Any mismatch: nothing is touched, KOReader stays, and it tells you.
2. **Never a forced unmount.** If anything still holds the partition, the helper gives up and logs who held it.
3. **Conservative mount check:** after unmounting, the helper refuses to export if the mount table is unreadable, either expected device is still mounted, or any other vfat mount is visible. This also rejects FAT mounts using aliases or other loop devices, including under a chroot in the same mount namespace. Separate mount namespaces and independent mount managers are unsupported; this is not a universal proof of device exclusivity.
4. **Known users are stopped:** KOReader closed, `koreader.sh` paused, `volumd` paused, framework stopped. If preventing suspend fails, export is aborted. This cannot prevent an unrelated privileged process from mounting the partition.
5. **Release checked before recovery:** both the LUN close operation and its empty readback must succeed before remounting or repair. Read errors are not treated as an eject or an unplug. A bus suspend alone does not end the session.
6. **Resume only after recovery:** unclean sessions are checked through `mntus --fsck mount`. A failed check is not bypassed with a plain mount. Plain mounts have at most three attempts; any terminal recovery failure stops automatic recovery. The base mount and access to KOReader through FUSE must be confirmed before the launcher resumes.
7. **One helper at a time:** Lua reserves an atomic lock before copying files, and both methods acknowledge the current session token and helper PID. A startup timeout cancels late helpers, and a cancelled helper leaves no result behind. A lock is cleared on the next start only once it has been unchanged for 30 s and its owner process is gone, or it is still this KOReader's own cancelled reservation. A lock whose owner PID is alive is never taken over; reboot to clear it.

If recovery cannot be confirmed, the helper leaves the launcher paused and displays a recovery message. Unplug the cable, then hold the power button 40 s to reboot. The log survives the reboot. Back up and check the userstore from a computer before continuing after filesystem errors. Traps cannot recover from `SIGKILL`, power loss or a kernel hang.

## Tests

Run `node --test tests/usbms.test.cjs` with Node.js 18 or later and Bash (WSL on Windows). The tests check shell syntax and exercise recovery, startup cancellation, mount detection and Amazon UI return with simulated device operations. They do not export storage or mount a real filesystem. On-device validation is still required for the Kindle kernel, BusyBox, `mntus` and USB host behavior.

Lua data and file-error checks: `node tests/lua-data.cjs | npx --yes --package=fengari-node-cli@0.1.0 fengari -`.
Run `pwsh -File tests/Test-Release.ps1` to check release packaging. These developer tools require Node.js/npm and PowerShell 7; npm downloads the pinned Lua tooling on first use. They are not needed on the Kindle.

## Languages

English plus the 41 other languages KOReader offers (Romanian (Moldova) and English (UK) reuse Romanian and English). Wherever KOReader already translates a phrase (its own USB storage feature on Kobo, its *Device* menu), the plugin uses KOReader's wording.

All translations other than English and Spanish are machine translations: corrections from native speakers are very welcome. Each language is one file in `usbms.koplugin/l10n/`; copy `es.lua` to add one.

The status screen text is drawn by KOReader's `fbink` with Noto Sans, which covers Latin, Greek and Cyrillic scripts but does no right-to-left or complex shaping. In Arabic, Persian, Hebrew, Hindi, Georgian, Japanese, Korean and Chinese, the status screens show English text; the rest of the plugin is in your language.

## Build A Release

Run `pwsh -File tools/Build-Release.ps1`. The version comes from the plugin metadata. The script stages the plugin and license, checks all Lua syntax, every translation table in `l10n/` and its placeholders, and text encoding and line endings. It rejects unexpected files.

The ZIP contains one `usbms.koplugin/` root and is checked entry by entry against the staged SHA-256 hashes. The ZIP, a `.sha256` checksum and a `.manifest.json` file are written under `dist/`; an existing ZIP is never overwritten. Use `-OutputDir` for another destination. These checks do not replace the on-device tests described above. A SHA-256 checksum detects accidental changes but is not a signature or proof of publisher identity.

## Troubleshooting

| Message | Meaning |
| :-- | :-- |
| No computer detected | Direct mode did not confirm both USB connection and charging signals within 30 s. Check the computer, cable and connection; the message alone does not identify the cause |
| Could not copy the helper | Preparation failed before the helper started. Preserve the detailed path and operation from the message and check KOReader's `koreader/crash.log`; the helper's session log may describe an earlier session |
| The storage was busy | Something kept a file open on the partition; the log lists the process |
| A pre-flight check failed | The device is not what the direct method expects; the log names the check. Enable the Amazon UI method instead |
| The file system check did not finish cleanly | Copy your data off from the computer and run `chkdsk` (Windows) or `fsck.vfat` (Linux) |
| The Kindle does not sleep after declining the prompt | Not caused by the plugin: the Kindle does not sleep while connected to a computer, even with the prompt turned off. Unplug the cable, then press the power button |

The log of the last session: *Settings → Device → USB mass storage → Show last session log*, or `/var/local/usbms-koplugin.log`.

## Credits

- [KOReader](https://github.com/koreader/koreader) and its developers. The design follows NiLuJe's [KoboUSBMS](https://github.com/koreader/KoboUSBMS) (helper on tmpfs, busy check before export, `dosfsck` on the way back) and the analysis in koreader issues [#3220](https://github.com/koreader/koreader/issues/3220) and [#2597](https://github.com/koreader/koreader/issues/2597).
- [zen-mtp](https://github.com/xZenLabs/zen-mtp), for the hand-off from KOReader to a helper on Kindle.
- [BusyBox](https://busybox.net) (GPLv2), bundled unmodified as `usbms.koplugin/busybox` to run the helpers: the official static `busybox-armv7l` 1.31.0 from [busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl](https://busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl/) (SHA-256 `cd04052b8b6885f75f50b2a280bfcbf849d8710c8e61d369c533acf307eda064`). Its source: [busybox-1.31.0.tar.bz2](https://busybox.net/downloads/busybox-1.31.0.tar.bz2), built with `make defconfig`.

## License

[AGPL-3.0](LICENSE), like KOReader. Not affiliated with Amazon or the KOReader project. Use at your own risk; see the [Safety](#safety) section for what the plugin does to your device.
