#!/usr/bin/env bash
# VIVENTIUM START
# Purpose: Fast, repeatable LibreCodeInterpreter local smoke test (health + exec + file upload/download).
# Why: Keep verification simple and deterministic after upstream syncs or execution image rebuilds.
# Usage:
#   cd viventium/services/librecodeinterpreter
#   ./scripts/viv_smoke.sh
# VIVENTIUM END

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f ".env" ]]; then
  API_KEY="$(awk -F= '/^API_KEY=/{print $2}' .env)"
else
  API_KEY="${API_KEY:-}"
fi

if [[ -z "${API_KEY}" ]]; then
  echo "ERROR: API_KEY not found. Put it in .env or export API_KEY."
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:8001}"

echo "== health =="
curl -sS "${BASE_URL}/health" | python -m json.tool
echo

echo "== exec (python imports) =="
cat > /tmp/viv_ci_imports.json <<'JSON'
{
  "lang": "py",
  "user_id": "viv-smoke",
  "code": "import duckdb\nimport mplfinance\nimport pandas_ta\nimport arch\nimport pmdarima\nimport statsforecast\nimport tsfresh\nimport fitz\nimport img2pdf\nimport markdown\nimport markdown_it\nimport mdit_py_plugins\nimport weasyprint\nimport xhtml2pdf\nimport md2docx_python\nimport asyncpg\nimport psycopg2\nimport pymongo\nimport textstat\nimport langdetect\nprint('imports ok')\n"
}
JSON

curl -sS -X POST "${BASE_URL}/exec" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/viv_ci_imports.json | python -m json.tool
echo

echo "== upload =="
echo "hello ci" > /tmp/viv_ci_upload_test.txt
UPLOAD_RES="$(curl -sS -X POST "${BASE_URL}/upload" \
  -H "x-api-key: ${API_KEY}" \
  -F "file=@/tmp/viv_ci_upload_test.txt" \
  -F "entity_id=viv-smoke")"
echo "${UPLOAD_RES}" | python -m json.tool
echo

echo "== exec (write output file) =="
cat > /tmp/viv_ci_write_file.json <<'JSON'
{
  "lang": "py",
  "user_id": "viv-smoke",
  "code": "with open('viv_smoke_output.txt','w') as f: f.write('hi from ci')\nprint('wrote file')\n"
}
JSON

WRITE_RES="$(curl -sS -X POST "${BASE_URL}/exec" \
  -H "x-api-key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/viv_ci_write_file.json)"
echo "${WRITE_RES}" | python -m json.tool

SESSION_ID="$(python -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' <<<"${WRITE_RES}")"
FILE_ID="$(python -c 'import json,sys; d=json.load(sys.stdin); f=d.get("files") or []; print((f[0] or {}).get("id","") if f else "")' <<<"${WRITE_RES}")"

if [[ -z "${SESSION_ID}" || -z "${FILE_ID}" ]]; then
  echo "ERROR: did not get session_id/file id from exec response"
  exit 1
fi

echo
echo "== download (verify content) =="
curl -sS -H "x-api-key: ${API_KEY}" "${BASE_URL}/download/${SESSION_ID}/${FILE_ID}" | head
echo
echo

echo "SMOKE PASS"
