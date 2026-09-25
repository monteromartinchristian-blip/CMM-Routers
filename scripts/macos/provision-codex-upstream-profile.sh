#!/usr/bin/env bash
set -euo pipefail

EXPECTED_VERSION="codex-cli 0.147.0"
CATALOG_URL="https://raw.githubusercontent.com/openai/codex/rust-v0.147.0/codex-rs/models-manager/models.json"

PROFILE_DIR="${CMM_ROUTER_CODEX_PROFILE_DIR:-$HOME/Library/Application Support/CMM Routers/codex-upstream}"
AUTH_SOURCE_HOME="${CMM_ROUTER_CODEX_AUTH_SOURCE_HOME:-$HOME/.codex}"
AUTH_SOURCE="$AUTH_SOURCE_HOME/auth.json"
CODEX_BIN="${CMM_ROUTER_CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
CATALOG_SOURCE_FILE="${CMM_ROUTER_CODEX_CATALOG_SOURCE_FILE:-}"

fail(){ echo "codex upstream profile: $*" >&2; exit 1; }

[[ -n "$CODEX_BIN" && -x "$CODEX_BIN" ]] || fail "codex binary is not executable"
ACTUAL_VERSION="$("$CODEX_BIN" --version 2>/dev/null || true)"
[[ "$ACTUAL_VERSION" == "$EXPECTED_VERSION" ]] \
  || fail "unsupported Codex version: expected '$EXPECTED_VERSION', got '${ACTUAL_VERSION:-unknown}'"
[[ -f "$AUTH_SOURCE" ]] || fail "subscription auth source missing: $AUTH_SOURCE"

PARENT_DIR="$(dirname "$PROFILE_DIR")"
mkdir -p "$PARENT_DIR"
chmod 700 "$PARENT_DIR" 2>/dev/null || true

