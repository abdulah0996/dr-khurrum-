param(
  [string]$OutputDir = "backups\mongodump"
)

if (-not $env:MONGODB_URI) {
  Write-Error "MONGODB_URI is required."
  exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $OutputDir $stamp
New-Item -ItemType Directory -Force -Path $target | Out-Null

mongodump --uri="$env:MONGODB_URI" --out="$target"
Compress-Archive -Path $target -DestinationPath "$target.zip" -Force
Remove-Item -LiteralPath $target -Recurse -Force

Write-Output "$target.zip"
