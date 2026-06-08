# Build a 4 MiB "cool" test image for the EN25Q32 / W25Q32 training chip.
# Output: <repo>\.runtime\test-pattern.bin (4,194,304 bytes, hash printed at end)
# Run with:   & "D:\Universal Chip Lab\scripts\make-cool-pattern.ps1"

$ErrorActionPreference = "Stop"

# 4 MiB — must equal the chip size or flashrom refuses.
$size = 4 * 1024 * 1024
$buf  = New-Object byte[] $size
for ($i = 0; $i -lt $size; $i++) { $buf[$i] = 0xFF }

function Stamp([int]$offset, [byte[]]$bytes) {
  if ($offset + $bytes.Length -gt $buf.Length) { throw "Stamp at 0x$($offset.ToString('X')) overflows buffer." }
  [Array]::Copy($bytes, 0, $buf, $offset, $bytes.Length)
}
function StampAscii([int]$offset, [string]$text) {
  Stamp $offset ([System.Text.Encoding]::ASCII.GetBytes($text))
}

# ----- Sector 0 (0x0000): ECU-style magic header --------------------------
StampAscii 0x0000 "UCLB"                                              # 4-byte magic
[Array]::Copy([BitConverter]::GetBytes([uint32]0x00010001), 0, $buf, 0x0004, 4)   # version 1.1

$stamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
StampAscii 0x0010 $stamp                                              # ISO timestamp

$banner = @"
================================================================
   UNIVERSAL CHIP LAB  -  FIRST REAL WRITE TO REAL SILICON
================================================================
   Operator     : Dmytro
   Project      : ECU Clone Lab
   Chip         : Eon EN25Q32  (W25Q32 silkscreen clone, 4 MiB SPI NOR)
   Programmer   : WCH CH341A  via flashrom 1.4 on Windows
   Bench rev    : Workstation v1  (Module A + E + B)
   Date         : $stamp
================================================================
   This dump exists to prove the full stack works:
     bench PSU -> level shifter -> programmer -> chip
     flashrom  -> ECU Clone Lab app -> verified backup
   If you are reading this in the app's hex viewer, the loop is closed.
================================================================
"@
StampAscii 0x0040 $banner

# ----- Sector 1 (0x0800): ASCII art of the chip ---------------------------
$art = @"
        _______________
       |               |
    CS-|1            8 |-VCC
    DO-|2   EN25Q32  7 |-HOLD
    WP-|3   4 MiB    6 |-CLK
   GND-|4   SPI NOR  5 |-DI
       |_______________|

       Universal Chip Lab
       first hands-on write
"@
StampAscii 0x0800 $art

# ----- Sector 2 (0x1000): structured "ECU-like" record --------------------
StampAscii 0x1000 "RECORD_BEGIN"
StampAscii 0x1020 "VIN              : UCLB-TRAINING-CHIP-NO-REAL-VEHICLE"
StampAscii 0x1080 "PART_NUMBER      : UCLB-W25Q32-TRAINING-001"
StampAscii 0x10E0 "CALIBRATION_ID   : UCLB_DEMO_0001"
StampAscii 0x1140 "SOFTWARE_VERSION : 0.1.0"
StampAscii 0x11A0 "CHECKSUM_PLACE   : 0xDEADBEEF"
StampAscii 0x1200 "BUILD_HOST       : $($env:COMPUTERNAME)"
StampAscii 0x1260 "BUILD_USER       : $($env:USERNAME)"
StampAscii 0x12C0 "WARNING          : This is synthetic training data."
StampAscii 0x1320 "WARNING          : DO NOT WRITE THIS INTO A REAL VEHICLE."
StampAscii 0x13C0 "RECORD_END"

# ----- Sector 3 (0x2000): byte ramp 0x00..0xFF, four times = 4 KiB --------
for ($i = 0; $i -lt 4096; $i++) {
  $buf[0x2000 + $i] = [byte]($i -band 0xFF)
}

# ----- Trailer (last 64 bytes of the 4 MiB file): tail signature ----------
StampAscii ($size - 64) "UCLB-TAIL-MARKER:if-you-see-this-you-read-the-whole-chip"

# ----- Write file --------------------------------------------------------
$runtimeDir = Join-Path $PSScriptRoot "..\.runtime" | Resolve-Path
$outPath    = Join-Path $runtimeDir "test-pattern.bin"
[System.IO.File]::WriteAllBytes($outPath, $buf)

$sha = (Get-FileHash $outPath -Algorithm SHA256).Hash
""
"  Wrote : $outPath"
"  Size  : $((Get-Item $outPath).Length.ToString('N0')) bytes"
"  SHA256: $sha"
""
"  Flash it with:"
'    cd "D:\Universal Chip Lab\.runtime"'
'    flashrom -p ch341a_spi -w test-pattern.bin'
""
"  After flashrom prints VERIFIED., expect the SAME SHA-256 above"
"  when you read the chip back through the app (Verified Backup)."
