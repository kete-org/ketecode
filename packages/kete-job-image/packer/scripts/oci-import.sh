#!/usr/bin/env bash
# Kete-owned. Imports the cloudvm QCOW2 into OCI as a custom image tagged with the job image digest
# (ADR 0023 rule 18; ../cloudvm.pkr.hcl's oci build). Needs the OCI CLI
# configured for the jobs image builder (never the portal's launcher key) and:
#   OCI_COMPARTMENT (the jobs compartment), OCI_NAMESPACE, OCI_BUCKET, IMAGE_NAME, IMAGE_DIGEST, DISK
set -euo pipefail
: "${OCI_COMPARTMENT:?}" "${OCI_NAMESPACE:?}" "${OCI_BUCKET:?}" "${IMAGE_NAME:?}" "${IMAGE_DIGEST:?}" "${DISK:?}"
[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "IMAGE_DIGEST must be sha256:<hex>" >&2; exit 2; }

object="$IMAGE_NAME.qcow2"
oci os object put --namespace "$OCI_NAMESPACE" --bucket-name "$OCI_BUCKET" --name "$object" --file "$DISK" --force
image_id=$(oci compute image import from-object \
  --compartment-id "$OCI_COMPARTMENT" \
  --namespace "$OCI_NAMESPACE" --bucket-name "$OCI_BUCKET" --name "$object" \
  --display-name "$IMAGE_NAME" \
  --source-image-type QCOW2 --launch-mode PARAVIRTUALIZED \
  --freeform-tags "{\"kete_job_image\":\"$IMAGE_DIGEST\"}" \
  --wait-for-state AVAILABLE --query 'data.id' --raw-output)
oci os object delete --namespace "$OCI_NAMESPACE" --bucket-name "$OCI_BUCKET" --name "$object" --force
echo "OCI_JOBS_IMAGE=$image_id"
