param([Parameter(Mandatory=$true)][string]$PrinterName, [Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$pages = @(Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json)
$document = New-Object System.Drawing.Printing.PrintDocument
$document.PrinterSettings.PrinterName = $PrinterName
if (-not $document.PrinterSettings.IsValid) { throw 'Configured printer is not installed.' }
$document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
# DNP DS-RX1: giấy PR (4x6) = 4 x 6 inch (400 x 600 phần trăm inch); driver có thể khai báo dọc hoặc ngang.
# Khổ 4x6 có thể lớn hơn một chút vì phần tràn lề (DNP: vd. 4,13 x 6,15 inch); không thấy thì dùng khổ
# đang đặt sẵn của hàng in (driver DNP mặc định 4x6) thay vì bỏ lệnh in.
$paper = @($document.PrinterSettings.PaperSizes | Where-Object {
  $short = [Math]::Min($_.Width, $_.Height); $long = [Math]::Max($_.Width, $_.Height)
  $short -ge 380 -and $short -le 440 -and $long -ge 580 -and $long -le 650
}) | Sort-Object @{ Expression = { [bool]($_.PaperName -match 'x ?2|2x6|strip|cut') } },
  @{ Expression = { [Math]::Abs([Math]::Min($_.Width, $_.Height) - 400) + [Math]::Abs([Math]::Max($_.Width, $_.Height) - 600) } } |
  Select-Object -First 1
if ($paper) { $document.DefaultPageSettings.PaperSize = $paper }
$document.DefaultPageSettings.Landscape = $false
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$script:pageIndex = 0
$document.add_PrintPage({
  param($sender, $event)
  $photo = [System.Drawing.Image]::FromFile($pages[$script:pageIndex])
  try {
    # Tờ khác chiều với trang của máy in (vd. tờ ngang 15 x 10 trên trang dọc) thì xoay 90 độ cho kín khổ.
    $pageLandscape = $event.PageBounds.Width -gt $event.PageBounds.Height
    if (($photo.Width -gt $photo.Height) -ne $pageLandscape) { $photo.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
    $event.Graphics.TranslateTransform(-$event.PageSettings.HardMarginX, -$event.PageSettings.HardMarginY)
    $event.Graphics.DrawImage($photo, $event.PageBounds)
  } finally { $photo.Dispose() }
  $script:pageIndex++
  $event.HasMorePages = $script:pageIndex -lt $pages.Count
})
try { $document.Print() } finally { $document.Dispose() }
