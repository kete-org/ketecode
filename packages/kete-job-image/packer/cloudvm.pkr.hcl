# Kete-owned. Provider images for the VM-per-job job hosts (kete-code-platform ADR 0023 rule 18;
# kete-code-platform docs/integrations/{gcp,digitalocean,hetzner,oci}-jobs.md "Image build").
# Moved here from kete-code-platform infra/packer/cloudvm/ (P7); packages/kete-job-image/README.md
# "Provider images (cloudvm)" is the runbook.
#
# One base disk per release and architecture, built by scripts/build-disk.sh from the release's
# cosign-verified job image (by index digest), Kete's cloudvm kernel and kete-job-init as PID 1,
# with no SSH server, cloud-init, guest agent, password or key. Each build here checks that disk's
# manifest against job_image (scripts/convert-disk.sh), converts it to the provider's upload format
# and imports it as an image whose description (GCP, DigitalOcean, Hetzner) or free-form tag (OCI)
# records `kete-job-image=sha256:<index digest>` exactly as the platform's adapters check
# (IMAGE_DIGEST_MARKER; OCI: freeformTags.kete_job_image) before every create.
#
# Usage (CI: .github/workflows/kete-cloudvm-images.yml, with the provider's image-builder
# credential only):
#   packer init packages/kete-job-image/packer
#   packer build -only='gcp.*' -var job_image=ghcr.io/kete-org/kete-job@sha256:<digest> \
#     -var disk_dir=<build-disk.sh --out> -var arch=amd64 \
#     -var gcp_project=<jobs project> -var gcp_bucket=<staging bucket> packages/kete-job-image/packer

packer {
  required_version = ">= 1.11.0"
  # Exact plugin versions (packer init verifies each release's checksums); bump deliberately.
  required_plugins {
    googlecompute = { source = "github.com/hashicorp/googlecompute", version = "= 1.2.7" }
    digitalocean  = { source = "github.com/digitalocean/digitalocean", version = "= 1.4.1" }
    hcloud        = { source = "github.com/hetznercloud/hcloud", version = "= 1.8.1" }
  }
}

variable "job_image" {
  type        = string
  description = "The release's job image by index digest: ghcr.io/kete-org/kete-job@sha256:<64 hex>."
  validation {
    condition     = can(regex("^ghcr\\.io/kete-org/kete-job@sha256:[0-9a-f]{64}$", var.job_image))
    error_message = "The job_image must be ghcr.io/kete-org/kete-job pinned by sha256 digest."
  }
}

variable "arch" {
  type        = string
  description = "The disk's architecture: amd64 or arm64 (the provider's machine type must match)."
  default     = "amd64"
  validation {
    condition     = contains(["amd64", "arm64"], var.arch)
    error_message = "The arch must be amd64 or arm64."
  }
}

variable "disk_dir" {
  type        = string
  description = "build-disk.sh's --out: kete-cloudvm-<arch>.raw and kete-cloudvm-<arch>.json."
}

variable "image_name" {
  type    = string
  default = "kete-cloudvm"
}

variable "gcp_project" {
  type    = string
  default = ""
}

variable "gcp_bucket" {
  type    = string
  default = ""
}

variable "do_spaces_bucket" {
  type    = string
  default = ""
}

variable "do_spaces_region" {
  type    = string
  default = "ams3"
}

variable "do_regions" {
  type    = list(string)
  default = []
}

variable "hcloud_location" {
  type    = string
  default = "fsn1"
}

variable "hcloud_server_type" {
  type        = string
  description = "The temporary build server; empty picks cx22 (amd64) or cax11 (arm64)."
  default     = ""
}

