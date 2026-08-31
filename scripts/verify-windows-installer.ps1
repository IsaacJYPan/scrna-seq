param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$expectedRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\release\desktop')).Path
if (-not $resolvedInstaller.StartsWith($expectedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installer must be under release\desktop.'
}

$file = Get-Item -LiteralPath $resolvedInstaller
if ($file.Name -notmatch '^TraceOmics-Setup-\d+\.\d+\.\d+-x64\.exe$') {
    throw "Unexpected installer name: $($file.Name)"
}
if ($file.Length -lt 1MB) {
    throw 'The installer is unexpectedly small.'
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "The release installer is not signed by a trusted certificate. Status: $($signature.Status)"
}
if ($env:WINDOWS_PUBLISHER_NAME -and $signature.SignerCertificate.Subject -notlike "*$($env:WINDOWS_PUBLISHER_NAME)*") {
    throw "The signing certificate does not match WINDOWS_PUBLISHER_NAME. Subject: $($signature.SignerCertificate.Subject)"
}

$version = $file.VersionInfo
if ($version.ProductName -ne 'TraceOmics') {
    throw "Unexpected ProductName metadata: $($version.ProductName)"
}
if ($version.CompanyName -ne 'TraceOmics') {
    throw "Unexpected CompanyName metadata: $($version.CompanyName)"
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedInstaller
Write-Output "Installer: $($file.Name)"
Write-Output "Publisher: $($signature.SignerCertificate.Subject)"
Write-Output "SHA256: $($hash.Hash.ToLowerInvariant())"
