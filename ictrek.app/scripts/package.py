#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import tarfile
import urllib.request
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
DIST = Path(os.getenv("MCPHUB_PACKAGE_DIR", str(Path.home() / "dev/build/mcphub/ictrek.app")))
SPREADSHEET = "Htotsn3oahO1zxt73YMcaB1zn8e"
REPOSITORY = "swr.cn-southwest-2.myhuaweicloud.com/ictrek/mcphub"
PROFILES = {
    "MCPHUB_AMD_WITHOUT_CUDA_IMAGE": ["AMD_with_mxn100"],
    "MCPHUB_AMD_IMAGE": ["AMD_with_cuda"],
    "MCPHUB_ARM_WITHOUT_CUDA_IMAGE": ["ARM_without_cuda"],
    "MCPHUB_ARM_IMAGE": ["ARM_with_cuda"],
    "MCPHUB_L4T_IMAGE": ["l4t"],
    "MCPHUB_THOR_SPARK_IMAGE": ["thor_spark"],
}
def request(method: str, url: str, token: str = "", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=30) as response:
        value = json.load(response)
    if value.get("code") != 0:
        raise RuntimeError("Feishu request failed: " + url.split("?")[0])
    return value


def cell_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "".join(cell_text(part) for part in value).strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("link") or "").strip()
    return "" if value is None else str(value).strip()


def column_name(index: int) -> str:
    output = ""
    while index:
        index, rem = divmod(index - 1, 26)
        output = chr(65 + rem) + output
    return output


class Feishu:
    def __init__(self) -> None:
        configured = os.getenv("FEISHU_CONFIG_FILE")
        paths = [Path(configured)] if configured else [Path.home() / ".feishu.components.json", Path.home() / ".feishu.json"]
        path = next((candidate for candidate in paths if candidate.is_file()), None)
        if path is None:
            raise RuntimeError("Feishu credential file not found")
        config = json.loads(path.read_text())
        login = request(
            "POST",
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            body={"app_id": config["feishu_app_id"], "app_secret": config["feishu_app_secret"]},
        )
        self.token = login["tenant_access_token"]
        self.base = "https://open.feishu.cn/open-apis/sheets"
        response = request("GET", f"{self.base}/v3/spreadsheets/{SPREADSHEET}/sheets/query", self.token)
        self.sheets = {row["title"]: row["sheet_id"] for row in response["data"]["sheets"]}

    def latest_image(self, title: str) -> str:
        sheet_id = self.sheets[title]
        response = request("GET", f"{self.base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!A1:ZZ2", self.token)
        rows = response.get("data", {}).get("valueRange", {}).get("values", [])
        header = rows[0] if rows else []
        repos = rows[1] if len(rows) > 1 else []
        column = next((index for index, value in enumerate(header, 1) if cell_text(value) == "mcphub"), None)
        if column is None:
            raise RuntimeError(f"mcphub column missing from {title}")
        repository = cell_text(repos[column - 1]) if len(repos) >= column else ""
        if repository != REPOSITORY:
            raise RuntimeError(f"Unexpected mcphub repository in {title}")
        response = request(
            "GET",
            f"{self.base}/v2/spreadsheets/{SPREADSHEET}/values/{sheet_id}!{column_name(column)}4:{column_name(column)}2000",
            self.token,
        )
        values = response.get("data", {}).get("valueRange", {}).get("values", [])
        tag = next((cell_text(row[0]) for row in values if row and cell_text(row[0])), "")
        if not tag:
            raise RuntimeError(f"mcphub tag missing from {title}")
        return f"{repository or REPOSITORY}:{tag}"


def render(version: str, images: dict[str, str], stage: Path) -> None:
    stage.mkdir(parents=True)
    (stage / ".env").write_text("".join(f"{key}={value}\n" for key, value in images.items()), encoding="utf-8")
    for name in ("manifest.yml", "configs.yml", "routers.yml", "README.zh-CN.md", "README.en.md"):
        text = (SRC / name).read_text(encoding="utf-8").replace("__APP_VERSION__", version)
        if name == "manifest.yml":
            manifest = yaml.safe_load(text)
            text = yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False)
        (stage / name).write_text(text, encoding="utf-8")
    shutil.copy2(SRC / "icon.png", stage / "icon.png")
    env = "".join(f"{key}={value}\n" for key, value in images.items())
    (stage / ".env").write_text(env, encoding="utf-8")
    compose = (SRC / "docker-compose.yml").read_text(encoding="utf-8").replace("__APP_VERSION__", version)
    compose = re.sub(
        r"\$\{([A-Z0-9_]+)(?::-[^}]*)?\}",
        lambda match: images.get(match.group(1), match.group(0)),
        compose,
    )
    (stage / "docker-compose.yml").write_text(compose, encoding="utf-8")
    if re.search(r"\$\{[^}]*_IMAGE[^}]*\}", compose):
        raise RuntimeError("unrendered image variable remains")


