#!/usr/bin/env bash
# Verifies that a WebDAV endpoint (e.g. Nextcloud behind nginx) supports everything DialDeck needs.
# Usage: ./check-webdav.sh https://cloud.example.com/remote.php/dav/files/USERNAME/ USERNAME
#        (you'll be prompted for the app password; nothing is stored)
set -u
URL="${1:?WebDAV base URL}"; USER_="${2:?username}"
[[ "$URL" == */ ]] || URL="$URL/"
read -rsp "App password for $USER_: " PASS; echo
DIR="${URL}dialdeck-selftest-$$"
C=(curl -sS -o /tmp/dd-body.$$ -D /tmp/dd-head.$$ -w '%{http_code}' -u "$USER_:$PASS")
pass=0; fail=0
ok()  { echo "  ✔ $1"; pass=$((pass+1)); }
bad() { echo "  ✘ $1"; fail=$((fail+1)); }
hdr() { grep -i "^$1:" /tmp/dd-head.$$ | head -1 | cut -d' ' -f2- | tr -d '\r"'; }

echo "Checking $URL"
[[ "$URL" == https://* ]] && ok "uses HTTPS" || bad "not HTTPS — your password would cross the internet in clear text"

code=$("${C[@]}" -X PROPFIND -H 'Depth: 0' "$URL")
[[ $code == 207 ]] && ok "PROPFIND on base URL (207)" || bad "PROPFIND on base URL returned $code (401=bad credentials, 404=wrong URL, 405=proxy blocks WebDAV methods)"

code=$("${C[@]}" -X MKCOL "$DIR/")
[[ $code == 201 ]] && ok "MKCOL creates folders (201)" || bad "MKCOL returned $code"

code=$("${C[@]}" -X PUT -H 'If-None-Match: *' --data-binary '{"v":1}' "$DIR/t.json")
[[ $code == 201 || $code == 204 ]] && ok "PUT with If-None-Match ($code)" || bad "PUT returned $code"

code=$("${C[@]}" -X GET "$DIR/t.json"); etag=$(hdr etag)
[[ $code == 200 && -n "$etag" ]] && ok "GET returns ETag ($etag)" || bad "GET returned $code, ETag='${etag}' — the proxy may strip ETag headers (gzip on JSON can do this)"
[[ "$etag" == W/* ]] && bad "ETag is weak (W/...) — disable gzip for /remote.php/dav in nginx" || true

code=$("${C[@]}" -X PUT -H "If-Match: \"$etag\"" --data-binary '{"v":2}' "$DIR/t.json")
[[ $code == 204 || $code == 200 || $code == 201 ]] && ok "PUT with matching If-Match ($code)" || bad "PUT with If-Match returned $code — the proxy may strip If-Match"

code=$("${C[@]}" -X PUT -H "If-Match: \"$etag\"" --data-binary '{"v":3}' "$DIR/t.json")
[[ $code == 412 ]] && ok "stale If-Match is rejected (412) — conflict protection works" || bad "stale If-Match returned $code (expected 412)"

head -c 3000000 /dev/urandom > /tmp/dd-big.$$
code=$("${C[@]}" -X PUT --data-binary @/tmp/dd-big.$$ "$DIR/big.bin")
[[ $code == 201 || $code == 204 ]] && ok "3 MB upload accepted" || bad "3 MB upload returned $code — raise client_max_body_size in nginx"

code=$("${C[@]}" -X PROPFIND -H 'Depth: 1' "$DIR/")
[[ $code == 207 ]] && grep -q "t.json" /tmp/dd-body.$$ && ok "PROPFIND Depth 1 lists files" || bad "PROPFIND Depth 1 returned $code"

code=$("${C[@]}" -X DELETE "$DIR/")
[[ $code == 204 || $code == 200 ]] && ok "DELETE cleaned up" || bad "DELETE returned $code (remove $DIR manually)"

rm -f /tmp/dd-body.$$ /tmp/dd-head.$$ /tmp/dd-big.$$
echo; echo "$pass passed, $fail failed"
[[ $fail == 0 ]] && echo "This server is ready for DialDeck sync." || exit 1
