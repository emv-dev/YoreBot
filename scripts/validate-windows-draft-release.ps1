[CmdletBinding()]
param(
    [switch] $ValidateContractOnly,
    [switch] $ValidateUploadTemplateOnly,
    [string] $DraftTag,
    [string] $TauriConfigPath = 'src-tauri/tauri.conf.json',
    [string] $ProductId,
    [string] $MonthlyCheckoutUrl,
    [string] $YearlyCheckoutUrl,
    [string] $ManageUrl,
    [string] $Repository,
    [long] $ReleaseId,
    [string] $UploadTemplate,
    [switch] $CheckRemoteAbsence
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

function Assert-ThrowsLike {
    param(
        [Parameter(Mandatory)] [scriptblock] $Action,
        [Parameter(Mandatory)] [string] $Expected
    )

    try {
        & $Action
    } catch {
        if ($_.Exception.Message.Contains($Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }
        throw
    }
    throw "Expected failure containing '$Expected'"
}

function Get-CheckedGumroadUri {
    param([Parameter(Mandatory)] [string] $Value)

    if ($Value.Length -gt 2048) {
        throw 'Gumroad URL exceeds the supported length'
    }
    $uri = $null
    if (-not [uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref] $uri)) {
        throw 'Gumroad URL is invalid'
    }
    if ($uri.Scheme -cne 'https' -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'Gumroad URL must be credential-free HTTPS without a fragment'
    }
    $authority = [regex]::Match($Value, '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)').Groups[1].Value
    if ([string]::IsNullOrEmpty($authority) -or $authority.Contains('@') -or $authority -match ':\d+$') {
        throw 'Gumroad URL must not contain credentials or an explicit port'
    }
    $host = $uri.DnsSafeHost.ToLowerInvariant()
    if ($host -cne 'gumroad.com' -and -not $host.EndsWith('.gumroad.com', [System.StringComparison]::Ordinal)) {
        throw 'Gumroad URL must use an official Gumroad host'
    }
    return $uri
}

function Get-QueryPairs {
    param([Parameter(Mandatory)] [uri] $Uri)

    if ([string]::IsNullOrEmpty($Uri.Query)) {
        return @()
    }
    return @(
        foreach ($part in $Uri.Query.TrimStart('?').Split('&', [System.StringSplitOptions]::None)) {
            $pieces = $part.Split('=', 2)
            [pscustomobject]@{
                Key = [System.Net.WebUtility]::UrlDecode($pieces[0])
                Value = if ($pieces.Count -eq 2) {
                    [System.Net.WebUtility]::UrlDecode($pieces[1])
                } else {
                    ''
                }
            }
        }
    )
}

function Get-CheckedCheckoutIdentity {
    param(
        [Parameter(Mandatory)] [string] $Value,
        [Parameter(Mandatory)] [ValidateSet('monthly', 'yearly')] [string] $Recurrence
    )

    $uri = Get-CheckedGumroadUri -Value $Value
    if ($uri.AbsolutePath -notmatch '^/l/[^/]+$') {
        throw 'Gumroad checkout must use one nonempty /l/<permalink> product path'
    }
    $recurrenceCount = 0
    $wantedCount = 0
    foreach ($pair in @(Get-QueryPairs -Uri $uri)) {
        if ($pair.Key -ceq $Recurrence) {
            if ($pair.Value -cne 'true') {
                throw "Gumroad $Recurrence selector must equal true"
            }
            $recurrenceCount += 1
        } elseif ($pair.Key -in @('monthly', 'quarterly', 'biannually', 'yearly')) {
            throw 'Gumroad checkout contains a conflicting recurrence selector'
        }
        if ($pair.Key -ceq 'wanted') {
            if ($pair.Value -cne 'true') {
                throw 'Gumroad wanted selector must equal true'
            }
            $wantedCount += 1
        }
    }
    if ($recurrenceCount -ne 1 -or $wantedCount -ne 1) {
        throw "Gumroad $Recurrence checkout must contain exactly one $Recurrence=true and wanted=true"
    }
    return "$($uri.DnsSafeHost.ToLowerInvariant())$($uri.AbsolutePath)"
}

function Assert-YoreBotDraftReleaseConfiguration {
    param(
        [Parameter(Mandatory)] [string] $Tag,
        [Parameter(Mandatory)] [string] $Version,
        [Parameter(Mandatory)] [string] $ConfiguredProductId,
        [Parameter(Mandatory)] [string] $ConfiguredMonthlyCheckoutUrl,
        [Parameter(Mandatory)] [string] $ConfiguredYearlyCheckoutUrl,
        [Parameter(Mandatory)] [string] $ConfiguredManageUrl
    )

    if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
        throw "Tauri app version is not a clean semantic version: $Version"
    }
    $expectedTag = 'yorebot-v$version'.Replace('$version', $Version)
    if ($Tag -cne $expectedTag) {
        throw "Draft tag must exactly match YoreBot app version: $expectedTag"
    }
    $trimmedProductId = $ConfiguredProductId.Trim()
    if ($trimmedProductId.Length -eq 0 -or
        $trimmedProductId.Length -gt 256 -or
        $trimmedProductId.ToCharArray().Where({ [int]$_ -lt 0x21 -or [int]$_ -gt 0x7e }).Count -gt 0) {
        throw 'Gumroad product id must be nonempty bounded ASCII without whitespace'
    }

    $monthlyIdentity = Get-CheckedCheckoutIdentity `
        -Value $ConfiguredMonthlyCheckoutUrl `
        -Recurrence 'monthly'
    $yearlyIdentity = Get-CheckedCheckoutIdentity `
        -Value $ConfiguredYearlyCheckoutUrl `
        -Recurrence 'yearly'
    if ($monthlyIdentity -cne $yearlyIdentity) {
        throw 'Monthly and yearly checkout URLs must identify the same Gumroad product'
    }

    $manage = Get-CheckedGumroadUri -Value $ConfiguredManageUrl
    $manageHost = $manage.DnsSafeHost.ToLowerInvariant()
    if ($manage.AbsolutePath -cne '/library' -or
        $manageHost -notin @('gumroad.com', 'app.gumroad.com')) {
        throw 'Gumroad manage URL must use the official /library path'
    }
}