def package(version: str, stage: Path) -> Path:
    DIST.mkdir(parents=True, exist_ok=True)
    app_tar = DIST / "app.tar.gz"
    members = [".env", "manifest.yml", "docker-compose.yml", "configs.yml", "routers.yml", "icon.png", "README.zh-CN.md", "README.en.md"]
    with tarfile.open(app_tar, "w:gz") as archive:
        for name in members:
            archive.add(stage / name, arcname=name)
    output = DIST / f"mcphub_{version}_pull.tar"
    payload = app_tar.read_bytes()
    info = tarfile.TarInfo("app.tar.gz")
    info.size = len(payload)
    with tarfile.open(output, "w") as archive:
        archive.addfile(info, io.BytesIO(payload))
    with tarfile.open(output) as archive:
        if archive.getnames() != ["app.tar.gz"]:
            raise RuntimeError("invalid outer package")
    for name in members:
        if name == "icon.png":
            continue
        text = (stage / name).read_text()
        if re.search(r"__[A-Z0-9_]+__", text):
            raise RuntimeError(f"unrendered placeholder: {name}")
    compose = yaml.safe_load((stage / "docker-compose.yml").read_text())
    if not compose.get("networks", {}).get("vos_default", {}).get("external"):
        raise RuntimeError("missing external vos_default network")
    for service in compose["services"].values():
        if not re.match(r"^[\w.-]+\.[\w.-]+(?::\d+)?/[^\s]+$", service.get("image", "")):
            raise RuntimeError("invalid service image")
        if not service.get("networks", {}).get("vos_default", {}).get("aliases"):
            raise RuntimeError("missing vos_default service alias")
    routing = yaml.safe_load((stage / "routers.yml").read_text())
    routers = routing["routers"]
    expected = {"mcphub": "/app/com.ictrek.mcphub/", "mcphub-guide": "/app/com.ictrek.mcphub/integration-guide"}
    if routing.get("router-type") != "structured" or len(routers) != 2 or {r.get("id") for r in routers} != set(expected):
        raise RuntimeError("expected two peer MCPHub pages, with no nested groups")
    for route in routers:
        if route.get("kind") != "page" or "children" in route or route.get("iframe-src") != expected[route["id"]] or not route.get("embed"):
            raise RuntimeError("invalid MCPHub page route")
        if bool(route.get("entry-point")) != (route["id"] == "mcphub"):
            raise RuntimeError("only service management may be the app entry point")
    manifest = yaml.safe_load((stage / "manifest.yml").read_text())
    if manifest["version"] != version:
        raise RuntimeError("manifest version mismatch")
    with tarfile.open(app_tar) as inner:
        if set(inner.getnames()) != set(members):
            raise RuntimeError("invalid inner package")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=os.getenv("PACKAGE_VERSION", ""))
    args = parser.parse_args()
    version = args.version or (ROOT / "VERSION").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"invalid version: {version}")
    print(f"[INFO] Package version: {version}")
    print("[INFO] Image source: pull")
    feishu = Feishu()
    images = {}
    for variable, sheets in PROFILES.items():
        errors = []
        for sheet in sheets:
            try:
                images[variable] = feishu.latest_image(sheet)
            except Exception as exc:
                errors.append(str(exc))
                continue
            profile = variable.removeprefix("MCPHUB_").removesuffix("_IMAGE").lower().replace("_", "-")
            print(f"[INFO] {profile} ({sheet}) mcphub -> {images[variable]}")
            break
        if variable not in images:
            raise RuntimeError("; ".join(errors))
    stage = DIST / "staging"
    if stage.exists():
        shutil.rmtree(stage)
    render(version, images, stage)
    output = package(version, stage)
    print(output)


if __name__ == "__main__":
    main()