locals {
  digest = regex("sha256:[0-9a-f]{64}$", var.job_image)
  short  = substr(replace(local.digest, "sha256:", ""), 0, 12)
  name   = "${var.image_name}-${var.arch}-${local.short}"
  # The adapters look for `kete-job-image=sha256:<64 hex>` delimited by whitespace.
  description = "Kete Code cloud job VM (cloudvm ${var.arch}) kete-job-image=${local.digest}"
  output      = "${path.root}/output"
  convert_env = [
    "DISK_DIR=${var.disk_dir}",
    "ARCH=${var.arch}",
    "JOB_IMAGE=${var.job_image}",
    "OUT=${local.output}",
  ]
  hcloud_type = var.hcloud_server_type != "" ? var.hcloud_server_type : (var.arch == "arm64" ? "cax11" : "cx22")
}

source "null" "disk" {
  communicator = "none"
}

# Hetzner Cloud has no image import: a temporary server boots the rescue system, the disk is
# written over its root disk, and the server is snapshotted. Packer's SSH session (a temporary key)
# is with the rescue system only, which is not on the disk and goes with the build server.
source "hcloud" "disk" {
  image         = "ubuntu-24.04"
  location      = var.hcloud_location
  server_type   = local.hcloud_type
  rescue        = "linux64"
  ssh_username  = "root"
  snapshot_name = local.description
  snapshot_labels = {
    kete_image = local.name
  }
}

build {
  name    = "gcp"
  sources = ["source.null.disk"]
  provisioner "shell-local" {
    environment_vars = concat(local.convert_env, ["FORMAT=gcp"])
    script           = "${path.root}/scripts/convert-disk.sh"
  }
  post-processors {
    post-processor "artifice" {
      files = ["${local.output}/disk.raw.tar.gz"]
    }
    post-processor "googlecompute-import" {
      project_id              = var.gcp_project
      bucket                  = var.gcp_bucket
      image_name              = local.name
      image_description       = local.description
      image_architecture      = var.arch == "arm64" ? "arm64" : "x86_64"
      image_guest_os_features = ["UEFI_COMPATIBLE", "VIRTIO_SCSI_MULTIQUEUE", "GVNIC"]
      skip_clean              = false
    }
  }
}

build {
  name    = "digitalocean"
  sources = ["source.null.disk"]
  provisioner "shell-local" {
    environment_vars = concat(local.convert_env, ["FORMAT=raw.gz"])
    script           = "${path.root}/scripts/convert-disk.sh"
  }
  post-processors {
    post-processor "artifice" {
      files = ["${local.output}/disk.raw.gz"]
    }
    post-processor "digitalocean-import" {
      spaces_region      = var.do_spaces_region
      space_name         = var.do_spaces_bucket
      image_name         = local.name
      image_description  = local.description
      image_distribution = "Unknown"
      image_regions      = var.do_regions
    }
  }
}

build {
  name    = "hetzner"
  sources = ["source.hcloud.disk"]
  provisioner "shell-local" {
    environment_vars = concat(local.convert_env, ["FORMAT=raw.xz"])
    script           = "${path.root}/scripts/convert-disk.sh"
  }
  provisioner "file" {
    source      = "${local.output}/disk.raw.xz"
    destination = "/tmp/disk.raw.xz"
  }
  provisioner "shell" {
    inline = [
      "set -eu",
      "xz -dc /tmp/disk.raw.xz | dd of=/dev/sda bs=4M conv=fsync status=none",
      "sync",
    ]
  }
}

# OCI: no maintained Packer import post-processor; the QCOW2 is imported with the OCI CLI from
# Object Storage (paravirtualized launch mode) and tagged with the job image digest.
build {
  name    = "oci"
  sources = ["source.null.disk"]
  provisioner "shell-local" {
    environment_vars = concat(local.convert_env, ["FORMAT=qcow2"])
    script           = "${path.root}/scripts/convert-disk.sh"
  }
  post-processor "shell-local" {
    environment_vars = ["IMAGE_NAME=${local.name}", "IMAGE_DIGEST=${local.digest}", "DISK=${local.output}/disk.qcow2"]
    script           = "${path.root}/scripts/oci-import.sh"
  }
}
