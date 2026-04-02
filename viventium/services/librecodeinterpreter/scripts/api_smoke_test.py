#!/usr/bin/env python3
import os
import sys
import time
import json
from typing import Dict, Any, List

import requests

API_BASE = os.environ.get("API_BASE", "http://localhost:8000")
API_KEY = os.environ.get("API_KEY", "test-api-key-for-development-only")
TIMEOUT = int(os.environ.get("API_TIMEOUT", "45"))

LANG_SNIPPETS: Dict[str, str] = {
	"c": "#include <stdio.h>\nint main(){int s=0; for(int i=1;i<=10;i++) s+=i; printf(\"c: sum(1..10)=%d\\n\", s); return 0;}",
	"cpp": "#include <iostream>\nint main(){int s=0; for(int i=1;i<=10;i++) s+=i; std::cout << \"cpp: sum(1..10)=\" << s << std::endl; return 0;}",
	"java": "public class Code { public static void main(String[] args){ int s=0; for(int i=1;i<=10;i++) s+=i; System.out.println(\"java: sum(1..10)=\"+s); } }",
	"php": "<?php $s=0; for($i=1;$i<=10;$i++){ $s+=$i; } echo \"php: sum(1..10)=$s\\n\";",
	"rs": "fn main(){ let mut s = 0; for i in 1..=10 { s += i; } println!(\"rs: sum(1..10)={}\", s); }",
	"go": "package main\n\nimport (\n\t\"fmt\"\n)\n\nfunc main() {\n\ts := 0\n\tfor i := 1; i <= 10; i++ {\n\t\ts += i\n\t}\n\tfmt.Printf(\"go: sum(1..10)=%d\\n\", s)\n}",
	"d": "import std.stdio;\nvoid main(){ int s=0; foreach(i; 1..11) s+=i; writeln(\"d: sum(1..10)=\", s); }",
	"f90": "program sum\n  integer :: s, i\n  s = 0\n  do i = 1, 10\n     s = s + i\n  end do\n  print *, \"f90: sum(1..10)=\", s\nend program sum\n",
}

HEADERS = {
	"x-api-key": API_KEY,
	"Content-Type": "application/json",
}


def post_exec(lang: str, code: str) -> Dict[str, Any]:
	url = f"{API_BASE}/exec"
	payload = {"code": code, "lang": lang, "user_id": "smoke-tester"}
	try:
		resp = requests.post(url, headers=HEADERS, data=json.dumps(payload), timeout=TIMEOUT)
		return {
			"status_code": resp.status_code,
			"ok": resp.ok,
			"body": (resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"raw": resp.text}),
		}
	except Exception as e:
		return {"status_code": None, "ok": False, "error": str(e)}


def main() -> int:
	print(f"API base: {API_BASE}")
	results: List[Dict[str, Any]] = []

	for lang, code in LANG_SNIPPETS.items():
		print(f"\n=== Testing {lang} ===")
		res = post_exec(lang, code)
		results.append({"lang": lang, **res})
		if res.get("ok") and isinstance(res.get("body"), dict):
			stdout = res["body"].get("stdout", "").strip()
			stderr = res["body"].get("stderr", "").strip()
			print(f"status={res['status_code']} ok={res['ok']}")
			print(f"stdout: {stdout if stdout else '<empty>'}")
			print(f"stderr: {stderr if stderr else '<empty>'}")
		else:
			print(f"status={res['status_code']} ok={res['ok']} error={res.get('error')}")

	# Summarize
	print("\n=== Summary ===")
	failures = 0
	for r in results:
		lang = r["lang"]
		ok = r.get("ok", False)
		status = r.get("status_code")
		stderr = ""
		if ok and isinstance(r.get("body"), dict):
			stderr = (r["body"].get("stderr", "") or "").strip()
		elif not ok:
			stderr = r.get("error") or json.dumps(r.get("body"))
		line = f"{lang}: {'OK' if ok else 'FAIL'} (status={status})"
		if stderr:
			line += f" — {stderr.splitlines()[0][:200]}"
		print(line)
		if not ok:
			failures += 1

	# Exit non-zero if any failed
	return 0 if failures == 0 else 1


if __name__ == "__main__":
	sys.exit(main())
