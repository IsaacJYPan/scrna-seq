param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    # For test builds without a code-signing certificate: check everything except the signature.
    [switch]$AllowUnsigned
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
if ($AllowUnsigned -and $signature.Status -eq 'NotSigned') {
    Write-Warning 'The installer is unsigned. Use it for testing only.'
} elseif ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "The release installer is not signed by a trusted certificate. Status: $($signature.Status)"
}
if ($env:WINDOWS_PUBLISHER_NAME -and $signature.SignerCertificate -and $signature.SignerCertificate.Subject -notlike "*$($env:WINDOWS_PUBLISHER_NAME)*") {
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
Write-Output "Publisher: $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { 'unsigned' })"
Write-Output "SHA256: $($hash.Hash.ToLowerInvariant())"
