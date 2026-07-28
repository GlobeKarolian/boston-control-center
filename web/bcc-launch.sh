#!/bin/bash
# Launch the cloud half of the Boston Newsroom Control Center.
#
# Run this from Terminal as yourself:
#
#     bash ~/Developer/bcc/web/bcc-launch.sh
#
# Safe to re-run. Every step checks before it acts. Secrets that already exist
# are reused rather than regenerated, so a second run will not lock you out of
# the dashboard or invalidate a Mac's ingest key.
#
# Why this is a script and not something Claude ran for you: six of the values
# below are credentials, and Claude does not type credentials into fields. The
# keys never leave your machine except as an encrypted env var write to your own
# Vercel project, and nothing in here prints the Anthropic or BestTime values.

set -uo pipefail

WEB="$HOME/Developer/bcc/web"
SEC="$HOME/.boston-control-center"
AUTH_USER="newsroom"

B=$'\033[1m'; R=$'\033[0m'; D=$'\033[2m'
G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'

ok()   { printf '  %sok%s %s\n'   "$G" "$R" "$*"; }
warn() { printf '  %swarn%s %s\n' "$Y" "$R" "$*"; }
die()  { printf '\n  %serror%s %s\n\n' "$E" "$R" "$*"; exit 1; }
head1() { printf '\n%s%s%s\n' "$B" "$*" "$R"; }

# ------------------------------------------------------------------ 0. sanity

head1 "0. Checks"

[ "$(id -u)" != "0" ] || die "run this as yourself, not with sudo. Vercel's CLI keeps its login in your home directory."
[ -d "$WEB" ] || die "$WEB does not exist. Is the repo somewhere else?"
command -v node >/dev/null 2>&1 || die "node is not installed."
command -v vercel >/dev/null 2>&1 || die "the vercel CLI is not installed. npm i -g vercel"
command -v openssl >/dev/null 2>&1 || die "openssl is missing, which should be impossible on macOS."

cd "$WEB" || die "cannot cd to $WEB"

WHO=$(vercel whoami 2>/dev/null)
[ -n "$WHO" ] || die "not logged in. Run: vercel login"
ok "vercel CLI $(vercel --version 2>/dev/null | head -1 | sed 's/Vercel CLI //') as $WHO"

if [ -f .vercel/project.json ]; then
  PROJ=$(node -e 'console.log(require("./.vercel/project.json").projectName)' 2>/dev/null)
  ok "linked to project $PROJ"
else
  warn "not linked yet, linking now"
  vercel link --project boston-control-center --yes >/dev/null 2>&1 \
    || die "vercel link failed. Run it by hand to see why: vercel link"
  ok "linked to boston-control-center"
fi

mkdir -p "$SEC"; chmod 700 "$SEC"

# ------------------------------------------------------------------- 1. tests

head1 "1. Tests"

if [ "${SKIP_TESTS:-0}" = "1" ]; then
  warn "skipped because SKIP_TESTS=1"
else
  if npm test >/tmp/bcc-launch-test.log 2>&1; then
    ok "$(grep -cE '^[[:space:]]+PASS' /tmp/bcc-launch-test.log) checks passed"
  else
    tail -30 /tmp/bcc-launch-test.log
    die "tests failed. Full log at /tmp/bcc-launch-test.log. Fix this before deploying, or re-run with SKIP_TESTS=1 if you know what broke."
  fi
fi

# ----------------------------------------------------------------- 2. secrets

head1 "2. Secrets"

# Three of these you invent, so generate them once and keep them on disk. The
# other two already exist because the Macs have been using them.
#
# Generated files are written with a umask that makes them unreadable by anyone
# else before any bytes land in them, rather than chmod-ing after the fact,
# which leaves a window where the file is world readable.
gen() {
  local path="$1" cmd="$2" label="$3"
  if [ -s "$path" ]; then
    ok "$label already set, reusing it"
  else
    ( umask 077; eval "$cmd" > "$path" )
    ok "$label generated, saved to $path"
    NEWLY_GENERATED="${NEWLY_GENERATED:-} $label"
  fi
}

# The viewer password on disk was pasted into a chat transcript in an earlier
# session, so it should not be the one that goes up. Offer to replace it. This
# one is safe to rotate here because it is generated locally and nothing outside
# this machine depends on its old value.
if [ -s "$SEC/.auth_pass.old" ]; then
  ok "viewer password already rotated, the exposed one is dead"
elif [ -s "$SEC/.auth_pass" ]; then
  printf '\n  %sThe viewer password in %s/.auth_pass was pasted into a chat%s\n' "$Y" "$SEC" "$R"
  printf '  %stranscript once, so treat it as public. Replace it now? [Y/n]: %s' "$Y" "$R"
  read -r ROT || true
  case "${ROT:-y}" in
    [Nn]*) warn "keeping the existing password, which is known to be exposed" ;;
    *)     mv -f "$SEC/.auth_pass" "$SEC/.auth_pass.old"
           ( umask 077; openssl rand -base64 24 | tr -d '\n' > "$SEC/.auth_pass" )
           ok "new viewer password generated, old one moved to .auth_pass.old"
           NEWLY_GENERATED="${NEWLY_GENERATED:-} AUTH_PASS" ;;
  esac