function Assert-RemoteDraftNameAbsent {
    param(
        [Parameter(Mandatory)] [int] $TagStatus,
        [Parameter(Mandatory)] [int] $ReleaseStatus
    )

    if ($TagStatus -eq 200) { throw 'Refusing to overwrite an existing tag' }
    if ($TagStatus -ne 404) { throw "Unable to prove tag absence (HTTP $TagStatus)" }
    if ($ReleaseStatus -eq 200) { throw 'Refusing to overwrite an existing release' }
    if ($ReleaseStatus -ne 404) { throw "Unable to prove release absence (HTTP $ReleaseStatus)" }
}

function Get-CheckedGitHubUploadBase {
    param(
        [Parameter(Mandatory)] [string] $RepositoryName,
        [Parameter(Mandatory)] [long] $ExactReleaseId,
        [Parameter(Mandatory)] [string] $Template
    )

    if ($RepositoryName -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $ExactReleaseId -le 0) {
        throw 'GitHub upload identity is invalid'
    }
    $expected = "https://uploads.github.com/repos/$RepositoryName/releases/$ExactReleaseId/assets{?name,label}"
    if ($Template -cne $expected) {
        throw 'GitHub release upload_url is not the exact expected uploads.github.com template'
    }
    return $expected.Substring(0, $expected.IndexOf('{'))
}

function Get-PublicGitHubStatus {
    param([Parameter(Mandatory)] [string] $Uri)

    $response = Invoke-WebRequest `
        -Uri $Uri `
        -Method Get `
        -Headers @{ Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' } `
        -SkipHttpErrorCheck
    return [int]$response.StatusCode
}

