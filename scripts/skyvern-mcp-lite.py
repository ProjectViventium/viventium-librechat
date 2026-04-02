#!/usr/bin/env python3
# === VIVENTIUM START ===
# Skyvern MCP lightweight server.
# Purpose: Provide Skyvern MCP tools without the full Skyvern SDK (Playwright,
#          Pandas, etc.) to keep Alpine builds lightweight and reliable.
# Notes:
#  - Uses direct HTTP calls to Skyvern API (/v1/run/tasks).
#  - Normalizes app_url when API returns localhost, using SKYVERN_APP_URL.
#  - Intended for Azure Container Apps where full SDK install is brittle.
# === VIVENTIUM END ===
from __future__ import annotations

import os
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import FastMCP

MCP_NAME = "Skyvern"
DEFAULT_TIMEOUT_SECONDS = 300.0

mcp = FastMCP(MCP_NAME)


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def _normalize_base_url(raw: str) -> str:
    base = raw.strip()
    if not base:
        raise RuntimeError("SKYVERN_BASE_URL is not set")
    return base.rstrip("/")


def _candidate_task_urls(base_url: str) -> list[str]:
    base = base_url.rstrip("/")
    if base.endswith("/api/v1"):
        return [f"{base}/run/tasks"]
    if base.endswith("/api"):
        return [f"{base}/v1/run/tasks"]
    return [f"{base}/v1/run/tasks", f"{base}/api/v1/run/tasks"]


def _candidate_run_urls(base_url: str, run_id: str) -> list[str]:
    base = base_url.rstrip("/")
    if base.endswith("/api/v1"):
        return [f"{base}/runs/{run_id}"]
    if base.endswith("/api"):
        return [f"{base}/v1/runs/{run_id}"]
    return [f"{base}/v1/runs/{run_id}", f"{base}/api/v1/runs/{run_id}"]


def _replace_localhost_app_url(app_url: Optional[str]) -> Optional[str]:
    if not app_url:
        return None
    parsed = urlparse(app_url)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return app_url
    base = os.environ.get("SKYVERN_APP_URL", "").strip()
    if not base:
        return app_url
    return f"{base.rstrip('/')}{parsed.path}"


def _build_task_url(run_id: Optional[str], app_url: Optional[str]) -> Optional[str]:
    normalized = _replace_localhost_app_url(app_url)
    if normalized:
        return normalized
    base = os.environ.get("SKYVERN_APP_URL", "").strip()
    if not base or not run_id:
        return normalized
    base = base.rstrip("/")
    if run_id.startswith("wr_"):
        return f"{base}/runs/{run_id}/overview"
    return f"{base}/tasks/{run_id}/actions"


async def _post_task(payload: dict[str, Any]) -> dict[str, Any]:
    base_url = _normalize_base_url(_env("SKYVERN_BASE_URL"))
    api_key = _env("SKYVERN_API_KEY")
    timeout = float(os.environ.get("SKYVERN_MCP_TIMEOUT", DEFAULT_TIMEOUT_SECONDS))
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "x-user-agent": "skyvern-mcp-lite",
    }
    last_error: Optional[Exception] = None
    tried_urls: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for url in _candidate_task_urls(base_url):
            tried_urls.append(url)
            try:
                response = await client.post(url, json=payload, headers=headers)
                if response.status_code == 404:
                    last_error = httpx.HTTPStatusError(
                        f"Skyvern endpoint not found: {url}",
                        request=response.request,
                        response=response,
                    )
                    continue
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # pragma: no cover - pass through MCP error
                last_error = exc
    # Enhanced error message with debug info
    raise RuntimeError(
        f"Skyvern API request failed: {last_error}. "
        f"Tried URLs: {tried_urls}. "
        f"Base URL was: {base_url}. "
        f"API Key starts with: {api_key[:20] if api_key else 'NONE'}..."
    )


async def _get_run(run_id: str) -> dict[str, Any]:
    base_url = _normalize_base_url(_env("SKYVERN_BASE_URL"))
    api_key = _env("SKYVERN_API_KEY")
    timeout = float(os.environ.get("SKYVERN_MCP_TIMEOUT", DEFAULT_TIMEOUT_SECONDS))
    headers = {
        "accept": "application/json",
        "x-api-key": api_key,
        "x-user-agent": "skyvern-mcp-lite",
    }
    last_error: Optional[Exception] = None
    tried_urls: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for url in _candidate_run_urls(base_url, run_id):
            tried_urls.append(url)
            try:
                response = await client.get(url, headers=headers)
                if response.status_code == 404:
                    last_error = httpx.HTTPStatusError(
                        f"Skyvern endpoint not found: {url}",
                        request=response.request,
                        response=response,
                    )
                    continue
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # pragma: no cover - pass through MCP error
                last_error = exc
    raise RuntimeError(
        f"Skyvern API request failed: {last_error}. "
        f"Tried URLs: {tried_urls}. "
        f"Base URL was: {base_url}. "
        f"API Key starts with: {api_key[:20] if api_key else 'NONE'}..."
    )


@mcp.tool()
async def skyvern_run_task(prompt: str, url: str) -> dict[str, Any]:
    """Run a Skyvern browser task via API and return output + UI link."""
    payload = {"prompt": prompt, "url": url}
    data = await _post_task(payload)
    run_id = data.get("run_id") or data.get("runId")
    app_url = data.get("app_url") or data.get("appUrl")
    task_url = _build_task_url(run_id, app_url)
    return {"output": data.get("output"), "task_url": task_url, "run_id": run_id}


@mcp.tool()
async def skyvern_get_run(run_id: str) -> dict[str, Any]:
    """Fetch Skyvern run status/progress by run_id."""
    data = await _get_run(run_id)
    resolved_run_id = data.get("run_id") or data.get("runId") or run_id
    app_url = data.get("app_url") or data.get("appUrl")
    task_url = _build_task_url(resolved_run_id, app_url)
    return {
        "run_id": resolved_run_id,
        "status": data.get("status"),
        "step_count": data.get("step_count"),
        "output": data.get("output"),
        "failure_reason": data.get("failure_reason"),
        "recording_url": data.get("recording_url"),
        "screenshot_urls": data.get("screenshot_urls"),
        "started_at": data.get("started_at"),
        "finished_at": data.get("finished_at"),
        "task_url": task_url,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
