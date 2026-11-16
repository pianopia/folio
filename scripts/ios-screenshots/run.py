"""Run native screenshot tests on disposable GitHub-hosted simulators."""
import json
import os
from pathlib import Path
import subprocess


def run(*args, **kwargs):
    print("+", " ".join(str(x) for x in args), flush=True)
    return subprocess.run(args, check=True, text=True, **kwargs)


output = Path("capture-output")
output.mkdir(exist_ok=True)
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "--json"]))
all_devices = [(runtime, device) for runtime, group in devices["devices"].items() for device in group]
products = Path(os.environ["DERIVED_DATA"]) / "Build" / "Products"
test_run = next(products.glob("*.xctestrun"))
record = []
for display, names in [
    ("iphone-medium", ["iPhone 17 Pro", "iPhone 16 Pro"]),
    ("ipad-13", ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)"]),
    ("iphone-large", ["iPhone 17 Pro Max", "iPhone 16 Pro Max"]),
]:
    candidates = [(runtime, device) for runtime, device in all_devices if device["name"] in names]
    if not candidates:
        raise RuntimeError(f"No device for {display}: {all_devices}")
    runtime, device = sorted(candidates, key=lambda entry: entry[0], reverse=True)[0]
    udid = device["udid"]
    run("xcrun", "simctl", "boot", udid)
    run("xcrun", "simctl", "bootstatus", udid, "-b", timeout=300)
    run("xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41",
        "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
        "--batteryState", "charged", "--batteryLevel", "100")
    result = output / f"{display}.xcresult"
    with (output / f"{display}.log").open("w") as log:
        status = subprocess.run([
            "xcodebuild", "test-without-building", "-xctestrun", str(test_run),
            "-destination", f"platform=iOS Simulator,id={udid}",
            "-resultBundlePath", str(result), "-parallel-testing-enabled", "NO",
            "-maximum-concurrent-test-simulator-destinations", "1",
        ], stdout=log, stderr=subprocess.STDOUT, timeout=600)
    export = output / display
    if result.exists():
        run("xcrun", "xcresulttool", "export", "attachments", "--path", str(result), "--output-path", str(export))
    record.append({"display": display, "device": device["name"], "udid": udid,
                   "runtime": runtime, "exit_code": status.returncode})
    (output / "capture-manifest.json").write_text(json.dumps(record, indent=2))
    run("xcrun", "simctl", "shutdown", udid)
    if status.returncode:
        print((output / f"{display}.log").read_text()[-18000:])
        raise SystemExit(status.returncode)
