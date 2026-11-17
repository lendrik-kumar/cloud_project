#!/usr/bin/env bash
# Write web/public/config.json from the outputs of the deployed CloudAttendStack,
# so `npm run dev` in web/ talks to the real API and Cognito user pool.
#
# Usage: scripts/write-local-config.sh            (uses your default AWS profile)
#        AWS_PROFILE=uni scripts/write-local-config.sh
# Env overrides: STACK_NAME (default CloudAttendStack), AWS_REGION (default ap-south-1)
set -euo pipefail

STACK_NAME="${STACK_NAME:-CloudAttendStack}"
REGION="${AWS_REGION:-ap-south-1}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="$ROOT_DIR/web/public/config.json"

die() { echo "error: $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed (https://aws.amazon.com/cli/)."

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  die "the AWS CLI has no valid credentials. Run 'aws configure' (or 'aws sso login') first."
fi

set +e
STACK_STATUS="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>&1)"
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  if printf '%s' "$STACK_STATUS" | grep -q "does not exist"; then
    die "stack '$STACK_NAME' is not deployed in $REGION yet. Deploy it first:
    cd infra && npx cdk deploy
  then run this script again."
  fi
  die "could not read stack '$STACK_NAME' in $REGION:
$STACK_STATUS"
fi

case "$STACK_STATUS" in
  CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE | IMPORT_COMPLETE | IMPORT_ROLLBACK_COMPLETE) ;;
  UPDATE_* | IMPORT_*)
    # An existing stack keeps its previous outputs while it updates.
    echo "warning: stack '$STACK_NAME' is $STACK_STATUS; using its current outputs." >&2 ;;
  CREATE_IN_PROGRESS | REVIEW_IN_PROGRESS)
    die "stack '$STACK_NAME' is still being created ($STACK_STATUS). Wait for it to finish, then run this script again." ;;
  *)
    die "stack '$STACK_NAME' is in state $STACK_STATUS, so its outputs are not usable. Fix and redeploy it (cd infra && npx cdk deploy)." ;;
esac

OUTPUTS="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output text)"

get_output() {
  printf '%s\n' "$OUTPUTS" | awk -F '\t' -v k="$1" '$1 == k { print $2; exit }'
}

API_URL="$(get_output ApiUrl)"
USER_POOL_ID="$(get_output UserPoolId)"
CLIENT_ID="$(get_output UserPoolClientId)"
STACK_REGION="$(get_output Region)"
STACK_REGION="${STACK_REGION:-$REGION}"

MISSING=()
[ -n "$API_URL" ] || MISSING+=(ApiUrl)
[ -n "$USER_POOL_ID" ] || MISSING+=(UserPoolId)
[ -n "$CLIENT_ID" ] || MISSING+=(UserPoolClientId)
if [ ${#MISSING[@]} -gt 0 ]; then
  die "stack '$STACK_NAME' has no output(s): ${MISSING[*]}. Is the deployment finished and up to date?"
fi

# The web app joins paths onto apiUrl without a leading slash.
case "$API_URL" in */) ;; *) API_URL="$API_URL/" ;; esac

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

mkdir -p "$(dirname "$OUT_FILE")"
cat > "$OUT_FILE" <<JSON
{
  "apiUrl": "$(json_escape "$API_URL")",
  "userPoolId": "$(json_escape "$USER_POOL_ID")",
  "userPoolClientId": "$(json_escape "$CLIENT_ID")",
  "region": "$(json_escape "$STACK_REGION")"
}
JSON

echo "Wrote $OUT_FILE"
cat "$OUT_FILE"
