#!/usr/bin/env python3
"""Install the latest Stable Chrome for Testing headless shell for this host."""

import json
import os
import platform
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


FEED = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"


def platform_name():
    system, machine = platform.system(), platform.machine().lower()
    names = {
        ("Linux", "aarch64"): "linux-arm64",
        ("Linux", "x86_64"): "linux64",
        ("Darwin", "arm64"): "mac-arm64",
        ("Darwin", "x86_64"): "mac-x64",
    }
    try:
        return names[(system, machine)]
    except KeyError:
        raise SystemExit(f"Unsupported host platform: {system} {machine}")


def download(url, destination):
    request = urllib.request.Request(url, headers={"User-Agent": "eya-chrome-headless-installer/1"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def main():
    default_cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    install_root = Path(sys.argv[1]).expanduser() if len(sys.argv) == 2 else default_cache / "eya/chrome-for-testing"
    if len(sys.argv) > 2:
        raise SystemExit(f"Usage: {Path(sys.argv[0]).name} [install-directory]")

    target = platform_name()
    with urllib.request.urlopen(FEED, timeout=30) as response:
        metadata = json.load(response)
    stable = metadata["channels"]["Stable"]
    version = stable["version"]
    download_info = next(item for item in stable["downloads"]["chrome-headless-shell"] if item["platform"] == target)

    install_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="eya-chrome-install-", dir=install_root) as temporary:
        temporary = Path(temporary)
        archive = temporary / "shell.zip"
        download(download_info["url"], archive)
        extraction = temporary / "unpacked"
        extraction.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                member = PurePosixPath(entry.filename)
                if member.is_absolute() or ".." in member.parts:
                    raise SystemExit(f"Unsafe path in Chrome archive: {entry.filename}")
            bundle.extractall(extraction)

        source = extraction / f"chrome-headless-shell-{target}"
        executable = source / "chrome-headless-shell"
        if not executable.is_file():
            raise SystemExit("Chrome archive did not contain the expected headless shell executable")
        executable.chmod(executable.stat().st_mode | 0o111)
        versioned = install_root / version
        if versioned.exists():
            shutil.rmtree(versioned)
        shutil.move(str(source), versioned)

    current = install_root / "current"
    temporary_link = install_root / f".current-{os.getpid()}"
    temporary_link.unlink(missing_ok=True)
    temporary_link.symlink_to(version, target_is_directory=True)
    temporary_link.replace(current)
    print(f"Installed Chrome for Testing headless shell {version} ({target}).")
    print(f"Eya will discover it automatically at: {current / 'chrome-headless-shell'}")
    print("Restart Eya to use the installed browser.")


if __name__ == "__main__":
    main()
