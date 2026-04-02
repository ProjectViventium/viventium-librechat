#!/usr/bin/env python3
import os
import sys
import io
import json
import time
import hashlib
import argparse
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except Exception as e:
    print("Missing dependency: requests. Install with: pip install requests", file=sys.stderr)
    raise


DEFAULT_LIBRECHAT_BASE = "https://api.librechat.ai/v1"
ENV_KEY = "LIBRECHAT_CODE_API_KEY"
ENV_BASE = "LIBRECHAT_CODE_BASEURL"

# Configuration via environment variables
# Set these environment variables before running:
#   LIBRECHAT_CODE_API_KEY - API key for LibreChat Code API
#   LIBRECHAT_CODE_BASEURL - Base URL for LibreChat (default: https://api.librechat.ai/v1)
#   CUSTOM_CODE_API_KEY - API key for custom Code Interpreter
#   CUSTOM_CODE_BASEURL - Base URL for custom Code Interpreter


class ApiClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "User-Agent": "CodeAPICompare/1.0",
        }

    def upload_files(self, files_payload: List[Tuple[str, Tuple[str, bytes, str]]], entity_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/upload"
        data = {"entity_id": entity_id}
        resp = requests.post(url, headers=self._headers(), data=data, files=files_payload, timeout=self.timeout)
        self._raise_for_status(resp)
        return resp.json()

    def exec_code(self, code: str, lang: str, entity_id: str, files: Optional[List[Dict[str, str]]] = None, args: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/exec"
        payload: Dict[str, Any] = {
            "code": code,
            "lang": lang,
            "entity_id": entity_id,
        }
        if files:
            payload["files"] = files
        if args:
            payload["args"] = args
        resp = requests.post(url, headers={**self._headers(), "Content-Type": "application/json"}, json=payload, timeout=self.timeout)
        self._raise_for_status(resp)
        return resp.json()

    def list_files(self, session_id: str, detail: str = "simple", entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/files/{session_id}"
        params: Dict[str, Any] = {"detail": detail}
        if entity_id:
            params["entity_id"] = entity_id
        resp = requests.get(url, headers=self._headers(), params=params, timeout=self.timeout)
        self._raise_for_status(resp)
        return resp.json()

    def download_file(self, session_id: str, file_id: str, entity_id: Optional[str] = None) -> bytes:
        url = f"{self.base_url}/download/{session_id}/{file_id}"
        if entity_id:
            url = f"{url}?entity_id={entity_id}"
        resp = requests.get(url, headers=self._headers(), timeout=self.timeout)
        self._raise_for_status(resp)
        return resp.content

    def delete_file(self, session_id: str, file_id: str) -> None:
        url = f"{self.base_url}/files/{session_id}/{file_id}"
        resp = requests.delete(url, headers=self._headers(), timeout=self.timeout)
        self._raise_for_status(resp)

    @staticmethod
    def _raise_for_status(resp: requests.Response) -> None:
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            detail = None
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise RuntimeError(f"HTTP {resp.status_code}: {detail}") from exc


def sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def normalized_execute_response(resp: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    run = resp.get("run", {}) or {}
    # Merge top-level fields if run is missing these
    run_out = {
        "stdout": run.get("stdout") if isinstance(run, dict) else None,
        "stderr": run.get("stderr") if isinstance(run, dict) else None,
        "code": run.get("code") if isinstance(run, dict) else None,
        "signal": run.get("signal") if isinstance(run, dict) else None,
        "status": run.get("status") if isinstance(run, dict) else None,
        "cpu_time": run.get("cpu_time") if isinstance(run, dict) else None,
        "wall_time": run.get("wall_time") if isinstance(run, dict) else None,
        "memory": run.get("memory") if isinstance(run, dict) else None,
    }
    # Fill from top-level fallbacks
    for k in ["stdout", "stderr", "code", "signal", "status", "cpu_time", "wall_time", "memory"]:
        if run_out.get(k) is None and k in resp:
            run_out[k] = resp.get(k)
    out["run"] = run_out

    out["language"] = resp.get("language") or resp.get("lang")
    out["version"] = resp.get("version")
    out["session_id"] = resp.get("session_id")
    # Normalize files: drop volatile ids if needed, but keep names and paths
    files = resp.get("files") or []
    norm_files = []
    for f in files:
        if not isinstance(f, dict):
            continue
        norm_files.append({
            "name": f.get("name"),
            "path": f.get("path"),
            "id_present": bool(f.get("id")),
        })
    out["files"] = sorted(norm_files, key=lambda x: (x.get("name") or "", x.get("path") or ""))
    return out


def diff_dicts(a: Any, b: Any, path: str = "") -> List[str]:
    diffs: List[str] = []
    if type(a) != type(b):
        diffs.append(f"{path}: type {type(a).__name__} != {type(b).__name__}")
        return diffs
    if isinstance(a, dict):
        a_keys = set(a.keys())
        b_keys = set(b.keys())
        for k in sorted(a_keys - b_keys):
            diffs.append(f"{path}.{k}: present only in A")
        for k in sorted(b_keys - a_keys):
            diffs.append(f"{path}.{k}: present only in B")
        for k in sorted(a_keys & b_keys):
            diffs.extend(diff_dicts(a[k], b[k], f"{path}.{k}" if path else k))
        return diffs
    if isinstance(a, list):
        if len(a) != len(b):
            diffs.append(f"{path}: list lengths {len(a)} != {len(b)}")
        # Compare element-by-element for simplicity
        for i, (ai, bi) in enumerate(zip(a, b)):
            diffs.extend(diff_dicts(ai, bi, f"{path}[{i}]"))
        return diffs
    if a != b:
        diffs.append(f"{path}: {repr(a)} != {repr(b)}")
    return diffs


def parse_env_report_bytes(data: bytes) -> Optional[Dict[str, Any]]:
    try:
        text = data.decode("utf-8", "ignore")
        return json.loads(text)
    except Exception:
        return None


def normalize_upload_files_for_request(upload_resp: Dict[str, Any], fallback_name: str) -> Tuple[Optional[str], Optional[List[Dict[str, str]]]]:
    session_id = upload_resp.get("session_id")
    files = upload_resp.get("files") or []
    if not session_id or not files:
        return None, None
    # Support multiple shapes:
    # - Spec: { name, id, session_id, ... }
    # - Custom: { filename, fileId }
    req_files: List[Dict[str, str]] = []
    for f in files:
        if not isinstance(f, dict):
            continue
        file_id = f.get("id") or f.get("fileId")
        name = f.get("name") or f.get("filename") or fallback_name
        if file_id:
            req_files.append({"id": file_id, "session_id": session_id, "name": name})
    return session_id, (req_files if req_files else None)


def diff_env_reports(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    # Simple fields
    for key in ["python_version", "executable", "platform", "machine", "cwd"]:
        if a.get(key) != b.get(key):
            result[key] = {"A": a.get(key), "B": b.get(key)}
    # Paths as sets to show only differences
    a_paths = list(map(str, a.get("python_paths", []) or []))
    b_paths = list(map(str, b.get("python_paths", []) or []))
    if set(a_paths) != set(b_paths):
        result["python_paths"] = {
            "only_in_A": sorted(set(a_paths) - set(b_paths)),
            "only_in_B": sorted(set(b_paths) - set(a_paths)),
        }
    # Env vars diff
    a_env = a.get("env", {}) or {}
    b_env = b.get("env", {}) or {}
    env_diffs = {}
    for k in sorted(set(a_env.keys()) | set(b_env.keys())):
        if a_env.get(k) != b_env.get(k):
            env_diffs[k] = {"A": a_env.get(k), "B": b_env.get(k)}
    if env_diffs:
        result["env"] = env_diffs
    # Packages diff (both exact and name-only)
    a_pkgs = list(map(str, a.get("packages", []) or []))
    b_pkgs = list(map(str, b.get("packages", []) or []))
    set_a = set(a_pkgs)
    set_b = set(b_pkgs)
    if set_a != set_b:
        result["packages_exact"] = {
            "only_in_A_count": len(set_a - set_b),
            "only_in_B_count": len(set_b - set_a),
            "sample_only_in_A": sorted(list(set_a - set_b))[:30],
            "sample_only_in_B": sorted(list(set_b - set_a))[:30],
        }
    def names(pkgs: List[str]) -> set:
        names_set = set()
        for p in pkgs:
            name = p.split("==")[0].strip() if "==" in p else p.strip()
            if name:
                names_set.add(name.lower())
        return names_set
    names_a = names(a_pkgs)
    names_b = names(b_pkgs)
    if names_a != names_b:
        result["packages_by_name"] = {
            "only_in_A_names_count": len(names_a - names_b),
            "only_in_B_names_count": len(names_b - names_a),
            "sample_only_in_A_names": sorted(list(names_a - names_b))[:30],
            "sample_only_in_B_names": sorted(list(names_b - names_a))[:30],
        }
    return result


def build_env_probe_code(upload_filename: str) -> str:
    # This code prints a JSON env report and writes env_report.txt in CWD.
    # It also tries to locate the uploaded file by name and prints a preview.
    return (
        "import sys, os, platform, json, pkgutil, subprocess\n"
        "report = {}\n"
        "report['python_version'] = sys.version\n"
        "report['executable'] = sys.executable\n"
        "report['platform'] = platform.platform()\n"
        "report['machine'] = platform.machine()\n"
        "report['python_paths'] = sys.path\n"
        "report['cwd'] = os.getcwd()\n"
        "keep_env = ['PYTHONPATH','PATH','HOME','LANG','LC_ALL']\n"
        "report['env'] = {k: os.environ.get(k) for k in keep_env}\n"
        "try:\n"
        "    pkgs = subprocess.check_output([sys.executable, '-m', 'pip', 'freeze'], stderr=subprocess.STDOUT, timeout=30).decode('utf-8','ignore').splitlines()\n"
        "except Exception:\n"
        "    pkgs = sorted({m.name for m in pkgutil.iter_modules()})\n"
        "report['packages'] = pkgs[:500]\n"
        f"target='{upload_filename}'\n"
        "found = []\n"
        "roots = [os.getcwd(), '/workspace', '/mnt/data', '/data', '/home', '/tmp', '/']\n"
        "def walk_limited(root, max_depth=3):\n"
        "    root = os.path.abspath(root)\n"
        "    for base, dirs, files in os.walk(root):\n"
        "        depth = base[len(root):].count(os.sep)\n"
        "        if depth > max_depth:\n"
        "            del dirs[:]\n"
        "            continue\n"
        "        yield base, files\n"
        "for r in roots:\n"
        "    if os.path.isdir(r):\n"
        "        for base, files in walk_limited(r, 3):\n"
        "            if target in files:\n"
        "                found.append(os.path.join(base, target))\n"
        "report['uploaded_file_candidates'] = found\n"
        "content_preview = None\n"
        "for p in found:\n"
        "    try:\n"
        "        with open(p, 'rb') as f:\n"
        "            b = f.read(256)\n"
        "        content_preview = b.decode('utf-8','ignore')\n"
        "        break\n"
        "    except Exception as e:\n"
        "        content_preview = str(e)\n"
        "report['uploaded_file_content_preview'] = content_preview\n"
        "report_path = os.path.join(os.getcwd(), 'env_report.txt')\n"
        "with open(report_path, 'w', encoding='utf-8') as f:\n"
        "    f.write(json.dumps(report, indent=2))\n"
        "print('ENV_REPORT_PATH:' + report_path)\n"
        "print(json.dumps(report))\n"
    )


def pick_file_id_by_name(files: List[Dict[str, Any]], name: str) -> Optional[str]:
    for f in files or []:
        if isinstance(f, dict) and f.get("name") == name and f.get("id"):
            return f.get("id")
    return None


def summarize_upload(resp: Dict[str, Any]) -> Dict[str, Any]:
    files = resp.get("files") or []
    return {
        "session_id": resp.get("session_id"),
        "files": [
            {
                "name": f.get("name"),
                "id_present": bool(f.get("id")),
                "size": f.get("size"),
                "contentType": f.get("contentType"),
            }
            for f in files if isinstance(f, dict)
        ],
    }


def run_workflow(client: ApiClient, label: str, entity_id: str, upload_filename: str, upload_bytes: bytes) -> Dict[str, Any]:
    result: Dict[str, Any] = {"label": label}
    # Upload
    try:
        files_payload = [("files", (upload_filename, upload_bytes, "text/plain"))]
        upload_resp = client.upload_files(files_payload=files_payload, entity_id=entity_id)
        result["upload_raw"] = upload_resp
        result["upload_summary"] = summarize_upload(upload_resp)
    except Exception as e:
        return {"label": label, "error": str(e), "error_stage": "upload"}

    upload_session_id, request_files = normalize_upload_files_for_request(upload_resp, fallback_name=upload_filename)
    uploaded_file_id = None
    if request_files:
        uploaded_file_id = request_files[0].get("id")

    # Exec
    try:
        code = build_env_probe_code(upload_filename)
        exec_resp = client.exec_code(code=code, lang="py", entity_id=entity_id, files=request_files)
        result["exec_raw"] = exec_resp
        result["exec_normalized"] = normalized_execute_response(exec_resp)
    except Exception as e:
        # Fallback: try without files (some implementations may restrict file refs)
        try:
            code = build_env_probe_code(upload_filename)
            exec_resp = client.exec_code(code=code, lang="py", entity_id=entity_id, files=None)
            result["exec_raw"] = exec_resp
            result["exec_normalized"] = normalized_execute_response(exec_resp)
            result["exec_warning"] = f"retry_without_files due_to: {str(e)}"
        except Exception as e2:
            return {"label": label, "error": str(e2), "error_stage": "exec"}

    # Decide what to download: prefer env_report.txt from exec response, else the uploaded file
    exec_session_id = exec_resp.get("session_id") or upload_session_id
    env_file_id = None
    exec_files = exec_resp.get("files") or []
    # Try direct match by name
    env_file_id = pick_file_id_by_name(exec_files, "env_report.txt")
    downloaded_targets: List[Dict[str, Any]] = []
    if env_file_id and exec_session_id:
        try:
            content = client.download_file(session_id=exec_session_id, file_id=env_file_id, entity_id=entity_id)
            downloaded_targets.append({
                "type": "env_report.txt",
                "sha256": sha256_bytes(content),
                "size": len(content),
            })
            env_json = parse_env_report_bytes(content)
            if env_json is not None:
                result["env_report"] = env_json
        except Exception as e:
            downloaded_targets.append({"type": "env_report.txt", "error": str(e)})
    # Also download the originally uploaded file to verify round-trip
    if uploaded_file_id and upload_session_id:
        try:
            content = client.download_file(session_id=upload_session_id, file_id=uploaded_file_id, entity_id=entity_id)
            downloaded_targets.append({
                "type": upload_filename,
                "sha256": sha256_bytes(content),
                "size": len(content),
            })
        except Exception as e:
            downloaded_targets.append({
                "type": upload_filename,
                "error": str(e),
            })
    result["downloads"] = downloaded_targets

    return result


def main() -> None:
    # Configuration from environment variables
    librechat_key = os.environ.get("LIBRECHAT_CODE_API_KEY")
    librechat_base = os.environ.get("LIBRECHAT_CODE_BASEURL", DEFAULT_LIBRECHAT_BASE)
    custom_key = os.environ.get("CUSTOM_CODE_API_KEY")
    custom_base = os.environ.get("CUSTOM_CODE_BASEURL")
    entity_id = os.environ.get("ENTITY_ID", "asst_compare_test_01")
    timeout = int(os.environ.get("API_TIMEOUT", "90"))
    run_librechat = librechat_key is not None
    run_custom = custom_base is not None and custom_key is not None

    if not run_librechat and not run_custom:
        print("Error: No API credentials configured.", file=sys.stderr)
        print("Set environment variables:", file=sys.stderr)
        print("  LIBRECHAT_CODE_API_KEY - for LibreChat API", file=sys.stderr)
        print("  CUSTOM_CODE_API_KEY + CUSTOM_CODE_BASEURL - for custom API", file=sys.stderr)
        sys.exit(1)

    upload_filename = "hello_compare.txt"
    upload_bytes = (f"Hello LibreChat Code API compare at {int(time.time())}\n").encode("utf-8")

    results: List[Dict[str, Any]] = []

    if run_librechat and librechat_key:
        lc_client = ApiClient(librechat_base, librechat_key, timeout=timeout)
        try:
            results.append(run_workflow(lc_client, label="librechat", entity_id=entity_id, upload_filename=upload_filename, upload_bytes=upload_bytes))
        except Exception as e:
            results.append({"label": "librechat", "error": str(e), "error_stage": "unknown"})

    if run_custom and custom_base and custom_key:
        custom_client = ApiClient(custom_base, custom_key, timeout=timeout)
        try:
            results.append(run_workflow(custom_client, label="custom", entity_id=entity_id, upload_filename=upload_filename, upload_bytes=upload_bytes))
        except Exception as e:
            results.append({"label": "custom", "error": str(e), "error_stage": "unknown"})

    # Print results and diff if both are present
    print("\n=== RAW RESULTS ===")
    print(json.dumps(results, indent=2))

    if len(results) == 2 and not results[0].get("error") and not results[1].get("error"):
        a = results[0]
        b = results[1]
        # Compare upload summaries
        up_diff = diff_dicts(a.get("upload_summary"), b.get("upload_summary"), path="upload")
        # Compare normalized exec
        ex_diff = diff_dicts(a.get("exec_normalized"), b.get("exec_normalized"), path="exec")
        # Compare download types and sizes
        dl_diff = diff_dicts(a.get("downloads"), b.get("downloads"), path="downloads")
        env_diff = None
        if a.get("env_report") and b.get("env_report"):
            env_diff = diff_env_reports(a["env_report"], b["env_report"])
        comparison = {
            "upload_diff": up_diff,
            "exec_diff": ex_diff,
            "downloads_diff": dl_diff,
            "env_report_diff": env_diff,
        }
        print("\n=== COMPARISON DIFF ===")
        print(json.dumps(comparison, indent=2))
    else:
        print("\nSkipping diff: need two successful results.")


if __name__ == "__main__":
    main()
