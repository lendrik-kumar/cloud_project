#!/usr/bin/env bash
# Create (or promote) a teacher login in the CloudAttend Cognito user pool.
# Cognito e-mails the new user a temporary password; they choose a new one at first sign-in.
#
#   scripts/create-teacher.sh teacher@example.com
set -euo pipefail

EMAIL="${1:?usage: scripts/create-teacher.sh <email>}"
REGION="${AWS_REGION:-ap-south-1}"
STACK="${STACK:-CloudAttendStack}"

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

POOL_ID="$(output UserPoolId)"
WEB_URL="$(output WebUrl)"

if aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$EMAIL" >/dev/null 2>&1; then
  echo "User $EMAIL already exists; adding to the teacher group."
else
  aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" \
    --username "$EMAIL" --desired-delivery-mediums EMAIL \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true >/dev/null
  echo "Created $EMAIL. Cognito has e-mailed a temporary password."
fi

aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --group-name teacher
echo "$EMAIL is a teacher. Sign in at $WEB_URL"
