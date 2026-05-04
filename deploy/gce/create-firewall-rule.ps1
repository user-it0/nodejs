param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$RuleName = "ivucx-helper-http",
  [string]$Network = "default",
  [string]$TargetTag = "ivucx-helper",
  [string]$SourceRanges = "0.0.0.0/0",
  [string]$Ports = "tcp:3000"
)

$ErrorActionPreference = "Stop"

$ArgsList = @(
  "compute", "firewall-rules", "create", $RuleName,
  "--project=$ProjectId",
  "--network=$Network",
  "--direction=INGRESS",
  "--action=ALLOW",
  "--rules=$Ports",
  "--source-ranges=$SourceRanges"
)

if ($TargetTag) {
  $ArgsList += "--target-tags=$TargetTag"
}

& gcloud @ArgsList