TMP_DIR="$(mktemp -d "$PARENT_DIR/.codex-upstream.tmp.XXXXXX")"
BACKUP_DIR=""
cleanup(){
  rm -rf "$TMP_DIR" 2>/dev/null || true
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" && ! -d "$PROFILE_DIR" ]]; then
    mv "$BACKUP_DIR" "$PROFILE_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

chmod 700 "$TMP_DIR"
cp "$AUTH_SOURCE" "$TMP_DIR/auth.json"
chmod 600 "$TMP_DIR/auth.json"

python3 - "$TMP_DIR/auth.json" <<'PY'
from pathlib import Path
import json, sys

p=Path(sys.argv[1])
data=json.loads(p.read_text(encoding="utf-8"))

def scrub(obj):
    if isinstance(obj, dict):
        out={}
        for k,v in obj.items():
            lk=str(k).lower()
            if (
                "api_key" in lk
                or lk in {"apikey","openai_api_key","codex_api_key","azure_openai_api_key"}
            ):
                continue
            out[k]=scrub(v)
        return out
    if isinstance(obj,list):
        return [scrub(v) for v in obj]
    return obj

clean=scrub(data)
if not isinstance(clean,dict):
    raise SystemExit("AUTH_OBJECT_INVALID")
if clean.get("auth_mode") != "chatgpt":
    raise SystemExit(f"AUTH_MODE_NOT_CHATGPT={clean.get('auth_mode')!r}")
tokens=clean.get("tokens")
if not isinstance(tokens,dict) or not tokens:
    raise SystemExit("CHATGPT_SUBSCRIPTION_TOKENS_MISSING")

p.write_text(json.dumps(clean,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print("SUBSCRIPTION_AUTH_GATE=PASS")
print("API_KEY_FIELDS_STRIPPED=YES")
PY

CATALOG="$TMP_DIR/model_catalog.json"
if [[ -n "$CATALOG_SOURCE_FILE" ]]; then
  [[ -f "$CATALOG_SOURCE_FILE" ]] || fail "catalog source file missing"
  cp "$CATALOG_SOURCE_FILE" "$CATALOG"
  echo "CATALOG_SOURCE=LOCAL_FILE"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required to fetch pinned model catalog"
  curl -fL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 60 \
    "$CATALOG_URL" -o "$CATALOG"
  echo "CATALOG_SOURCE=OPENAI_GITHUB_RUST_V0_147_0"
fi
[[ -s "$CATALOG" ]] || fail "model catalog is empty"

python3 - "$CATALOG" <<'PY'
from pathlib import Path
import json, sys

p=Path(sys.argv[1])
data=json.loads(p.read_text(encoding="utf-8"))
models=data.get("models")
if not isinstance(models,list) or not models:
    raise SystemExit("MODEL_CATALOG_MODELS_INVALID")

patched=0
for m in models:
    if not isinstance(m,dict):
        continue
    m["tool_mode"]="direct"
    m["shell_type"]="disabled"
    m["supports_search_tool"]=False
    m["apply_patch_tool_type"]=None
    m["experimental_supported_tools"]=[]
    m["multi_agent_version"]=None
    patched += 1

if patched == 0:
    raise SystemExit("MODEL_CATALOG_PATCHED_COUNT=0")

p.write_text(json.dumps(data,ensure_ascii=False,separators=(",",":"))+"\n",encoding="utf-8")
print(f"MODEL_CATALOG_PATCHED_COUNT={patched}")
print("ALL_UPSTREAM_MODELS_TOOL_MODE=direct")
print("ALL_UPSTREAM_MODELS_SHELL_TYPE=disabled")
print("ALL_UPSTREAM_MODELS_SEARCH_TOOL=false")
print("ALL_UPSTREAM_MODELS_APPLY_PATCH=null")
print("ALL_UPSTREAM_MODELS_MULTI_AGENT=null")
PY
chmod 600 "$CATALOG"

python3 - "$TMP_DIR/config.toml" "$PROFILE_DIR/model_catalog.json" <<'PY'
from pathlib import Path
import json,sys

out=Path(sys.argv[1])
catalog_path=sys.argv[2]
quoted=json.dumps(catalog_path)
text=(
    f"model_catalog_json = {quoted}\n"
    'web_search = "disabled"\n\n'
    "[features]\n"
    "remote_models = false\n"
    "multi_agent = false\n"
    "code_mode = false\n"
    "code_mode_host = false\n"
    "collaboration_modes = false\n"
    "apps = false\n"
    "plugins = false\n"
    "recommended_plugins = false\n"
    "tool_suggest = false\n"
    "remote_plugin = false\n\n"
    "[agents]\n"
    "enabled = false\n\n"
    "[tools.update_plan]\n"
    "enabled = false\n"
)
out.write_text(text,encoding="utf-8")
PY
chmod 600 "$TMP_DIR/config.toml"

python3 - "$TMP_DIR/auth.json" "$CATALOG" "$TMP_DIR/config.toml" <<'PY'
from pathlib import Path
import json,sys

auth=json.loads(Path(sys.argv[1]).read_text())
cat=json.loads(Path(sys.argv[2]).read_text())
cfg=Path(sys.argv[3]).read_text()

assert auth.get("auth_mode") == "chatgpt"
assert isinstance(auth.get("tokens"),dict) and auth["tokens"]
models=cat.get("models")
assert isinstance(models,list) and models
for m in models:
    if not isinstance(m,dict):
        continue
    assert m.get("tool_mode") == "direct"
    assert m.get("shell_type") == "disabled"
    assert m.get("supports_search_tool") is False
    assert m.get("apply_patch_tool_type") is None
    assert m.get("multi_agent_version") is None
assert 'web_search = "disabled"' in cfg
assert '[agents]' in cfg and 'enabled = false' in cfg
print("PROFILE_STRUCTURAL_VALIDATION=PASS")
PY

if [[ -d "$PROFILE_DIR" ]]; then
  BACKUP_DIR="$PROFILE_DIR.previous.$$"
  mv "$PROFILE_DIR" "$BACKUP_DIR"
fi

mv "$TMP_DIR" "$PROFILE_DIR"
TMP_DIR=""

if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
  rm -rf "$BACKUP_DIR"
  BACKUP_DIR=""
fi

chmod 700 "$PROFILE_DIR"
chmod 600 "$PROFILE_DIR/auth.json" "$PROFILE_DIR/model_catalog.json" "$PROFILE_DIR/config.toml"

echo "CODEX_UPSTREAM_PROFILE=READY"
echo "CODEX_UPSTREAM_PROFILE_DIR=$PROFILE_DIR"
echo "CODEX_UPSTREAM_PROFILE_VERSION=$EXPECTED_VERSION"
echo "GLOBAL_CODEX_HOME_MUTATED=NO"
echo "PAYG_CREDENTIALS_COPIED=NO"
echo "UPSTREAM_NATIVE_SHELL=DISABLED"
echo "UPSTREAM_SEARCH=DISABLED"
echo "UPSTREAM_APPLY_PATCH=DISABLED"
echo "UPSTREAM_AGENTS=DISABLED"
