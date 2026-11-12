#!/usr/bin/env bash
# scripts/macos-signing.sh — generate a stable self-signed certificate for the
# macOS release builds (DESIGN.md §9, D14).
#
# Why: macOS's TCC ("Files and Folders") permission store ties a folder grant to
# the app's code-signing identity. An unsigned or ad-hoc build gets a new
# cdhash on every rebuild, so TCC treats each rebuild as a new app and re-prompts
# on save. A stable self-signed certificate keeps that identity stable.
#
# The app is still NOT notarized, so the "unidentified developer" workaround
# (right-click → Open) still applies. This is a *stability* fix, not a
# "trusted publisher" fix.
#
# Usage:
#   ./scripts/macos-signing.sh            # generate ./macos-signing/
#   ./scripts/macos-signing.sh --out DIR  # generate into DIR
#   ./scripts/macos-signing.sh --force    # overwrite an existing certificate
#
# Output: DIR/certificate.p12, DIR/certificate.pem, DIR/key.pem
# Also DIR/certificate.p12.b64 and DIR/password.txt, the two values the release
# workflow needs. Then set the two repository secrets:
#   APPLE_CERTIFICATE           base64 of the .p12
#   APPLE_CERTIFICATE_PASSWORD  the password
#
# The script is idempotent: it refuses to overwrite an existing certificate
# unless --force is passed.

set -euo pipefail

IDENTITY="${IDENTITY:-CircuitSim++ Self-Signed}"
PASSWORD="${PASSWORD:-}"
OUT="${OUT:-$(pwd)/macos-signing}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      echo "run $0 --help" >&2
      exit 2
      ;;
  esac
done

command -v openssl >/dev/null 2>&1 || {
  echo "error: openssl is required (install it with your package manager)" >&2
  exit 1
}

P12="$OUT/certificate.p12"
if [ -e "$P12" ] && [ "$FORCE" -ne 1 ]; then
  echo "error: $P12 already exists; pass --force to overwrite" >&2
  exit 1
fi

# A fresh password is generated once per certificate; the release workflow needs
# the same password to import the .p12, so print it to stderr.
if [ -z "$PASSWORD" ]; then
  PASSWORD="$(openssl rand -hex 16)"
fi

mkdir -p "$OUT"
umask 077

# 10 years is plenty for a semester course; the key is only used for the
# release build, not for anything else.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$OUT/key.pem" \
  -out "$OUT/certificate.pem" \
  -subj "/CN=$(printf '%s' "$IDENTITY" | sed 's/+/\\+/g')" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  >/dev/null 2>&1

openssl pkcs12 -export \
  -inkey "$OUT/key.pem" \
  -in "$OUT/certificate.pem" \
  -out "$P12" \
  -passout "pass:$PASSWORD" \
  >/dev/null 2>&1

# The two values the release workflow needs, written to files so the setup can
# be scripted without copying them out of the terminal. The directory is 0700
# (umask) and the files are 0600.
base64 < "$P12" | tr -d '\n' > "$OUT/certificate.p12.b64"
printf '%s\n' "$PASSWORD" > "$OUT/password.txt"
chmod 600 "$OUT/certificate.p12.b64" "$OUT/password.txt"

echo "wrote $P12" >&2
echo "identity: $IDENTITY" >&2
echo "password: $PASSWORD" >&2
echo "APPLE_CERTIFICATE (base64):" >&2
base64 < "$P12" | tr -d '\n'
echo >&2
