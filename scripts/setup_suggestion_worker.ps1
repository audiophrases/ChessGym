param(
  [string]$AllowedOrigins = "*"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ConfigPath = Join-Path $Root "wrangler.suggestion.jsonc"

Set-Location $Root

Write-Host "Checking Cloudflare Wrangler login..."
npx wrangler whoami | Out-Host

Write-Host "Creating KV namespace SUGGESTIONS..."
$output = npx wrangler kv namespace create SUGGESTIONS 2>&1 | Out-String
Write-Host $output

$match = [regex]::Match($output, '"id"\s*:\s*"([^"]+)"')
if (-not $match.Success) {
  throw "Could not find the KV namespace id in Wrangler output. Copy the id into wrangler.suggestion.jsonc manually."
}

$namespaceId = $match.Groups[1].Value
$config = Get-Content -LiteralPath $ConfigPath -Raw
$config = $config -replace 'REPLACE_WITH_KV_NAMESPACE_ID', $namespaceId
$config = $config -replace '"ALLOWED_ORIGINS"\s*:\s*"[^"]*"', ('"ALLOWED_ORIGINS": "' + $AllowedOrigins.Replace('"', '\"') + '"')
Set-Content -LiteralPath $ConfigPath -Value $config -Encoding UTF8

Write-Host "Updated wrangler.suggestion.jsonc with KV namespace id $namespaceId"
Write-Host "Next:"
Write-Host "  npm run worker:secret:admin"
Write-Host "  npm run worker:secret:submit   # optional, but recommended"
Write-Host "  npm run worker:deploy"
