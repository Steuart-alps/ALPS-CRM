#!/bin/sh
# Saves a copy of everything in ALPS CRM to this Mac. Run it by hand, or let
# launchd run it each night (see README.md, "Nightly copy on the Mac").
#
#   CRM_URL      the CRM's address, e.g. https://crm.alpsconsultancy.co.uk
#   BACKUP_TOKEN copied from the CRM's Environment page on Render
set -eu
: "${CRM_URL:?set CRM_URL}"
: "${BACKUP_TOKEN:?set BACKUP_TOKEN}"
DIR="${BACKUP_DIR:-$HOME/Documents/ALPS CRM backups}"
mkdir -p "$DIR"
FILE="$DIR/alps-crm-$(date +%Y-%m-%d).json"
curl -fsS -H "Authorization: Bearer $BACKUP_TOKEN" "$CRM_URL/export/backup.json" -o "$FILE.part"
mv "$FILE.part" "$FILE"
# Keep the last 60 copies.
ls -1t "$DIR"/alps-crm-*.json 2>/dev/null | tail -n +61 | while read -r old; do rm -f "$old"; done
echo "Saved $FILE"
