param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$Zone,

  [Parameter(Mandatory = $true)]
  [string]$InstanceName,

  [string]$MachineType = "e2-micro",
  [string]$BootDiskSize = "20GB",
  [string]$ImageProject = "ubuntu-os-cloud",
  [string]$ImageFamily = "ubuntu-2204-lts",
  [string]$NetworkTag = "ivucx-helper",
  [string]$StaticIp = "",
  [string]$RepoUrl = "https://github.com/user-it0/nodejs.git",
  [string]$RepoRef = "main",
  [string]$StartupScriptPath = "deploy/gce/startup-script.sh",
  [string]$RuntimeEnvPath = "deploy/gce/.env.runtime"
)

$ErrorActionPreference = "Stop"

$ArgsList = @(
  "compute", "instances", "create", $InstanceName,
  "--project=$ProjectId",
  "--zone=$Zone",
  "--machine-type=$MachineType",
  "--boot-disk-size=$BootDiskSize",
  "--image-project=$ImageProject",
  "--image-family=$ImageFamily",
  "--tags=$NetworkTag",
  "--metadata=ivucx-helper-repo-url=$RepoUrl,ivucx-helper-repo-ref=$RepoRef",
  "--metadata-from-file=startup-script=$StartupScriptPath,ivucx-helper-env=$RuntimeEnvPath"
)

if ($StaticIp) {
  $ArgsList += "--address=$StaticIp"
}

& gcloud @ArgsList