function Test-YoreBotDraftReleaseContract {
    $valid = @{
        Tag = 'yorebot-v2.0.0'
        Version = '2.0.0'
        ConfiguredProductId = 'product-123'
        ConfiguredMonthlyCheckoutUrl = 'https://yorebot.gumroad.com/l/access?monthly=true&wanted=true'
        ConfiguredYearlyCheckoutUrl = 'https://yorebot.gumroad.com/l/access?yearly=true&wanted=true'
        ConfiguredManageUrl = 'https://gumroad.com/library'
    }
    Assert-YoreBotDraftReleaseConfiguration @valid
    Assert-RemoteDraftNameAbsent -TagStatus 404 -ReleaseStatus 404
    $uploadBase = Get-CheckedGitHubUploadBase `
        -RepositoryName 'emv-dev/YoreBot' `
        -ExactReleaseId 123 `
        -Template 'https://uploads.github.com/repos/emv-dev/YoreBot/releases/123/assets{?name,label}'
    if ($uploadBase -cne 'https://uploads.github.com/repos/emv-dev/YoreBot/releases/123/assets') {
        throw 'Valid GitHub upload template produced the wrong base URL'
    }

    foreach ($unsafeTag in @('v2.0.0', 'yorebot-v2.0.1', 'yorebot-v2.0.0-beta.1')) {
        $case = $valid.Clone()
        $case.Tag = $unsafeTag
        Assert-ThrowsLike -Expected 'must exactly match' -Action {
            Assert-YoreBotDraftReleaseConfiguration @case
        }
    }
    $differentProduct = $valid.Clone()
    $differentProduct.ConfiguredYearlyCheckoutUrl = 'https://yorebot.gumroad.com/l/other?yearly=true&wanted=true'
    Assert-ThrowsLike -Expected 'same Gumroad product' -Action {
        Assert-YoreBotDraftReleaseConfiguration @differentProduct
    }
    $missingSelector = $valid.Clone()
    $missingSelector.ConfiguredMonthlyCheckoutUrl = 'https://yorebot.gumroad.com/l/access?monthly=true'
    Assert-ThrowsLike -Expected 'wanted=true' -Action {
        Assert-YoreBotDraftReleaseConfiguration @missingSelector
    }
    $badManage = $valid.Clone()
    $badManage.ConfiguredManageUrl = 'https://creator.gumroad.com/library'
    Assert-ThrowsLike -Expected 'official /library' -Action {
        Assert-YoreBotDraftReleaseConfiguration @badManage
    }
    Assert-ThrowsLike -Expected 'existing tag' -Action {
        Assert-RemoteDraftNameAbsent -TagStatus 200 -ReleaseStatus 404
    }
    Assert-ThrowsLike -Expected 'existing release' -Action {
        Assert-RemoteDraftNameAbsent -TagStatus 404 -ReleaseStatus 200
    }
    foreach ($unsafeUploadTemplate in @(
        'https://api.uploads.github.com/repos/emv-dev/YoreBot/releases/123/assets{?name,label}',
        'https://attacker.example/repos/emv-dev/YoreBot/releases/123/assets{?name,label}',
        'https://uploads.github.com/repos/emv-dev/YoreBot/releases/124/assets{?name,label}',
        "https://uploads.github.com/repos/emv-dev/YoreBot/releases/123/assets{?name,label}`n"
    )) {
        Assert-ThrowsLike -Expected 'exact expected uploads.github.com template' -Action {
            Get-CheckedGitHubUploadBase `
                -RepositoryName 'emv-dev/YoreBot' `
                -ExactReleaseId 123 `
                -Template $unsafeUploadTemplate
        }
    }
    Write-Host 'YoreBot signed draft preflight contract passed.'
}

if ($ValidateContractOnly) {
    Test-YoreBotDraftReleaseContract
    return
}

if ($ValidateUploadTemplateOnly) {
    Get-CheckedGitHubUploadBase `
        -RepositoryName $Repository `
        -ExactReleaseId $ReleaseId `
        -Template $UploadTemplate
    return
}

$configPath = (Resolve-Path -LiteralPath $TauriConfigPath).Path
$tauriConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$appVersion = [string]$tauriConfig.version
Assert-YoreBotDraftReleaseConfiguration `
    -Tag $DraftTag `
    -Version $appVersion `
    -ConfiguredProductId $ProductId `
    -ConfiguredMonthlyCheckoutUrl $MonthlyCheckoutUrl `
    -ConfiguredYearlyCheckoutUrl $YearlyCheckoutUrl `
    -ConfiguredManageUrl $ManageUrl

if ($CheckRemoteAbsence) {
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw 'GitHub repository identity is invalid'
    }
    $encodedTag = [uri]::EscapeDataString($DraftTag)
    $tagStatus = Get-PublicGitHubStatus -Uri "https://api.github.com/repos/$Repository/git/ref/tags/$encodedTag"
    $releaseStatus = Get-PublicGitHubStatus -Uri "https://api.github.com/repos/$Repository/releases/tags/$encodedTag"
    Assert-RemoteDraftNameAbsent -TagStatus $tagStatus -ReleaseStatus $releaseStatus
}

Write-Host "YoreBot signed draft preflight passed: tag=$DraftTag app_version=$appVersion"
