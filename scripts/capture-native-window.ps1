param(
  [Parameter(Mandatory = $true)][string]$WindowHandle,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [int]$FrameCount = 60,
  [int]$FrameIntervalMs = 100
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TraceOmicsWindowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$handleValue = 0L
if (-not [long]::TryParse($WindowHandle, [ref]$handleValue) -or $handleValue -eq 0) {
  throw 'Electron supplied an invalid native window handle.'
}
$nativeHandle = [IntPtr]::new($handleValue)

$rect = New-Object TraceOmicsWindowCapture+RECT
if (-not [TraceOmicsWindowCapture]::GetWindowRect($nativeHandle, [ref]$rect)) {
  throw 'Could not read the Electron window rectangle.'
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 320 -or $height -lt 240) { throw "Electron window rectangle is invalid: ${width}x${height}." }

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
  Where-Object { $_.MimeType -eq 'image/jpeg' } |
  Select-Object -First 1
$qualityEncoder = [System.Drawing.Imaging.Encoder]::Quality
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($qualityEncoder, [long]88)

for ($index = 0; $index -lt $FrameCount; $index += 1) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $rendered = $false
  try {
    $hdc = $graphics.GetHdc()
    try {
      # PW_RENDERFULLCONTENT asks Chromium/DWM to render this exact HWND even
      # when another application overlaps it. This never samples the desktop.
      $rendered = [TraceOmicsWindowCapture]::PrintWindow($nativeHandle, $hdc, 2)
      if (-not $rendered) {
        $rendered = [TraceOmicsWindowCapture]::PrintWindow($nativeHandle, $hdc, 0)
      }
    } finally {
      $graphics.ReleaseHdc($hdc)
    }
    if (-not $rendered) { throw 'Could not render the Electron native window.' }
    $target = Join-Path $OutputDirectory ('frame_{0:D4}.jpg' -f $index)
    $bitmap.Save($target, $jpegCodec, $encoderParams)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  if ($index + 1 -lt $FrameCount) { Start-Sleep -Milliseconds $FrameIntervalMs }
}

$encoderParams.Dispose()
[pscustomobject]@{
  width = $width
  height = $height
  frames = $FrameCount
  left = $rect.Left
  top = $rect.Top
} | ConvertTo-Json -Compress
