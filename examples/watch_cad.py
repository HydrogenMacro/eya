"""Usage: python watch_cad.py model.py [other_source.py ...]. Ctrl+C stops."""
import argparse
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Rebuild a CAD script after source edits settle.")
    parser.add_argument("script", type=Path)
    parser.add_argument("dependencies", type=Path, nargs="*")
    args = parser.parse_args()
    paths = [args.script, *args.dependencies]

    def versions():
        result = []
        for path in paths:
            try:
                stat = path.stat()
                result.append((stat.st_mtime_ns, stat.st_size, stat.st_ino))
            except FileNotFoundError:
                result.append(None)
        return result

    built = None
    try:
        while True:
            current = versions()
            if current != built:
                time.sleep(0.3)
                if current != versions():
                    continue
                print(f"Building {args.script}", flush=True)
                result = subprocess.run([sys.executable, str(args.script)])
                if result.returncode:
                    print("Build failed; the viewer keeps the last successfully exported model.", flush=True)
                built = current
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
