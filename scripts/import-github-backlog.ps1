param(
    [string]$Repository = "jrmilburn/content-automation",
    [switch]$AllowPublic
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repoRoot "docs\delivery\manifest.json"
$checkpointPath = Join-Path $repoRoot "docs\delivery\backlog-import-checkpoint.json"
$resultPath = Join-Path $repoRoot "docs\delivery\backlog-import-results.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Backlog manifest not found at $manifestPath"
}

& gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI authentication is not valid. Run gh auth login/refresh before importing."
}

$repoInfo = & gh repo view $Repository --json nameWithOwner,visibility | ConvertFrom-Json
if ($repoInfo.visibility -eq "PUBLIC" -and -not $AllowPublic) {
    throw "Refusing to publish the internal backlog to public repository $Repository. Make it private or rerun with -AllowPublic only after explicit approval."
}

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.repository -ne $Repository) {
    throw "Manifest targets $($manifest.repository), not $Repository. Update/review the manifest before importing."
}

$items = @($manifest.issues | Sort-Object order)
$titleBySlug = @{}
foreach ($item in $items) {
    if ($titleBySlug.ContainsKey($item.slug)) {
        throw "Duplicate manifest slug: $($item.slug)"
    }
    $titleBySlug[$item.slug] = $item.title
}

$numberBySlug = @{}
if (Test-Path -LiteralPath $checkpointPath) {
    $checkpoint = Get-Content -Raw -Encoding UTF8 -LiteralPath $checkpointPath | ConvertFrom-Json
    if ($checkpoint.repository -ne $Repository) {
        throw "Checkpoint belongs to $($checkpoint.repository), not $Repository."
    }
    foreach ($property in $checkpoint.numbers.PSObject.Properties) {
        $numberBySlug[$property.Name] = [int]$property.Value
    }
}

$existingLabelNames = @{}
$labelRows = & gh label list --repo $Repository --limit 100 --json name | ConvertFrom-Json
foreach ($labelRow in $labelRows) {
    $existingLabelNames[$labelRow.name] = $true
}

function Resolve-BacklogBody {
    param(
        [string]$Body,
        [hashtable]$Numbers,
        [bool]$RequireAllNumbers
    )

    $resolved = $Body
    foreach ($slug in $titleBySlug.Keys) {
        $resolved = $resolved.Replace("{{TITLE:$slug}}", $titleBySlug[$slug])
        if ($Numbers.ContainsKey($slug)) {
            $resolved = $resolved.Replace("{{ISSUE:$slug}}", "#$($Numbers[$slug])")
        }
    }

    if ($RequireAllNumbers -and ($resolved -match "\{\{ISSUE:" -or $resolved -match "\{\{TITLE:")) {
        throw "Unresolved backlog reference remains in a final issue body."
    }
    return $resolved
}

function Write-Checkpoint {
    $checkpointNumbers = [ordered]@{}
    foreach ($item in $items) {
        if ($numberBySlug.ContainsKey($item.slug)) {
            $checkpointNumbers[$item.slug] = $numberBySlug[$item.slug]
        }
    }
    $payload = [ordered]@{
        repository = $Repository
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
        numbers = $checkpointNumbers
    }
    $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $checkpointPath -Encoding UTF8
}

foreach ($item in $items) {
    if ($numberBySlug.ContainsKey($item.slug)) {
        continue
    }

    $bodyPath = Join-Path $repoRoot $item.body_file
    if (-not (Test-Path -LiteralPath $bodyPath)) {
        throw "Missing body file for $($item.slug): $bodyPath"
    }

    $body = Resolve-BacklogBody -Body (Get-Content -Raw -Encoding UTF8 -LiteralPath $bodyPath) -Numbers $numberBySlug -RequireAllNumbers $false
    $temporaryBody = New-TemporaryFile
    try {
        Set-Content -LiteralPath $temporaryBody.FullName -Value $body -Encoding UTF8
        $createArgs = @("issue", "create", "--repo", $Repository, "--title", $item.title, "--body-file", $temporaryBody.FullName)
        foreach ($label in @($item.labels)) {
            if ($existingLabelNames.ContainsKey($label)) {
                $createArgs += @("--label", $label)
            }
        }
        if ($null -ne $item.milestone -and -not [string]::IsNullOrWhiteSpace([string]$item.milestone)) {
            $createArgs += @("--milestone", [string]$item.milestone)
        }

        $issueUrl = (& gh @createArgs | Select-Object -Last 1).Trim()
        if ($LASTEXITCODE -ne 0 -or $issueUrl -notmatch "/issues/(\d+)$") {
            throw "Failed to create $($item.slug), or could not parse issue URL: $issueUrl"
        }
        $numberBySlug[$item.slug] = [int]$Matches[1]
        Write-Checkpoint
        Write-Host "Created #$($numberBySlug[$item.slug]) $($item.title)"
    }
    finally {
        if (Test-Path -LiteralPath $temporaryBody.FullName) {
            Remove-Item -LiteralPath $temporaryBody.FullName -Force
        }
    }
}

foreach ($item in $items) {
    $bodyPath = Join-Path $repoRoot $item.body_file
    $finalBody = Resolve-BacklogBody -Body (Get-Content -Raw -Encoding UTF8 -LiteralPath $bodyPath) -Numbers $numberBySlug -RequireAllNumbers $true
    $temporaryBody = New-TemporaryFile
    try {
        Set-Content -LiteralPath $temporaryBody.FullName -Value $finalBody -Encoding UTF8
        & gh issue edit $numberBySlug[$item.slug] --repo $Repository --body-file $temporaryBody.FullName | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to backfill issue #$($numberBySlug[$item.slug]) ($($item.slug))."
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryBody.FullName) {
            Remove-Item -LiteralPath $temporaryBody.FullName -Force
        }
    }
}

$resultIssues = foreach ($item in $items) {
    $number = $numberBySlug[$item.slug]
    $view = & gh issue view $number --repo $Repository --json number,title,url,labels,milestone | ConvertFrom-Json
    [ordered]@{
        order = $item.order
        slug = $item.slug
        number = $view.number
        title = $view.title
        url = $view.url
        labels = @($view.labels | ForEach-Object { $_.name })
        milestone = if ($null -eq $view.milestone) { $null } else { $view.milestone.title }
    }
}

$result = [ordered]@{
    repository = $Repository
    imported_at = (Get-Date).ToUniversalTime().ToString("o")
    issue_count = $resultIssues.Count
    issues = @($resultIssues)
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8

Write-Host "Imported and backfilled $($resultIssues.Count) issues. Results: $resultPath"