else
  gen "$SEC/.auth_pass" "openssl rand -base64 24 | tr -d '\n'" "AUTH_PASS"
fi

gen "$SEC/.cron_secret"  "openssl rand -hex 32"                 "CRON_SECRET"

# The two vendor keys also leaked, and neither can be rotated from here. They
# have to be regenerated at the vendor and rewritten into these files. This does
# not block the launch, because a leaked key still works and a dashboard nobody
# can reach is worse than one running on a key that needs replacing. It does get
# said out loud, every run, until the files change.
printf '\n  %sTwo keys that cannot be rotated from here%s\n' "$Y" "$R"
printf '  %sBoth of these were pasted into a chat transcript. Regenerate at the vendor,%s\n' "$D" "$R"
printf '  %sthen overwrite the file and re-run this script:%s\n' "$D" "$R"
printf '    console.anthropic.com  ->  %s/.anthropic_key\n' "$SEC"
printf '    besttime.app          ->  %s/.besttime_key\n' "$SEC"
printf '  %sLaunching on the current values is fine for now.%s\n' "$D" "$R"

[ -s "$SEC/.anthropic_key" ] || die "$SEC/.anthropic_key is missing or empty. Extraction and the analyst pass need it."
[ -s "$SEC/.besttime_key" ]  || warn "$SEC/.besttime_key is missing. The crowd layer will sit at 503 and the rest of the map will work."
ok "ANTHROPIC_API_KEY found on disk"
[ -s "$SEC/.besttime_key" ] && ok "BESTTIME_API_KEY_PRIVATE found on disk"

# Per-machine ingest tokens. One per Mac, so a laptop that walks out of the
# building is revoked on its own without rotating the fleet.
printf '\n  %sWhich Macs will run the agent?%s\n' "$B" "$R"
printf '  %sSpace separated names. These show up in the dashboard when a feed goes quiet.%s\n' "$D" "$R"
printf '  Names [mac-1 mac-2 mac-3]: '
read -r MACHINES || true
MACHINES="${MACHINES:-mac-1 mac-2 mac-3}"

TOKEN_JSON="{"
FIRST=1
for m in $MACHINES; do
  safe=$(printf '%s' "$m" | tr -cd 'A-Za-z0-9._-')
  [ -n "$safe" ] || continue
  tf="$SEC/.ingest_token_$safe"
  gen "$tf" "openssl rand -hex 32" "ingest token for $safe"
  tok=$(tr -d '[:space:]' < "$tf")
  [ $FIRST -eq 1 ] || TOKEN_JSON="$TOKEN_JSON,"
  TOKEN_JSON="$TOKEN_JSON\"$safe\":\"$tok\""
  FIRST=0
done
TOKEN_JSON="$TOKEN_JSON}"
[ "$TOKEN_JSON" != "{}" ] || die "no valid machine names given, so there is no ingest table to write."

# ------------------------------------------------------------------- 3. Redis

head1 "3. Redis"

# Vercel KV was retired at the end of 2024 and auto-migrated to Upstash. First
# party storage is now Blob and Edge Config only, so Redis comes from the
# marketplace. Without it every write goes to process memory and is lost on the
# next request, which lands on a different machine.
have_redis() {
  vercel env ls production 2>/dev/null \
    | grep -qE 'KV_REST_API_URL|UPSTASH_REDIS_REST_URL|REDIS_REST_URL'
}

if have_redis; then
  ok "Redis env vars already present"
else
  printf '  %sProvisioning Upstash Redis. Pick the free plan unless you have a reason not to.%s\n' "$D" "$R"
  printf '  %sThis app stores a venue TTL map, bike dock history and rendered output. Free is plenty.%s\n\n' "$D" "$R"
  vercel install upstash
  if have_redis; then
    ok "Redis provisioned and connected"
  else
    die "Upstash did not attach KV_REST_API_URL to production. Check the Storage tab of the project in the dashboard, then re-run this script."
  fi
fi

# -------------------------------------------------------------- 4. env vars

head1 "4. Environment"

# vercel env add reads the value from stdin when stdin is not a terminal, which
# is how every secret below crosses over without ever appearing in a shell
# history, a process list, or this script's output.
setenv() {
  local name="$1" file="$2" required="$3"
  if [ ! -s "$file" ]; then
    if [ "$required" = "required" ]; then
      die "$name has no source file at $file"
    fi
    warn "$name skipped, no $file"
    return 0
  fi
  vercel env rm "$name" production --yes >/dev/null 2>&1
  if tr -d '\n' < "$file" | vercel env add "$name" production >/dev/null 2>&1; then
    ok "$name set"
  else
    die "$name failed to set. Try by hand: vercel env add $name production"
  fi
}

setenv AUTH_PASS                  "$SEC/.auth_pass"      required
setenv CRON_SECRET                "$SEC/.cron_secret"    required
setenv ANTHROPIC_API_KEY          "$SEC/.anthropic_key"  required
setenv BESTTIME_API_KEY_PRIVATE   "$SEC/.besttime_key"   optional

vercel env rm AUTH_USER production --yes >/dev/null 2>&1
printf '%s' "$AUTH_USER" | vercel env add AUTH_USER production >/dev/null 2>&1 \
  && ok "AUTH_USER set to $AUTH_USER"

vercel env rm INGEST_TOKENS production --yes >/dev/null 2>&1
if printf '%s' "$TOKEN_JSON" | vercel env add INGEST_TOKENS production >/dev/null 2>&1; then
  ok "INGEST_TOKENS set, $(printf '%s' "$MACHINES" | wc -w | tr -d ' ') machine(s)"
else
  die "INGEST_TOKENS failed to set."
fi

# A deploy with no AUTH_PASS puts the whole dashboard on the open internet.
# Refuse rather than warn.
vercel env ls production 2>/dev/null | grep -q 'AUTH_PASS' \
  || die "AUTH_PASS is not on the project. Refusing to deploy, because without it the dashboard is public."
ok "AUTH_PASS confirmed present, the site will be password protected"

# -------------------------------------------------------------- 5. deploy

head1 "5. Deploy"

printf '  %sBuilding and shipping to production. This takes a couple of minutes.%s\n\n' "$D" "$R"
DEPLOY_LOG=/tmp/bcc-launch-deploy.log
if ! vercel --prod 2>&1 | tee "$DEPLOY_LOG"; then
  die "deploy failed. Log at $DEPLOY_LOG"
fi

URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' "$DEPLOY_LOG" | tail -1)
[ -n "$URL" ] || die "deployed, but could not find the URL in the output. Check $DEPLOY_LOG"
ok "live at $URL"

# -------------------------------------------------------------- 6. verify

head1 "6. Verify"

PASS=$(tr -d '[:space:]' < "$SEC/.auth_pass")

printf '  waiting for the first cold start '
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/healthz" 2>/dev/null)
  [ "$code" = "200" ] && break
  printf '.'; sleep 3
done
printf '\n'
[ "$code" = "200" ] && ok "/api/healthz answered 200" || warn "/api/healthz returned $code, the first request after a deploy is sometimes slow"

printf '\n  %s/api/status%s %s(presence only, never values)%s\n' "$B" "$R" "$D" "$R"
curl -s -u "$AUTH_USER:$PASS" "$URL/api/status" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2).split("\n").map(l=>"    "+l).join("\n"))}catch(e){console.log("    "+s.slice(0,600))}})'

UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state" 2>/dev/null)
if [ "$UNAUTH" = "401" ]; then
  ok "unauthenticated reads are refused"
else
  warn "an unauthenticated /api/state returned $UNAUTH, expected 401. Check AUTH_PASS actually took."
fi

# --------------------------------------------------------------- what's next

head1 "Done"

printf '  Dashboard   %s%s%s\n' "$B" "$URL" "$R"
printf '  Username    %s\n' "$AUTH_USER"
printf '  Password    %sin %s/.auth_pass%s\n' "$D" "$SEC" "$R"
printf '\n'
printf '  %sTo see the password:%s  cat %s/.auth_pass\n' "$D" "$R" "$SEC"
printf '\n'
printf '  %sNext, on each spare Mac:%s\n' "$B" "$R"
printf '    1. Copy over BCC-Agent-1.0.0.pkg, right-click, Open, approve the unsigned build.\n'
printf '    2. Run  bcc-setup  in Terminal as yourself.\n'
printf '    3. Give it the dashboard URL above and that machine%ss ingest token.\n' "'"
printf '\n'
for m in $MACHINES; do
  safe=$(printf '%s' "$m" | tr -cd 'A-Za-z0-9._-')
  [ -n "$safe" ] && printf '       %s%-16s%s cat %s/.ingest_token_%s\n' "$B" "$safe" "$R" "$SEC" "$safe"
done
printf '\n'
if [ -n "${NEWLY_GENERATED:-}" ]; then
  printf '  %sGenerated this run:%s%s\n' "$Y" "$R" "$NEWLY_GENERATED"
  printf '  %sAll of it is on disk in %s at mode 600. Nothing is printed here on purpose.%s\n' "$D" "$SEC" "$R"
  printf '\n'
fi
printf '  %sThe map will be empty of incidents until a Mac starts sending. The crowd%s\n' "$D" "$R"
printf '  %slayer fills in on its own within a few minutes as the crons fire.%s\n' "$D" "$R"
printf '\n'
